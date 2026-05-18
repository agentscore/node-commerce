import { describe, expect, it, vi } from 'vitest';
import { createPayToAddressFromStripePI } from '../src/stripe-multichain/pay_to_address';
import type { PiCache } from '../src/stripe-multichain/pi-cache';

vi.mock('mppx', () => ({
  Credential: {
    extractPaymentScheme: (auth: string): string | null =>
      auth.startsWith('Payment ') ? 'Payment' : null,
    fromRequest: (request: Request) => {
      // Encode method + recipient as `Payment <method>:<recipient>` in tests.
      const auth = request.headers.get('authorization') ?? '';
      const payload = auth.replace(/^Payment\s+/, '');
      const [method, recipient] = payload.split(':');
      return {
        challenge: {
          method,
          request: { recipient },
        },
      };
    },
  },
}));

function makeFakeCache(initial: { hasAddress?: boolean } = {}): {
  cache: PiCache;
  cachedAddresses: string[];
  cachedPIs: Array<[string, string]>;
  cachedNetworkAddresses: Array<[string, Record<string, string>]>;
} {
  const cachedAddresses: string[] = [];
  const cachedPIs: Array<[string, string]> = [];
  const cachedNetworkAddresses: Array<[string, Record<string, string>]> = [];
  const cache: PiCache = {
    async cacheAddress(a) { cachedAddresses.push(a); },
    async hasAddress(_a) { return initial.hasAddress ?? false; },
    cachePaymentIntent(addr, pi) { cachedPIs.push([addr, pi]); },
    getPaymentIntentId() { return undefined; },
    cacheNetworkAddresses(pi, addrs) { cachedNetworkAddresses.push([pi, addrs]); },
    getNetworkDepositAddress() { return undefined; },
    stop() {},
  };
  return { cache, cachedAddresses, cachedPIs, cachedNetworkAddresses };
}

function makeFakeStripe(addresses: Record<string, string>) {
  return {
    paymentIntents: {
      create: vi.fn(async () => ({
        id: 'pi_test_123',
        next_action: {
          crypto_display_details: {
            deposit_addresses: Object.fromEntries(
              Object.entries(addresses).map(([n, a]) => [n, { address: a }]),
            ),
          },
        },
      })),
    },
  };
}

