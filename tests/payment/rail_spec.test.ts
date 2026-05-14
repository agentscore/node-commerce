/**
 * Tests for the canonical *RailSpec types + RecipientLike resolution. Mirrors
 * python-commerce/tests/test_rail_spec.py so cross-language behavior parity is
 * locked at the spec level.
 */

import { describe, expect, it } from 'vitest';
import {
  RAIL_SPEC_DEFAULTS,
  type SolanaMppRailSpec,
  type StripeRailSpec,
  type TempoRailSpec,
  type TempoSessionRailSpec,
  type X402BaseRailSpec,
  resolveRecipient,
} from '../../src/payment/rail_spec';

describe('TempoRailSpec', () => {
  it('mainnet defaults match the USDC registry', () => {
    const spec: TempoRailSpec = { recipient: '0xfeedface', ...RAIL_SPEC_DEFAULTS.tempo };
    expect(spec.recipient).toBe('0xfeedface');
    expect(spec.network).toBe('tempo-mainnet');
    expect(spec.chainId).toBe(4217);
    expect(spec.symbol).toBe('USDC.e');
    expect(spec.decimals).toBe(6);
    expect(spec.testnet).toBe(false);
    expect(spec.recommend).toBe('both');
  });
});

describe('X402BaseRailSpec', () => {
  it('defaults pin Base mainnet (CAIP-2 eip155:8453) + USDC', () => {
    const spec: X402BaseRailSpec = { recipient: '0xfeedface', ...RAIL_SPEC_DEFAULTS.x402Base };
    expect(spec.network).toBe('eip155:8453');
    expect(spec.chainId).toBe(8453);
    expect(spec.symbol).toBe('USDC');
    expect(spec.decimals).toBe(6);
    expect(spec.mode).toBe('exact');
  });

  it("mode='upto' selects the Permit2 + Settlement-Overrides variant", () => {
    const spec: X402BaseRailSpec = { recipient: '0xfeedface', mode: 'upto' };
    expect(spec.mode).toBe('upto');
  });
});

describe('SolanaMppRailSpec', () => {
  it('mainnet defaults from the USDC registry', () => {
    const spec: SolanaMppRailSpec = {
      recipient: 'GEQg2TM4VL315Bd4LLkGrhBjdNfoatKjCJYHBDPM3D74',
      ...RAIL_SPEC_DEFAULTS.solanaMpp,
    };
    expect(spec.network?.startsWith('solana:')).toBe(true);
    expect(spec.symbol).toBe('USDC');
    expect(spec.decimals).toBe(6);
    expect(spec.rpcUrl).toBeUndefined();
    expect(spec.signer).toBeUndefined();
    expect(spec.tokenProgram).toBeUndefined();
  });

  it('fee-payer signer roundtrips through the spec — opaque object', () => {
    const sentinel = { __sentinel: true };
    const spec: SolanaMppRailSpec = {
      recipient: 'GEQg2TM4VL315Bd4LLkGrhBjdNfoatKjCJYHBDPM3D74',
      signer: sentinel,
    };
    expect(spec.signer).toBe(sentinel);
  });
});

describe('StripeRailSpec', () => {
  it('has no on-chain recipient; profileId replaces it', () => {
    const spec: StripeRailSpec = { profileId: 'profile_abc', ...RAIL_SPEC_DEFAULTS.stripe };
    expect(spec.profileId).toBe('profile_abc');
    expect(spec.rails).toEqual(['card', 'link', 'shared_payment_token']);
    expect(spec.paymentMethodTypes).toBeUndefined();
    expect(spec.productName).toBeUndefined();
    expect(spec.secretKey).toBeUndefined();
  });
});

describe('TempoSessionRailSpec', () => {
  it('requires escrow + store; defaults mirror tempo', () => {
    const store = {};
    const spec: TempoSessionRailSpec = {
      recipient: '0xfeedface',
      escrowContract: '0xescrow',
      store,
      ...RAIL_SPEC_DEFAULTS.tempoSession,
    };
    expect(spec.escrowContract).toBe('0xescrow');
    expect(spec.store).toBe(store);
    expect(spec.testnet).toBe(false);
    expect(spec.chains).toBeUndefined();
  });
});

describe('resolveRecipient', () => {
  it('returns string recipient verbatim', async () => {
    expect(await resolveRecipient('0xfeedface')).toBe('0xfeedface');
  });

  it('calls a sync factory once and uses the return value', async () => {
    let calls = 0;
    const factory = () => {
      calls += 1;
      return '0xdynamic';
    };
    expect(await resolveRecipient(factory)).toBe('0xdynamic');
    expect(calls).toBe(1);
  });

  it('awaits an async factory once', async () => {
    let calls = 0;
    const factory = async () => {
      calls += 1;
      return '0xdynamic';
    };
    expect(await resolveRecipient(factory)).toBe('0xdynamic');
    expect(calls).toBe(1);
  });

  it('calls the factory exactly once per resolution — caching is caller-side', async () => {
    let calls = 0;
    const factory = async () => {
      calls += 1;
      return `0xattempt-${calls}`;
    };
    expect(await resolveRecipient(factory)).toBe('0xattempt-1');
    expect(await resolveRecipient(factory)).toBe('0xattempt-2');
    expect(calls).toBe(2);
  });
});
