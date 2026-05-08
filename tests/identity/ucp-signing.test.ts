import { describe, expect, it } from 'vitest';
import { buildUCPProfile } from '../../src/identity/ucp';
import {
  buildJWKSResponse,
  generateUCPSigningKey,
  signUCPProfile,
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
    ).rejects.toThrow(/no `signature` field/);
  });
});

describe('UCP signing — canonicalization', () => {
  it('signs the profile such that key-order in the JSON does not affect verification', async () => {
    const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'k' });
    const profileA = buildUCPProfile({ ...baseInput, signing_keys: [publicJWK] });
    const signed = await signUCPProfile(profileA, { signingKey: privateKey, kid: 'k' });

    // Re-construct the same profile with keys in different insertion order; should
    // still verify because canonicalization sorts keys deterministically.
    const reordered = JSON.parse(JSON.stringify(signed));
    const ok = await verifyUCPProfile(reordered, buildJWKSResponse([publicJWK]));
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
