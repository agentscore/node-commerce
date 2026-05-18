import { describe, expect, it } from 'vitest';
import {
  createRateLimiter,
  defaultKeyFromForwardedFor,
  RATE_LIMIT_JSON_BODY,
} from '../../src/middleware/_core';

describe('createRateLimiter', () => {
  it('first check inside window → allowed with remaining = max-1', async () => {
    const limiter = createRateLimiter({ windowSeconds: 60, maxRequests: 3 });
    const result = await limiter.check('client-a');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
    expect(result.limit).toBe(3);
  });

  it('counts increments per key', async () => {
    const limiter = createRateLimiter({ windowSeconds: 60, maxRequests: 2 });
    const r1 = await limiter.check('client-b');
    const r2 = await limiter.check('client-b');
    const r3 = await limiter.check('client-b');
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(false); // over the limit
    expect(r3.remaining).toBe(0);
  });

  it('keys are isolated', async () => {
    const limiter = createRateLimiter({ windowSeconds: 60, maxRequests: 1 });
    const a = await limiter.check('client-x');
    const b = await limiter.check('client-y');
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
  });

  it('defaults: window=60, max=60', async () => {
    const limiter = createRateLimiter();
    const r = await limiter.check('any');
    expect(r.limit).toBe(60);
    expect(r.remaining).toBe(59);
  });
});

describe('defaultKeyFromForwardedFor', () => {
  it('returns first hop', () => {
    expect(defaultKeyFromForwardedFor('1.2.3.4, 5.6.7.8')).toBe('1.2.3.4');
  });

  it('strips whitespace', () => {
    expect(defaultKeyFromForwardedFor('  1.2.3.4  , 5.6.7.8')).toBe('1.2.3.4');
  });

  it('returns "unknown" for null / undefined / empty', () => {
    expect(defaultKeyFromForwardedFor(null)).toBe('unknown');
    expect(defaultKeyFromForwardedFor(undefined)).toBe('unknown');
    expect(defaultKeyFromForwardedFor('')).toBe('unknown');
  });
});

describe('RATE_LIMIT_JSON_BODY', () => {
  it('exposes canonical rate-limited error envelope', () => {
    expect(RATE_LIMIT_JSON_BODY).toEqual({
      error: { code: 'rate_limited', message: 'Too many requests' },
    });
  });
});
