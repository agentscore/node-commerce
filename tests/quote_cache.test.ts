import { describe, expect, it } from 'vitest';
import { createQuoteCache } from '../src/quote_cache';

describe('createQuoteCache', () => {
  it('writes + reads back a quote', async () => {
    const cache = createQuoteCache();
    const key = cache.bodyHashKey('search', { query: 'acme', limit: 5 });
    await cache.write(key, { matches: ['a', 'b'] }, 200, { tempo: '0xt', x402_base: '0xb' });
    const got = await cache.read(key);
    expect(got).toEqual({ body: { matches: ['a', 'b'] }, priceCents: 200, recipients: { tempo: '0xt', x402_base: '0xb' } });
  });

  it('defaults recipients to empty object when not provided', async () => {
    const cache = createQuoteCache();
    const key = cache.bodyHashKey('search', { q: 'x' });
    await cache.write(key, {}, 1);
    expect((await cache.read(key))?.recipients).toEqual({});
  });

  it('returns null on miss', async () => {
    const cache = createQuoteCache();
    const key = cache.bodyHashKey('search', { query: 'never_written' });
    expect(await cache.read(key)).toBeNull();
  });

  it('hashes identical bodies to identical keys regardless of property order', () => {
    const cache = createQuoteCache();
    const k1 = cache.bodyHashKey('search', { query: 'acme', limit: 5 });
    const k2 = cache.bodyHashKey('search', { limit: 5, query: 'acme' });
    expect(k1).toBe(k2);
  });

  it('different prefixes yield different keys for the same body', () => {
    const cache = createQuoteCache();
    const body = { query: 'acme' };
    expect(cache.bodyHashKey('person_search', body)).not.toBe(cache.bodyHashKey('company_search', body));
  });

  it('expires entries after the configured TTL', async () => {
    const cache = createQuoteCache({ ttlMs: 10 });
    const key = cache.bodyHashKey('search', { query: 'x' });
    await cache.write(key, {}, 1);
    expect(await cache.read(key)).not.toBeNull();
    await new Promise((r) => setTimeout(r, 25));
    expect(await cache.read(key)).toBeNull();
  });

  it('clear() drops all entries', async () => {
    const cache = createQuoteCache();
    const k = cache.bodyHashKey('search', { q: '1' });
    await cache.write(k, {}, 1);
    await cache.clear();
    expect(await cache.read(k)).toBeNull();
  });
});

describe('createResultCache', () => {
  it('stores and replays arbitrary JSON values keyed by body hash', async () => {
    const { createResultCache } = await import('../src/quote_cache');
    const cache = createResultCache<{ matches: string[]; upstreamCostUsd: number }>();
    const key = cache.bodyHashKey('enrich', { domain: 'acme.com' });
    expect(await cache.read(key)).toBeNull();
    await cache.write(key, { matches: ['a', 'b'], upstreamCostUsd: 0.04 });
    expect(await cache.read(key)).toEqual({ matches: ['a', 'b'], upstreamCostUsd: 0.04 });
  });

  it('hashes identical bodies to identical keys regardless of property order', async () => {
    const { createResultCache } = await import('../src/quote_cache');
    const cache = createResultCache();
    expect(cache.bodyHashKey('enrich', { a: 1, b: 2 })).toBe(cache.bodyHashKey('enrich', { b: 2, a: 1 }));
  });

  it('expires entries after the configured TTL', async () => {
    const { createResultCache } = await import('../src/quote_cache');
    const cache = createResultCache<string>({ ttlMs: 10 });
    const key = cache.bodyHashKey('enrich', { q: 'x' });
    await cache.write(key, 'value');
    expect(await cache.read(key)).toBe('value');
    await new Promise((r) => setTimeout(r, 25));
    expect(await cache.read(key)).toBeNull();
  });

  it('createQuoteCache round-trips through the same primitive (shape preserved)', async () => {
    const { createQuoteCache } = await import('../src/quote_cache');
    const cache = createQuoteCache();
    const key = cache.bodyHashKey('search', { q: 'acme' });
    await cache.write(key, { total: 2 }, 150, { x402_base: '0xabc' });
    expect(await cache.read(key)).toEqual({
      body: { total: 2 },
      priceCents: 150,
      recipients: { x402_base: '0xabc' },
    });
  });
});
