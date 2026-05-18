import { createRateLimit, type RateLimitWebOptions } from './web';

/**
 * Wrap a Next.js App Router route handler with rate limiting. When the bucket is
 * exhausted the wrapper returns a 429 directly; otherwise `handler` runs with the
 * `X-RateLimit-Limit` / `X-RateLimit-Remaining` headers already merged into the
 * outgoing response.
 *
 * ```ts
 * // app/api/route.ts
 * import { withRateLimit } from '@agent-score/commerce/middleware/nextjs';
 *
 * export const POST = withRateLimit({ maxRequests: 60, windowSeconds: 60 }, async (req) => {
 *   return Response.json({ ok: true });
 * });
 * ```
 */
export function withRateLimit<TReq extends Request = Request>(
  opts: RateLimitWebOptions,
  handler: (req: TReq) => Response | Promise<Response>,
): (req: TReq) => Promise<Response> {
  const guard = createRateLimit(opts);
  return async (req: TReq) => {
    const result = await guard(req);
    if (!result.allowed) return result.response;
    const downstream = await handler(req);
    downstream.headers.set('X-RateLimit-Limit', String(result.limit));
    downstream.headers.set('X-RateLimit-Remaining', String(result.remaining));
    return downstream;
  };
}

export { createRateLimit, type RateLimitGuard, type RateLimitGuardResult, type RateLimitWebOptions } from './web';
