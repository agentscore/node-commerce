import {
  RATE_LIMIT_JSON_BODY,
  createRateLimiter,
  defaultKeyFromForwardedFor,
  type RateLimitCoreOptions,
} from './_core';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

export interface RateLimitFastifyOptions extends RateLimitCoreOptions {
  /** Bucket key resolver. Default: first hop of `x-forwarded-for`, else `req.ip`, else `'unknown'`. */
  keyResolver?: (req: FastifyRequest) => string;
}

export function rateLimitFastify(opts: RateLimitFastifyOptions = {}): preHandlerHookHandler {
  const limiter = createRateLimiter(opts);
  const keyResolver =
    opts.keyResolver ??
    ((req: FastifyRequest): string => {
      const forwarded = req.headers['x-forwarded-for'];
      const forwardedStr = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      if (forwardedStr) return defaultKeyFromForwardedFor(forwardedStr);
      return req.ip ?? 'unknown';
    });

  return async (req: FastifyRequest, reply: FastifyReply) => {
    const { allowed, remaining, limit } = await limiter.check(keyResolver(req));
    reply.header('X-RateLimit-Limit', String(limit));
    reply.header('X-RateLimit-Remaining', String(remaining));
    if (!allowed) {
      reply.header('Cache-Control', 'no-store');
      reply.code(429).send(RATE_LIMIT_JSON_BODY);
    }
  };
}
