import { generateKeyPair, exportJWK, type JWK } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CACHE_SECONDS,
  HARD_MAX_CACHE_SECONDS,
  JwksCache,
  canonicalizeIssuer,
  resolveCacheSeconds,
} from '../src/aip/jwks';

let keyA: JWK;
let keyB: JWK;

beforeAll(async () => {
  const a = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const b = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  keyA = { ...(await exportJWK(a.publicKey)), kid: 'key-A', use: 'sig' };
  keyB = { ...(await exportJWK(b.publicKey)), kid: 'key-B', use: 'sig' };
});

describe('canonicalizeIssuer', () => {
  it('lowercases scheme and host', () => {
    expect(canonicalizeIssuer('HTTPS://Issuer.EXAMPLE')).toBe('https://issuer.example');
  });

  it('drops a trailing slash', () => {
    expect(canonicalizeIssuer('https://issuer.example/')).toBe('https://issuer.example');
  });

  it('drops the default https port', () => {
    expect(canonicalizeIssuer('https://issuer.example:443')).toBe('https://issuer.example');
  });

  it('keeps a non-default port', () => {
    expect(canonicalizeIssuer('https://issuer.example:8443')).toBe('https://issuer.example:8443');
  });

  it('preserves a non-root path', () => {
    expect(canonicalizeIssuer('https://idp.example.com/tenant1/')).toBe('https://idp.example.com/tenant1');
  });

  it('returns null for non-URLs', () => {
    expect(canonicalizeIssuer('not a url')).toBeNull();
  });

  it('makes issuer.example and issuer.example/ compare equal', () => {
    expect(canonicalizeIssuer('https://issuer.example')).toBe(canonicalizeIssuer('https://issuer.example/'));
  });
});

describe('resolveCacheSeconds', () => {
  it('defaults when no header', () => {
    expect(resolveCacheSeconds(null)).toBe(DEFAULT_CACHE_SECONDS);
  });

  it('honors a reasonable max-age', () => {
    expect(resolveCacheSeconds('max-age=600')).toBe(600);
  });

  it('clamps to the hard cap', () => {
    expect(resolveCacheSeconds('max-age=31536000')).toBe(HARD_MAX_CACHE_SECONDS);
  });

  it('falls back to default on no-store / no-cache', () => {
    expect(resolveCacheSeconds('no-store')).toBe(DEFAULT_CACHE_SECONDS);
    expect(resolveCacheSeconds('no-cache, max-age=999')).toBe(DEFAULT_CACHE_SECONDS);
  });

  it('falls back to default on a zero or junk max-age', () => {
    expect(resolveCacheSeconds('max-age=0')).toBe(DEFAULT_CACHE_SECONDS);
    expect(resolveCacheSeconds('max-age=abc')).toBe(DEFAULT_CACHE_SECONDS);
  });
});

const makeFetch = (keys: JWK[], opts: { cacheControl?: string; ok?: boolean; status?: number; body?: unknown } = {}) => {
  const impl = vi.fn(async () => ({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: { get: (n: string) => (n.toLowerCase() === 'cache-control' ? opts.cacheControl ?? null : null) },
    json: async () => opts.body ?? { keys },
  }));
  return impl;
};

const TRUSTED = ['https://issuer.example'];

describe('JwksCache.isTrusted', () => {
  it('matches canonicalized issuers', () => {
    const c = new JwksCache({ trustedIssuers: TRUSTED, fetchImpl: makeFetch([keyA]) });
    expect(c.isTrusted('https://issuer.example/')).toBe(true);
    expect(c.isTrusted('https://ISSUER.example')).toBe(true);
    expect(c.isTrusted('https://evil.com')).toBe(false);
  });

  it('always trusts AgentScore’s canonical issuer, even with no/empty trustedIssuers', () => {
    // The invariant must hold for EVERY consumer (raw adapters included), not just Checkout —
    // a merchant can't accidentally fail to trust AgentScore-issued AITs.
    const noList = new JwksCache({ fetchImpl: makeFetch([keyA]) });
    expect(noList.isTrusted('https://agentscore.sh')).toBe(true);
    expect(noList.isTrusted('https://agentscore.sh/')).toBe(true); // canonicalized
    expect(noList.isTrusted('https://issuer.example')).toBe(false);

    const emptyList = new JwksCache({ trustedIssuers: [], fetchImpl: makeFetch([keyA]) });
    expect(emptyList.isTrusted('https://agentscore.sh')).toBe(true);

    const withExternal = new JwksCache({ trustedIssuers: ['https://issuer.example'], fetchImpl: makeFetch([keyA]) });
    expect(withExternal.isTrusted('https://agentscore.sh')).toBe(true); // still implicit
    expect(withExternal.isTrusted('https://issuer.example')).toBe(true);
  });
});

