import { describe, expect, it } from 'vitest';
import { buildUCPProfile, UCPSigningKey } from '../../src/identity/ucp';
import {
  buildJWKSResponse,
  generateUCPSigningKey,
  signUCPProfile,
  UCPVerificationError,
  verifyUCPProfile,
} from '../../src/identity/ucp-jwks';

const baseInput = {
  name: 'Test Merchant',
  services: {
    'dev.ucp.shopping': [
      {
        version: '2026-04-08',
        spec: 'https://ucp.dev/2026-04-08/specification/overview',
        transport: 'rest' as const,
        endpoint: 'https://agents.example.com/api/ucp',
        schema: 'https://ucp.dev/services/shopping/mcp.openrpc.json',
      },
    ],
  },
  payment_handlers: {
    'com.agentscore.payment.tempo': [
      {
        id: 'tempo',
        version: '2026-04-08',
        spec: 'https://www.agentscore.com/specification/payment-handlers/tempo',
        schema: 'https://www.agentscore.com/schemas/payment-handlers/tempo.json',
        config: { recipient: '0x1234' },
      },
    ],
  },
};

describe('UCP signing — generateUCPSigningKey', () => {
  it('generates an Ed25519 keypair by default', async () => {
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'test-key-1' });
    expect(privateKey).toBeDefined();
    expect(publicJWK.kid).toBe('test-key-1');
    expect(publicJWK.alg).toBe('EdDSA');
    expect(publicJWK.use).toBe('sig');
    expect(publicJWK.kty).toBe('OKP');
    expect(publicJWK.crv).toBe('Ed25519');
    expect(typeof (publicJWK as Record<string, unknown>).x).toBe('string');
  });

  it('generates an ES256 keypair when alg=ES256', async () => {
    const { publicJWK } = await generateUCPSigningKey({ kid: 'test-es256', alg: 'ES256' });
    expect(publicJWK.alg).toBe('ES256');
    expect(publicJWK.kty).toBe('EC');
    expect(publicJWK.crv).toBe('P-256');
    expect(typeof (publicJWK as Record<string, unknown>).x).toBe('string');
    expect(typeof (publicJWK as Record<string, unknown>).y).toBe('string');
  });

  it('produces a different kid + key material on each call', async () => {
    const a = await generateUCPSigningKey({ kid: 'a' });
    const b = await generateUCPSigningKey({ kid: 'b' });
    expect(a.publicJWK.kid).toBe('a');
    expect(b.publicJWK.kid).toBe('b');
    expect((a.publicJWK as Record<string, unknown>).x).not.toBe((b.publicJWK as Record<string, unknown>).x);
  });
});

describe('UCP signing — signUCPProfile / verifyUCPProfile round-trip', () => {
  it('signs an Ed25519-keyed profile and verifies against the matching JWKS', async () => {
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'merchant-2026-05' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    const signed = await signUCPProfile(profile, { signingKey: privateKey, kid: 'merchant-2026-05' });

    expect(signed.signature).toBeDefined();
    expect(typeof signed.signature).toBe('string');
    expect(signed.signature.split('.')).toHaveLength(3); // JWS Compact has 3 segments

    const ok = await verifyUCPProfile(signed, buildJWKSResponse([publicJWK]));
    expect(ok).toBe(true);
  });

  it('signs an ES256-keyed profile and verifies', async () => {
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'es256-key', alg: 'ES256' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    const signed = await signUCPProfile(profile, { signingKey: privateKey, kid: 'es256-key', alg: 'ES256' });

    const ok = await verifyUCPProfile(signed, buildJWKSResponse([publicJWK]));
    expect(ok).toBe(true);
  });

  it('verifies against a multi-key JWKS (selects by kid)', async () => {
    const oldKey = await generateUCPSigningKey({ kid: 'old-key' });
    const newKey = await generateUCPSigningKey({ kid: 'new-key' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [oldKey.publicJWK, newKey.publicJWK] });
    const signed = await signUCPProfile(profile, { signingKey: newKey.privateKey, kid: 'new-key' });

    const ok = await verifyUCPProfile(signed, buildJWKSResponse([oldKey.publicJWK, newKey.publicJWK]));
    expect(ok).toBe(true);
  });

  it('rejects a tampered profile body', async () => {
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'k' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    const signed = await signUCPProfile(profile, { signingKey: privateKey, kid: 'k' });

    const tampered = { ...signed, name: 'Different Name' };
    await expect(verifyUCPProfile(tampered, buildJWKSResponse([publicJWK]))).rejects.toThrow();
  });

  it('rejects when JWKS does not contain the signing key', async () => {
    const signer = await generateUCPSigningKey({ kid: 'signer' });
    const other = await generateUCPSigningKey({ kid: 'other' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [signer.publicJWK] });
    const signed = await signUCPProfile(profile, { signingKey: signer.privateKey, kid: 'signer' });

    await expect(verifyUCPProfile(signed, buildJWKSResponse([other.publicJWK]))).rejects.toThrow(/No JWK in JWKS/);
  });

  it('rejects when profile has no signature field', async () => {
    const { publicJWK } = await generateUCPSigningKey({ kid: 'k' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    await expect(
      verifyUCPProfile(profile as unknown as Awaited<ReturnType<typeof signUCPProfile>>, buildJWKSResponse([publicJWK])),
    ).rejects.toMatchObject({ name: 'UCPVerificationError', code: 'no_signature' });
  });
});

describe('UCP signing — canonicalization', () => {
  it('signs the profile such that key-order in the JSON does not affect verification', async () => {
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'k' });
    const profileA = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    const signed = await signUCPProfile(profileA, { signingKey: privateKey, kid: 'k' });

    // Hand-construct the same profile with keys in REVERSE insertion order so
    // canonicalization actually has work to do. JSON.parse(JSON.stringify(x))
    // preserves the source order, which is a vacuous round-trip — this version
    // genuinely re-orders.
    const reordered: Record<string, unknown> = {};
    const sortedKeys = Object.keys(signed).sort().reverse();
    for (const k of sortedKeys) reordered[k] = (signed as Record<string, unknown>)[k];
    expect(Object.keys(reordered)[0]).not.toBe(Object.keys(signed).sort()[0]); // sanity: order really differs
    const ok = await verifyUCPProfile(reordered as never, buildJWKSResponse([publicJWK]));
    expect(ok).toBe(true);
  });
});

