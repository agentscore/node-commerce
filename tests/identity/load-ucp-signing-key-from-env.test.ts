/**
 * Tests for `loadUCPSigningKeyFromEnv` — env-driven UCP signing-key loader.
 *
 * Locked behavior contract (shared with the Python sibling at
 * `python-commerce/tests/test_load_ucp_signing_key_from_env.py`):
 *
 * - env JWK present → load + validate kty/crv (OKP+Ed25519 or EC+P-256), project to canonical public JWK
 * - env JWK absent → generate ephemeral key
 * - malformed JSON → Error naming the env var
 * - unsupported kty/crv → Error naming the actual kty/crv
 * - malformed key material → sanitized Error (no key bytes in the message)
 * - whitespace-only env value → treated as absent
 * - embedded kid in JWK wins over env kid; empty-string kid falls through to default
 * - concurrent first-callers await the same in-flight Promise (no two-key race)
 * - different opts get separate cache entries
 */

import { exportJWK, generateKeyPair } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetUCPSigningKeyCache,
  loadUCPSigningKeyFromEnv,
} from '../../src/identity/ucp-jwks.js';

const ENV_KEYS = ['UCP_SIGNING_KEY_JWK_PRIVATE', 'UCP_SIGNING_KEY_KID', 'UCP_SIGNING_KEY_ALG', 'PROD_UCP_JWK'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  _resetUCPSigningKeyCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  _resetUCPSigningKeyCache();
});

async function buildEd25519JWK(): Promise<Record<string, unknown>> {
  const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  return (await exportJWK(privateKey)) as unknown as Record<string, unknown>;
}

async function buildP256JWK(): Promise<Record<string, unknown>> {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  return (await exportJWK(privateKey)) as unknown as Record<string, unknown>;
}

// ─── env JWK present: happy paths ─────────────────────────────────────────

describe('loadUCPSigningKeyFromEnv — env JWK present', () => {
  it('loads an Ed25519 JWK', async () => {
    const jwk = await buildEd25519JWK();
    jwk.kid = 'test-ed25519-key';
    process.env.UCP_SIGNING_KEY_JWK_PRIVATE = JSON.stringify(jwk);

    const result = await loadUCPSigningKeyFromEnv();

    expect(result.publicJWK.kty).toBe('OKP');
    expect(result.publicJWK.crv).toBe('Ed25519');
    expect(result.publicJWK.alg).toBe('EdDSA');
    expect(result.publicJWK.use).toBe('sig');
    expect(result.publicJWK.kid).toBe('test-ed25519-key');
    expect('d' in result.publicJWK).toBe(false);  // private field stripped
  });

  it('loads an ES256 (P-256) JWK', async () => {
    const jwk = await buildP256JWK();
    jwk.kid = 'test-p256-key';
    process.env.UCP_SIGNING_KEY_JWK_PRIVATE = JSON.stringify(jwk);

    const result = await loadUCPSigningKeyFromEnv();

    expect(result.publicJWK.kty).toBe('EC');
    expect(result.publicJWK.crv).toBe('P-256');
    expect(result.publicJWK.alg).toBe('ES256');
    expect(result.publicJWK.kid).toBe('test-p256-key');
    expect('d' in result.publicJWK).toBe(false);
  });

  it('drops unknown env-JWK fields from the public JWK', async () => {
    const jwk = await buildEd25519JWK();
    jwk.kid = 'test-kid';
    jwk.key_ops = ['sign', 'verify'];
    jwk.x5c = ['fake-cert'];
    jwk.x5t = 'fake-thumbprint';
    process.env.UCP_SIGNING_KEY_JWK_PRIVATE = JSON.stringify(jwk);

    const result = await loadUCPSigningKeyFromEnv();

    expect('key_ops' in result.publicJWK).toBe(false);
    expect('x5c' in result.publicJWK).toBe(false);
    expect('x5t' in result.publicJWK).toBe(false);
  });
});

