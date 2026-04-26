import { describe, expect, it } from 'vitest';
import { createMppxStripe } from '../../src/stripe-multichain/mppx_stripe';

describe('createMppxStripe', () => {
  it('returns a Stripe charge method when called with profileId + secretKey', async () => {
    const method = await createMppxStripe({ profileId: 'acct_test', secretKey: 'sk_test_xxx' });
    expect(method).toBeDefined();
  });

  it('accepts custom paymentMethodTypes', async () => {
    const method = await createMppxStripe({
      profileId: 'acct_test',
      secretKey: 'sk_test_xxx',
      paymentMethodTypes: ['card'],
    });
    expect(method).toBeDefined();
  });
});