describe('UCP signing — buildJWKSResponse', () => {
  it('wraps keys in a `{ keys: [...] }` document', () => {
    const k1 = { kid: 'a', kty: 'OKP', crv: 'Ed25519', x: 'xxx', use: 'sig', alg: 'EdDSA' };
    const k2 = { kid: 'b', kty: 'EC', crv: 'P-256', x: 'xxx', y: 'yyy', use: 'sig', alg: 'ES256' };
    const jwks = buildJWKSResponse([k1, k2]);
    expect(jwks).toEqual({ keys: [k1, k2] });
  });

  it('handles empty key set', () => {
    expect(buildJWKSResponse([])).toEqual({ keys: [] });
  });
});

describe('UCP signing — security: alg-confusion + typ + dup-kid', () => {
  // RFC 8725 §3.1: a verifier MUST restrict accepted JWS algorithms to the
  // set the application expects. A naive implementation that calls importJWK(jwk, header.alg)
  // can be coerced into using HS256 (symmetric) with the public key as the secret —
  // a hostile signing_keys[] entry then mints valid-looking signatures.
  it('rejects HS256 signatures even when the JWKS contains an HS256 oct key', async () => {
    const jose = await import('jose');
    const sharedSecret = new Uint8Array(32).fill(0xab);
    const ocJwk = {
      kid: 'attacker',
      kty: 'oct',
      alg: 'HS256',
      use: 'sig',
      k: Buffer.from(sharedSecret).toString('base64url'),
    };
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [ocJwk as never] });
    const stripped = { ...profile } as Record<string, unknown>;
    delete stripped.signature;
    const sortedJson = (() => {
      const sort = (v: unknown): unknown => {
        if (v === null || typeof v !== 'object') return v;
        if (Array.isArray(v)) return v.map(sort);
        return Object.keys(v as Record<string, unknown>).sort().reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = sort((v as Record<string, unknown>)[k]);
          return acc;
        }, {});
      };
      return JSON.stringify(sort(stripped));
    })();
    const evilSig = await new jose.CompactSign(new TextEncoder().encode(sortedJson))
      .setProtectedHeader({ alg: 'HS256', kid: 'attacker', typ: 'agentscore-profile+jws' })
      .sign(sharedSecret);
    const tampered = { ...profile, signature: evilSig };
    await expect(verifyUCPProfile(tampered as never, buildJWKSResponse([ocJwk as never])))
      .rejects.toThrow(UCPVerificationError);
  });

  it('rejects a JWS with typ != "agentscore-profile+jws"', async () => {
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'k' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    const jose = await import('jose');
    const stripped = { ...profile } as Record<string, unknown>;
    delete stripped.signature;
    const sortedJson = (() => {
      const sort = (v: unknown): unknown => {
        if (v === null || typeof v !== 'object') return v;
        if (Array.isArray(v)) return v.map(sort);
        return Object.keys(v as Record<string, unknown>).sort().reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = sort((v as Record<string, unknown>)[k]);
          return acc;
        }, {});
      };
      return JSON.stringify(sort(stripped));
    })();
    const wrongTypSig = await new jose.CompactSign(new TextEncoder().encode(sortedJson))
      .setProtectedHeader({ alg: 'EdDSA', kid: 'k', typ: 'JWT' })
      .sign(privateKey as Parameters<typeof jose.CompactSign.prototype.sign>[0]);
    await expect(
      verifyUCPProfile({ ...profile, signature: wrongTypSig } as never, buildJWKSResponse([publicJWK])),
    ).rejects.toThrow(/typ/);
  });

  it('rejects duplicate kids in the JWKS', async () => {
    const a = await generateUCPSigningKey({ kid: 'dup' });
    const b = await generateUCPSigningKey({ kid: 'dup' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [a.publicJWK] });
    const signed = await signUCPProfile(profile, { signingKey: a.privateKey, kid: 'dup' });
    await expect(verifyUCPProfile(signed, buildJWKSResponse([a.publicJWK, b.publicJWK])))
      .rejects.toThrow(/duplicate|2 keys/);
  });

  it('emits typed UCPVerificationError for body mismatch', async () => {
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'k' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    const signed = await signUCPProfile(profile, { signingKey: privateKey, kid: 'k' });
    const tampered = { ...signed, name: 'Different' };
    await expect(verifyUCPProfile(tampered, buildJWKSResponse([publicJWK])))
      .rejects.toMatchObject({ name: 'UCPVerificationError', code: 'body_mismatch' });
  });

  it('emits typed UCPVerificationError for missing signature', async () => {
    const { publicJWK } = await generateUCPSigningKey({ kid: 'k' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    await expect(verifyUCPProfile(profile as never, buildJWKSResponse([publicJWK])))
      .rejects.toMatchObject({ name: 'UCPVerificationError', code: 'no_signature' });
  });

  it('emits typed UCPVerificationError for kid not in JWKS', async () => {
    const signer = await generateUCPSigningKey({ kid: 'signer' });
    const other = await generateUCPSigningKey({ kid: 'other' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [signer.publicJWK] });
    const signed = await signUCPProfile(profile, { signingKey: signer.privateKey, kid: 'signer' });
    await expect(verifyUCPProfile(signed, buildJWKSResponse([other.publicJWK])))
      .rejects.toMatchObject({ name: 'UCPVerificationError', code: 'kid_not_found' });
  });

  it('rejects malformed JWS (not three segments)', async () => {
    const { publicJWK } = await generateUCPSigningKey({ kid: 'k' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    const garbage = { ...profile, signature: 'not.a.jws' };
    await expect(verifyUCPProfile(garbage as never, buildJWKSResponse([publicJWK])))
      .rejects.toThrow();
  });

  it('rejects a tampered signature segment with valid header+payload', async () => {
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'k' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    const signed = await signUCPProfile(profile, { signingKey: privateKey, kid: 'k' });
    const segments = signed.signature.split('.');
    // Flip a char near the start of the signature segment (NOT the last char,
    // which is partial padding bits and may not affect the decoded signature).
    const sig = segments[2]!;
    const flippedChar = sig[0] === 'A' ? 'B' : 'A';
    const flipped = flippedChar + sig.slice(1);
    const tampered = { ...signed, signature: `${segments[0]}.${segments[1]}.${flipped}` };
    // JWSSignatureVerificationFailed → wraps to signature_invalid (line 465-466 in ucp-jwks.ts).
    await expect(verifyUCPProfile(tampered, buildJWKSResponse([publicJWK])))
      .rejects.toMatchObject({ name: 'UCPVerificationError', code: 'signature_invalid' });
  });


  it('signing twice with EdDSA is idempotent (deterministic signature)', async () => {
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'k' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    const a = await signUCPProfile(profile, { signingKey: privateKey, kid: 'k' });
    const b = await signUCPProfile(profile, { signingKey: privateKey, kid: 'k' });
    expect(a.signature).toBe(b.signature);
  });

  it('signing twice with ES256 produces different signatures but both verify', async () => {
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'k', alg: 'ES256' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    const a = await signUCPProfile(profile, { signingKey: privateKey, kid: 'k', alg: 'ES256' });
    const b = await signUCPProfile(profile, { signingKey: privateKey, kid: 'k', alg: 'ES256' });
    expect(a.signature).not.toBe(b.signature);
    expect(await verifyUCPProfile(a, buildJWKSResponse([publicJWK]))).toBe(true);
    expect(await verifyUCPProfile(b, buildJWKSResponse([publicJWK]))).toBe(true);
  });
});

describe('UCP signing — float canonicalization defense', () => {
  it('throws when signing a profile that contains a non-integer Number anywhere', async () => {
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'k' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    (profile as unknown as Record<string, unknown>).extras = { rate: 0.0125 };
    await expect(signUCPProfile(profile, { signingKey: privateKey, kid: 'k' }))
      .rejects.toThrow(/non-integer Number/);
  });

  it('throws on NaN / Infinity', async () => {
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'k' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    (profile as unknown as Record<string, unknown>).extras = { value: Number.POSITIVE_INFINITY };
    await expect(signUCPProfile(profile, { signingKey: privateKey, kid: 'k' }))
      .rejects.toThrow(/non-finite Number/);
  });

  it('signing with integers + strings is fine', async () => {
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'k' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    (profile as unknown as Record<string, unknown>).extras = { count: 7, label: 'wine' };
    const signed = await signUCPProfile(profile, { signingKey: privateKey, kid: 'k' });
    expect(await verifyUCPProfile(signed, buildJWKSResponse([publicJWK]))).toBe(true);
  });
});

describe('UCP signing — additional hardening', () => {
  it('signUCPProfile throws when kid is not in profile.signing_keys[]', async () => {
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'real' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    await expect(signUCPProfile(profile, { signingKey: privateKey, kid: 'wrong' }))
      .rejects.toThrow(/not present in profile.signing_keys/);
  });

  it('verifyUCPProfile rejects malformed JWKS shape (missing keys array)', async () => {
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'k' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    const signed = await signUCPProfile(profile, { signingKey: privateKey, kid: 'k' });
    await expect(verifyUCPProfile(signed, {} as never))
      .rejects.toMatchObject({ name: 'UCPVerificationError', code: 'malformed_jwks' });
  });

  it('verifyUCPProfile rejects null JWKS', async () => {
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'k' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    const signed = await signUCPProfile(profile, { signingKey: privateKey, kid: 'k' });
    await expect(verifyUCPProfile(signed, null as never))
      .rejects.toMatchObject({ name: 'UCPVerificationError', code: 'malformed_jwks' });
  });

  it('verifyUCPProfile rejects JWKS where keys is not an array', async () => {
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'k' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    const signed = await signUCPProfile(profile, { signingKey: privateKey, kid: 'k' });
    await expect(verifyUCPProfile(signed, { keys: 'not-an-array' } as never))
      .rejects.toMatchObject({ name: 'UCPVerificationError', code: 'malformed_jwks' });
  });

  it('verifyUCPProfile wraps unrecognized critical header into typed error', async () => {
    const { generateUCPSigningKey, buildJWKSResponse, verifyUCPProfile } = await import('../../src/identity/ucp-jwks');
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'k' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });

    // Hand-craft a JWS with a critical header that the verifier doesn't recognize.
    const { base64url } = await import('jose');
    const { sign } = await import('node:crypto');
    function ss(v: unknown): string {
      if (v === null || typeof v !== 'object') return JSON.stringify(v);
      if (Array.isArray(v)) return `[${v.map(ss).join(',')}]`;
      const o = v as Record<string, unknown>;
      return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${ss(o[k])}`).join(',')}}`;
    }
    const canonical = ss(profile);
    const headerJson = JSON.stringify({ alg: 'EdDSA', kid: 'k', typ: 'agentscore-profile+jws', crit: ['fakething'], fakething: 'x' });
    const headerB64 = base64url.encode(new TextEncoder().encode(headerJson));
    const payloadB64 = base64url.encode(new TextEncoder().encode(canonical));
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const sigBytes = sign(null, data, privateKey as Parameters<typeof sign>[2]);
    const sigB64 = base64url.encode(sigBytes);
    const jws = `${headerB64}.${payloadB64}.${sigB64}`;
    const signed = { ...profile, signature: jws };

    await expect(verifyUCPProfile(signed as never, buildJWKSResponse([publicJWK])))
      .rejects.toMatchObject({ name: 'UCPVerificationError', code: 'unrecognized_critical_header' });
  });

  it('wraps a jose JWSInvalid (valid header, structurally broken compact JWS) into malformed_jws', async () => {
    const { generateUCPSigningKey, buildJWKSResponse, verifyUCPProfile } = await import('../../src/identity/ucp-jwks');
    const { publicJWK } = await generateUCPSigningKey({ kid: 'k' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });

    const { base64url } = await import('jose');
    // Valid protected header (passes the typ/alg/kid pre-checks), but the JWS has
    // only two segments after it — jose's compactVerify rejects with JWSInvalid,
    // which the inner catch wraps to malformed_jws (distinct from the pre-decode
    // header check that fires for an unparseable header segment).
    const headerJson = JSON.stringify({ alg: 'EdDSA', kid: 'k', typ: 'agentscore-profile+jws' });
    const headerB64 = base64url.encode(new TextEncoder().encode(headerJson));
    // Two segments only (header.payload) — not a valid compact JWS (needs three).
    const jws = `${headerB64}.${base64url.encode(new TextEncoder().encode('{}'))}`;
    const signed = { ...profile, signature: jws };

    await expect(verifyUCPProfile(signed as never, buildJWKSResponse([publicJWK])))
      .rejects.toMatchObject({ name: 'UCPVerificationError', code: 'malformed_jws' });
  });

  // RFC 7515 §4.1.11: crit MUST be a non-empty array of strings if present.
  // The four cases below mirror python-commerce's malformed_jws parity tests so
  // a malformed crit shape never silently falls through to the unrecognized
  // branch (or worse, gets accepted) on either SDK.
  it.each([
    { label: 'null', crit: null as unknown },
    { label: 'empty array', crit: [] as unknown },
    { label: 'string (not array)', crit: 'fakething' as unknown },
    { label: 'array with non-string element', crit: [42] as unknown },
  ])('verifyUCPProfile rejects malformed crit ($label) with malformed_jws', async ({ crit }) => {
    const { generateUCPSigningKey, buildJWKSResponse, verifyUCPProfile } = await import('../../src/identity/ucp-jwks');
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'k' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });

    const { base64url } = await import('jose');
    const { sign } = await import('node:crypto');
    function ss(v: unknown): string {
      if (v === null || typeof v !== 'object') return JSON.stringify(v);
      if (Array.isArray(v)) return `[${v.map(ss).join(',')}]`;
      const o = v as Record<string, unknown>;
      return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${ss(o[k])}`).join(',')}}`;
    }
    const canonical = ss(profile);
    const headerJson = JSON.stringify({ alg: 'EdDSA', kid: 'k', typ: 'agentscore-profile+jws', crit });
    const headerB64 = base64url.encode(new TextEncoder().encode(headerJson));
    const payloadB64 = base64url.encode(new TextEncoder().encode(canonical));
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const sigBytes = sign(null, data, privateKey as Parameters<typeof sign>[2]);
    const sigB64 = base64url.encode(sigBytes);
    const jws = `${headerB64}.${payloadB64}.${sigB64}`;
    const signed = { ...profile, signature: jws };

    await expect(verifyUCPProfile(signed as never, buildJWKSResponse([publicJWK])))
      .rejects.toMatchObject({ name: 'UCPVerificationError', code: 'malformed_jws' });
  });
});

