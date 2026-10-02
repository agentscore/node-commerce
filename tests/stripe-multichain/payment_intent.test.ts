import { describe, expect, it, vi } from 'vitest';
import { createMultichainPaymentIntent } from '../../src/stripe-multichain/payment_intent';

function fakeStripe(piResult: object) {
  const create = vi.fn().mockResolvedValue(piResult);
  return { paymentIntents: { create }, _create: create };
}

describe('createMultichainPaymentIntent', () => {
  it('calls Stripe with deposit_options.networks defaulting to tempo+base+solana', async () => {
    const stripe = fakeStripe({
      id: 'pi_test_1',
      next_action: {
        crypto_display_details: {
          deposit_addresses: {
            tempo: { address: '0xtempo' },
            base: { address: '0xbase' },
            solana: { address: 'sol_addr' },
          },
        },
      },
    });
    const result = await createMultichainPaymentIntent({ stripe, amount: 25000 });
    expect(result.paymentIntentId).toBe('pi_test_1');
    expect(result.depositAddresses).toEqual({ tempo: '0xtempo', base: '0xbase', solana: 'sol_addr' });
    const callArgs = stripe._create.mock.calls[0]![0] as { payment_method_options: { crypto: { deposit_options: { networks: string[] } } } };
    expect(callArgs.payment_method_options.crypto.deposit_options.networks).toEqual(['tempo', 'base', 'solana']);
  });

  // Stripe's 2026-09-30.preview API rejects payment_method_types ("no longer supported");
  // allowed_payment_method_types is accepted on that version and on the earlier previews.
  it('restricts the intent to crypto with allowed_payment_method_types', async () => {
    const stripe = fakeStripe({
      id: 'pi_types',
      next_action: { crypto_display_details: { deposit_addresses: { base: { address: '0xb' } } } },
    });
    await createMultichainPaymentIntent({ stripe, amount: 100 });
    const params = stripe._create.mock.calls[0]![0] as Record<string, unknown>;
    expect(params.allowed_payment_method_types).toEqual(['crypto']);
    expect(params).not.toHaveProperty('payment_method_types');
  });

  it('passes idempotencyKey + metadata through', async () => {
    const stripe = fakeStripe({
      id: 'pi_x',
      next_action: { crypto_display_details: { deposit_addresses: { tempo: { address: '0xt' } } } },
    });
    await createMultichainPaymentIntent({
      stripe,
      amount: 100,
      idempotencyKey: 'order-123',
      metadata: { order_id: 'order-123', merchant: 'example-merchant' },
    });
    const [params, opts] = stripe._create.mock.calls[0]!;
    expect((params as { metadata: Record<string, string> }).metadata).toEqual({
      order_id: 'order-123',
      merchant: 'example-merchant',
    });
    expect(opts).toEqual({ idempotencyKey: 'order-123' });
  });

  it('throws CheckoutValidationError(503, payment_provider_unavailable) when Stripe returns no deposit addresses', async () => {
    const stripe = fakeStripe({ id: 'pi_y', next_action: null });
    await expect(createMultichainPaymentIntent({ stripe, amount: 100 })).rejects.toMatchObject({
      name: 'CheckoutValidationError',
      code: 'payment_provider_unavailable',
      status: 503,
    });
  });

  it('skips deposit-address entries that lack an address field but keeps the valid ones', async () => {
    const stripe = fakeStripe({
      id: 'pi_mixed',
      next_action: {
        crypto_display_details: {
          deposit_addresses: {
            tempo: { address: '0xtempo' },
            base: {}, // no address → skipped
            solana: { address: null }, // null address → skipped
          },
        },
      },
    });
    const result = await createMultichainPaymentIntent({ stripe, amount: 100 });
    expect(result.depositAddresses).toEqual({ tempo: '0xtempo' });
  });
});

describe('createMultichainPaymentIntent single-flight', () => {
  const pi = {
    id: 'pi_sf',
    next_action: { crypto_display_details: { deposit_addresses: { tempo: { address: '0xsf' } } } },
  };

  function deferredStripe() {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const create = vi.fn(async () => { await gate; return pi; });
    return { stripe: { paymentIntents: { create } }, create, release };
  }

  it('shares one Stripe call across concurrent requests with the same idempotency key', async () => {
    const { stripe, create, release } = deferredStripe();
    const calls = [1, 2, 3].map(() => createMultichainPaymentIntent({ stripe, amount: 100, idempotencyKey: 'pi-same-100' }));
    release();
    const results = await Promise.all(calls);
    expect(create).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.paymentIntentId)).toEqual(['pi_sf', 'pi_sf', 'pi_sf']);
  });

  it('does not share across different keys or unkeyed calls', async () => {
    const { stripe, create, release } = deferredStripe();
    const calls = [
      createMultichainPaymentIntent({ stripe, amount: 100, idempotencyKey: 'pi-a-100' }),
      createMultichainPaymentIntent({ stripe, amount: 100, idempotencyKey: 'pi-b-100' }),
      createMultichainPaymentIntent({ stripe, amount: 100 }),
      createMultichainPaymentIntent({ stripe, amount: 100 }),
    ];
    release();
    await Promise.all(calls);
    expect(create).toHaveBeenCalledTimes(4);
  });

  it('calls Stripe again once the shared call has settled', async () => {
    const { stripe, create, release } = deferredStripe();
    release();
    await createMultichainPaymentIntent({ stripe, amount: 100, idempotencyKey: 'pi-later-100' });
    await createMultichainPaymentIntent({ stripe, amount: 100, idempotencyKey: 'pi-later-100' });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('shares a failure with every waiter and clears the key for the next attempt', async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce(pi);
    const stripe = { paymentIntents: { create } };
    const a = createMultichainPaymentIntent({ stripe, amount: 100, idempotencyKey: 'pi-fail-100' });
    const b = createMultichainPaymentIntent({ stripe, amount: 100, idempotencyKey: 'pi-fail-100' });
    await expect(a).rejects.toThrow('rate limited');
    await expect(b).rejects.toThrow('rate limited');
    await expect(createMultichainPaymentIntent({ stripe, amount: 100, idempotencyKey: 'pi-fail-100' })).resolves.toMatchObject({ paymentIntentId: 'pi_sf' });
    expect(create).toHaveBeenCalledTimes(2);
  });
});
