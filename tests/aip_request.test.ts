import { describe, expect, it } from 'vitest';
import { buildVerifyContextFromParts, buildVerifyContextFromRequest, hasAgentIdentityHeader } from '../src/aip/request';

const make = (headers: Record<string, string>, url = 'https://wine-merchant.com/checkout', method = 'POST'): Request =>
  new Request(url, { method, headers });

describe('buildVerifyContextFromRequest', () => {
  it('extracts method, path, and authority from the Host header', () => {
    const ctx = buildVerifyContextFromRequest(
      make({ host: 'wine-merchant.com', 'agent-identity': 'jwt.a.b', 'signature-input': 'si', signature: 'sig' }),
    );
    expect(ctx.method).toBe('POST');
    expect(ctx.path).toBe('/checkout');
    expect(ctx.authority).toBe('wine-merchant.com');
    expect(ctx.agentIdentityHeaders).toEqual(['jwt.a.b']);
    expect(ctx.signatureInput).toBe('si');
    expect(ctx.signature).toBe('sig');
  });

  it('falls back to the URL host when no Host header is set', () => {
    const ctx = buildVerifyContextFromRequest(make({ 'agent-identity': 'x.y.z' }, 'https://api.example.com:3003/path'));
    expect(ctx.authority).toBe('api.example.com:3003');
    expect(ctx.path).toBe('/path');
  });

  it('drops the query string from the path', () => {
    const ctx = buildVerifyContextFromRequest(make({ 'agent-identity': 'a.b.c' }, 'https://m.com/wines?sort=price'));
    expect(ctx.path).toBe('/wines');
  });

  it('returns empty headers when none present', () => {
    const ctx = buildVerifyContextFromRequest(make({}));
    expect(ctx.agentIdentityHeaders).toEqual([]);
    expect(ctx.signatureInput).toBeNull();
    expect(ctx.signature).toBeNull();
  });

  it('splits multiple comma-folded Agent-Identity headers into separate tokens', () => {
    // Fetch Headers folds repeated headers into one comma-joined value.
    const h = new Headers();
    h.append('agent-identity', 'aaa.bbb.ccc');
    h.append('agent-identity', 'ddd.eee.fff');
    const ctx = buildVerifyContextFromRequest(new Request('https://m.com/x', { method: 'POST', headers: h }));
    expect(ctx.agentIdentityHeaders).toEqual(['aaa.bbb.ccc', 'ddd.eee.fff']);
  });
});

describe('hasAgentIdentityHeader', () => {
  it('is true when an Agent-Identity header is present', () => {
    expect(hasAgentIdentityHeader(make({ 'agent-identity': 'a.b.c' }))).toBe(true);
  });

  it('is false when absent', () => {
    expect(hasAgentIdentityHeader(make({}))).toBe(false);
  });

  it('is false for an empty header value', () => {
    expect(hasAgentIdentityHeader(make({ 'agent-identity': '' }))).toBe(false);
  });
});

describe('buildVerifyContextFromParts — @path derivation matches the signer', () => {
  const parts = (url: string, host = 'wine.example') => buildVerifyContextFromParts({
    method: 'POST', url, headers: { host, 'agent-identity': 'a.b.c', 'signature-input': 'si', signature: 'sig' },
  });

  it('derives the path from an origin-form target and drops the query', () => {
    expect(parts('/checkout?order=42').path).toBe('/checkout');
  });

  it('preserves a leading // in the path (regression: must equal URL.pathname, not protocol-relative)', () => {
    // The signer signs `new URL('https://wine.example//promo//x').pathname` === '//promo//x';
    // the old `new URL('//promo//x', base)` mis-read it as authority and produced '//x'.
    expect(parts('//promo//x').path).toBe('//promo//x');
    expect(new URL('https://wine.example//promo//x').pathname).toBe('//promo//x'); // pin the contract
  });

  it('normalizes dot-segments identically to the signer', () => {
    expect(parts('/a/../b').path).toBe(new URL('https://wine.example/a/../b').pathname);
  });

  it('handles an absolute URL target', () => {
    expect(parts('https://wine.example/wines/pinot?x=1').path).toBe('/wines/pinot');
  });
});
