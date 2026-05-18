import express from 'express';
import Fastify from 'fastify';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { rateLimitExpress } from '../../src/middleware/express';
import { rateLimitFastify } from '../../src/middleware/fastify';
import { rateLimitHono } from '../../src/middleware/hono';
import { withRateLimit } from '../../src/middleware/nextjs';
import { createRateLimit } from '../../src/middleware/web';

function makeHono(maxRequests = 3) {
  const app = new Hono();
  app.use('*', rateLimitHono({ maxRequests, windowSeconds: 60, keyResolver: () => 'fixed' }));
  app.get('/health', (c) => c.json({ ok: true }));
  return app;
}

describe('rateLimitHono', () => {
  it('allows the first N requests, then 429s', async () => {
    const app = makeHono(3);
    const r1 = await app.request('/health');
    const r2 = await app.request('/health');
    const r3 = await app.request('/health');
    const r4 = await app.request('/health');
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
    expect(r4.status).toBe(429);
    expect(r1.headers.get('X-RateLimit-Limit')).toBe('3');
    expect(r1.headers.get('X-RateLimit-Remaining')).toBe('2');
    expect(r4.headers.get('Cache-Control')).toBe('no-store');
    const body = await r4.json();
    expect(body).toEqual({ error: { code: 'rate_limited', message: 'Too many requests' } });
  });

  it('isolates buckets across separate factory calls', async () => {
    const a = new Hono();
    a.use('*', rateLimitHono({ maxRequests: 1, keyResolver: () => 'k' }));
    a.get('/p', (c) => c.text('ok'));
    const b = new Hono();
    b.use('*', rateLimitHono({ maxRequests: 1, keyResolver: () => 'k' }));
    b.get('/p', (c) => c.text('ok'));

    expect((await a.request('/p')).status).toBe(200);
    expect((await b.request('/p')).status).toBe(200);
    expect((await a.request('/p')).status).toBe(429);
    expect((await b.request('/p')).status).toBe(429);
  });

  it('falls back to "unknown" when no x-forwarded-for is present', async () => {
    const app = new Hono();
    app.use('*', rateLimitHono({ maxRequests: 1 }));
    app.get('/health', (c) => c.json({ ok: true }));
    const r1 = await app.request('/health');
    const r2 = await app.request('/health');
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(429);
  });
});

describe('rateLimitExpress', () => {
  it('allows then 429s using req.ip when no forwarded header', async () => {
    const app = express();
    app.use(rateLimitExpress({ maxRequests: 2, keyResolver: () => 'fixed' }));
    app.get('/health', (req, res) => {
      res.json({ ok: true });
    });
    const baseUrl = await new Promise<string>((resolve) => {
      const server = app.listen(0, () => {
        const port = (server.address() as { port: number }).port;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
    const r1 = await fetch(`${baseUrl}/health`);
    const r2 = await fetch(`${baseUrl}/health`);
    const r3 = await fetch(`${baseUrl}/health`);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
    expect(r1.headers.get('x-ratelimit-limit')).toBe('2');
    expect(r3.headers.get('cache-control')).toBe('no-store');
  });
});

describe('rateLimitFastify', () => {
  it('allows then 429s', async () => {
    const app = Fastify();
    app.addHook('preHandler', rateLimitFastify({ maxRequests: 2, keyResolver: () => 'fixed' }));
    app.get('/health', async () => ({ ok: true }));
    await app.ready();
    const r1 = await app.inject({ method: 'GET', url: '/health' });
    const r2 = await app.inject({ method: 'GET', url: '/health' });
    const r3 = await app.inject({ method: 'GET', url: '/health' });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(429);
    expect(r1.headers['x-ratelimit-limit']).toBe('2');
    expect(r3.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(r3.body)).toEqual({ error: { code: 'rate_limited', message: 'Too many requests' } });
    await app.close();
  });
});

describe('createRateLimit (Web)', () => {
  it('returns allowed=true with limit headers when under cap', async () => {
    const guard = createRateLimit({ maxRequests: 2, keyResolver: () => 'fixed' });
    const r1 = await guard(new Request('http://x/'));
    expect(r1.allowed).toBe(true);
    expect(r1.limit).toBe(2);
    expect(r1.remaining).toBe(1);
    const r2 = await guard(new Request('http://x/'));
    expect(r2.allowed).toBe(true);
    const r3 = await guard(new Request('http://x/'));
    expect(r3.allowed).toBe(false);
    if (r3.allowed) throw new Error('unreachable');
    expect(r3.response.status).toBe(429);
    expect(r3.response.headers.get('Content-Type')).toBe('application/json');
    expect(r3.response.headers.get('X-RateLimit-Limit')).toBe('2');
    expect(await r3.response.json()).toEqual({ error: { code: 'rate_limited', message: 'Too many requests' } });
  });
});

describe('withRateLimit (Next.js)', () => {
  it('forwards X-RateLimit headers onto the handler response', async () => {
    const handler = withRateLimit(
      { maxRequests: 2, keyResolver: () => 'fixed' },
      async () => Response.json({ ok: true }),
    );
    const r1 = await handler(new Request('http://x/'));
    expect(r1.status).toBe(200);
    expect(r1.headers.get('X-RateLimit-Limit')).toBe('2');
    expect(r1.headers.get('X-RateLimit-Remaining')).toBe('1');
    await handler(new Request('http://x/'));
    const r3 = await handler(new Request('http://x/'));
    expect(r3.status).toBe(429);
  });
});
