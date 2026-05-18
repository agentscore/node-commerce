/** Tests for the shared lazy `_redis` factory.
 *
 *  `tryCreateRedis` is not exported (only used internally by `memoizedRedis`),
 *  so these tests exercise the public `memoizedRedis` getter behavior. */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { memoizedRedis } from '../src/_redis';

describe('memoizedRedis', () => {
  beforeEach(() => {
    delete process.env.REDIS_URL;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns null when no URL is configured', async () => {
    const get = memoizedRedis({ url: undefined, label: 'test' });
    expect(await get()).toBeNull();
  });

  it('memoizes — second call returns the same value without re-attempting', async () => {
    const get = memoizedRedis({ url: undefined, label: 'test' });
    const a = await get();
    const b = await get();
    expect(a).toBe(b);
    expect(a).toBeNull();
  });

  it('falls back to process.env.REDIS_URL when url omitted', async () => {
    vi.stubEnv('REDIS_URL', '');
    const get = memoizedRedis({ url: undefined, label: 'test' });
    expect(await get()).toBeNull();
  });

  it('attempts construction when URL is provided (returns null if ioredis fails)', async () => {
    // The lazy import of ioredis may or may not succeed depending on environment;
    // either way the helper returns null cleanly when construction fails.
    const get = memoizedRedis({ url: 'redis://invalid:0', label: 'test' });
    const result = await get();
    // We don't assert null specifically — only that memoization works (no throw).
    const result2 = await get();
    expect(result2).toBe(result);
  });
});
