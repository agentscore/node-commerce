/**
 * Echo the request-id middleware sets on the context as an `X-Request-ID`
 * response header. Agents correlate logs across 4xx retries by reading this.
 *
 * Hono variant — reads `c.get('requestId')` populated by `hono/request-id`.
 * Express / Fastify / Next.js / Web Fetch variants will follow when consumers
 * need them.
 *
 * Universal for AgentScore commerce merchants: every retry-loop pattern
 * (probe-then-pay, 403-then-resume, settle-then-retry) benefits from the
 * agent being able to grep server logs for the request id.
 *
 * @example
 * ```ts
 * import { Hono } from 'hono';
 * import { requestId } from 'hono/request-id';
 * import { echoRequestIdHeaderHono } from '@agent-score/commerce/discovery';
 *
 * const app = new Hono();
 * app.use('*', requestId());
 * app.use('*', echoRequestIdHeaderHono());
 * ```
 */
export function echoRequestIdHeaderHono(): (
  c: {
    get: (key: 'requestId') => string | undefined;
    header: (name: string, value: string) => void;
  },
  next: () => Promise<void>,
) => Promise<void> {
  return async (c, next) => {
    await next();
    const id = c.get('requestId');
    if (id) c.header('X-Request-ID', id);
  };
}