describe('UCPSigningKey.fromJWK', () => {
  it('round-trips an EdDSA public JWK from generateUCPSigningKey', async () => {
    const { publicJWK } = await generateUCPSigningKey({ kid: 'rt-eddsa', alg: 'EdDSA' });
    const result = UCPSigningKey.fromJWK(publicJWK as Record<string, unknown>);
    const r = result as Record<string, unknown>;
    expect(r.kid).toBe('rt-eddsa');
    expect(r.kty).toBe('OKP');
    expect(r.crv).toBe('Ed25519');
    expect(r.alg).toBe('EdDSA');
    expect(r.use).toBe('sig');
    expect(typeof r.x).toBe('string');
  });

  it('round-trips an ES256 public JWK from generateUCPSigningKey', async () => {
    const { publicJWK } = await generateUCPSigningKey({ kid: 'rt-es256', alg: 'ES256' });
    const result = UCPSigningKey.fromJWK(publicJWK as Record<string, unknown>);
    const r = result as Record<string, unknown>;
    expect(r.kid).toBe('rt-es256');
    expect(r.kty).toBe('EC');
    expect(r.crv).toBe('P-256');
    expect(r.alg).toBe('ES256');
    expect(r.use).toBe('sig');
    expect(typeof r.x).toBe('string');
    expect(typeof r.y).toBe('string');
  });

  it('rejects symmetric oct keys', () => {
    expect(() =>
      UCPSigningKey.fromJWK({ kid: 'k', kty: 'oct', k: 'AAAA' }),
    ).toThrow(/asymmetric/i);
  });

  it('rejects JWK missing kid', () => {
    expect(() => UCPSigningKey.fromJWK({ kty: 'OKP' })).toThrow(/kid/);
  });

  it('rejects JWK missing kty', () => {
    expect(() => UCPSigningKey.fromJWK({ kid: 'k' })).toThrow(/kty/);
  });

  it('rejects non-object inputs', () => {
    expect(() => UCPSigningKey.fromJWK(null as never)).toThrow();
    expect(() => UCPSigningKey.fromJWK('string' as never)).toThrow();
    expect(() => UCPSigningKey.fromJWK(42 as never)).toThrow();
  });

  it('rejects EC JWK missing crv', () => {
    expect(() => UCPSigningKey.fromJWK({ kid: 'k', kty: 'EC' })).toThrow(/crv/);
  });

  it('rejects OKP JWK with empty crv', () => {
    expect(() => UCPSigningKey.fromJWK({ kid: 'k', kty: 'OKP', crv: '' })).toThrow(/crv/);
  });
});

