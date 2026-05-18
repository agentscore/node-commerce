import { describe, expect, it } from 'vitest';
import { withRateLimit } from '../../src/middleware/nextjs';
import { createRateLimit } from '../../src/middleware/web';

describe('createRateLimit (Web Fetch)', () => {
  it('returns allowed result under limit', async () => {
    const guard = createRateLimit({ maxRequests: 5 });
    const result = await guard(new Request('https://x'));
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(5);
    expect(result.remaining).toBe(4);
  });

  it('returns 429 Response when over limit', async () => {
    const guard = createRateLimit({ maxRequests: 1, keyResolver: () => 'fixed' });
    await guard(new Request('https://x'));
    const result = await guard(new Request('https://x'));
    expect(result.allowed).toBe(false);
    expect(result.response).toBeDefined();
    expect(result.response!.status).toBe(429);
  });

  it('reads x-forwarded-for header by default', async () => {
    const guard = createRateLimit({ maxRequests: 5 });
    const req = new Request('https://x', { headers: { 'x-forwarded-for': '1.2.3.4' } });
    const result = await guard(req);
    expect(result.allowed).toBe(true);
  });

  it('respects custom keyResolver', async () => {
    let lastKey = '';
    const guard = createRateLimit({
      maxRequests: 5,
      keyResolver: (req) => {
        lastKey = req.url;
        return lastKey;
      },
    });
    await guard(new Request('https://example.com/a'));
    expect(lastKey).toBe('https://example.com/a');
  });
});

describe('withRateLimit (Next.js)', () => {
  it('wraps a handler with rate limiting', async () => {
    const wrapped = withRateLimit(
      { maxRequests: 5 },
      async (_req) => new Response('ok'),
    );
    const res = await wrapped(new Request('https://x'));
    expect(res.status).toBe(200);
  });

  it('returns 429 when limit exceeded', async () => {
    const wrapped = withRateLimit(
      { maxRequests: 1, keyResolver: () => 'fixed-nextjs' },
      async () => new Response('ok'),
    );
    await wrapped(new Request('https://x'));
    const res = await wrapped(new Request('https://x'));
    expect(res.status).toBe(429);
  });
});
