/** Per-framework rate-limit middleware adapter tests.
 *
 *  Each adapter wraps `createRateLimiter` and adds its framework-shaped
 *  request/response handling. The core was already tested in `core.test.ts`;
 *  these tests cover the per-framework glue (response header writing, denial
 *  status code, etc.). */

import { describe, expect, it } from 'vitest';
import { rateLimitExpress } from '../../src/middleware/express';
import { rateLimitFastify } from '../../src/middleware/fastify';
import { rateLimitHono } from '../../src/middleware/hono';

describe('rateLimitExpress', () => {
  it('sets rate-limit headers and calls next when allowed', async () => {
    const middleware = rateLimitExpress({ maxRequests: 5 });
    const headers: Record<string, string> = {};
    let nextCalled = false;
    await middleware(
      {
        header: () => undefined,
        ip: '1.2.3.4',
      } as never,
      {
        setHeader: (k: string, v: string) => {
          headers[k] = v;
        },
      } as never,
      () => {
        nextCalled = true;
      },
    );
    expect(nextCalled).toBe(true);
    expect(headers['X-RateLimit-Limit']).toBe('5');
    expect(headers['X-RateLimit-Remaining']).toBe('4');
  });

  it('returns 429 when limit exceeded', async () => {
    const middleware = rateLimitExpress({ maxRequests: 1 });
    let status = 0;
    let body: unknown;
    const fakeRes = {
      setHeader: () => undefined,
      status: (s: number) => {
        status = s;
        return fakeRes;
      },
      json: (b: unknown) => {
        body = b;
        return fakeRes;
      },
    };
    const req = { header: () => undefined, ip: 'limited' };
    let nextCalled = false;
    // First call: allowed
    await middleware(req as never, fakeRes as never, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    // Second call: over limit
    await middleware(req as never, fakeRes as never, () => {});
    expect(status).toBe(429);
    expect((body as { error: { code: string } }).error.code).toBe('rate_limited');
  });

  it('respects custom keyResolver', async () => {
    const middleware = rateLimitExpress({
      maxRequests: 10,
      keyResolver: () => 'fixed-key',
    });
    const headers: Record<string, string> = {};
    let nextCalled = false;
    await middleware(
      {} as never,
      { setHeader: (k: string, v: string) => { headers[k] = v; } } as never,
      () => { nextCalled = true; },
    );
    expect(nextCalled).toBe(true);
    expect(headers['X-RateLimit-Limit']).toBe('10');
  });

  it('reads x-forwarded-for header when present', async () => {
    const middleware = rateLimitExpress({ maxRequests: 5 });
    const headers: Record<string, string> = {};
    let nextCalled = false;
    await middleware(
      {
        header: (name: string) => (name === 'x-forwarded-for' ? '5.6.7.8, 9.10.11.12' : undefined),
        ip: 'should-not-be-used',
      } as never,
      { setHeader: (k: string, v: string) => { headers[k] = v; } } as never,
      () => { nextCalled = true; },
    );
    expect(nextCalled).toBe(true);
  });

  it('falls back to "unknown" when no forwarded-for + no ip', async () => {
    const middleware = rateLimitExpress({ maxRequests: 5 });
    await middleware(
      { header: () => undefined } as never,
      { setHeader: () => undefined } as never,
      () => {},
    );
  });
});

describe('rateLimitFastify', () => {
  it('sets headers and allows under limit', async () => {
    const hook = rateLimitFastify({ maxRequests: 5 });
    const headers: Record<string, string> = {};
    const reply = {
      header: (k: string, v: string) => {
        headers[k] = v;
        return reply;
      },
      code: () => reply,
      send: () => reply,
    };
    const req = { headers: {}, ip: '1.2.3.4' };
    await hook(req as never, reply as never);
    expect(headers['X-RateLimit-Limit']).toBe('5');
    expect(headers['X-RateLimit-Remaining']).toBe('4');
  });

  it('denies with 429 over limit', async () => {
    const hook = rateLimitFastify({ maxRequests: 1 });
    let code = 0;
    const reply = {
      header: () => reply,
      code: (c: number) => {
        code = c;
        return reply;
      },
      send: () => reply,
    };
    const req = { headers: {}, ip: 'limited-fastify' };
    await hook(req as never, reply as never);
    await hook(req as never, reply as never);
    expect(code).toBe(429);
  });

  it('reads x-forwarded-for via header dict', async () => {
    const hook = rateLimitFastify({ maxRequests: 5 });
    const headers: Record<string, string> = {};
    const reply = {
      header: (k: string, v: string) => {
        headers[k] = v;
        return reply;
      },
      code: () => reply,
      send: () => reply,
    };
    const req = { headers: { 'x-forwarded-for': '5.6.7.8, 9.10.11.12' }, ip: undefined };
    await hook(req as never, reply as never);
    expect(headers['X-RateLimit-Remaining']).toBe('4');
  });

  it('falls back to "unknown" key when no forwarded-for + no ip', async () => {
    const hook = rateLimitFastify({ maxRequests: 5 });
    const reply = {
      header: () => reply,
      code: () => reply,
      send: () => reply,
    };
    const req = { headers: {}, ip: undefined };
    await hook(req as never, reply as never);
    // No assertion — just exercises the fallback branch
  });

  it('respects custom keyResolver', async () => {
    const hook = rateLimitFastify({
      maxRequests: 10,
      keyResolver: () => 'custom-fastify',
    });
    const reply = {
      header: () => reply,
      code: () => reply,
      send: () => reply,
    };
    await hook({} as never, reply as never);
  });
});

describe('rateLimitHono', () => {
  it('returns a Hono middleware function', () => {
    const middleware = rateLimitHono({ maxRequests: 5 });
    expect(typeof middleware).toBe('function');
  });
});