describe('UCP signing — JCS-incompatible value rejection', () => {
  // Probe the internal stableStringify by signing a profile that holds the
  // offending value. The signer canonicalizes via stableStringify, so any
  // rejection there bubbles up through signUCPProfile.
  async function signWith(extras: unknown): Promise<void> {
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'k' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    (profile as unknown as Record<string, unknown>).extras = extras;
    await signUCPProfile(profile, { signingKey: privateKey, kid: 'k' });
  }

  it('rejects undefined values in objects', async () => {
    await expect(signWith({ a: undefined })).rejects.toThrow(/undefined values are not allowed/);
  });

  it('rejects undefined values inside arrays', async () => {
    await expect(signWith([1, undefined, 3])).rejects.toThrow(/undefined values are not allowed/);
  });

  it('rejects function values', async () => {
    await expect(signWith({ a: () => {} })).rejects.toThrow(/function values are not allowed/);
  });

  it('rejects Symbol values', async () => {
    await expect(signWith({ a: Symbol('x') })).rejects.toThrow(/symbol values are not allowed/);
  });

  it('rejects Date instances', async () => {
    await expect(signWith({ a: new Date() })).rejects.toThrow(/Date instances are not allowed/);
  });

  it('rejects BigInt values', async () => {
    await expect(signWith({ a: 1n })).rejects.toThrow(/BigInt values are not allowed/);
  });

  it('rejects Map values', async () => {
    await expect(signWith({ a: new Map([['x', 1]]) })).rejects.toThrow(/Map values are not allowed/);
  });

  it('rejects Set values', async () => {
    await expect(signWith({ a: new Set([1, 2]) })).rejects.toThrow(/Set values are not allowed/);
  });

  it('rejects WeakMap values', async () => {
    await expect(signWith({ a: new WeakMap() })).rejects.toThrow(/WeakMap values are not allowed/);
  });

  it('rejects WeakSet values', async () => {
    await expect(signWith({ a: new WeakSet() })).rejects.toThrow(/WeakSet values are not allowed/);
  });

  it('rejects typed arrays (Uint8Array)', async () => {
    await expect(signWith({ a: new Uint8Array([1, 2, 3]) })).rejects.toThrow(/typed arrays are not allowed/);
  });

  it('rejects typed arrays (Int32Array)', async () => {
    await expect(signWith({ a: new Int32Array([1, 2, 3]) })).rejects.toThrow(/typed arrays are not allowed/);
  });
});

