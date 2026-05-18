/** Boilerplate-reducer for the `rails` config passed to `Checkout` /
 *  `computeFirstCheckout`. Merchants supplying a chain set always rebuild the
 *  same constants (`recipient: ''` sentinel, network/chainId/token defaults);
 *  this helper folds those defaults in so the merchant config only specifies
 *  the merchant-specific overrides.
 *
 *  Per-order recipient minting (Stripe-multichain) is wired via the Checkout's
 *  `mintRecipients` hook, so the `recipient: ''` sentinel here is the expected
 *  shape — `mintRecipients` overrides it at request time.
 */

import { networks } from './networks';
import { RAIL_SPEC_DEFAULTS, type RecipientLike, type SolanaMppRailSpec, type StripeRailSpec, type TempoRailSpec, type X402BaseRailSpec } from './rail_spec';
import { USDC } from './usdc';

export interface BuildDefaultCheckoutRailsOptions {
  /** Tempo MPP rail. Pass `{}` to accept all defaults; pass overrides
   *  (`network`, `chainId`, `token`, ...) to customize. Omit to skip. */
  tempo?: { recipient?: RecipientLike } & Partial<Omit<TempoRailSpec, 'recipient'>>;
  /** x402 EVM (Base) rail. Same opt-in semantics. */
  x402Base?: { recipient?: RecipientLike } & Partial<Omit<X402BaseRailSpec, 'recipient'>>;
  /** Solana MPP rail. Same opt-in semantics. */
  solanaMpp?: { recipient?: RecipientLike } & Partial<Omit<SolanaMppRailSpec, 'recipient'>>;
  /** Stripe SPT rail. No recipient (Stripe owns the deposit address). */
  stripe?: Partial<StripeRailSpec>;
}

type DefaultRails = {
  tempo?: TempoRailSpec;
  x402_base?: X402BaseRailSpec;
  solana_mpp?: SolanaMppRailSpec;
  stripe?: StripeRailSpec;
};

/** Build the canonical four-rail `rails` dict. Keys match the convention used
 *  across consumer codebases (`tempo`, `x402_base`, `solana_mpp`, `stripe`).
 *  Empty-string recipients are placeholders — Checkout's `mintRecipients` hook
 *  must populate real values at request time. */
export function buildDefaultCheckoutRails(opts: BuildDefaultCheckoutRailsOptions): DefaultRails {
  const out: DefaultRails = {};
  if (opts.tempo) {
    out.tempo = { recipient: '', ...RAIL_SPEC_DEFAULTS.tempo, ...opts.tempo };
  }
  if (opts.x402Base) {
    // Derive chainId + token from network when caller overrides network without
    // pinning them — Sepolia network must point at the Sepolia USDC contract,
    // not the mainnet contract baked into RAIL_SPEC_DEFAULTS. Mirrors python's
    // `X402BaseRailSpec.__post_init__` derivation pattern.
    const merged: X402BaseRailSpec = { recipient: '', ...RAIL_SPEC_DEFAULTS.x402Base, ...opts.x402Base };
    if (merged.network === networks.base.sepolia.caip2) {
      if (opts.x402Base.chainId === undefined) merged.chainId = networks.base.sepolia.chainId;
      if (opts.x402Base.token === undefined) merged.token = USDC.base.sepolia.address;
    } else if (merged.network === networks.base.mainnet.caip2) {
      if (opts.x402Base.chainId === undefined) merged.chainId = networks.base.mainnet.chainId;
      if (opts.x402Base.token === undefined) merged.token = USDC.base.mainnet.address;
    }
    out.x402_base = merged;
  }
  if (opts.solanaMpp) {
    // Mint flips by network; mirrors `X402BaseRailSpec.__post_init__`. Accepts
    // both CAIP-2 (`solana:EtWTRABZ…`) and the raw `@solana/mpp` `'devnet'` form
    // since the mppx server resolver tolerates both.
    const merged: SolanaMppRailSpec = { recipient: '', ...RAIL_SPEC_DEFAULTS.solanaMpp, ...opts.solanaMpp };
    const isDevnet = merged.network === 'devnet' || merged.network === networks.solana.devnet.caip2;
    if (isDevnet && opts.solanaMpp.token === undefined) {
      merged.token = USDC.solana.devnet.mint;
    }
    out.solana_mpp = merged;
  }
  if (opts.stripe) {
    out.stripe = { ...RAIL_SPEC_DEFAULTS.stripe, ...opts.stripe };
  }
  return out;
}
