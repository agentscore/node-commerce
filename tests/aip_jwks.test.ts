import { generateKeyPair, exportJWK, type JWK } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CACHE_SECONDS,
  HARD_MAX_CACHE_SECONDS,
  JwksCache,
  REFETCH_COOLDOWN_MS,
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
    expect(noList.isTrusted('https://www.agentscore.com')).toBe(true);
    expect(noList.isTrusted('https://www.agentscore.com/')).toBe(true); // canonicalized
    expect(noList.isTrusted('https://issuer.example')).toBe(false);

    const emptyList = new JwksCache({ trustedIssuers: [], fetchImpl: makeFetch([keyA]) });
    expect(emptyList.isTrusted('https://www.agentscore.com')).toBe(true);

    const withExternal = new JwksCache({ trustedIssuers: ['https://issuer.example'], fetchImpl: makeFetch([keyA]) });
    expect(withExternal.isTrusted('https://www.agentscore.com')).toBe(true); // still implicit
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

  it('refetches once on a kid miss within the cache window (past the cooldown)', async () => {
    // First fetch returns only key-A; after "rotation" the impl returns A+B. The kid-miss
    // refetch is gated by REFETCH_COOLDOWN_MS, so advance the clock past it to observe the
    // single rotation-pickup refetch (the cooldown behavior itself is pinned separately below).
    let call = 0;
    let nowMs = 1_000_000;
    const fetchImpl = vi.fn(async () => {
      call++;
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'max-age=600' },
        json: async () => ({ keys: call === 1 ? [keyA] : [keyA, keyB] }),
      };
    });
    const c = new JwksCache({ trustedIssuers: TRUSTED, fetchImpl, now: () => nowMs });
    await c.getKey('https://issuer.example', 'key-A'); // populates cache (call 1)
    nowMs += 30_001; // past the 30s refetch cooldown, still inside the 600s cache window
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

  // --- refetch-amplification / DoS guard (REFETCH_COOLDOWN_MS) ---------------------------------

  it('does NOT refetch on a kid miss within the cooldown — a flood of unknown kids costs 1 fetch', async () => {
    // Canonical issuer is always trusted and kid/iss are read pre-verify, so an unauthenticated
    // attacker could otherwise force one JWKS GET per unknown-kid token. The cooldown caps it.
    let nowMs = 1_000_000;
    const fetchImpl = makeFetch([keyA], { cacheControl: 'max-age=600' });
    const c = new JwksCache({ trustedIssuers: TRUSTED, fetchImpl, now: () => nowMs });
    await c.getKey('https://issuer.example', 'key-A'); // populates cache + stamps cooldown (call 1)
    // Stream many distinct unknown kids well inside the cooldown window.
    for (let i = 0; i < 50; i++) {
      nowMs += 100; // 5s total elapsed — still < 30s cooldown
      const r = await c.getKey('https://issuer.example', `attacker-kid-${i}`);
      expect(r).toEqual({ ok: false, reason: 'key_not_found' });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no amplification
  });

  it('a repeat lookup for a known-bad kid short-circuits within the cooldown', async () => {
    let nowMs = 1_000_000;
    const fetchImpl = makeFetch([keyA], { cacheControl: 'max-age=600' });
    const c = new JwksCache({ trustedIssuers: TRUSTED, fetchImpl, now: () => nowMs });
    await c.getKey('https://issuer.example', 'key-A'); // call 1
    nowMs += 1_000;
    const r1 = await c.getKey('https://issuer.example', 'ghost'); // memoized as negative, no fetch
    const r2 = await c.getKey('https://issuer.example', 'ghost'); // short-circuits via memo
    expect(r1).toEqual({ ok: false, reason: 'key_not_found' });
    expect(r2).toEqual({ ok: false, reason: 'key_not_found' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('allows one rotation-pickup refetch once the cooldown elapses', async () => {
    // After the cooldown a single kid-miss may refetch (rotation may have published the key);
    // the new fetch re-stamps the cooldown so the window reopens, not a permanent suppression.
    let call = 0;
    let nowMs = 1_000_000;
    const fetchImpl = vi.fn(async () => {
      call++;
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'max-age=600' },
        json: async () => ({ keys: call === 1 ? [keyA] : [keyA, keyB] }),
      };
    });
    const c = new JwksCache({ trustedIssuers: TRUSTED, fetchImpl, now: () => nowMs });
    await c.getKey('https://issuer.example', 'key-A'); // call 1, cooldown until now+30s
    nowMs += 5_000;
    expect(await c.getKey('https://issuer.example', 'key-B')).toMatchObject({ ok: false }); // suppressed
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    nowMs += REFETCH_COOLDOWN_MS; // past the cooldown
    const r = await c.getKey('https://issuer.example', 'key-B'); // now refetches → finds key-B
    expect(r.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('a rotated-in kid resolves once the cooldown elapses (fresh fetch picks it up)', async () => {
    let call = 0;
    let nowMs = 1_000_000;
    const fetchImpl = vi.fn(async () => {
      call++;
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'max-age=600' },
        json: async () => ({ keys: call === 1 ? [keyA] : [keyA, keyB] }),
      };
    });
    const c = new JwksCache({ trustedIssuers: TRUSTED, fetchImpl, now: () => nowMs });
    await c.getKey('https://issuer.example', 'key-A'); // call 1
    nowMs += 1_000;
    await c.getKey('https://issuer.example', 'key-B'); // suppressed by cooldown, no fetch
    nowMs += REFETCH_COOLDOWN_MS; // cooldown elapsed
    const r = await c.getKey('https://issuer.example', 'key-B'); // refetch clears memo, finds key-B
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.key.kid).toBe('key-B'); }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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

  // --- failure cooldown (negative cache for cold/erroring issuers) -----------------------------

  it('sequential failures within the cooldown perform exactly ONE upstream fetch', async () => {
    // An erroring issuer must not be re-fetched per request: the failed attempt stamps the same
    // per-issuer cooldown a success does, so a stream of tokens against a down/cold issuer costs
    // one GET per cooldown window — not one per token.
    let nowMs = 1_000_000;
    const fetchImpl = vi.fn(async () => { throw new Error('network'); });
    const c = new JwksCache({ trustedIssuers: TRUSTED, fetchImpl, now: () => nowMs });
    expect(await c.getKey('https://issuer.example', 'key-A')).toEqual({ ok: false, reason: 'fetch_failed' });
    for (let i = 0; i < 50; i++) {
      nowMs += 100; // 5s total elapsed — still < 30s cooldown
      const r = await c.getKey('https://issuer.example', `kid-${i}`);
      expect(r).toEqual({ ok: false, reason: 'fetch_failed' });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a non-2xx JWKS response also stamps the cooldown (one fetch per window)', async () => {
    let nowMs = 1_000_000;
    const fetchImpl = makeFetch([], { ok: false, status: 503 });
    const c = new JwksCache({ trustedIssuers: TRUSTED, fetchImpl, now: () => nowMs });
    expect(await c.getKey('https://issuer.example', 'key-A')).toEqual({ ok: false, reason: 'fetch_failed' });
    nowMs += 5_000;
    expect(await c.getKey('https://issuer.example', 'key-A')).toEqual({ ok: false, reason: 'fetch_failed' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a malformed JWKS body also stamps the cooldown and replays its reason', async () => {
    let nowMs = 1_000_000;
    const fetchImpl = makeFetch([], { body: { notkeys: 1 } });
    const c = new JwksCache({ trustedIssuers: TRUSTED, fetchImpl, now: () => nowMs });
    expect(await c.getKey('https://issuer.example', 'key-A')).toEqual({ ok: false, reason: 'malformed_jwks' });
    nowMs += 5_000;
    expect(await c.getKey('https://issuer.example', 'key-A')).toEqual({ ok: false, reason: 'malformed_jwks' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries the upstream fetch once the failure cooldown elapses', async () => {
    let call = 0;
    let nowMs = 1_000_000;
    const fetchImpl = vi.fn(async () => {
      call++;
      if (call === 1) { throw new Error('network'); }
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'max-age=600' },
        json: async () => ({ keys: [keyA] }),
      };
    });
    const c = new JwksCache({ trustedIssuers: TRUSTED, fetchImpl, now: () => nowMs });
    expect(await c.getKey('https://issuer.example', 'key-A')).toEqual({ ok: false, reason: 'fetch_failed' });
    nowMs += REFETCH_COOLDOWN_MS + 1; // past the failure cooldown
    const r = await c.getKey('https://issuer.example', 'key-A'); // retried → recovers
    expect(r.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('a failed kid-miss refetch does not nuke a still-fresh cached key set', async () => {
    // Fresh cache for key-A; an unknown-kid lookup past the cooldown forces a refetch that FAILS.
    // The failure stamps a new cooldown but must preserve the fresh keys: key-A keeps resolving.
    let call = 0;
    let nowMs = 1_000_000;
    const fetchImpl = vi.fn(async () => {
      call++;
      if (call > 1) { throw new Error('network'); }
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'max-age=600' },
        json: async () => ({ keys: [keyA] }),
      };
    });
    const c = new JwksCache({ trustedIssuers: TRUSTED, fetchImpl, now: () => nowMs });
    expect((await c.getKey('https://issuer.example', 'key-A')).ok).toBe(true); // call 1
    nowMs += REFETCH_COOLDOWN_MS + 1; // past the cooldown, still inside the 600s window
    expect(await c.getKey('https://issuer.example', 'ghost')).toEqual({ ok: false, reason: 'fetch_failed' }); // call 2 fails
    const r = await c.getKey('https://issuer.example', 'key-A'); // fresh keys preserved
    expect(r.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // --- single-flight: coalesce CONCURRENT refreshes to one upstream fetch ---------------------

  it('coalesces a concurrent distinct-kid burst on a cold cache to a SINGLE fetch', async () => {
    // The cooldown only suppresses SEQUENTIAL refetches. Without single-flight, a concurrent burst
    // of distinct unknown kids on a COLD/expired cache each enters refresh() before any has
    // populated the cache → N parallel JWKS GETs (refetch amplification against the issuer). A
    // deferred fetch impl keeps the first GET in-flight until all 200 callers have queued, so we
    // observe exactly one upstream call.
    let resolveFetch: (() => void) | undefined;
    const gate = new Promise<void>((res) => { resolveFetch = res; });
    const fetchImpl = vi.fn(async () => {
      await gate; // hold the fetch open until every concurrent caller has entered refresh()
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'max-age=600' },
        json: async () => ({ keys: [keyA, keyB] }),
      };
    });
    const c = new JwksCache({ trustedIssuers: TRUSTED, fetchImpl });

    // Fire 200 concurrent lookups, each with a DISTINCT kid (most unknown), on the cold cache.
    const lookups = Array.from({ length: 200 }, (_, i) =>
      c.getKey('https://issuer.example', i === 0 ? 'key-A' : i === 1 ? 'key-B' : `kid-${i}`),
    );
    // Let all 200 register their await on the shared in-flight promise, then release the fetch.
    await Promise.resolve();
    resolveFetch?.();
    const results = await Promise.all(lookups);

    expect(fetchImpl).toHaveBeenCalledTimes(1); // single upstream fetch for the whole burst
    // Each caller still selects independently from the shared key set: the two known kids resolve,
    // the rest report key_not_found — proving coalescing didn't cross-contaminate verdicts.
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[1]).toMatchObject({ ok: true });
    expect(results[2]).toEqual({ ok: false, reason: 'key_not_found' });
    if (results[0].ok) { expect(results[0].key.kid).toBe('key-A'); }
    if (results[1].ok) { expect(results[1].key.kid).toBe('key-B'); }
  });

  it('clears the in-flight entry so a later cold/expired lookup can refetch', async () => {
    // Single-flight must not pin the first fetch forever: once it settles, the entry is cleared and
    // the next expired-window lookup issues a fresh GET.
    let nowMs = 1_000_000;
    const fetchImpl = makeFetch([keyA], { cacheControl: 'max-age=300' });
    const c = new JwksCache({ trustedIssuers: TRUSTED, fetchImpl, now: () => nowMs });
    await c.getKey('https://issuer.example', 'key-A'); // fetch 1, in-flight cleared on settle
    nowMs += 301_000; // expire the cache window
    await c.getKey('https://issuer.example', 'key-A'); // fetch 2 (entry was not pinned)
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