describe('UCP signing — integer overflow defense', () => {
  async function signWith(extras: unknown): Promise<Awaited<ReturnType<typeof signUCPProfile>>> {
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'k' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    (profile as unknown as Record<string, unknown>).extras = extras;
    return signUCPProfile(profile, { signingKey: privateKey, kid: 'k' });
  }

  it('accepts Number.MAX_SAFE_INTEGER (2^53 - 1)', async () => {
    await expect(signWith({ n: 9007199254740991 })).resolves.toBeDefined();
  });

  it('rejects 2^53 (boundary, ambiguous in IEEE 754)', async () => {
    await expect(signWith({ n: 9007199254740992 })).rejects.toThrow(/MAX_SAFE_INTEGER/);
  });

  it('rejects 2^60 as lossy (well above MAX_SAFE_INTEGER, distinct float from 2^53)', async () => {
    await expect(signWith({ n: 2 ** 60 })).rejects.toThrow(/MAX_SAFE_INTEGER/);
  });

  it('rejects -(2^60) as lossy', async () => {
    await expect(signWith({ n: -(2 ** 60) })).rejects.toThrow(/MAX_SAFE_INTEGER/);
  });

  it('accepts Number.MAX_SAFE_INTEGER', async () => {
    await expect(signWith({ n: Number.MAX_SAFE_INTEGER })).resolves.toBeDefined();
  });

  it('rejects Number.MAX_SAFE_INTEGER + 1', async () => {
    await expect(signWith({ n: Number.MAX_SAFE_INTEGER + 1 })).rejects.toThrow(/MAX_SAFE_INTEGER/);
  });
});

