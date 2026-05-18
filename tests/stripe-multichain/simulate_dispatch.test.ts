import { describe, expect, it, vi } from 'vitest';
import { networkForOutcome, simulateDepositForOutcome } from '../../src/stripe-multichain/simulate_dispatch';

describe('networkForOutcome', () => {
  it('returns "base" for x402 rails', () => {
    expect(networkForOutcome({ rail: 'x402' })).toBe('base');
  });

  it('accepts both bare `tempo` and `tempo/charge` mppMethod', () => {
    expect(networkForOutcome({ rail: 'mpp', mppMethod: 'tempo' })).toBe('tempo');
    expect(networkForOutcome({ rail: 'mpp', mppMethod: 'tempo/charge' })).toBe('tempo');
  });

  it('accepts both bare `solana` and `solana/charge` mppMethod', () => {
    expect(networkForOutcome({ rail: 'mpp', mppMethod: 'solana' })).toBe('solana');
    expect(networkForOutcome({ rail: 'mpp', mppMethod: 'solana/charge' })).toBe('solana');
  });

  it('returns null for stripe SPT (no on-chain deposit)', () => {
    expect(networkForOutcome({ rail: 'mpp', mppMethod: 'stripe' })).toBeNull();
    expect(networkForOutcome({ rail: 'mpp', mppMethod: 'stripe/charge' })).toBeNull();
  });

  it('falls back to railKey when mppMethod is missing', () => {
    expect(networkForOutcome({ rail: 'mpp', railKey: 'solana_mpp' })).toBe('solana');
    expect(networkForOutcome({ rail: 'mpp', railKey: 'tempo_mpp' })).toBe('tempo');
    expect(networkForOutcome({ rail: 'mpp', railKey: 'stripe' })).toBeNull();
  });

  it('returns null for unknown outcomes', () => {
    expect(networkForOutcome({})).toBeNull();
    expect(networkForOutcome({ rail: 'mpp', mppMethod: 'unknown' })).toBeNull();
  });
});

describe('simulateDepositForOutcome', () => {
  it('no-ops on Stripe SPT (no network)', async () => {
    const getPaymentIntentId = vi.fn().mockReturnValue('pi_x');
    await simulateDepositForOutcome({
      outcome: { rail: 'mpp', mppMethod: 'stripe' },
      depositAddress: '0xabc',
      getPaymentIntentId,
      stripeSecretKey: 'sk_test_dummy',
    });
    expect(getPaymentIntentId).not.toHaveBeenCalled();
  });

  it('no-ops on live Stripe keys (gate is inside simulateDepositIfTestMode)', async () => {
    const getPaymentIntentId = vi.fn().mockReturnValue('pi_x');
    await simulateDepositForOutcome({
      outcome: { rail: 'x402' },
      depositAddress: '0xabc',
      getPaymentIntentId,
      stripeSecretKey: 'sk_live_real',
    });
    // The simulator early-returns on sk_live_*; getPaymentIntentId is called once
    // inside simulateDepositIfTestMode only when the testnet branch is taken.
    expect(getPaymentIntentId).not.toHaveBeenCalled();
  });
});
