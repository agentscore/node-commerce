import { describe, expect, it } from 'vitest';
import { buildDefaultCheckoutRails } from '../../src/payment/default_rails';

describe('buildDefaultCheckoutRails', () => {
  it('returns an empty dict when nothing is requested', () => {
    expect(buildDefaultCheckoutRails({})).toEqual({});
  });

  it('emits tempo with `recipient: ""` sentinel + RAIL_SPEC_DEFAULTS', () => {
    const rails = buildDefaultCheckoutRails({ tempo: {} });
    expect(rails.tempo).toEqual(
      expect.objectContaining({ recipient: '', network: 'tempo-mainnet', chainId: 4217, decimals: 6 }),
    );
  });

  it('caller overrides win over RAIL_SPEC_DEFAULTS', () => {
    const rails = buildDefaultCheckoutRails({
      tempo: { network: 'tempo-testnet', chainId: 42431, testnet: true },
    });
    expect(rails.tempo?.network).toBe('tempo-testnet');
    expect(rails.tempo?.chainId).toBe(42431);
    expect(rails.tempo?.testnet).toBe(true);
  });

  it('derives tempo network/chainId/token from `testnet: true` alone', () => {
    const rails = buildDefaultCheckoutRails({ tempo: { testnet: true } });
    expect(rails.tempo?.network).toBe('tempo-testnet');
    expect(rails.tempo?.chainId).toBe(42431);
    expect(rails.tempo?.token).toBe('0x20c0000000000000000000000000000000000000');
  });

  it('keys map to canonical rails-dict slugs (`x402_base`, `solana_mpp`)', () => {
    const rails = buildDefaultCheckoutRails({ x402Base: {}, solanaMpp: {} });
    expect(rails.x402_base).toBeDefined();
    expect(rails.solana_mpp).toBeDefined();
  });

  it('stripe rail has no recipient and merges paymentMethodTypes through', () => {
    const rails = buildDefaultCheckoutRails({
      stripe: { profileId: 'p_test', paymentMethodTypes: ['card', 'link'] },
    });
    expect(rails.stripe?.profileId).toBe('p_test');
    expect(rails.stripe?.paymentMethodTypes).toEqual(['card', 'link']);
    expect((rails.stripe as { recipient?: unknown }).recipient).toBeUndefined();
  });
});