// ─── kid precedence ──────────────────────────────────────────────────────

describe('loadUCPSigningKeyFromEnv — kid precedence', () => {
  it('embedded JWK kid wins over env kid', async () => {
    const jwk = await buildEd25519JWK();
    jwk.kid = 'embedded-kid';
    process.env.UCP_SIGNING_KEY_JWK_PRIVATE = JSON.stringify(jwk);
    process.env.UCP_SIGNING_KEY_KID = 'env-kid';

    const result = await loadUCPSigningKeyFromEnv();
    expect(result.publicJWK.kid).toBe('embedded-kid');
  });

  it('empty-string embedded kid falls through to env default', async () => {
    const jwk = await buildEd25519JWK();
    jwk.kid = '';
    process.env.UCP_SIGNING_KEY_JWK_PRIVATE = JSON.stringify(jwk);
    process.env.UCP_SIGNING_KEY_KID = 'fallback-kid';

    const result = await loadUCPSigningKeyFromEnv();
    expect(result.publicJWK.kid).toBe('fallback-kid');
  });

  it('missing embedded kid falls through to options default', async () => {
    const jwk = await buildEd25519JWK();
    delete jwk.kid;
    process.env.UCP_SIGNING_KEY_JWK_PRIVATE = JSON.stringify(jwk);

    const result = await loadUCPSigningKeyFromEnv({ defaultKid: 'opts-default' });
    expect(result.publicJWK.kid).toBe('opts-default');
  });
});

// ─── ephemeral fallback ──────────────────────────────────────────────────

describe('loadUCPSigningKeyFromEnv — ephemeral fallback', () => {
  it('generates an ephemeral Ed25519 key when env JWK is missing', async () => {
    const result = await loadUCPSigningKeyFromEnv();
    expect(result.publicJWK.alg).toBe('EdDSA');
    expect(result.publicJWK.kid).toBe('merchant-default');
  });

  it('respects defaultAlg option in ephemeral path', async () => {
    const result = await loadUCPSigningKeyFromEnv({ defaultAlg: 'ES256' });
    expect(result.publicJWK.alg).toBe('ES256');
    expect(result.publicJWK.kty).toBe('EC');
  });

  it('env alg (case-insensitive) overrides default in ephemeral path', async () => {
    process.env.UCP_SIGNING_KEY_ALG = 'es256';  // lowercase
    const result = await loadUCPSigningKeyFromEnv();
    expect(result.publicJWK.alg).toBe('ES256');
  });

  it('unrecognized env alg falls back to default', async () => {
    process.env.UCP_SIGNING_KEY_ALG = 'rs256';  // not supported
    const result = await loadUCPSigningKeyFromEnv();
    expect(result.publicJWK.alg).toBe('EdDSA');
  });
});

// ─── whitespace handling ─────────────────────────────────────────────────

describe('loadUCPSigningKeyFromEnv — whitespace handling', () => {
  it('whitespace-only env JWK is treated as absent', async () => {
    process.env.UCP_SIGNING_KEY_JWK_PRIVATE = '   \n\t  ';
    const result = await loadUCPSigningKeyFromEnv();
    // Falls through to ephemeral
    expect(result.publicJWK.alg).toBe('EdDSA');
  });

  it('trims whitespace from env kid', async () => {
    process.env.UCP_SIGNING_KEY_KID = '  trimmed-kid  ';
    const result = await loadUCPSigningKeyFromEnv();
    expect(result.publicJWK.kid).toBe('trimmed-kid');
  });
});

// ─── error paths ─────────────────────────────────────────────────────────

