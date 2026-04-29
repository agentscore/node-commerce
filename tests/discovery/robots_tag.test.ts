import { describe, expect, it, vi } from 'vitest';
import {
  defaultDiscoveryPaths,
  isDiscoveryPath,
  noindexNonDiscoveryPaths,
} from '../../src/discovery/robots_tag';

describe('defaultDiscoveryPaths', () => {
  it('includes the canonical agent-discovery surfaces', () => {
    for (const p of [
      '/openapi.json',
      '/llms.txt',
      '/.well-known/mpp.json',
      '/.well-known/agent-card.json',
      '/.well-known/ucp',
      '/favicon.png',
      '/favicon.ico',
    ]) {
      expect(defaultDiscoveryPaths.has(p)).toBe(true);
    }
  });
});

describe('isDiscoveryPath', () => {
  it('matches paths in the default set', () => {
    expect(isDiscoveryPath('/openapi.json')).toBe(true);
    expect(isDiscoveryPath('/llms.txt')).toBe(true);
    expect(isDiscoveryPath('/.well-known/mpp.json')).toBe(true);
  });

  it('returns false for arbitrary paths', () => {
    expect(isDiscoveryPath('/purchase')).toBe(false);
    expect(isDiscoveryPath('/orders/abc')).toBe(false);
  });

  it('honors customPaths as additive when replace is not set', () => {
    expect(isDiscoveryPath('/sitemap.xml', { customPaths: ['/sitemap.xml'] })).toBe(true);
    expect(isDiscoveryPath('/openapi.json', { customPaths: ['/sitemap.xml'] })).toBe(true);
  });

  it('honors replace=true to skip the bundled defaults', () => {
    expect(isDiscoveryPath('/openapi.json', { customPaths: ['/sitemap.xml'], replace: true })).toBe(false);
    expect(isDiscoveryPath('/sitemap.xml', { customPaths: ['/sitemap.xml'], replace: true })).toBe(true);
  });
});

describe('noindexNonDiscoveryPaths (Hono middleware)', () => {
  function makeCtx(path: string) {
    const headers: Record<string, string> = {};
    return {
      headers,
      ctx: { req: { path }, header: (k: string, v: string) => { headers[k] = v; } },
    };
  }

  it('sets X-Robots-Tag on non-discovery paths', async () => {
    const mw = noindexNonDiscoveryPaths();
    const { ctx, headers } = makeCtx('/purchase');
    await mw(ctx, async () => {});
    expect(headers['X-Robots-Tag']).toBe('noindex, nofollow, noarchive, nosnippet');
  });

  it('does NOT set X-Robots-Tag on default discovery paths', async () => {
    const mw = noindexNonDiscoveryPaths();
    const { ctx, headers } = makeCtx('/openapi.json');
    await mw(ctx, async () => {});
    expect(headers['X-Robots-Tag']).toBeUndefined();
  });

  it('treats customPaths as discovery (additive)', async () => {
    const mw = noindexNonDiscoveryPaths({ customPaths: ['/sitemap.xml'] });
    const { ctx, headers } = makeCtx('/sitemap.xml');
    await mw(ctx, async () => {});
    expect(headers['X-Robots-Tag']).toBeUndefined();
  });

  it('replacePaths=true ignores defaults', async () => {
    const mw = noindexNonDiscoveryPaths({ customPaths: ['/sitemap.xml'], replacePaths: true });
    const a = makeCtx('/openapi.json');
    await mw(a.ctx, async () => {});
    expect(a.headers['X-Robots-Tag']).toBe('noindex, nofollow, noarchive, nosnippet');
    const b = makeCtx('/sitemap.xml');
    await mw(b.ctx, async () => {});
    expect(b.headers['X-Robots-Tag']).toBeUndefined();
  });

  it('honors a custom robotsTag value', async () => {
    const mw = noindexNonDiscoveryPaths({ robotsTag: 'noindex' });
    const { ctx, headers } = makeCtx('/purchase');
    await mw(ctx, async () => {});
    expect(headers['X-Robots-Tag']).toBe('noindex');
  });

  it('runs next() before applying the header (so handler can override)', async () => {
    const mw = noindexNonDiscoveryPaths();
    const { ctx } = makeCtx('/purchase');
    const next = vi.fn(async () => {});
    await mw(ctx, next);
    expect(next).toHaveBeenCalled();
  });
});
