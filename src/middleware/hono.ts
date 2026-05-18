import {
  RATE_LIMIT_JSON_BODY,
  createRateLimiter,
  defaultKeyFromForwardedFor,
  type RateLimitCoreOptions,
} from './_core';
import type { Context, MiddlewareHandler, Next } from 'hono';

export interface RateLimitHonoOptions extends RateLimitCoreOptions {
  /** Bucket key resolver. Default: first hop of `x-forwarded-for`, else `'unknown'`. */
  keyResolver?: (c: Context) => string;
}

export function rateLimitHono(opts: RateLimitHonoOptions = {}): MiddlewareHandler {
  const limiter = createRateLimiter(opts);
  const keyResolver = opts.keyResolver ?? ((c: Context) => defaultKeyFromForwardedFor(c.req.header('x-forwarded-for')));

  return async (c: Context, next: Next) => {
    const { allowed, remaining, limit } = await limiter.check(keyResolver(c));
    c.header('X-RateLimit-Limit', String(limit));
    c.header('X-RateLimit-Remaining', String(remaining));
    if (!allowed) {
      return c.json(RATE_LIMIT_JSON_BODY, 429, { 'Cache-Control': 'no-store' });
    }
    await next();
  };
}
