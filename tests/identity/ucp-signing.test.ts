import { describe, expect, it } from 'vitest';
import { buildUCPProfile, ucpSigningKeyFromJWK } from '../../src/identity/ucp';
import {
  buildJWKSResponse,
  generateUCPSigningKey,
  signUCPProfile,
  UCPVerificationError,
  verifyUCPProfile,
} from '../../src/identity/ucp-jwks';

const baseInput = {
  name: 'Test Merchant',
  services: [{ type: 'rest', url: 'https://agents.example.com' }],
  payment_handlers: [
    { name: 'tempo', config: { recipient: '0x1234' } },
  ],
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
      .setProtectedHeader({ alg: 'HS256', kid: 'attacker', typ: 'ucp-profile+jws' })
      .sign(sharedSecret);
    const tampered = { ...profile, signature: evilSig };
    await expect(verifyUCPProfile(tampered as never, buildJWKSResponse([ocJwk as never])))
      .rejects.toThrow(UCPVerificationError);
  });

  it('rejects a JWS with typ != "ucp-profile+jws"', async () => {
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
    await expect(verifyUCPProfile(tampered, buildJWKSResponse([publicJWK])))
      .rejects.toThrow();
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
    const headerJson = JSON.stringify({ alg: 'EdDSA', kid: 'k', typ: 'ucp-profile+jws', crit: ['fakething'], fakething: 'x' });
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
});

describe('ucpSigningKeyFromJWK', () => {
  it('round-trips an EdDSA public JWK from generateUCPSigningKey', async () => {
    const { publicJWK } = await generateUCPSigningKey({ kid: 'rt-eddsa', alg: 'EdDSA' });
    const result = ucpSigningKeyFromJWK(publicJWK as Record<string, unknown>);
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
    const result = ucpSigningKeyFromJWK(publicJWK as Record<string, unknown>);
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
      ucpSigningKeyFromJWK({ kid: 'k', kty: 'oct', k: 'AAAA' }),
    ).toThrow(/asymmetric/i);
  });

  it('rejects JWK missing kid', () => {
    expect(() => ucpSigningKeyFromJWK({ kty: 'OKP' })).toThrow(/kid/);
  });

  it('rejects JWK missing kty', () => {
    expect(() => ucpSigningKeyFromJWK({ kid: 'k' })).toThrow(/kty/);
  });

  it('rejects non-object inputs', () => {
    expect(() => ucpSigningKeyFromJWK(null as never)).toThrow();
    expect(() => ucpSigningKeyFromJWK('string' as never)).toThrow();
    expect(() => ucpSigningKeyFromJWK(42 as never)).toThrow();
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
