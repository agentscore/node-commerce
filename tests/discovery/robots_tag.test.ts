import { describe, expect, it, vi } from 'vitest';
import {
  applyNoindexHeader,
  defaultDiscoveryPaths,
  isDiscoveryPath,
  noindexNonDiscoveryPaths,
  noindexNonDiscoveryPathsExpress,
  noindexNonDiscoveryPathsFastify,
  wrapNoindexResponse,
} from '../../src/discovery/robots_tag';

describe('defaultDiscoveryPaths', () => {
  it('includes the canonical agent-discovery surfaces', () => {
    for (const p of [
      '/openapi.json',
      '/llms.txt',
      '/skill.md',
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
    expect(isDiscoveryPath('/skill.md')).toBe(true);
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

describe('noindexNonDiscoveryPathsExpress', () => {
  it('sets X-Robots-Tag on non-discovery paths', () => {
    const mw = noindexNonDiscoveryPathsExpress();
    const headers: Record<string, string> = {};
    const next = vi.fn();
    mw(
      { path: '/purchase' },
      { setHeader: (k, v) => { headers[k] = v; } },
      next,
    );
    expect(headers['X-Robots-Tag']).toBe('noindex, nofollow, noarchive, nosnippet');
    expect(next).toHaveBeenCalled();
  });

  it('skips X-Robots-Tag on discovery paths', () => {
    const mw = noindexNonDiscoveryPathsExpress();
    const headers: Record<string, string> = {};
    mw(
      { path: '/llms.txt' },
      { setHeader: (k, v) => { headers[k] = v; } },
      () => {},
    );
    expect(headers['X-Robots-Tag']).toBeUndefined();
  });
});

describe('noindexNonDiscoveryPathsFastify', () => {
  type FastifyHook = (req: { url?: string }, reply: { header: (n: string, v: string) => void }, done: () => void) => void;
  it('registers an onRequest hook that sets the header on non-discovery paths', () => {
    let registeredHook: FastifyHook | undefined;
    const fakeApp = {
      addHook: (event: 'onRequest', handler: FastifyHook) => {
        if (event === 'onRequest') registeredHook = handler;
      },
    };
    const done = vi.fn();
    noindexNonDiscoveryPathsFastify(fakeApp, undefined, done);
    expect(done).toHaveBeenCalled();
    expect(registeredHook).toBeTypeOf('function');

    const replyHeaders: Record<string, string> = {};
    registeredHook!(
      { url: '/purchase?foo=bar' },
      { header: (k: string, v: string) => { replyHeaders[k] = v; } },
      () => {},
    );
    expect(replyHeaders['X-Robots-Tag']).toBe('noindex, nofollow, noarchive, nosnippet');

    const discoveryHeaders: Record<string, string> = {};
    registeredHook!(
      { url: '/openapi.json' },
      { header: (k: string, v: string) => { discoveryHeaders[k] = v; } },
      () => {},
    );
    expect(discoveryHeaders['X-Robots-Tag']).toBeUndefined();
  });
});

describe('wrapNoindexResponse / applyNoindexHeader (Web Fetch + Next.js)', () => {
  it('returns a wrapped Response with X-Robots-Tag on non-discovery paths', () => {
    const original = Response.json({ ok: true });
    const wrapped = wrapNoindexResponse('/purchase', original);
    expect(wrapped.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive, nosnippet');
  });

  it('returns the original Response untouched on discovery paths', () => {
    const original = Response.json({ ok: true });
    const wrapped = wrapNoindexResponse('/.well-known/mpp.json', original);
    expect(wrapped).toBe(original);
    expect(wrapped.headers.get('x-robots-tag')).toBeNull();
  });

  it('applyNoindexHeader is the same helper (Next.js alias)', () => {
    expect(applyNoindexHeader).toBe(wrapNoindexResponse);
  });
});
