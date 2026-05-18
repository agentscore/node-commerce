import {
  RATE_LIMIT_JSON_BODY,
  createRateLimiter,
  defaultKeyFromForwardedFor,
  type RateLimitCoreOptions,
} from './_core';

export interface RateLimitWebOptions extends RateLimitCoreOptions {
  /** Bucket key resolver. Default: first hop of `x-forwarded-for`, else `'unknown'`. */
  keyResolver?: (req: Request) => string;
}

export type RateLimitGuardResult =
  | { allowed: true; remaining: number; limit: number; response?: undefined }
  | { allowed: false; remaining: number; limit: number; response: Response };

export type RateLimitGuard = (req: Request) => Promise<RateLimitGuardResult>;

/**
 * Build a rate-limit guard for Web Fetch–style handlers. Call `guard(req)` at the top
 * of your route. When `allowed === false`, return `result.response` directly.
 */
export function createRateLimit(opts: RateLimitWebOptions = {}): RateLimitGuard {
  const limiter = createRateLimiter(opts);
  const keyResolver =
    opts.keyResolver ?? ((req: Request) => defaultKeyFromForwardedFor(req.headers.get('x-forwarded-for')));

  return async (req: Request) => {
    const { allowed, remaining, limit } = await limiter.check(keyResolver(req));
    const baseHeaders = {
      'X-RateLimit-Limit': String(limit),
      'X-RateLimit-Remaining': String(remaining),
    };
    if (!allowed) {
      const response = new Response(JSON.stringify(RATE_LIMIT_JSON_BODY), {
        status: 429,
        headers: { ...baseHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
      return { allowed: false, remaining, limit, response };
    }
    return { allowed: true, remaining, limit };
  };
}
