/**
 * AIP IdP key discovery: fetch, cache, and select JWKS signing keys.
 *
 * Verifiers resolve an IdP's public keys from `https://{iss}/.well-known/agent-identity/jwks.json`
 * (the spec's well-known path). This module owns:
 *
 *   - **Trusted-issuer enforcement** — only `iss` values on the allowlist are fetched, compared
 *     after URL canonicalization (lowercase scheme+host, no default port, no trailing slash) so
 *     `https://issuer.example` and `https://issuer.example/` match.
 *   - **HTTPS-only** — JWKS over plain HTTP is MITM-vulnerable; we refuse it.
 *   - **Caching with a HARD cap** — we honor `Cache-Control: max-age` as advisory but never
 *     cache longer than {@link HARD_MAX_CACHE_SECONDS}, regardless of what the IdP sends. A
 *     compromised IdP can't pin stale keys with `max-age=31536000`.
 *   - **kid-miss refresh** — a lookup for a `kid` not in the cached set triggers one refetch
 *     (rotation may have published a new key inside the cache window).
 *   - **use:"sig" filtering** — only signing keys are returned.
 *
 * Pure-ish: the only I/O is `fetch`, injectable for tests.
 */

import type { JWK } from 'jose';

/** The spec's well-known JWKS path, relative to the issuer origin. */
export const JWKS_WELL_KNOWN_PATH = '/.well-known/agent-identity/jwks.json';

/** Hard ceiling on cache age, regardless of IdP-supplied Cache-Control. */
export const HARD_MAX_CACHE_SECONDS = 86_400; // 24h

/** Floor used when the IdP sends no usable cache directive. */
export const DEFAULT_CACHE_SECONDS = 300; // 5m

/**
 * After a fetch ATTEMPT (initial, kid-miss-triggered, success OR failure), suppress further
 * upstream fetches for this issuer for this many ms. Mirrors the API verifier's
 * `cooldownDuration: 30_000` (jose `createRemoteJWKSet`, `the AgentScore API verifier`). Without
 * it, an unauthenticated attacker who sends a stream of tokens with unknown `kid`s (the `kid`/`iss`
 * are decoded BEFORE signature verification, and the canonical issuer is always trusted) forces one
 * upstream JWKS GET per request — a refetch-amplification / DoS vector against the issuer. Stamping
 * the cooldown on FAILURE too (a negative cache) closes the cold/erroring-issuer variant: a stream
 * of tokens against an issuer whose JWKS is down would otherwise retry the GET on every request.
 */
export const REFETCH_COOLDOWN_MS = 30_000; // 30s — matches the API verifier

type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

/** AgentScore's own AIT issuer. ALWAYS trusted by every {@link JwksCache} (and therefore every
 *  gate/adapter built on it) without the merchant listing it — this SDK is the AgentScore
 *  verifier, so a merchant can't accidentally fail to trust AgentScore-issued AITs. `trustedIssuers`
 *  only needs to name ADDITIONAL external issuers. */
export const AGENTSCORE_CANONICAL_ISSUER = 'https://www.agentscore.com';

export interface JwksCacheOptions {
  /** ADDITIONAL external issuer URLs to trust beyond AgentScore's own (compared after
   *  canonicalization). AgentScore's canonical issuer is always trusted; omit/empty to accept
   *  only AgentScore-issued AITs. */
  trustedIssuers?: string[];
  /** Injectable fetch (defaults to global fetch). */
  fetchImpl?: FetchLike;
  /** Injectable clock (ms), for tests. */
  now?: () => number;
  /** User-Agent for JWKS requests. */
  userAgent?: string;
}

export type JwksLookupFailure =
  | 'untrusted_issuer'
  | 'insecure_issuer'
  | 'fetch_failed'
  | 'malformed_jwks'
  | 'key_not_found';

export type JwksLookupResult =
  | { ok: true; key: JWK }
  | { ok: false; reason: JwksLookupFailure };

interface CachedKeys {
  keys: JWK[];
  expiresAt: number; // ms
  /** Until this timestamp (ms), no lookup will hit upstream — a kid-miss within a fresh cache
   *  returns `key_not_found`, and a cold/expired cache returns `lastFailure` without fetching.
   *  Stamped to `now + REFETCH_COOLDOWN_MS` on every fetch ATTEMPT (success or failure). This is
   *  the refetch-amplification / DoS guard (see {@link REFETCH_COOLDOWN_MS}). */
  cooldownUntil: number; // ms
  /** Why the last fetch attempt failed, when it did. Served (without refetching) to lookups that
   *  land within the cooldown with no usable cached keys — the negative-cache entry for a
   *  cold/erroring issuer. Absent after a successful fetch. */
  lastFailure?: JwksLookupFailure;
}