describe('UCP signing — JWK alg / header alg consistency', () => {
  it('rejects when matched JWK alg does not match JWS header alg', async () => {
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'mismatch', alg: 'EdDSA' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    const signed = await signUCPProfile(profile, { signingKey: privateKey, kid: 'mismatch', alg: 'EdDSA' });
    const lyingJWK = { ...(publicJWK as Record<string, unknown>), alg: 'ES256' };
    const badJWKS = { keys: [lyingJWK] };
    await expect(verifyUCPProfile(signed, badJWKS as never))
      .rejects.toMatchObject({ name: 'UCPVerificationError', code: 'unusable_key' });
  });
});

describe('UCP signing — round-4 hardening', () => {
  it('rejects a JWK with use=enc as unusable_key', async () => {
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'enc-key', alg: 'EdDSA' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    const signed = await signUCPProfile(profile, { signingKey: privateKey, kid: 'enc-key', alg: 'EdDSA' });
    const badJWKS = { keys: [{ ...(publicJWK as Record<string, unknown>), use: 'enc' }] };
    await expect(verifyUCPProfile(signed, badJWKS as never))
      .rejects.toMatchObject({ name: 'UCPVerificationError', code: 'unusable_key' });
  });

  it('rejects non-string signature values with no_signature', async () => {
    const { publicJWK } = await generateUCPSigningKey({ kid: 'k' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    for (const badSig of [42, null, [], {}]) {
      const tampered = { ...profile, signature: badSig as unknown as string };
      await expect(verifyUCPProfile(tampered as never, buildJWKSResponse([publicJWK])))
        .rejects.toMatchObject({ name: 'UCPVerificationError', code: 'no_signature' });
    }
  });

  it('returns kid_not_found when JWKS contains a null entry', async () => {
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'real' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    const signed = await signUCPProfile(profile, { signingKey: privateKey, kid: 'real' });
    const badJWKS = { keys: [null] };
    await expect(verifyUCPProfile(signed, badJWKS as never))
      .rejects.toMatchObject({ name: 'UCPVerificationError', code: 'kid_not_found' });
  });

  it('returns kid_not_found when JWKS contains a string entry', async () => {
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'real' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    const signed = await signUCPProfile(profile, { signingKey: privateKey, kid: 'real' });
    const badJWKS = { keys: ['string-not-jwk'] };
    await expect(verifyUCPProfile(signed, badJWKS as never))
      .rejects.toMatchObject({ name: 'UCPVerificationError', code: 'kid_not_found' });
  });

  it('rejects a JWS whose protected header decodes to a JSON array', async () => {
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'k' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    const { base64url } = await import('jose');
    const { sign } = await import('node:crypto');

    function ss(v: unknown): string {
      if (v === null || typeof v !== 'object') return JSON.stringify(v);
      if (Array.isArray(v)) return `[${v.map(ss).join(',')}]`;
      const o = v as Record<string, unknown>;
      return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${ss(o[k])}`).join(',')}}`;
    }
    const canonical = ss(profile);

    const headerJson = JSON.stringify(['EdDSA', 'kid-x']);
    const headerB64 = base64url.encode(new TextEncoder().encode(headerJson));
    const payloadB64 = base64url.encode(new TextEncoder().encode(canonical));
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const sigBytes = sign(null, data, privateKey as Parameters<typeof sign>[2]);
    const sigB64 = base64url.encode(sigBytes);
    const jws = `${headerB64}.${payloadB64}.${sigB64}`;
    const signed = { ...profile, signature: jws };

    await expect(verifyUCPProfile(signed as never, buildJWKSResponse([publicJWK])))
      .rejects.toBeInstanceOf(UCPVerificationError);
  });
});

describe('UCP signing — verifier-side canonicalize must not leak raw Error', () => {
  async function makeSigned(): Promise<{
    signed: Awaited<ReturnType<typeof signUCPProfile>>;
    jwks: ReturnType<typeof buildJWKSResponse>;
  }> {
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'k' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    const signed = await signUCPProfile(profile, { signingKey: privateKey, kid: 'k' });
    return { signed, jwks: buildJWKSResponse([publicJWK]) };
  }

  it('emits typed body_mismatch when received profile carries a non-integer Number', async () => {
    const { signed, jwks } = await makeSigned();
    const tampered = { ...signed, extras: { n: 1.5 } } as unknown as typeof signed;
    await expect(verifyUCPProfile(tampered, jwks))
      .rejects.toMatchObject({ name: 'UCPVerificationError', code: 'body_mismatch' });
  });

  it('emits typed body_mismatch when received profile carries an unsafe-large Number', async () => {
    const { signed, jwks } = await makeSigned();
    const tampered = { ...signed, extras: { n: Number.MAX_SAFE_INTEGER + 1 } } as unknown as typeof signed;
    await expect(verifyUCPProfile(tampered, jwks))
      .rejects.toMatchObject({ name: 'UCPVerificationError', code: 'body_mismatch' });
  });

  it('emits typed body_mismatch when received profile carries NaN', async () => {
    const { signed, jwks } = await makeSigned();
    const tampered = { ...signed, extras: { n: NaN } } as unknown as typeof signed;
    await expect(verifyUCPProfile(tampered, jwks))
      .rejects.toMatchObject({ name: 'UCPVerificationError', code: 'body_mismatch' });
  });

  it('emits typed body_mismatch when received profile carries Infinity', async () => {
    const { signed, jwks } = await makeSigned();
    const tampered = { ...signed, extras: { n: Infinity } } as unknown as typeof signed;
    await expect(verifyUCPProfile(tampered, jwks))
      .rejects.toMatchObject({ name: 'UCPVerificationError', code: 'body_mismatch' });
  });

  it('emits typed body_mismatch when received profile carries a BigInt', async () => {
    const { signed, jwks } = await makeSigned();
    const tampered = { ...signed, extras: { n: 1n } } as unknown as typeof signed;
    await expect(verifyUCPProfile(tampered, jwks))
      .rejects.toMatchObject({ name: 'UCPVerificationError', code: 'body_mismatch' });
  });
});

describe('UCP signing — error precedence parity (profile-first)', () => {
  it('null profile + malformed JWKS returns no_signature (profile-first)', async () => {
    await expect(verifyUCPProfile(null as never, 'not a jwks' as never))
      .rejects.toMatchObject({ name: 'UCPVerificationError', code: 'no_signature' });
  });

  it('mixed body-malformed + wrong-typ JWS emits wrong_typ (header-first like Python)', async () => {
    // Build a profile, sign it with the wrong typ (typ="JWT" instead of
    // agentscore-profile+jws) so header validation rejects, then mutate the body
    // to also carry a non-integer Number that would fail canonicalize. The
    // verifier must surface `wrong_typ` (header-first), matching the Python
    // sibling's _peek_jws_header order.
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'k' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    const jose = await import('jose');
    const stripped = { ...profile } as Record<string, unknown>;
    delete stripped.signature;
    const sortedJson = (() => {
      const sort = (v: unknown): unknown => {
        if (v === null || typeof v !== 'object') return v;
        if (Array.isArray(v)) return v.map(sort);
        return Object.keys(v as Record<string, unknown>).sort().reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = sort((v as Record<string, unknown>)[k]);
          return acc;
        }, {});
      };
      return JSON.stringify(sort(stripped));
    })();
    const wrongTypSig = await new jose.CompactSign(new TextEncoder().encode(sortedJson))
      .setProtectedHeader({ alg: 'EdDSA', kid: 'k', typ: 'JWT' })
      .sign(privateKey as Parameters<typeof jose.CompactSign.prototype.sign>[0]);
    const tampered = { ...profile, signature: wrongTypSig, extras: { rate: 1.5 } } as never;
    await expect(verifyUCPProfile(tampered, buildJWKSResponse([publicJWK])))
      .rejects.toMatchObject({ name: 'UCPVerificationError', code: 'wrong_typ' });
  });

  it('mixed alg=HS256 + typ=JWT JWS emits wrong_typ (typ-first like Python)', async () => {
    // Hand-craft a JWS whose protected header carries BOTH a wrong typ
    // ("JWT") AND a disallowed alg ("HS256"). Python's _peek_jws_header
    // checks typ before alg, so it surfaces wrong_typ; Node must do the
    // same so cross-SDK error codes stay aligned for any caller routing
    // on `code`.
    const jose = await import('jose');
    const { publicJWK } = await generateUCPSigningKey({ kid: 'k' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    const stripped = { ...profile } as Record<string, unknown>;
    delete stripped.signature;
    const sortedJson = (() => {
      const sort = (v: unknown): unknown => {
        if (v === null || typeof v !== 'object') return v;
        if (Array.isArray(v)) return v.map(sort);
        return Object.keys(v as Record<string, unknown>).sort().reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = sort((v as Record<string, unknown>)[k]);
          return acc;
        }, {});
      };
      return JSON.stringify(sort(stripped));
    })();
    const sharedSecret = new Uint8Array(32).fill(0xab);
    const mixedSig = await new jose.CompactSign(new TextEncoder().encode(sortedJson))
      .setProtectedHeader({ alg: 'HS256', kid: 'k', typ: 'JWT' })
      .sign(sharedSecret);
    await expect(
      verifyUCPProfile({ ...profile, signature: mixedSig } as never, buildJWKSResponse([publicJWK])),
    ).rejects.toMatchObject({ name: 'UCPVerificationError', code: 'wrong_typ' });
  });

  it('mixed crit + wrong typ JWS emits wrong_typ (typ-first like Python)', async () => {
    // Hand-craft a JWS whose protected header carries BOTH a wrong typ ("JWT")
    // AND an unrecognized crit header ("fakething"). jose's compactVerify
    // enforces `crit` BEFORE invoking the key-resolver callback, so without
    // the pre-decode pass this would surface `unrecognized_critical_header`.
    // Python's _peek_jws_header decodes manually and checks typ first; Node
    // mirrors that ordering so the same input emits the same `code` in both
    // SDKs.
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'real' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    const { base64url } = await import('jose');
    const { sign } = await import('node:crypto');
    function ss(v: unknown): string {
      if (v === null || typeof v !== 'object') return JSON.stringify(v);
      if (Array.isArray(v)) return `[${v.map(ss).join(',')}]`;
      const o = v as Record<string, unknown>;
      return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${ss(o[k])}`).join(',')}}`;
    }
    const canonical = ss(profile);
    const headerJson = JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: 'real', crit: ['fakething'], fakething: 'x' });
    const headerB64 = base64url.encode(new TextEncoder().encode(headerJson));
    const payloadB64 = base64url.encode(new TextEncoder().encode(canonical));
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const sigBytes = sign(null, data, privateKey as Parameters<typeof sign>[2]);
    const sigB64 = base64url.encode(sigBytes);
    const jws = `${headerB64}.${payloadB64}.${sigB64}`;
    const signed = { ...profile, signature: jws };

    await expect(verifyUCPProfile(signed as never, buildJWKSResponse([publicJWK])))
      .rejects.toMatchObject({ name: 'UCPVerificationError', code: 'wrong_typ' });
  });
});

