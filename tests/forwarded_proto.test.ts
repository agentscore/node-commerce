import { describe, expect, it } from 'vitest';
import { computeFirstCheckout } from '../src';
import { applyForwardedProto, readForwardedProto } from '../src/forwarded_proto';

const decodePaymentRequired = (header: string) =>
  JSON.parse(Buffer.from(header, 'base64').toString('utf-8')) as { resource?: { url: string } };

describe('applyForwardedProto', () => {
  it('rewrites the scheme from X-Forwarded-Proto', () => {
    expect(applyForwardedProto('http://agents.example.com/purchase', 'https')).toBe(
      'https://agents.example.com/purchase',
    );
  });
  it('takes the first hop of a proxy chain', () => {
    expect(applyForwardedProto('http://x.com/a', 'https, http')).toBe('https://x.com/a');
  });
  it('passes the URL through untouched when no proto is present (local dev)', () => {
    expect(applyForwardedProto('http://localhost:3003/purchase', undefined)).toBe(
      'http://localhost:3003/purchase',
    );
    expect(applyForwardedProto('http://x.com/a', '')).toBe('http://x.com/a');
  });
  it('keeps the original on a malformed URL', () => {
    expect(applyForwardedProto('not a url', 'https')).toBe('not a url');
  });
});

describe('readForwardedProto', () => {
  it('reads a Web Headers object case-insensitively', () => {
    expect(readForwardedProto(new Headers({ 'X-Forwarded-Proto': 'https' }))).toBe('https');
  });
  it('reads a plain Record under either casing', () => {
    expect(readForwardedProto({ 'x-forwarded-proto': 'https' })).toBe('https');
    expect(readForwardedProto({ 'X-Forwarded-Proto': 'https' })).toBe('https');
  });
  it('returns undefined when absent', () => {
    expect(readForwardedProto({})).toBeUndefined();
    expect(readForwardedProto(new Headers())).toBeUndefined();
  });
});

describe('computeFirstCheckout — resource.url honors X-Forwarded-Proto', () => {
  const rails = {
    rails: {
      tempo: {
        recipient: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        network: 'tempo-mainnet',
        chainId: 4217,
        token: '0x20c000000000000000000000b9537d11c60e8b50',
        symbol: 'USDC.e' as const,
        decimals: 6,
      },
      stripe: { profileId: 'profile_test_x' },
    },
    url: 'https://agents.example.com/purchase',
  };
  const mkHandler = (name: string) =>
    computeFirstCheckout({
      ...rails,
      name,
      unitPriceCents: 1,
      x402Server: {},
      runWork: async () => ({ resultCount: 1, body: { ok: true } }),
    });

  it('emits https:// resource.url when behind a TLS-terminating proxy (http request + X-Forwarded-Proto: https)', async () => {
    const res = await mkHandler('fwd_https').handleWeb(
      new Request('http://agents.example.com/purchase', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
        body: JSON.stringify({ query: 'x' }),
      }),
    );
    expect(res.status).toBe(402);
    const decoded = decodePaymentRequired(res.headers.get('PAYMENT-REQUIRED')!);
    expect(decoded.resource?.url).toBe('https://agents.example.com/purchase');
  });

  it('leaves http:// untouched with no proxy header (local dev direct HTTP)', async () => {
    const res = await mkHandler('fwd_none').handleWeb(
      new Request('http://localhost:3003/purchase', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'x' }),
      }),
    );
    expect(res.status).toBe(402);
    const decoded = decodePaymentRequired(res.headers.get('PAYMENT-REQUIRED')!);
    expect(decoded.resource?.url).toBe('http://localhost:3003/purchase');
  });
});