describe('createPayToAddressFromStripePI', () => {
  it('reuses the buyer-signed payTo from the credential when MPP auth + address cached', async () => {
    const { cache } = makeFakeCache({ hasAddress: true });
    const request = new Request('https://x.example', {
      method: 'POST',
      headers: { authorization: 'Payment tempo:0xCACHED' },
    });
    const result = await createPayToAddressFromStripePI({
      request,
      amountCents: 100,
      stripe: makeFakeStripe({}),
      piCache: cache,
    });
    expect(result).toBe('0xCACHED');
  });

  it('throws when the credential-bound payTo is NOT in the cache', async () => {
    const { cache } = makeFakeCache({ hasAddress: false });
    const request = new Request('https://x.example', {
      method: 'POST',
      headers: { authorization: 'Payment tempo:0xUNKNOWN' },
    });
    await expect(
      createPayToAddressFromStripePI({
        request,
        amountCents: 100,
        stripe: makeFakeStripe({}),
        piCache: cache,
      }),
    ).rejects.toThrow(/not found in cache or expired/);
  });

  it('mints a fresh PI and caches addresses + PI mapping when no auth header', async () => {
    const { cache, cachedAddresses, cachedPIs, cachedNetworkAddresses } = makeFakeCache();
    const stripe = makeFakeStripe({ tempo: '0xTEMPO', base: '0xBASE', solana: 'SOLABC' });
    const result = await createPayToAddressFromStripePI({
      request: new Request('https://x.example', { method: 'POST' }),
      amountCents: 250,
      stripe,
      piCache: cache,
      orderId: 'order-1',
    });
    expect(result).toBe('0xTEMPO');
    expect(cachedAddresses).toEqual(['0xTEMPO', '0xBASE', 'SOLABC']);
    expect(cachedPIs).toEqual([
      ['0xTEMPO', 'pi_test_123'],
      ['0xBASE', 'pi_test_123'],
      ['SOLABC', 'pi_test_123'],
    ]);
    expect(cachedNetworkAddresses).toEqual([
      ['pi_test_123', { tempo: '0xTEMPO', base: '0xBASE', solana: 'SOLABC' }],
    ]);
    // Idempotency key derived from orderId + amount
    expect(stripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.anything(),
      { idempotencyKey: 'pi-order-1-250' },
    );
  });

  it('falls back to base when preferredNetwork=tempo is missing', async () => {
    const { cache } = makeFakeCache();
    const stripe = makeFakeStripe({ base: '0xBASE' });
    const result = await createPayToAddressFromStripePI({
      request: new Request('https://x.example', { method: 'POST' }),
      amountCents: 100,
      stripe,
      piCache: cache,
    });
    expect(result).toBe('0xBASE');
  });

  it('mints fresh when credential method is stripe (no on-chain recipient bound)', async () => {
    const { cache } = makeFakeCache();
    const stripe = makeFakeStripe({ tempo: '0xFRESH' });
    const result = await createPayToAddressFromStripePI({
      request: new Request('https://x.example', {
        method: 'POST',
        headers: { authorization: 'Payment stripe:does-not-matter' },
      }),
      amountCents: 100,
      stripe,
      piCache: cache,
    });
    expect(result).toBe('0xFRESH');
    expect(stripe.paymentIntents.create).toHaveBeenCalled();
  });

  it('reuses solana credential payTo when cached (parity with tempo path)', async () => {
    const { cache } = makeFakeCache({ hasAddress: true });
    const request = new Request('https://x.example', {
      method: 'POST',
      headers: { authorization: 'Payment solana:SOLCACHED' },
    });
    const result = await createPayToAddressFromStripePI({
      request,
      amountCents: 100,
      stripe: makeFakeStripe({}),
      piCache: cache,
    });
    expect(result).toBe('SOLCACHED');
  });

  it('ignores a non-Payment Authorization header and mints fresh', async () => {
    const { cache } = makeFakeCache();
    const stripe = makeFakeStripe({ tempo: '0xMINTED' });
    const result = await createPayToAddressFromStripePI({
      request: new Request('https://x.example', {
        method: 'POST',
        headers: { authorization: 'Bearer abc123' },
      }),
      amountCents: 100,
      stripe,
      piCache: cache,
    });
    expect(result).toBe('0xMINTED');
    expect(stripe.paymentIntents.create).toHaveBeenCalled();
  });

  it('passes metadata through to the Stripe PaymentIntent create call', async () => {
    const { cache } = makeFakeCache();
    const stripe = makeFakeStripe({ tempo: '0xWITHMETA' });
    await createPayToAddressFromStripePI({
      request: new Request('https://x.example', { method: 'POST' }),
      amountCents: 500,
      stripe,
      piCache: cache,
      metadata: { order_id: 'ord_42', source: 'agent' },
    });
    expect(stripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { order_id: 'ord_42', source: 'agent' } }),
      undefined,
    );
  });

  it('throws when preferred + base + tempo are all missing from the minted PI', async () => {
    // Stripe returns only `solana` while preferredNetwork defaults to `tempo`.
    // Both fallback keys (`base`, `tempo`) are also missing, so the final null guard fires.
    const { cache } = makeFakeCache();
    const stripe = makeFakeStripe({ solana: 'SOLONLY' });
    await expect(
      createPayToAddressFromStripePI({
        request: new Request('https://x.example', { method: 'POST' }),
        amountCents: 100,
        stripe,
        piCache: cache,
      }),
    ).rejects.toThrow(/Failed to resolve pay_to address/);
  });
});