describe('UCP signing — U+2028 / U+2029 rejection', () => {
  // Modern V8 emits U+2028 / U+2029 raw from JSON.stringify, so on today's Node
  // the divergence with Python json.dumps(ensure_ascii=False) is theoretical.
  // The rejection mirrors core/api/src/lib/canonicalize.ts so the contract
  // stays symmetric for any pre-ES2019 verifier (older V8, browser-side
  // verifier code) where JSON.stringify still escapes these codepoints.
  async function signWith(extras: unknown): Promise<void> {
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'k' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    (profile as unknown as Record<string, unknown>).extras = extras;
    await signUCPProfile(profile, { signingKey: privateKey, kid: 'k' });
  }

  it('rejects strings containing U+2028 (LINE SEPARATOR) at top level', async () => {
    await expect(signWith({ note: 'before after' }))
      .rejects.toThrow(/U\+2028/);
  });

  it('rejects strings containing U+2029 (PARAGRAPH SEPARATOR) at top level', async () => {
    await expect(signWith({ note: 'before after' }))
      .rejects.toThrow(/U\+2029/);
  });

  it('rejects U+2028 nested inside an array', async () => {
    await expect(signWith({ items: ['ok', 'bad tail'] }))
      .rejects.toThrow(/U\+2028/);
  });

  it('rejects U+2029 nested inside an array', async () => {
    await expect(signWith({ items: ['ok', 'bad tail'] }))
      .rejects.toThrow(/U\+2029/);
  });

  it('rejects U+2028 nested inside an object value', async () => {
    await expect(signWith({ deep: { inner: 'before after' } }))
      .rejects.toThrow(/U\+2028/);
  });

  it('rejects U+2029 nested inside an object value', async () => {
    await expect(signWith({ deep: { inner: 'before after' } }))
      .rejects.toThrow(/U\+2029/);
  });

  it('accepts U+2027 (HYPHENATION POINT) as sanity case — different codepoint, not a target', async () => {
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'k' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    (profile as unknown as Record<string, unknown>).extras = { note: 'before‧after' };
    const signed = await signUCPProfile(profile, { signingKey: privateKey, kid: 'k' });
    expect(await verifyUCPProfile(signed, buildJWKSResponse([publicJWK]))).toBe(true);
  });

  // Object-key rejection: same cross-language byte-parity rationale as the
  // value-side rejection above. Python's _reject_unsafe_numbers recurses into
  // dict keys, so a Node-signed profile with U+2028 / U+2029 in an object key
  // would canonicalize cleanly here but throw body_mismatch on Python verify.
  it('rejects an object key containing U+2028 (LINE SEPARATOR)', async () => {
    await expect(signWith({ 'bad key': 'value' }))
      .rejects.toThrow(/U\+2028/);
  });

  it('rejects a nested object key containing U+2029 (PARAGRAPH SEPARATOR)', async () => {
    await expect(signWith({ outer: { 'bad key': 'value' } }))
      .rejects.toThrow(/U\+2029/);
  });

  it('accepts an object key containing U+2027 (HYPHENATION POINT) as sanity case', async () => {
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'k' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    (profile as unknown as Record<string, unknown>).extras = { 'fine‧key': 'value' };
    const signed = await signUCPProfile(profile, { signingKey: privateKey, kid: 'k' });
    expect(await verifyUCPProfile(signed, buildJWKSResponse([publicJWK]))).toBe(true);
  });
});

