/** Shared lazy `ioredis` factory. Used by `quote_cache`, `middleware/_core`,
 *  and `stripe-multichain/pi-cache` so they don't drift on connect-timeout,
 *  TLS handling, or error-logging posture.
 *
 *  `ioredis` is an optional peer dep — callers pass `redisUrl` (or rely on
 *  `process.env.REDIS_URL`); when unset or the lazy import fails, this returns
 *  null and the caller falls back to its in-process `Map`.
 *
 *  Not part of the public API.
 */

/** Minimal Redis surface — each caller intersects with its own usage
 *  (incr/expire for rate-limit, get/set/del for caches). Returning `unknown`
 *  on commands keeps the shape narrow; cast at the call site. */
export interface MinimalRedis {
  on(event: 'error', handler: (err: Error) => void): unknown;
}

export interface CreateRedisOptions {
  /** Override `process.env.REDIS_URL` for tests. */
  url?: string;
  /** Logging label, e.g. `'quote-cache'` / `'rate-limit'` / `'pi-cache'`. */
  label: string;
  /** Connect timeout in ms. Default `3000`. */
  connectTimeout?: number;
  /** Per-request retry cap. Default `1`. */
  maxRetriesPerRequest?: number;
}

/** Lazy-import ioredis and construct a client. Returns null when:
 *   - no URL is configured (caller falls back to in-memory)
 *   - `ioredis` isn't installed (optional peer; caller falls back to in-memory)
 *   - the import throws for any other reason
 *
 *  `rediss://` URLs auto-enable TLS. The error handler logs with the caller's
 *  label so multi-cache deployments can tell which subsystem complained. */
async function tryCreateRedis<T extends MinimalRedis>(opts: CreateRedisOptions): Promise<T | null> {
  const url = opts.url ?? process.env.REDIS_URL;
  if (!url) return null;
  try {
    const mod = (await import('ioredis')) as unknown as { default: new (url: string, opts?: unknown) => T };
    const client = new mod.default(url, {
      connectTimeout: opts.connectTimeout ?? 3000,
      maxRetriesPerRequest: opts.maxRetriesPerRequest ?? 1,
      tls: url.startsWith('rediss://') ? {} : undefined,
    });
    client.on('error', (err) => console.error(`[${opts.label}] Redis error:`, err.message));
    return client;
  } catch {
    return null;
  }
}

/** Memoized-promise variant: call once per caller; subsequent calls return the
 *  same promise. Pairs with the pattern `let p: Promise<T|null> | null = null;
 *  const getRedis = () => (p ??= tryCreateRedis(...))` in callers that want
 *  per-call promise caching without managing the closure themselves. */
export function memoizedRedis<T extends MinimalRedis>(opts: CreateRedisOptions): () => Promise<T | null> {
  let promise: Promise<T | null> | null = null;
  return () => {
    if (!promise) promise = tryCreateRedis<T>(opts);
    return promise;
  };
}