describe('loadUCPSigningKeyFromEnv — error paths', () => {
  it('throws for malformed JSON, naming the env var', async () => {
    process.env.UCP_SIGNING_KEY_JWK_PRIVATE = '{not valid json';
    await expect(loadUCPSigningKeyFromEnv()).rejects.toThrow(
      /UCP_SIGNING_KEY_JWK_PRIVATE is not valid JSON/,
    );
  });

  it('throws for unsupported kty/crv, naming the actual values', async () => {
    process.env.UCP_SIGNING_KEY_JWK_PRIVATE = JSON.stringify({ kty: 'RSA', n: 'abc', e: 'AQAB' });
    await expect(loadUCPSigningKeyFromEnv()).rejects.toThrow(/unsupported kty\/crv.*RSA/);
  });

  it('throws when JWK is not a JSON object', async () => {
    process.env.UCP_SIGNING_KEY_JWK_PRIVATE = '[1, 2, 3]';
    await expect(loadUCPSigningKeyFromEnv()).rejects.toThrow(/must be a non-empty JWK object/);
  });

  it('throws for empty JWK object', async () => {
    process.env.UCP_SIGNING_KEY_JWK_PRIVATE = '{}';
    await expect(loadUCPSigningKeyFromEnv()).rejects.toThrow(/must be a non-empty JWK object/);
  });

  it('sanitizes malformed-key-material errors (no key bytes in the message)', async () => {
    const badJwk = {
      kty: 'OKP',
      crv: 'Ed25519',
      x: 'this-is-not-base64-key-material',
      d: 'leaked-secret-should-not-appear',
    };
    process.env.UCP_SIGNING_KEY_JWK_PRIVATE = JSON.stringify(badJwk);
    try {
      await loadUCPSigningKeyFromEnv();
      expect.fail('expected loadUCPSigningKeyFromEnv to throw');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain('leaked-secret-should-not-appear');
      expect(msg).toContain('Underlying details suppressed to avoid leaking key bytes');
    }
  });
});

// ─── caching + concurrency ───────────────────────────────────────────────

describe('loadUCPSigningKeyFromEnv — caching', () => {
  it('repeated calls return the cached key (same object identity)', async () => {
    const first = await loadUCPSigningKeyFromEnv();
    const second = await loadUCPSigningKeyFromEnv();
    expect(first).toBe(second);
  });

  it('different opts get separate cache entries', async () => {
    const first = await loadUCPSigningKeyFromEnv({ defaultKid: 'kid-a' });
    const second = await loadUCPSigningKeyFromEnv({ defaultKid: 'kid-b' });
    expect(first).not.toBe(second);
    expect(first.publicJWK.kid).toBe('kid-a');
    expect(second.publicJWK.kid).toBe('kid-b');
  });

  it('concurrent first-callers share the same in-flight Promise', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => loadUCPSigningKeyFromEnv()),
    );
    // All 8 callers received the same key object — no two-key race.
    for (const r of results) expect(r).toBe(results[0]);
  });

  it('cache reset clears entries; next call generates a fresh ephemeral', async () => {
    const first = await loadUCPSigningKeyFromEnv();
    _resetUCPSigningKeyCache();
    const second = await loadUCPSigningKeyFromEnv();
    expect(first).not.toBe(second);
  });

  it('rejection clears cache so next call retries (no permanent poison)', async () => {
    process.env.UCP_SIGNING_KEY_JWK_PRIVATE = '{not valid';
    await expect(loadUCPSigningKeyFromEnv()).rejects.toThrow();
    // Fix the env, retry — should succeed.
    delete process.env.UCP_SIGNING_KEY_JWK_PRIVATE;
    const result = await loadUCPSigningKeyFromEnv();
    expect(result.publicJWK.alg).toBe('EdDSA');
  });

  it('env var override via opts isolates from default UCP_SIGNING_KEY_JWK_PRIVATE', async () => {
    const jwk = await buildEd25519JWK();
    jwk.kid = 'prod-key';
    process.env.PROD_UCP_JWK = JSON.stringify(jwk);

    const result = await loadUCPSigningKeyFromEnv({ envJwkVar: 'PROD_UCP_JWK' });
    expect(result.publicJWK.kid).toBe('prod-key');
  });
});
