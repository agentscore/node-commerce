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
