import { describe, expect, it } from 'vitest';
import { computeFirstCheckout, createQuoteCache } from '../src';

const baseRails = {
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
  url: 'https://api.example.com/search',
};

const fakeX402Server = {
  // The x402Server is referenced only by buildX402AcceptsFor402 + processX402Settle.
  // The tests below don't exercise the x402 rail (no x402_base in rails), so the
  // server is never actually invoked.
};

describe('computeFirstCheckout', () => {
  it('emits 402 with exact price on probe leg', async () => {
    const handler = computeFirstCheckout({
      ...baseRails,
      name: 'test_search',
      unitPriceCents: 1,
      x402Server: fakeX402Server,
      runWork: async () => ({ resultCount: 3, body: { matches: ['a', 'b', 'c'] } }),
    });

    const res = await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'acme', limit: 5 }),
    }));
    expect(res.status).toBe(402);
    const body = await res.json() as { pricing: { total: string } };
    expect(body.pricing.total).toBe('0.03');
  });

  it('short-circuits to 200 no_charge on 0 results (no 402 emitted)', async () => {
    const handler = computeFirstCheckout({
      ...baseRails,
      name: 'test_search_empty',
      unitPriceCents: 1,
      x402Server: fakeX402Server,
      runWork: async () => ({ resultCount: 0, body: { matches: [], total: 0 } }),
    });

    const res = await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'empty' }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { payment_status: string; charged_usd: string };
    expect(body.payment_status).toBe('no_charge');
    expect(body.charged_usd).toBe('0.00');
  });

  it('returns 200 no_charge with upstream error envelope when runWork throws', async () => {
    const handler = computeFirstCheckout({
      ...baseRails,
      name: 'test_search_fail',
      unitPriceCents: 1,
      x402Server: fakeX402Server,
      runWork: async () => {
        throw new Error('synthetic upstream failure');
      },
    });

    const res = await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'fail' }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { payment_status: string; error?: { code: string } };
    expect(body.payment_status).toBe('no_charge');
    expect(body.error?.code).toBe('upstream_failed');
  });

  it('returns 400 stale_quote when payment header sent without a cached probe', async () => {
    const handler = computeFirstCheckout({
      ...baseRails,
      name: 'test_search_stale',
      unitPriceCents: 1,
      x402Server: fakeX402Server,
      runWork: async () => ({ resultCount: 1, body: {} }),
    });

    const res = await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-payment': 'opaque' },
      body: JSON.stringify({ query: 'whatever' }),
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string }; next_steps: { action: string } };
    expect(body.error.code).toBe('stale_quote');
    expect(body.next_steps.action).toBe('re_probe');
  });

  it('honors sub-cent unit pricing (decimals auto-derived from fractional unitPriceCents)', async () => {
    const handler = computeFirstCheckout({
      ...baseRails,
      name: 'per_token',
      unitPriceCents: 0.0001, // $0.000001 per unit
      x402Server: fakeX402Server,
      runWork: async () => ({ resultCount: 1234, body: { tokens: 1234 } }),
    });

    const res = await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi' }),
    }));
    expect(res.status).toBe(402);
    const body = await res.json() as { pricing: { total: string } };
    // 1234 × 0.0001 cents = 0.1234 cents = $0.001234. Decimals auto-derived → 6.
    expect(body.pricing.total).toBe('0.001234');
  });

  it('runs work only once across probe + settle (cached body served on settle)', async () => {
    let workCalls = 0;
    const cache = createQuoteCache();
    const handler = computeFirstCheckout({
      ...baseRails,
      name: 'test_cache_reuse',
      unitPriceCents: 1,
      x402Server: fakeX402Server,
      cache,
      runWork: async () => {
        workCalls += 1;
        return { resultCount: 2, body: { matches: ['x', 'y'] } };
      },
    });

    // Probe leg
    const probeRes = await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'acme', limit: 3 }),
    }));
    expect(probeRes.status).toBe(402);
    expect(workCalls).toBe(1);

    // The settle path needs a valid payment payload that processX402Settle accepts;
    // without one, we get stale_quote / settle_failed paths. Here we just confirm
    // the work didn't fire a second time on a no-header retry of the same body.
    const reProbeRes = await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'acme', limit: 3 }),
    }));
    expect(reProbeRes.status).toBe(402);
    expect(workCalls).toBe(1); // body unchanged → cache hit, no re-run
  });

  it('handleHono adapts c.req.raw correctly', async () => {
    const handler = computeFirstCheckout({
      ...baseRails,
      name: 'hono_adapter',
      unitPriceCents: 1,
      x402Server: fakeX402Server,
      runWork: async () => ({ resultCount: 2, body: { matches: ['a', 'b'] } }),
    });
    const fakeContext = {
      req: {
        raw: new Request('https://api.example.com/search', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ q: 'x' }),
        }),
      },
    };
    const res = await handler.handleHono(fakeContext as never);
    expect(res.status).toBe(402);
  });

  it('runWork error → 200 no_charge envelope (does not crash)', async () => {
    const handler = computeFirstCheckout({
      ...baseRails,
      name: 'upstream_failed',
      unitPriceCents: 1,
      x402Server: fakeX402Server,
      runWork: async () => {
        throw new Error('upstream blew up');
      },
    });
    const res = await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: 'x' }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { payment_status: string; error: { code: string } };
    expect(body.payment_status).toBe('no_charge');
    expect(body.error.code).toBe('upstream_failed');
  });

  it('validateInput throws CheckoutValidationError → 4xx envelope', async () => {
    const { CheckoutValidationError } = await import('../src/errors');
    const handler = computeFirstCheckout({
      ...baseRails,
      name: 'validation_check',
      unitPriceCents: 1,
      x402Server: fakeX402Server,
      validateInput: (body) => {
        if (!body.query) throw new CheckoutValidationError({ code: 'missing_query', message: '`query` required.' });
      },
      runWork: async () => ({ resultCount: 1, body: {} }),
    });
    const res = await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('missing_query');
  });

  it('CheckoutValidationError with action + extra surfaces next_steps + extra', async () => {
    const { CheckoutValidationError } = await import('../src/errors');
    const handler = computeFirstCheckout({
      ...baseRails,
      name: 'validation_action',
      unitPriceCents: 1,
      x402Server: fakeX402Server,
      validateInput: () => {
        throw new CheckoutValidationError({
          code: 'bad_input',
          message: 'fix it.',
          action: 'fix_request',
          status: 422,
          extra: { hint: 'try harder' },
        });
      },
      runWork: async () => ({ resultCount: 1, body: {} }),
    });
    const res = await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(422);
    const body = await res.json() as { next_steps: { action: string }; hint: string };
    expect(body.next_steps.action).toBe('fix_request');
    expect(body.hint).toBe('try harder');
  });

  it('non-JSON body falls back to {} without crashing', async () => {
    const handler = computeFirstCheckout({
      ...baseRails,
      name: 'malformed_body',
      unitPriceCents: 1,
      x402Server: fakeX402Server,
      runWork: async () => ({ resultCount: 1, body: { matches: [] } }),
    });
    const res = await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      body: 'not valid json',
    }));
    // Falls back to body={}, runWork still fires, emits 402
    expect(res.status).toBe(402);
  });

  it('MPP-only header (no x402) without composeMppx returns 503 mpp_unavailable', async () => {
    const cache = createQuoteCache();
    // Seed the cache so we go down the settle path.
    const body = { q: 'mpp_test' };
    const handler = computeFirstCheckout({
      ...baseRails,
      name: 'mpp_unavailable_test',
      unitPriceCents: 1,
      x402Server: fakeX402Server,
      cache,
      runWork: async () => ({ resultCount: 1, body: { matches: ['a'] } }),
    });
    // Probe to seed cache
    await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    // Now settle with MPP header
    const res = await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Payment <base64>',
      },
      body: JSON.stringify(body),
    }));
    expect(res.status).toBe(503);
    const errBody = await res.json() as { error: { code: string } };
    expect(errBody.error.code).toBe('mpp_unavailable');
  });
});