/**
 * Canonicalize an issuer URL for trust-list comparison: lowercase scheme + host, drop the
 * default port for the scheme, strip a trailing slash on an empty path. Returns null if the
 * input is not a parseable absolute URL.
 */
export const canonicalizeIssuer = (iss: string): string | null => {
  let url: URL;
  try {
    url = new URL(iss.trim());
  } catch {
    return null;
  }
  const scheme = url.protocol.toLowerCase();
  const host = url.hostname.toLowerCase();
  const isDefaultPort =
    url.port === '' ||
    (scheme === 'https:' && url.port === '443') ||
    (scheme === 'http:' && url.port === '80');
  const portPart = isDefaultPort ? '' : `:${url.port}`;
  // Drop a trailing slash when the path is just "/".
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  return `${scheme}//${host}${portPart}${path}`;
};

/** Parse `Cache-Control: max-age=N`, clamped to the hard cap. Returns seconds. */
export const resolveCacheSeconds = (cacheControl: string | null): number => {
  if (!cacheControl) { return DEFAULT_CACHE_SECONDS; }
  if (/\bno-store\b/i.test(cacheControl) || /\bno-cache\b/i.test(cacheControl)) {
    return DEFAULT_CACHE_SECONDS;
  }
  const m = /\bmax-age\s*=\s*(\d+)/i.exec(cacheControl);
  if (!m) { return DEFAULT_CACHE_SECONDS; }
  const advertised = Number(m[1]);
  if (!Number.isFinite(advertised) || advertised <= 0) { return DEFAULT_CACHE_SECONDS; }
  return Math.min(advertised, HARD_MAX_CACHE_SECONDS);
};

/** Extract `use: "sig"` keys (or keys with no `use`, which default to usable for sig). */
const signingKeys = (keys: JWK[]): JWK[] =>
  keys.filter((k) => k.use === undefined || k.use === 'sig');

/**
 * JWKS resolver bound to a trusted-issuer allowlist. One instance can serve many issuers;
 * each issuer's key set is cached independently.
 */
export class JwksCache {
  private readonly trusted: Set<string>;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly userAgent: string;
  private readonly cache = new Map<string, CachedKeys>();
  /** Per-issuer in-flight refresh promise — coalesces concurrent refreshes to ONE upstream fetch.
   *  Without it, a concurrent burst of distinct-kid lookups on a cold/expired cache each call
   *  `refresh()` before any has populated the cache → N parallel JWKS GETs (refetch amplification).
   *  The cooldown only suppresses SEQUENTIAL refetches; single-flight suppresses CONCURRENT ones.
   *  Entry is cleared in a `finally` once the fetch settles. */
  private readonly inflight = new Map<string, Promise<{ ok: true; keys: JWK[] } | { ok: false; reason: JwksLookupFailure }>>();

  constructor(opts: JwksCacheOptions) {
    // AgentScore's own issuer is always trusted, plus any additional external issuers. Canonicalize
    // both so a merchant-supplied duplicate (or trailing-slash variant) of the canonical issuer
    // collapses into the same Set entry.
    this.trusted = new Set(
      [AGENTSCORE_CANONICAL_ISSUER, ...(opts.trustedIssuers ?? [])]
        .map(canonicalizeIssuer)
        .filter((s): s is string => s !== null),
    );
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.now = opts.now ?? Date.now;
    this.userAgent = opts.userAgent ?? '@agentscore/commerce';
  }

  /** Is this issuer on the canonicalized trust list? */
  isTrusted(iss: string): boolean {
    const canon = canonicalizeIssuer(iss);
    return canon !== null && this.trusted.has(canon);
  }

