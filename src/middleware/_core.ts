import { memoizedRedis, type MinimalRedis } from '../_redis';

export interface RateLimitCoreOptions {
  windowSeconds?: number;
  maxRequests?: number;
  /** Redis connection URL. Default: `process.env.REDIS_URL`. Falls back to in-memory when unset or the lazy `ioredis` import fails. */
  redisUrl?: string;
  /** Per-instance key prefix so multiple limiters sharing a Redis don't collide. */
  keyPrefix?: string;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  limit: number;
}

export interface RateLimiter {
  check(key: string): Promise<RateLimitDecision>;
}

interface RedisLike extends MinimalRedis {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

/** Framework-agnostic rate limiter. Hono / Express / Fastify / Next.js / Web adapters
 *  share one core. Each `createRateLimiter` call owns its own memory map + redis
 *  connection, so multiple instances in the same process don't share state unless
 *  they share a Redis with the same `keyPrefix`. */
export function createRateLimiter(opts: RateLimitCoreOptions = {}): RateLimiter {
  const windowSeconds = opts.windowSeconds ?? 60;
  const maxRequests = opts.maxRequests ?? 60;
  const keyPrefix = opts.keyPrefix ?? 'rl:';

  const memMap = new Map<string, { count: number; resetAt: number }>();
  const getRedis = memoizedRedis<RedisLike>({ url: opts.redisUrl, label: 'rate-limit' });

  const checkMem = (key: string): RateLimitDecision => {
    const now = Date.now();
    const entry = memMap.get(key);
    if (!entry || entry.resetAt < now) {
      memMap.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return { allowed: true, remaining: maxRequests - 1, limit: maxRequests };
    }
    entry.count++;
    const remaining = Math.max(0, maxRequests - entry.count);
    return { allowed: entry.count <= maxRequests, remaining, limit: maxRequests };
  };

  return {
    async check(key: string): Promise<RateLimitDecision> {
      const r = await getRedis();
      if (!r) return checkMem(key);
      try {
        const fullKey = `${keyPrefix}${key}`;
        const count = await r.incr(fullKey);
        if (count === 1) await r.expire(fullKey, windowSeconds);
        const remaining = Math.max(0, maxRequests - count);
        return { allowed: count <= maxRequests, remaining, limit: maxRequests };
      } catch {
        return checkMem(key);
      }
    },
  };
}

export const RATE_LIMIT_JSON_BODY = {
  error: { code: 'rate_limited', message: 'Too many requests' },
} as const;

/** Default key resolver: first hop of `x-forwarded-for`, else `'unknown'`. Works on any
 *  framework's request once you adapt the header read. */
export function defaultKeyFromForwardedFor(forwardedFor: string | null | undefined): string {
  if (!forwardedFor) return 'unknown';
  return forwardedFor.split(',')[0]?.trim() || 'unknown';
}
