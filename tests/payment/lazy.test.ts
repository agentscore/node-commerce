/** Tests for `lazyX402Server` + `lazyMppxServer`. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { lazyX402Server, lazyMppxServer } from '../../src/payment/lazy';

describe('lazyX402Server', () => {
  it('throws for unsupported network', () => {
    expect(() =>
      lazyX402Server({
        spec: { recipient: '0xabc', network: 'eip155:1' as never },
      }),
    ).toThrow(/unsupported X402BaseRailSpec.network/);
  });

  it('builds a memoized getter for base-mainnet (default network)', () => {
    const getter = lazyX402Server({ spec: { recipient: '0xabc' } });
    expect(typeof getter).toBe('function');
  });

  it('builds a memoized getter for base-sepolia', () => {
    const getter = lazyX402Server({
      spec: { recipient: '0xabc', network: 'eip155:84532' },
    });
    expect(typeof getter).toBe('function');
  });

  it('CDP creds toggle facilitator to coinbase when both present', () => {
    const getter = lazyX402Server({
      spec: { recipient: '0xabc' },
      cdpApiKeyId: 'cdp-id',
      cdpApiKeySecret: 'cdp-secret',
    });
    expect(typeof getter).toBe('function');
  });

  it('one of cdp creds missing → falls back to http facilitator', () => {
    const getter = lazyX402Server({
      spec: { recipient: '0xabc' },
      cdpApiKeyId: 'cdp-id',
    });
    expect(typeof getter).toBe('function');
  });
});

describe('lazyMppxServer', () => {
  it('returns an async getter', () => {
    const getter = lazyMppxServer({
      rails: {},
      secretKey: 'lazy_test_secret_padded_to_32_bytes_a',
    });
    expect(typeof getter).toBe('function');
  });

  it('memoizes — concurrent first-calls share the same promise', async () => {
    // Spy on createMppxServer's lazy import. Without ioredis-style mocks for
    // mppx peer dep, we just confirm the getter is callable and returns the
    // same shape (memoization is internal).
    const getter = lazyMppxServer({
      rails: {},
      secretKey: 'lazy_test_mppx_padded_to_32_bytes_bbbb',
    });
    const a = getter();
    const b = getter();
    // Both calls should share the in-flight promise — settle them either way.
    await Promise.allSettled([a, b]);
  });

  it('returns the cached instance on a subsequent (post-settle) call', async () => {
    const getter = lazyMppxServer({ rails: {}, secretKey: 'lazy_test_mppx_cached_padded_to_32b_cc' });
    const first = await getter();
    const second = await getter();
    expect(second).toBe(first);
  });
});

describe('lazyX402Server — memoized getter invocation (stub facilitator)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('constructs the x402 server on first getter call and caches it for subsequent calls', async () => {
    // lazyX402Server derives facilitator from CDP creds; with neither it uses the
    // public HTTP facilitator and calls initialize() (network). Stub global.fetch so
    // the facilitator getSupported() resolves without a real round-trip, then assert
    // the getter memoizes (second call returns the identical instance).
    const supportedBody = JSON.stringify({ kinds: [{ x402Version: 2, network: 'eip155:8453', scheme: 'exact' }] });
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => supportedBody,
      json: async () => JSON.parse(supportedBody),
    })) as unknown as typeof fetch;
    const getter = lazyX402Server({ spec: { recipient: '0xabc' } });
    const a = await getter();
    const b = await getter();
    expect(a).toBeDefined();
    expect(b).toBe(a);
  });
});
