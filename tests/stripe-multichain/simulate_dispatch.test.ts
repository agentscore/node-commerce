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

  it('maps the bare railKey forms (tempo / x402_base)', () => {
    expect(networkForOutcome({ railKey: 'tempo' })).toBe('tempo');
    expect(networkForOutcome({ railKey: 'x402_base' })).toBe('base');
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

  it('forwards buyerWallet + stripeVersion through to the simulator on a test key', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await simulateDepositForOutcome({
        outcome: { rail: 'x402' },
        depositAddress: '0xabc',
        getPaymentIntentId: () => 'pi_cached',
        stripeSecretKey: 'sk_test_xxx',
        buyerWallet: '0xbuyerwallet',
        stripeVersion: '2026-03-04.preview',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0]!;
      expect((init as RequestInit).body as string).toContain('buyer_wallet=0xbuyerwallet');
      expect(((init as RequestInit).headers as Record<string, string>)['Stripe-Version']).toBe('2026-03-04.preview');
    } finally {
      globalThis.fetch = originalFetch;
      warnSpy.mockRestore();
    }
  });
});
