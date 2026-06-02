import { generateKeyPair, exportJWK, calculateJwkThumbprint, type JWK } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AIP_COVERED_COMPONENTS,
  AIP_SIGNATURE_TAG,
  buildSignatureBase,
  normalizeAuthority,
  parseSignatureInput,
  parseSignatureValue,
  signMessage,
  verifyMessageSignature,
  type SignMessageInput,
} from '../src/aip/http-signature';

let privateJwk: JWK;
let publicJwk: JWK;
let thumbprint: string;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  privateJwk = await exportJWK(privateKey);
  publicJwk = await exportJWK(publicKey);
  thumbprint = await calculateJwkThumbprint(publicJwk, 'sha256');
});

const baseReq = {
  method: 'POST',
  authority: 'wine-merchant.com',
  path: '/checkout',
  agentIdentity: 'eyJhbGciOiJFZERTQSJ9.payload.sig',
};

const roundTrip = async (overrides: Partial<SignMessageInput> = {}) => {
  const { signatureInput, signature } = await signMessage({
    ...baseReq,
    privateJwk,
    publicJwk,
    ...overrides,
  });
  return { signatureInput, signature };
};

describe('normalizeAuthority', () => {
  it('lowercases the host', () => {
    expect(normalizeAuthority('Wine-Merchant.COM')).toBe('wine-merchant.com');
  });

  it('drops default ports 80 and 443', () => {
    expect(normalizeAuthority('host.com:443')).toBe('host.com');
    expect(normalizeAuthority('host.com:80')).toBe('host.com');
  });

  it('keeps non-default ports', () => {
    expect(normalizeAuthority('host.com:3003')).toBe('host.com:3003');
  });

  it('leaves IPv6 literals without a port intact', () => {
    expect(normalizeAuthority('[::1]')).toBe('[::1]');
  });
});

describe('buildSignatureBase', () => {
  it('emits one line per component plus @signature-params, no trailing newline', () => {
    const base = buildSignatureBase(
      { components: ['@method', '@authority', '@path', 'agent-identity'], created: 1715400000, keyid: 'kid', tag: 'agent-identity' },
      baseReq,
    );
    const lines = base.split('\n');
    expect(lines[0]).toBe('"@method": POST');
    expect(lines[1]).toBe('"@authority": wine-merchant.com');
    expect(lines[2]).toBe('"@path": /checkout');
    expect(lines[3]).toBe(`"agent-identity": ${baseReq.agentIdentity}`);
    expect(lines[4]).toBe('"@signature-params": ("@method" "@authority" "@path" "agent-identity");created=1715400000;keyid="kid";tag="agent-identity"');
    expect(base.endsWith('\n')).toBe(false);
  });

  it('throws when a covered component has no value', () => {
    expect(() =>
      buildSignatureBase({ components: ['@method', 'x-missing'] }, baseReq),
    ).toThrow();
  });
});

describe('parseSignatureInput', () => {
  it('parses components and params from a single member', () => {
    const header = 'ait=("@method" "@authority" "@path" "agent-identity");created=1715400000;expires=1715400060;keyid="abc";tag="agent-identity"';
    const parsed = parseSignatureInput(header);
    expect(parsed?.label).toBe('ait');
    expect(parsed?.params.components).toEqual(['@method', '@authority', '@path', 'agent-identity']);
    expect(parsed?.params.created).toBe(1715400000);
    expect(parsed?.params.expires).toBe(1715400060);
    expect(parsed?.params.keyid).toBe('abc');
    expect(parsed?.params.tag).toBe('agent-identity');
  });

  it('selects the agent-identity member when a web-bot-auth member coexists', () => {
    const header =
      'web-bot=("@authority");created=1;tag="web-bot-auth", ait=("@method" "@authority" "@path" "agent-identity");created=2;keyid="k";tag="agent-identity"';
    const parsed = parseSignatureInput(header);
    expect(parsed?.label).toBe('ait');
    expect(parsed?.params.created).toBe(2);
  });

  it('accepts a sole untagged member', () => {
    const header = 'sig1=("@method" "@path");created=5;keyid="k"';
    const parsed = parseSignatureInput(header);
    expect(parsed?.label).toBe('sig1');
  });

  it('returns null when only non-AIP tagged members are present', () => {
    const header = 'web-bot=("@authority");created=1;tag="web-bot-auth"';
    expect(parseSignatureInput(header)).toBeNull();
  });

  it('returns null on malformed input', () => {
    expect(parseSignatureInput('garbage')).toBeNull();
  });
});