describe('UCP signing — JWK use/alg null treated as absent', () => {
  // RFC 7517 lists `use` and `alg` as optional. JSON null for these fields is
  // out-of-spec but harmless; treat null as absent so the Node verifier
  // matches Python's `is not None` semantics and a JWK with explicit nulls
  // doesn't reject in one language and pass in the other.
  it('verifies successfully when matched JWK has use=null', async () => {
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'null-use' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    const signed = await signUCPProfile(profile, { signingKey: privateKey, kid: 'null-use' });
    const jwksWithNullUse = { keys: [{ ...(publicJWK as Record<string, unknown>), use: null }] };
    expect(await verifyUCPProfile(signed, jwksWithNullUse as never)).toBe(true);
  });

  it('verifies successfully when matched JWK has alg=null', async () => {
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'null-alg', alg: 'EdDSA' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    const signed = await signUCPProfile(profile, { signingKey: privateKey, kid: 'null-alg', alg: 'EdDSA' });
    const jwksWithNullAlg = { keys: [{ ...(publicJWK as Record<string, unknown>), alg: null }] };
    expect(await verifyUCPProfile(signed, jwksWithNullAlg as never)).toBe(true);
  });

  it('still rejects use=enc with unusable_key (sanity: non-null wrong values still fail)', async () => {
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'enc-sanity', alg: 'EdDSA' });
    const profile = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    const signed = await signUCPProfile(profile, { signingKey: privateKey, kid: 'enc-sanity', alg: 'EdDSA' });
    const badJWKS = { keys: [{ ...(publicJWK as Record<string, unknown>), use: 'enc' }] };
    await expect(verifyUCPProfile(signed, badJWKS as never))
      .rejects.toMatchObject({ name: 'UCPVerificationError', code: 'unusable_key' });
  });
});
