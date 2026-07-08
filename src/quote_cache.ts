/**
 * Short-TTL body-hash caches.
 *
 * `createResultCache` is the neutral primitive: a keyed JSON-value cache with
 * a stable content-hash key builder. Use it to cache any per-request result a
 * merchant computes on the probe leg and replays on the settle leg — e.g. the
 * output of a paid upstream call made in a `Checkout.preValidate` hook, so a
 * payment retry (or a junk payment header) never pays upstream twice.
 *
 * `createQuoteCache` is the compute-first-flavored wrapper used by
 * {@link computeFirstCheckout}: the cached value is a `CachedQuote`
 * (`{body, priceCents, recipients}`). Standard x402-fetch retry semantics
 * resign the buyer's ORIGINAL request body — there's no `result_id` echo
 * channel through the protocol — so both caches key by a stable content-hash
 * of the request body. Same body → same hash → same cache slot.
 *
 * Default in-memory `Map`; optional `redisUrl` lazy-imports `ioredis` for
 * multi-instance deployments. `ioredis` is an optional peer dep.
 */

import { createHash } from 'crypto';
import { memoizedRedis, type MinimalRedis } from './_redis';

export interface ResultCacheOptions {
  /** Entry lifetime in milliseconds. Default `5 * 60_000` (5 min). */
  ttlMs?: number;
  /** Redis connection URL. Default: `process.env.REDIS_URL`. When unset or the
   *  lazy `ioredis` import fails, falls back to in-process `Map`. */
  redisUrl?: string;
  /** Per-instance key prefix so multiple caches sharing a Redis don't collide. */
  keyPrefix?: string;
}

export type QuoteCacheOptions = ResultCacheOptions;

export interface CachedQuote {
  body: Record<string, unknown>;
  priceCents: number;
  /** Per-rail deposit addresses minted on the probe leg. The settle leg replays
   *  these instead of re-minting (avoids second Stripe PaymentIntent for the
   *  same logical purchase). Empty object when no `mintRecipients` hook is wired. */
  recipients: Record<string, string>;
}

export interface ResultCache<T> {
  /** Build a stable content-hash key from a per-merchant prefix and a request body.
   *  Property order in the body does NOT affect the hash (keys are sorted recursively). */
  bodyHashKey(prefix: string, body: Record<string, unknown>): string;
  read(key: string): Promise<T | null>;
  write(key: string, value: T): Promise<void>;
  /** Clear all entries. Primarily for tests. */
  clear(): Promise<void>;
}

export interface QuoteCache {
  /** Build a stable content-hash key from a per-merchant prefix and a request body.
   *  Property order in the body does NOT affect the hash (keys are sorted recursively). */
  bodyHashKey(prefix: string, body: Record<string, unknown>): string;
  read(key: string): Promise<CachedQuote | null>;
  write(
    key: string,
    body: Record<string, unknown>,
    priceCents: number,
    recipients?: Record<string, string>,
  ): Promise<void>;
  /** Clear all entries. Primarily for tests. */
  clear(): Promise<void>;
}

interface RedisLike extends MinimalRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', ms: number): Promise<unknown>;
  flushdb(): Promise<unknown>;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** Build a fresh neutral result cache. Each call owns its own state (memory
 *  map + Redis client). Values must survive `JSON.stringify` round-trips. */
export function createResultCache<T>(opts: ResultCacheOptions = {}): ResultCache<T> {
  const ttlMs = opts.ttlMs ?? 5 * 60_000;
  const keyPrefix = opts.keyPrefix ?? 'result:';

  const memMap = new Map<string, { entry: T; expiresAt: number }>();
  const getRedis = memoizedRedis<RedisLike>({ url: opts.redisUrl, label: 'result-cache' });

  const evictExpired = (): void => {
    const now = Date.now();
    for (const [k, v] of memMap.entries()) {
      if (v.expiresAt <= now) memMap.delete(k);
    }
  };

  return {
    bodyHashKey(prefix: string, body: Record<string, unknown>): string {
      const canonical = JSON.stringify(canonicalize(body));
      const hash = createHash('sha256').update(`${prefix}::${canonical}`).digest('hex').slice(0, 24);
      return `${prefix}::${hash}`;
    },
    async read(key: string): Promise<T | null> {
      const r = await getRedis();
      if (r) {
        try {
          const raw = await r.get(`${keyPrefix}${key}`);
          if (!raw) return null;
          return JSON.parse(raw) as T;
        } catch {
          // Fall through to mem cache on Redis failure
        }
      }
      evictExpired();
      const entry = memMap.get(key);
      return entry ? entry.entry : null;
    },
    async write(key: string, value: T): Promise<void> {
      const r = await getRedis();
      if (r) {
        try {
          await r.set(`${keyPrefix}${key}`, JSON.stringify(value), 'PX', ttlMs);
          return;
        } catch {
          // Fall through to mem cache on Redis failure
        }
      }
      memMap.set(key, { entry: value, expiresAt: Date.now() + ttlMs });
    },
    async clear(): Promise<void> {
      memMap.clear();
      const r = await getRedis();
      if (r) {
        try {
          await r.flushdb();
        } catch {
          // ignore
        }
      }
    },
  };
}

/** Build a fresh compute-first quote cache (a `ResultCache<CachedQuote>` with
 *  the quote-shaped `write` signature). */
export function createQuoteCache(opts: QuoteCacheOptions = {}): QuoteCache {
  const cache = createResultCache<CachedQuote>({ ...opts, keyPrefix: opts.keyPrefix ?? 'quote:' });
  return {
    bodyHashKey: cache.bodyHashKey,
    read: cache.read,
    async write(
      key: string,
      body: Record<string, unknown>,
      priceCents: number,
      recipients: Record<string, string> = {},
    ): Promise<void> {
      await cache.write(key, { body, priceCents, recipients });
    },
    clear: cache.clear,
  };
}
