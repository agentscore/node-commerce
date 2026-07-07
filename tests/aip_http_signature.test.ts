import { generateKeyPair, exportJWK, calculateJwkThumbprint, importJWK, type JWK } from 'jose';
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
  // The verifier now REQUIRES `expires` (replay-window hardening), so default to a 60s window
  // (matching pay's signer) unless a test overrides it. `signMessage` itself omits `expires` by
  // default — that's only the serialization-format default, exercised explicitly below.
  const created = overrides.created ?? Math.floor(Date.now() / 1000);
  const { signatureInput, signature } = await signMessage({
    ...baseReq,
    privateJwk,
    publicJwk,
    expires: created + 60,
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

  it('rejects a sole untagged member (tag="agent-identity" is required)', () => {
    const header = 'sig1=("@method" "@path");created=5;keyid="k"';
    expect(parseSignatureInput(header)).toBeNull();
  });

  it('preserves the raw member value (rawParams) byte-for-byte', () => {
    // The verifier echoes this into the "@signature-params" base line, so it must be the member
    // value exactly as received — including a non-canonical param order.
    const raw = '("@method" "@authority" "@path" "agent-identity");keyid="abc";created=1715400000;expires=1715400060;tag="agent-identity"';
    const parsed = parseSignatureInput(`ait=${raw}`);
    expect(parsed?.rawParams).toBe(raw);
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

  it('verifies a signer that declared params in a NON-canonical order (raw @signature-params)', async () => {
    // RFC 9421 puts no order on signature params. A spec-legal signer that emits keyid BEFORE
    // created/expires signs over THAT serialization; the verifier must rebuild the base from the
    // raw received member value, not a re-serialization in our canonical order.
    const created = 1715400000;
    const rawParams = `("@method" "@authority" "@path" "agent-identity");keyid="${thumbprint}";created=${created};expires=${created + 60};tag="agent-identity"`;
    const base = [
      '"@method": POST',
      '"@authority": wine-merchant.com',
      '"@path": /checkout',
      `"agent-identity": ${baseReq.agentIdentity}`,
      `"@signature-params": ${rawParams}`,
    ].join('\n');
    const key = await importJWK(privateJwk, 'EdDSA');
    const sigBytes = await globalThis.crypto.subtle.sign(
      'Ed25519',
      key as CryptoKey,
      new TextEncoder().encode(base) as unknown as ArrayBuffer,
    );
    const signature = `ait=:${Buffer.from(new Uint8Array(sigBytes)).toString('base64')}:`;
    const r = await verifyMessageSignature({
      ...baseReq,
      signatureInput: `ait=${rawParams}`,
      signature,
      cnfJwk: publicJwk,
      now: created + 10,
    });
    expect(r.ok).toBe(true);
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
    const s = await signMessage({ ...baseReq, privateJwk: otherPriv, publicJwk: otherPub, created: 1715400000, expires: 1715400060 });
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

  it('rejects a signature missing created (no enforceable time bound)', async () => {
    // Hand-build a Signature-Input with neither created nor expires, signed over that exact base, so
    // the missing-created branch fires before the byte verification. An unbounded PoP is replayable.
    const { signature } = await signMessage({ ...baseReq, privateJwk, publicJwk, created: 1715400000 });
    const header = `ait=${'("@method" "@authority" "@path" "agent-identity")'};keyid="${thumbprint}";tag="agent-identity"`;
    const r = await verify({ signatureInput: header }, { signatureInput: header, signature });
    expect(r).toEqual({ ok: false, reason: 'created_missing' });
  });

  it('rejects a signature missing expires (replayable for the full AIT lifetime)', async () => {
    // signMessage omits `expires` by default — exactly the spec-loose shape the hardening rejects.
    const s = await signMessage({ ...baseReq, privateJwk, publicJwk, created: 1715400000 });
    const r = await verify({}, s);
    expect(r).toEqual({ ok: false, reason: 'expires_missing' });
  });

  it('rejects a signature whose declared window (expires - created) exceeds the 120s ceiling', async () => {
    // created+expires alone only bound replay to whatever window the SIGNER chose; the HTTP-sig layer
    // caps it at 120s. A 300s window (an attacker matching the AIT's 300s ceiling) is rejected even
    // though created/expires are present and `now` sits inside the window.
    const s = await roundTrip({ created: 1715400000, expires: 1715400300 }); // 300s > 120s
    const r = await verify({ now: 1715400005 }, s); // well inside the declared window
    expect(r).toEqual({ ok: false, reason: 'pop_window_too_long' });
  });

  it('accepts a signature whose declared window equals the 120s ceiling (boundary)', async () => {
    const s = await roundTrip({ created: 1715400000, expires: 1715400120 }); // exactly 120s
    const r = await verify({ now: 1715400005 }, s);
    expect(r.ok).toBe(true);
  });

  it('rejects a NEGATIVE window (expires before created)', async () => {
    // A negative window would slip under the 120s cap (negative < 120) and, within skew, pass the
    // created/expires clock checks — it must be rejected as a window violation.
    const s = await roundTrip({ created: 1715400000, expires: 1715399990 });
    const r = await verify({ now: 1715400005 }, s);
    expect(r).toEqual({ ok: false, reason: 'pop_window_too_long' });
  });

  it('rejects an untagged sole member at verify (tag is required)', async () => {
    const s = await roundTrip({ created: 1715400000 });
    const stripped = s.signatureInput.replace(';tag="agent-identity"', '');
    const r = await verify({ signatureInput: stripped }, { signatureInput: stripped, signature: s.signature });
    expect(r).toEqual({ ok: false, reason: 'no_aip_signature' });
  });

  it('verifies a valid 60s-window PoP (the first-party pay signer shape)', async () => {
    // pay signs created + expires = created + 60. This must still verify post-hardening.
    const s = await roundTrip({ created: 1715400000, expires: 1715400060 });
    const r = await verify({ now: 1715400010 }, s);
    expect(r.ok).toBe(true);
  });

  it('rejects a non-ed25519 alg param', async () => {
    const header = 'ait=("@method" "@authority" "@path" "agent-identity");created=1715400000;keyid="k";alg="rsa";tag="agent-identity"';
    const r = await verify({ signatureInput: header }, { signatureInput: header, signature: 'ait=:AA:' });
    expect(r).toEqual({ ok: false, reason: 'unsupported_alg' });
  });

  it('accepts the JWS alg spelling "EdDSA" at the alg gate (case-insensitive)', async () => {
    // ed25519 is the RFC 9421 label; EdDSA is the JWS label. We accept both, so an external signer
    // that emits alg="EdDSA" must pass the alg gate and fail later for a real reason, not unsupported_alg.
    // (created+expires present so the alg-spelling reaches the keyid check, not the time-bound gates.)
    const header = 'ait=("@method" "@authority" "@path" "agent-identity");created=1715400000;expires=1715400060;keyid="k";alg="EdDSA";tag="agent-identity"';
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
