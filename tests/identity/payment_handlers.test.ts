import { describe, expect, it } from 'vitest';
import {
  mppPaymentHandler,
  stripeSptPaymentHandler,
  x402PaymentHandler,
} from '../../src/identity/ucp';
import { networks } from '../../src/payment/networks';
import type {
  SolanaMppRailSpec,
  StripeRailSpec,
  TempoRailSpec,
  TempoSessionRailSpec,
  X402BaseRailSpec,
} from '../../src/payment/rail_spec';

const mppConfig = (out: ReturnType<typeof mppPaymentHandler>): { networks: Record<string, unknown>[] } => {
  const binding = out['sh.agentscore.payment.mpp']?.[0];
  return binding!.config as { networks: Record<string, unknown>[] };
};

const x402Config = (out: ReturnType<typeof x402PaymentHandler>): { networks: Record<string, unknown>[] } => {
  const binding = out['sh.agentscore.payment.x402']?.[0];
  return binding!.config as { networks: Record<string, unknown>[] };
};

describe('mppPaymentHandler — TempoRailSpec', () => {
  it('static recipient is emitted verbatim under tempo-mainnet', () => {
    const out = mppPaymentHandler({ networks: [{ recipient: '0xfeedface' } as TempoRailSpec] });
    expect(mppConfig(out).networks).toEqual([
      { network: 'tempo-mainnet', chain_id: 4217, recipient: '0xfeedface' },
    ]);
  });

  it('testnet flag overrides the network name to tempo-testnet', () => {
    const out = mppPaymentHandler({
      networks: [{ recipient: '0xfeedface', testnet: true } as TempoRailSpec],
    });
    expect(mppConfig(out).networks[0]!.network).toBe('tempo-testnet');
  });

  it('factory recipient is omitted from the static UCP profile', () => {
    const out = mppPaymentHandler({
      networks: [{ recipient: () => '0xdynamic' } as TempoRailSpec],
    });
    const entry = mppConfig(out).networks[0]!;
    expect('recipient' in entry).toBe(false);
    expect(entry.network).toBe('tempo-mainnet');
    expect(entry.chain_id).toBe(4217);
  });

  it('async factory recipient is also omitted from the profile', () => {
    const out = mppPaymentHandler({
      networks: [{ recipient: async () => '0xasync' } as TempoRailSpec],
    });
    expect('recipient' in mppConfig(out).networks[0]!).toBe(false);
  });
});

describe('mppPaymentHandler — SolanaMppRailSpec', () => {
  it('mainnet CAIP-2 maps to solana-mainnet-beta UCP namespace', () => {
    const spec: SolanaMppRailSpec = {
      recipient: 'solanaaddr',
      network: networks.solana.mainnet.caip2,
    };
    const out = mppPaymentHandler({ networks: [spec] });
    const entry = mppConfig(out).networks[0]!;
    expect(entry.network).toBe('solana-mainnet-beta');
    expect(entry.recipient).toBe('solanaaddr');
  });

  it('devnet CAIP-2 maps to solana-devnet UCP namespace', () => {
    const spec: SolanaMppRailSpec = {
      recipient: 'solanaaddr',
      network: networks.solana.devnet.caip2,
    };
    const out = mppPaymentHandler({ networks: [spec] });
    expect(mppConfig(out).networks[0]!.network).toBe('solana-devnet');
  });
});