describe('JwksCache.getKey', () => {
  it('rejects an untrusted issuer without fetching', async () => {
    const fetchImpl = makeFetch([keyA]);
    const c = new JwksCache({ trustedIssuers: TRUSTED, fetchImpl });
    const r = await c.getKey('https://evil.com', 'key-A');
    expect(r).toEqual({ ok: false, reason: 'untrusted_issuer' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an http (insecure) trusted issuer', async () => {
    const c = new JwksCache({ trustedIssuers: ['http://issuer.example'], fetchImpl: makeFetch([keyA]) });
    const r = await c.getKey('http://issuer.example', 'key-A');
    expect(r).toEqual({ ok: false, reason: 'insecure_issuer' });
  });

  it('fetches and returns a key by kid', async () => {
    const fetchImpl = makeFetch([keyA, keyB]);
    const c = new JwksCache({ trustedIssuers: TRUSTED, fetchImpl });
    const r = await c.getKey('https://issuer.example', 'key-B');
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.key.kid).toBe('key-B'); }
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][0]).toBe('https://issuer.example/.well-known/agent-identity/jwks.json');
  });

  it('serves a second lookup from cache (no second fetch)', async () => {
    const fetchImpl = makeFetch([keyA]);
    const c = new JwksCache({ trustedIssuers: TRUSTED, fetchImpl });
    await c.getKey('https://issuer.example', 'key-A');
    await c.getKey('https://issuer.example', 'key-A');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('refetches once on a kid miss within the cache window', async () => {
    // First fetch returns only key-A; after "rotation" the impl returns A+B.
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call++;
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'max-age=600' },
        json: async () => ({ keys: call === 1 ? [keyA] : [keyA, keyB] }),
      };
    });
    const c = new JwksCache({ trustedIssuers: TRUSTED, fetchImpl });
    await c.getKey('https://issuer.example', 'key-A'); // populates cache (call 1)
    const r = await c.getKey('https://issuer.example', 'key-B'); // miss → forced refetch (call 2)
    expect(r.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns key_not_found when the kid is absent after refresh', async () => {
    const fetchImpl = makeFetch([keyA]);
    const c = new JwksCache({ trustedIssuers: TRUSTED, fetchImpl });
    const r = await c.getKey('https://issuer.example', 'nonexistent');
    expect(r).toEqual({ ok: false, reason: 'key_not_found' });
  });

  it('re-fetches after the cache expires (hard clock advance)', async () => {
    let nowMs = 1_000_000;
    const fetchImpl = makeFetch([keyA], { cacheControl: 'max-age=300' });
    const c = new JwksCache({ trustedIssuers: TRUSTED, fetchImpl, now: () => nowMs });
    await c.getKey('https://issuer.example', 'key-A');
    nowMs += 301_000; // past the 300s window
    await c.getKey('https://issuer.example', 'key-A');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('selects the sole key when the token header has no kid', async () => {
    const c = new JwksCache({ trustedIssuers: TRUSTED, fetchImpl: makeFetch([keyA]) });
    const r = await c.getKey('https://issuer.example', undefined);
    expect(r.ok).toBe(true);
  });

  it('refuses a no-kid lookup when multiple keys exist (ambiguous)', async () => {
    const c = new JwksCache({ trustedIssuers: TRUSTED, fetchImpl: makeFetch([keyA, keyB]) });
    const r = await c.getKey('https://issuer.example', undefined);
    expect(r).toEqual({ ok: false, reason: 'key_not_found' });
  });

  it('ignores non-signing (use != sig) keys', async () => {
    const encKey = { ...keyA, kid: 'key-A', use: 'enc' };
    const c = new JwksCache({ trustedIssuers: TRUSTED, fetchImpl: makeFetch([encKey]) });
    const r = await c.getKey('https://issuer.example', 'key-A');
    expect(r).toEqual({ ok: false, reason: 'key_not_found' });
  });

  it('reports fetch_failed on a non-ok response', async () => {
    const c = new JwksCache({ trustedIssuers: TRUSTED, fetchImpl: makeFetch([keyA], { ok: false, status: 503 }) });
    const r = await c.getKey('https://issuer.example', 'key-A');
    expect(r).toEqual({ ok: false, reason: 'fetch_failed' });
  });

  it('reports malformed_jwks when the body has no keys array', async () => {
    const c = new JwksCache({ trustedIssuers: TRUSTED, fetchImpl: makeFetch([], { body: { notkeys: 1 } }) });
    const r = await c.getKey('https://issuer.example', 'key-A');
    expect(r).toEqual({ ok: false, reason: 'malformed_jwks' });
  });

  it('reports fetch_failed when fetch throws', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network'); });
    const c = new JwksCache({ trustedIssuers: TRUSTED, fetchImpl });
    const r = await c.getKey('https://issuer.example', 'key-A');
    expect(r).toEqual({ ok: false, reason: 'fetch_failed' });
  });
});
