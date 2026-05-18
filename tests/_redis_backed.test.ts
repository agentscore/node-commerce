/** Tests for the Redis-backed paths in `_redis`, `quote_cache`, and rate-limit
 *  `_core`. Uses vi.mock to stub `ioredis` so the lazy `await import('ioredis')`
 *  path resolves to a fake client without needing a real Redis daemon. */

import { describe, expect, it, vi } from 'vitest';

class FakeRedis {
  // In-memory KV state for `get` / `set` / `del` / `incr` semantics.
  private store = new Map<string, string>();
  private counters = new Map<string, number>();
  private errorHandler: ((err: Error) => void) | null = null;

  constructor(_url?: string, _opts?: unknown) {}

  on(_event: 'error', handler: (err: Error) => void): this {
    this.errorHandler = handler;
    return this;
  }

  async set(key: string, value: string, ..._args: unknown[]): Promise<'OK'> {
    this.store.set(key, value);
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async flushdb(): Promise<'OK'> {
    this.store.clear();
    this.counters.clear();
    return 'OK';
  }

  async incr(key: string): Promise<number> {
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }

  async expire(_key: string, _seconds: number): Promise<number> {
    return 1;
  }

  triggerError(err: Error): void {
    if (this.errorHandler) this.errorHandler(err);
  }
}

vi.mock('ioredis', () => ({
  default: FakeRedis,
}));

describe('redis-backed quote_cache', () => {
  it('writes + reads via Redis when redisUrl is configured', async () => {
    const { createQuoteCache } = await import('../src/quote_cache');
    const cache = createQuoteCache({ redisUrl: 'redis://fake', ttlMs: 60_000 });
    const key = cache.bodyHashKey('test', { q: 'hello' });
    await cache.write(key, { matches: ['a', 'b'] }, 2, { tempo: '0xtempo' });
    const got = await cache.read(key);
    expect(got).not.toBeNull();
    expect(got!.body).toEqual({ matches: ['a', 'b'] });
    expect(got!.priceCents).toBe(2);
    expect(got!.recipients).toEqual({ tempo: '0xtempo' });
  });

  it('clear() drops all Redis entries', async () => {
    const { createQuoteCache } = await import('../src/quote_cache');
    const cache = createQuoteCache({ redisUrl: 'redis://fake', ttlMs: 60_000 });
    const key = cache.bodyHashKey('test', { q: 'clear-test' });
    await cache.write(key, {}, 1);
    expect(await cache.read(key)).not.toBeNull();
    await cache.clear();
    expect(await cache.read(key)).toBeNull();
  });
});

describe('redis-backed rate-limit core', () => {
  it('uses Redis incr+expire when redisUrl set; allows below limit', async () => {
    const { createRateLimiter } = await import('../src/middleware/_core');
    const limiter = createRateLimiter({
      redisUrl: 'redis://fake',
      windowSeconds: 60,
      maxRequests: 3,
      keyPrefix: 'rl-test:',
    });
    const r1 = await limiter.check('ip-1');
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);
    const r2 = await limiter.check('ip-1');
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);
  });

  it('denies when Redis count exceeds maxRequests', async () => {
    const { createRateLimiter } = await import('../src/middleware/_core');
    const limiter = createRateLimiter({
      redisUrl: 'redis://fake-2',
      windowSeconds: 60,
      maxRequests: 1,
      keyPrefix: 'rl-test-deny:',
    });
    await limiter.check('ip-2');
    const r = await limiter.check('ip-2');
    expect(r.allowed).toBe(false);
  });
});

describe('rediss:// (TLS) URL exercise', () => {
  it('accepts rediss:// URL (tls option set)', async () => {
    const { createQuoteCache } = await import('../src/quote_cache');
    const cache = createQuoteCache({ redisUrl: 'rediss://secure-fake', ttlMs: 60_000 });
    const key = cache.bodyHashKey('tls', { q: 'tls' });
    await cache.write(key, { ok: true }, 1);
    const got = await cache.read(key);
    expect(got).not.toBeNull();
  });
});