describe('mppPaymentHandler — mixed rails', () => {
  it('one call mixes Tempo, Solana MPP, and Tempo session entries', () => {
    const out = mppPaymentHandler({
      networks: [
        { recipient: '0xtempo' } as TempoRailSpec,
        { recipient: 'solanaaddr', network: networks.solana.mainnet.caip2 } as SolanaMppRailSpec,
        {
          recipient: '0xsession',
          escrowContract: '0xescrow',
          store: {} as unknown,
        } as TempoSessionRailSpec,
      ],
    });
    const entries = mppConfig(out).networks;
    expect(entries.length).toBe(3);
    expect(entries[2]!.escrow_contract).toBe('0xescrow');
    expect(entries[2]!.network).toBe('tempo-mainnet');
  });

  it('tempo session testnet flag flips network to tempo-testnet', () => {
    const out = mppPaymentHandler({
      networks: [
        {
          recipient: '0xsession',
          escrowContract: '0xescrow',
          store: {} as unknown,
          testnet: true,
        } as TempoSessionRailSpec,
      ],
    });
    expect(mppConfig(out).networks[0]!.network).toBe('tempo-testnet');
  });

  it('tempo session with factory recipient omits recipient from profile', () => {
    const out = mppPaymentHandler({
      networks: [
        {
          recipient: () => '0xsessionDynamic',
          escrowContract: '0xescrow',
          store: {} as unknown,
        } as TempoSessionRailSpec,
      ],
    });
    expect('recipient' in mppConfig(out).networks[0]!).toBe(false);
  });

  it('solana spec with factory recipient omits recipient', () => {
    const out = mppPaymentHandler({
      networks: [
        { recipient: () => 'sol-dynamic', network: networks.solana.mainnet.caip2 } as SolanaMppRailSpec,
      ],
    });
    expect('recipient' in mppConfig(out).networks[0]!).toBe(false);
  });
});

describe('x402PaymentHandler', () => {
  it('mainnet CAIP-2 maps to base-8453 UCP namespace', () => {
    const out = x402PaymentHandler({
      networks: [{ recipient: '0xbase' } as X402BaseRailSpec],
    });
    const entry = x402Config(out).networks[0]!;
    expect(entry.network).toBe('base-8453');
    expect(entry.recipient).toBe('0xbase');
  });

  it('sepolia CAIP-2 maps to base-84532 UCP namespace', () => {
    const out = x402PaymentHandler({
      networks: [{ recipient: '0xbase', network: 'eip155:84532' } as X402BaseRailSpec],
    });
    expect(x402Config(out).networks[0]!.network).toBe('base-84532');
  });

  it('factory recipient is omitted from the static UCP profile', () => {
    const out = x402PaymentHandler({
      networks: [{ recipient: () => '0xdynamic' } as X402BaseRailSpec],
    });
    expect('recipient' in x402Config(out).networks[0]!).toBe(false);
  });

  it('unknown CAIP-2 strings pass through verbatim', () => {
    const out = x402PaymentHandler({
      networks: [{ recipient: '0xbase', network: 'custom-rail-id' } as X402BaseRailSpec],
    });
    expect(x402Config(out).networks[0]!.network).toBe('custom-rail-id');
  });
});

describe('stripeSptPaymentHandler', () => {
  it('emits profile_id under the stripe-spt binding', () => {
    const out = stripeSptPaymentHandler({
      spec: { profileId: 'profile_5xKvNqM9BaH' } as StripeRailSpec,
    });
    const binding = out['sh.agentscore.payment.stripe_spt']?.[0];
    expect(binding!.config).toEqual({ rail: 'stripe-spt', profile_id: 'profile_5xKvNqM9BaH' });
  });

  it('emits profile_id: null when caller omits profileId', () => {
    const out = stripeSptPaymentHandler({ spec: {} as StripeRailSpec });
    const binding = out['sh.agentscore.payment.stripe_spt']?.[0];
    expect((binding!.config as Record<string, unknown>).profile_id).toBeNull();
  });
});

describe('payment-handler metadata', () => {
  it('all three handlers share the same handler-version constant and spec base', () => {
    const mpp = mppPaymentHandler({
      networks: [{ recipient: '0xt' } as TempoRailSpec],
    });
    const x402 = x402PaymentHandler({
      networks: [{ recipient: '0xb' } as X402BaseRailSpec],
    });
    const stripe = stripeSptPaymentHandler({ spec: { profileId: 'profile_x' } as StripeRailSpec });
    const mppBinding = mpp['sh.agentscore.payment.mpp']![0]!;
    const x402Binding = x402['sh.agentscore.payment.x402']![0]!;
    const stripeBinding = stripe['sh.agentscore.payment.stripe_spt']![0]!;
    expect(mppBinding.version).toBe(x402Binding.version);
    expect(x402Binding.version).toBe(stripeBinding.version);
    for (const b of [mppBinding, x402Binding, stripeBinding]) {
      expect(b.spec.startsWith('https://agentscore.sh/specification/payment-handlers/')).toBe(true);
    }
  });
});
