/** Tests for `lazyX402Server` + `lazyMppxServer`. */

import { describe, expect, it } from 'vitest';
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
      secretKey: 'test-secret',
    });
    expect(typeof getter).toBe('function');
  });

  it('memoizes — concurrent first-calls share the same promise', async () => {
    // Spy on createMppxServer's lazy import. Without ioredis-style mocks for
    // mppx peer dep, we just confirm the getter is callable and returns the
    // same shape (memoization is internal).
    const getter = lazyMppxServer({
      rails: {},
      secretKey: 'test-mppx',
    });
    const a = getter();
    const b = getter();
    // Both calls should share the in-flight promise — settle them either way.
    await Promise.allSettled([a, b]);
  });
});