describe('parseSignatureValue', () => {
  it('extracts a base64 byte sequence for the label', () => {
    const bytes = parseSignatureValue('ait=:AQID:', 'ait');
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('returns null for a missing label', () => {
    expect(parseSignatureValue('ait=:AQID:', 'other')).toBeNull();
  });

  it('does not split a byte sequence that contains a comma-like char inside base64', () => {
    // base64 never contains commas, but ensure colon-delimited parsing is intact across members
    const header = 'web-bot=:AAAA:, ait=:AQID:';
    expect(parseSignatureValue(header, 'ait')).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe('signMessage + verifyMessageSignature round trip', () => {
  it('verifies a freshly signed request', async () => {
    const { signatureInput, signature } = await roundTrip({ created: 1715400000 });
    const result = await verifyMessageSignature({
      ...baseReq,
      signatureInput,
      signature,
      cnfJwk: publicJwk,
      now: 1715400010,
    });
    expect(result.ok).toBe(true);
  });

  it('sets keyid to the public key thumbprint and tag to agent-identity', async () => {
    const { signatureInput } = await roundTrip();
    const parsed = parseSignatureInput(signatureInput);
    expect(parsed?.params.keyid).toBe(thumbprint);
    expect(parsed?.params.tag).toBe(AIP_SIGNATURE_TAG);
  });

  it('covers exactly the AIP minimum components by default', async () => {
    const { signatureInput } = await roundTrip();
    const parsed = parseSignatureInput(signatureInput);
    expect(parsed?.params.components).toEqual([...AIP_COVERED_COMPONENTS]);
  });
});

describe('verifyMessageSignature failure modes', () => {
  const verify = async (over: Partial<Parameters<typeof verifyMessageSignature>[0]>, sig?: { signatureInput: string; signature: string }) => {
    const s = sig ?? (await roundTrip({ created: 1715400000 }));
    return verifyMessageSignature({
      ...baseReq,
      signatureInput: s.signatureInput,
      signature: s.signature,
      cnfJwk: publicJwk,
      now: 1715400010,
      ...over,
    });
  };

  it('rejects a tampered method (signature base mismatch)', async () => {
    const r = await verify({ method: 'GET' });
    expect(r).toEqual({ ok: false, reason: 'signature_invalid' });
  });

  it('rejects a tampered path', async () => {
    const r = await verify({ path: '/admin' });
    expect(r).toEqual({ ok: false, reason: 'signature_invalid' });
  });

  it('rejects a tampered authority', async () => {
    const r = await verify({ authority: 'evil.com' });
    expect(r).toEqual({ ok: false, reason: 'signature_invalid' });
  });

  it('rejects a swapped Agent-Identity value (token swap)', async () => {
    const r = await verify({ agentIdentity: 'different.token.here' });
    expect(r).toEqual({ ok: false, reason: 'signature_invalid' });
  });

  it('rejects when cnf.jwk is a different key (keyid mismatch)', async () => {
    const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const otherPriv = await exportJWK(privateKey);
    const otherPub = await exportJWK(publicKey);
    const s = await signMessage({ ...baseReq, privateJwk: otherPriv, publicJwk: otherPub, created: 1715400000 });
    // present the wrong cnf (our original key) — keyid in the sig won't match its thumbprint
    const r = await verifyMessageSignature({
      ...baseReq,
      signatureInput: s.signatureInput,
      signature: s.signature,
      cnfJwk: publicJwk,
      now: 1715400010,
    });
    expect(r).toEqual({ ok: false, reason: 'keyid_mismatch' });
  });

  it('rejects an expired signature beyond skew', async () => {
    const s = await roundTrip({ created: 1715400000, expires: 1715400060 });
    const r = await verify({ now: 1715400200 }, s);
    expect(r).toEqual({ ok: false, reason: 'expired' });
  });

  it('accepts an expired signature within skew tolerance', async () => {
    const s = await roundTrip({ created: 1715400000, expires: 1715400060 });
    const r = await verify({ now: 1715400080, maxSkewSeconds: 30 }, s);
    expect(r.ok).toBe(true);
  });

  it('rejects a created timestamp too far in the future', async () => {
    const s = await roundTrip({ created: 1715400000 });
    const r = await verify({ now: 1715300000 }, s);
    expect(r).toEqual({ ok: false, reason: 'created_in_future' });
  });

  it('rejects when the AIP minimum components are not all covered', async () => {
    const s = await roundTrip({ created: 1715400000, components: ['@method', '@authority'] });
    const r = await verify({}, s);
    expect(r).toEqual({ ok: false, reason: 'missing_covered_component' });
  });

  it('rejects a non-ed25519 alg param', async () => {
    const header = 'ait=("@method" "@authority" "@path" "agent-identity");created=1715400000;keyid="k";alg="rsa";tag="agent-identity"';
    const r = await verify({ signatureInput: header }, { signatureInput: header, signature: 'ait=:AA:' });
    expect(r).toEqual({ ok: false, reason: 'unsupported_alg' });
  });

  it('accepts the JWS alg spelling "EdDSA" at the alg gate (case-insensitive)', async () => {
    // ed25519 is the RFC 9421 label; EdDSA is the JWS label. We accept both, so an external signer
    // that emits alg="EdDSA" must pass the alg gate and fail later for a real reason, not unsupported_alg.
    const header = 'ait=("@method" "@authority" "@path" "agent-identity");created=1715400000;keyid="k";alg="EdDSA";tag="agent-identity"';
    const r = await verify({ signatureInput: header }, { signatureInput: header, signature: 'ait=:AA:' });
    expect(r).toEqual({ ok: false, reason: 'keyid_mismatch' });
  });

  it('returns no_aip_signature when no member matches', async () => {
    const header = 'web-bot=("@authority");created=1;tag="web-bot-auth"';
    const r = await verify({ signatureInput: header }, { signatureInput: header, signature: 'web-bot=:AA:' });
    expect(r).toEqual({ ok: false, reason: 'no_aip_signature' });
  });

  it('returns malformed_signature when the Signature dict lacks the selected label', async () => {
    const s = await roundTrip({ created: 1715400000 });
    const r = await verify({ signature: 'wronglabel=:AQID:' }, { signatureInput: s.signatureInput, signature: 'wronglabel=:AQID:' });
    expect(r).toEqual({ ok: false, reason: 'malformed_signature' });
  });

  it('rejects a P-256 cnf key with a typed failure (no throw)', async () => {
    const r = await verify({ cnfJwk: { kty: 'EC', crv: 'P-256', x: 'abc', y: 'def' } as never });
    expect(r).toEqual({ ok: false, reason: 'unsupported_cnf_key' });
  });

  it('rejects a malformed OKP cnf with non-string x without throwing', async () => {
    // A trusted external issuer could mint an AIT whose cnf.jwk has a bad `x`; the thumbprint
    // computation must not throw uncaught and crash the gate.
    const r = await verify({ cnfJwk: { kty: 'OKP', crv: 'Ed25519', x: 123 } as never });
    expect(r).toEqual({ ok: false, reason: 'unsupported_cnf_key' });
  });

  it('rejects an OKP cnf missing x without throwing', async () => {
    const r = await verify({ cnfJwk: { kty: 'OKP', crv: 'Ed25519' } as never });
    expect(r).toEqual({ ok: false, reason: 'unsupported_cnf_key' });
  });
});