  /**
   * Resolve the signing key for `(iss, kid)`. Enforces trust + HTTPS, serves from cache when
   * fresh, and refetches once on a kid-miss before giving up.
   */
  async getKey(iss: string, kid: string | undefined): Promise<JwksLookupResult> {
    const canon = canonicalizeIssuer(iss);
    if (canon === null || !this.trusted.has(canon)) {
      return { ok: false, reason: 'untrusted_issuer' };
    }
    if (!canon.startsWith('https://')) {
      return { ok: false, reason: 'insecure_issuer' };
    }

    const cached = this.cache.get(canon);
    if (cached && this.now() < cached.expiresAt) {
      const hit = this.select(cached.keys, kid);
      if (hit) { return { ok: true, key: hit }; }
      // kid miss within the cache window. Normally we'd force one refetch (rotation may have
      // published a new key) — but only once the refetch cooldown has elapsed. WITHIN the
      // cooldown we return key_not_found WITHOUT refetching. This caps JWKS GETs at ~1 per issuer
      // per cooldown regardless of how many unknown-kid tokens an attacker streams (the DoS
      // guard). Once the cooldown passes we fall through to a single refetch, because rotation
      // may have published the kid since.
      if (this.now() < cached.cooldownUntil) {
        return { ok: false, reason: 'key_not_found' };
      }
      // Past the cooldown: fall through to a single forced refetch below.
    } else if (cached && this.now() < cached.cooldownUntil) {
      // No usable cached keys (cold fetch failed, or the cache expired) and still inside the
      // refetch cooldown — fail WITHOUT an upstream GET. This is the negative cache for a
      // cold/erroring issuer: sequential lookups within the cooldown cost zero fetches.
      return { ok: false, reason: cached.lastFailure ?? 'key_not_found' };
    }

    const refreshed = await this.refresh(canon);
    if (!refreshed.ok) { return refreshed; }

    const hit = this.select(refreshed.keys, kid);
    if (hit) { return { ok: true, key: hit }; }
    return { ok: false, reason: 'key_not_found' };
  }

  private select(keys: JWK[], kid: string | undefined): JWK | undefined {
    const candidates = signingKeys(keys);
    if (kid !== undefined) {
      const byKid = candidates.find((k) => k.kid === kid);
      if (byKid) { return byKid; }
      return undefined;
    }
    // No kid in the token header: only safe when exactly one signing key exists.
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  /**
   * Refresh the cached key set for `canonIssuer`, coalescing concurrent callers onto a single
   * upstream fetch (single-flight). The first caller for an issuer with no in-flight refresh kicks
   * off the fetch and registers the promise; concurrent callers await that same promise instead of
   * issuing their own GET. The entry is cleared once the fetch settles so the NEXT cold/expired
   * lookup can refresh again.
   */
  private async refresh(canonIssuer: string): Promise<{ ok: true; keys: JWK[] } | { ok: false; reason: JwksLookupFailure }> {
    const existing = this.inflight.get(canonIssuer);
    if (existing !== undefined) { return existing; }
    const promise = this.fetchAndCache(canonIssuer).finally(() => {
      this.inflight.delete(canonIssuer);
    });
    this.inflight.set(canonIssuer, promise);
    return promise;
  }

  private async fetchAndCache(canonIssuer: string): Promise<{ ok: true; keys: JWK[] } | { ok: false; reason: JwksLookupFailure }> {
    const url = `${canonIssuer}${JWKS_WELL_KNOWN_PATH}`;
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(url, { headers: { 'User-Agent': this.userAgent, Accept: 'application/jwk-set+json, application/json' } });
    } catch {
      return this.stampFailure(canonIssuer, 'fetch_failed');
    }
    if (!res.ok) { return this.stampFailure(canonIssuer, 'fetch_failed'); }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return this.stampFailure(canonIssuer, 'malformed_jwks');
    }
    if (typeof body !== 'object' || body === null || !Array.isArray((body as { keys?: unknown }).keys)) {
      return this.stampFailure(canonIssuer, 'malformed_jwks');
    }
    const keys = (body as { keys: JWK[] }).keys;

    const ttlSeconds = resolveCacheSeconds(res.headers.get('cache-control'));
    const now = this.now();
    // Stamp the cooldown window on every fetch so a kid-miss can't trigger another refetch for
    // REFETCH_COOLDOWN_MS.
    this.cache.set(canonIssuer, {
      keys,
      expiresAt: now + ttlSeconds * 1000,
      cooldownUntil: now + REFETCH_COOLDOWN_MS,
    });
    return { ok: true, keys };
  }

  /** Stamp the per-issuer refetch cooldown on a FAILED fetch attempt (the negative cache). Any
   *  previously cached keys + expiry are preserved — a failed kid-miss refetch must not nuke a
   *  still-fresh key set; only the cooldown and failure reason are updated. */
  private stampFailure(canonIssuer: string, reason: JwksLookupFailure): { ok: false; reason: JwksLookupFailure } {
    const now = this.now();
    const prev = this.cache.get(canonIssuer);
    this.cache.set(canonIssuer, {
      keys: prev?.keys ?? [],
      expiresAt: prev?.expiresAt ?? now,
      cooldownUntil: now + REFETCH_COOLDOWN_MS,
      lastFailure: reason,
    });
    return { ok: false, reason };
  }
}
