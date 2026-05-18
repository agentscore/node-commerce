import {
  RATE_LIMIT_JSON_BODY,
  createRateLimiter,
  defaultKeyFromForwardedFor,
  type RateLimitCoreOptions,
} from './_core';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface RateLimitExpressOptions extends RateLimitCoreOptions {
  /** Bucket key resolver. Default: first hop of `x-forwarded-for`, else req.ip, else `'unknown'`. */
  keyResolver?: (req: Request) => string;
}

export function rateLimitExpress(opts: RateLimitExpressOptions = {}): RequestHandler {
  const limiter = createRateLimiter(opts);
  const keyResolver =
    opts.keyResolver ??
    ((req: Request): string => {
      const forwarded = req.header('x-forwarded-for');
      if (forwarded) return defaultKeyFromForwardedFor(forwarded);
      return req.ip ?? 'unknown';
    });

  return async (req: Request, res: Response, next: NextFunction) => {
    const { allowed, remaining, limit } = await limiter.check(keyResolver(req));
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    if (!allowed) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(429).json(RATE_LIMIT_JSON_BODY);
      return;
    }
    next();
  };
}
