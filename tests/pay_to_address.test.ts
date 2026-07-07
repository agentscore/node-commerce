import { describe, expect, it, vi } from 'vitest';
import { createPayToAddressFromStripePI, mintMultichainRecipients } from '../src/stripe-multichain/pay_to_address';
import type { PiCache } from '../src/stripe-multichain/pi-cache';

vi.mock('mppx', () => ({
  Credential: {
    extractPaymentScheme: (auth: string): string | null =>
      auth.startsWith('Payment ') ? 'Payment' : null,
    fromRequest: (request: Request) => {
      // Encode method + recipient as `Payment <method>:<recipient>` in tests.
      // Special-case `Payment <malformed>` (no colon) → throw, mirroring mppx's
      // InvalidCredentialEncodingError for unparseable credentials.
      const auth = request.headers.get('authorization') ?? '';
      const payload = auth.replace(/^Payment\s+/, '');
      if (!payload.includes(':')) {
        const err = new Error('Invalid base64url or JSON.');
        err.name = 'InvalidCredentialEncodingError';
        throw err;
      }
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

// Runs first so it observes the once-per-process warning before other mint tests fire it.
describe('rotating Solana mint warning', () => {
  it('warns when a per-PI Solana recipient is minted; a static Solana recipient takes the safe path', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Rotating: default networks include solana, no staticRecipients → warn.
    const { cache } = makeFakeCache();
    await mintMultichainRecipients({
      request: new Request('https://x.example', { method: 'POST' }),
      amountCents: 250,
      stripe: makeFakeStripe({ tempo: '0xT', base: '0xB', solana: 'SOL1' }),
      piCache: cache,
    });
    expect(
      warnSpy.mock.calls.some(
        (c) => /solana/i.test(String(c[0])) && /staticRecipients/.test(String(c[0])),
      ),
    ).toBe(true);

    // Static: solana is filtered out of the Stripe mint and served from staticRecipients.
    const { cache: cache2 } = makeFakeCache();
    const stripe2 = makeFakeStripe({ tempo: '0xT2', base: '0xB2' });
    const res = await mintMultichainRecipients({
      request: new Request('https://x.example', { method: 'POST' }),
      amountCents: 250,
      stripe: stripe2,
      piCache: cache2,
      networks: ['tempo', 'base', 'solana'],
      staticRecipients: { solana: 'STATICSOL' },
    });
    expect(res.recipients.solana).toBe('STATICSOL');
    warnSpy.mockRestore();
  });
});

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

  it('throws CheckoutValidationError(401, invalid_credential) when the credential-bound payTo is NOT in the cache', async () => {
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
    ).rejects.toMatchObject({
      name: 'CheckoutValidationError',
      code: 'invalid_credential',
      status: 401,
    });
  });

  it('throws CheckoutValidationError(401, invalid_credential) when Authorization: Payment is malformed', async () => {
    const { cache } = makeFakeCache({ hasAddress: true });
    const request = new Request('https://x.example', {
      method: 'POST',
      headers: { authorization: 'Payment fake.jwt.bogus' },
    });
    await expect(
      createPayToAddressFromStripePI({
        request,
        amountCents: 100,
        stripe: makeFakeStripe({}),
        piCache: cache,
      }),
    ).rejects.toMatchObject({
      name: 'CheckoutValidationError',
      code: 'invalid_credential',
      status: 401,
    });
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

  it('throws CheckoutValidationError(503, payment_provider_unavailable) when preferred + base + tempo are all missing', async () => {
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
    ).rejects.toMatchObject({
      name: 'CheckoutValidationError',
      code: 'payment_provider_unavailable',
      status: 503,
    });
  });

  describe('staticRecipients (per-network merchant-owned wallets)', () => {
    it('excludes static-recipient networks from the Stripe deposit_options request', async () => {
      const { cache } = makeFakeCache();
      const stripe = makeFakeStripe({ tempo: '0xT', base: '0xB' });
      await createPayToAddressFromStripePI({
        request: new Request('https://x.example', { method: 'POST' }),
        amountCents: 100,
        stripe,
        piCache: cache,
        networks: ['tempo', 'base', 'solana'],
        staticRecipients: { solana: 'FR96wd96urHJdMnYayFrPYmDeAjKvwi3rQ2wkgXXTSP8' },
      });
      const callArg = stripe.paymentIntents.create.mock.calls[0]![0] as Record<string, unknown>;
      const pmOpts = (callArg.payment_method_options as Record<string, unknown>).crypto as Record<string, unknown>;
      const networks = ((pmOpts.deposit_options as Record<string, unknown>).networks) as string[];
      expect(networks).toEqual(['tempo', 'base']);
    });

    it('registers static recipients with piCache.cacheAddress (so settle-leg hasAddress passes)', async () => {
      const { cache, cachedAddresses } = makeFakeCache();
      const stripe = makeFakeStripe({ tempo: '0xT', base: '0xB' });
      const STATIC_SOLANA = 'FR96wd96urHJdMnYayFrPYmDeAjKvwi3rQ2wkgXXTSP8';
      await createPayToAddressFromStripePI({
        request: new Request('https://x.example', { method: 'POST' }),
        amountCents: 100,
        stripe,
        piCache: cache,
        staticRecipients: { solana: STATIC_SOLANA },
      });
      expect(cachedAddresses).toContain(STATIC_SOLANA);
      expect(cachedAddresses).toContain('0xT');
      expect(cachedAddresses).toContain('0xB');
    });

    it('merges static recipients into the per-PI network map (getNetworkDepositAddress returns the static)', async () => {
      const { cache, cachedNetworkAddresses } = makeFakeCache();
      const stripe = makeFakeStripe({ tempo: '0xT', base: '0xB' });
      const STATIC_SOLANA = 'FR96wd96urHJdMnYayFrPYmDeAjKvwi3rQ2wkgXXTSP8';
      await createPayToAddressFromStripePI({
        request: new Request('https://x.example', { method: 'POST' }),
        amountCents: 100,
        stripe,
        piCache: cache,
        staticRecipients: { solana: STATIC_SOLANA },
      });
      const [, merged] = cachedNetworkAddresses[0]!;
      expect(merged).toEqual({ tempo: '0xT', base: '0xB', solana: STATIC_SOLANA });
    });

    it('settle leg accepts a credential signed against a static recipient unconditionally (bypasses TTL)', async () => {
      // hasAddress=false simulates the TTL having expired between discovery + settle.
      // Without the static-recipient bypass, this would throw invalid_credential.
      const { cache } = makeFakeCache({ hasAddress: false });
      const STATIC_SOLANA = 'FR96wd96urHJdMnYayFrPYmDeAjKvwi3rQ2wkgXXTSP8';
      const request = new Request('https://x.example', {
        method: 'POST',
        headers: { authorization: `Payment solana:${STATIC_SOLANA}` },
      });
      const result = await createPayToAddressFromStripePI({
        request,
        amountCents: 100,
        stripe: makeFakeStripe({}),
        piCache: cache,
        staticRecipients: { solana: STATIC_SOLANA },
      });
      expect(result).toBe(STATIC_SOLANA);
    });

    it('settle leg still rejects when the credential signs against an unknown recipient even with staticRecipients configured', async () => {
      // The static-recipient bypass MUST only apply when the signed-against recipient
      // exactly matches the configured static address — otherwise it'd let any
      // attacker-chosen recipient through.
      const { cache } = makeFakeCache({ hasAddress: false });
      const STATIC_SOLANA = 'FR96wd96urHJdMnYayFrPYmDeAjKvwi3rQ2wkgXXTSP8';
      const request = new Request('https://x.example', {
        method: 'POST',
        headers: { authorization: 'Payment solana:ATTACKERATTACKERATTACKERATTACKERATTACKER' },
      });
      await expect(
        createPayToAddressFromStripePI({
          request,
          amountCents: 100,
          stripe: makeFakeStripe({}),
          piCache: cache,
          staticRecipients: { solana: STATIC_SOLANA },
        }),
      ).rejects.toMatchObject({
        name: 'CheckoutValidationError',
        code: 'invalid_credential',
        status: 401,
      });
    });
  });
});

describe('mintMultichainRecipients', () => {
  it('returns the full per-rail map on the discovery leg', async () => {
    const { cache } = makeFakeCache();
    const stripe = makeFakeStripe({ tempo: '0xTEMPO', base: '0xBASE', solana: 'SOLABC' });
    const request = new Request('https://x.example', { method: 'POST' });
    const out = await mintMultichainRecipients({
      request,
      amountCents: 100,
      stripe,
      piCache: cache,
    });
    expect(out.recipients).toEqual({ tempo: '0xTEMPO', base: '0xBASE', solana: 'SOLABC' });
    expect(out.paymentIntentId).toBe('pi_test_123');
    expect(out.reusedFromCredential).toBe(false);
  });

  it('merges static_recipients with Stripe-minted addresses on the discovery leg', async () => {
    const { cache } = makeFakeCache();
    const stripe = makeFakeStripe({ tempo: '0xTEMPO', base: '0xBASE' });
    const STATIC_SOLANA = 'FR96wd96urHJdMnYayFrPYmDeAjKvwi3rQ2wkgXXTSP8';
    const request = new Request('https://x.example', { method: 'POST' });
    const out = await mintMultichainRecipients({
      request,
      amountCents: 100,
      stripe,
      piCache: cache,
      staticRecipients: { solana: STATIC_SOLANA },
    });
    expect(out.recipients).toEqual({ tempo: '0xTEMPO', base: '0xBASE', solana: STATIC_SOLANA });
    expect(out.paymentIntentId).toBe('pi_test_123');
    expect(out.reusedFromCredential).toBe(false);
  });

  it('flags reusedFromCredential: true when the settle leg short-circuits to the credential', async () => {
    const { cache } = makeFakeCache({ hasAddress: true });
    const request = new Request('https://x.example', {
      method: 'POST',
      headers: { authorization: 'Payment tempo:0xCACHED' },
    });
    const out = await mintMultichainRecipients({
      request,
      amountCents: 100,
      stripe: makeFakeStripe({}),
      piCache: cache,
    });
    expect(out.recipients).toEqual({}); // no PI minted, no static, nothing to merge
    expect(out.paymentIntentId).toBeUndefined();
    expect(out.reusedFromCredential).toBe(true);
  });

  it('on settle leg with static-recipient match, returns the static address without piCache.hasAddress check', async () => {
    // Cache says false; the static-recipient bypass should let it through anyway.
    const { cache } = makeFakeCache({ hasAddress: false });
    const STATIC_SOLANA = 'FR96wd96urHJdMnYayFrPYmDeAjKvwi3rQ2wkgXXTSP8';
    const request = new Request('https://x.example', {
      method: 'POST',
      headers: { authorization: `Payment solana:${STATIC_SOLANA}` },
    });
    const out = await mintMultichainRecipients({
      request,
      amountCents: 100,
      stripe: makeFakeStripe({}),
      piCache: cache,
      staticRecipients: { solana: STATIC_SOLANA },
    });
    expect(out.recipients).toEqual({ solana: STATIC_SOLANA });
    expect(out.reusedFromCredential).toBe(true);
  });

  it('on settle leg rejects an attacker-chosen recipient even when staticRecipients is configured', async () => {
    const { cache } = makeFakeCache({ hasAddress: false });
    const STATIC_SOLANA = 'FR96wd96urHJdMnYayFrPYmDeAjKvwi3rQ2wkgXXTSP8';
    const request = new Request('https://x.example', {
      method: 'POST',
      headers: { authorization: 'Payment solana:ATTACKERATTACKERATTACKERATTACKERATTACKER' },
    });
    await expect(
      mintMultichainRecipients({
        request,
        amountCents: 100,
        stripe: makeFakeStripe({}),
        piCache: cache,
        staticRecipients: { solana: STATIC_SOLANA },
      }),
    ).rejects.toMatchObject({
      name: 'CheckoutValidationError',
      code: 'invalid_credential',
      status: 401,
    });
  });

  it('rebuilds the full per-rail network map from cache when the credential resolves to a known PI', async () => {
    // getPaymentIntentId returns a real PI id, so readNetworkMapFromCache runs and
    // hydrates the per-network map (tempo/base/solana) from the cache, and the
    // returned paymentIntentId is populated.
    const stored: Record<string, string> = {
      tempo: '0xTEMPOdeposit',
      base: '0xBASEdeposit',
    };
    const cache: PiCache = {
      async cacheAddress() {},
      async hasAddress() { return true; },
      cachePaymentIntent() {},
      getPaymentIntentId() { return 'pi_reused_999'; },
      cacheNetworkAddresses() {},
      getNetworkDepositAddress(_pi: string, n: string) { return stored[n]; },
      stop() {},
    };
    const request = new Request('https://x.example', {
      method: 'POST',
      headers: { authorization: 'Payment tempo:0xTEMPOdeposit' },
    });
    const out = await mintMultichainRecipients({
      request,
      amountCents: 100,
      stripe: makeFakeStripe({}),
      piCache: cache,
    });
    expect(out.reusedFromCredential).toBe(true);
    expect(out.paymentIntentId).toBe('pi_reused_999');
    expect(out.recipients).toEqual({ tempo: '0xTEMPOdeposit', base: '0xBASEdeposit' });
  });

  it('rejects a credential whose recipient field is empty (missing recipient)', async () => {
    const { cache } = makeFakeCache({ hasAddress: true });
    const request = new Request('https://x.example', {
      method: 'POST',
      headers: { authorization: 'Payment tempo:' },
    });
    await expect(
      mintMultichainRecipients({
        request,
        amountCents: 100,
        stripe: makeFakeStripe({}),
        piCache: cache,
      }),
    ).rejects.toMatchObject({
      name: 'CheckoutValidationError',
      code: 'invalid_credential',
      status: 401,
    });
  });
});
