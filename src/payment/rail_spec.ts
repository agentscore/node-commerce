/**
 * Canonical `*RailSpec` types — one shape per rail, consumed by every helper.
 *
 * Pre-304 a merchant accepting Tempo + Base + Solana + Stripe restated the same
 * recipient four times in four different shapes (`buildAcceptedMethods`,
 * `buildHowToPay`, `mppPaymentHandler`, `createMppxServer` each had its own
 * per-rail config). This module unifies those into one `*RailSpec` per rail;
 * every helper accepts the same instance.
 *
 * `RecipientLike` is polymorphic over `string | (() => string | Promise<string>)`
 * so per-order recipients (Stripe-multichain mints fresh deposit addresses per
 * PaymentIntent) flow through identically to static-treasury recipients. The
 * factory is called once per helper invocation; callers cache externally.
 */

import { USDC } from './usdc';

export type RecipientLike = string | (() => string | Promise<string>);

/**
 * Resolve a `RecipientLike` to a concrete address string. Accepts a string
 * (returned verbatim), a sync callable (called once), or an async callable
 * (awaited once). The orchestrator (TEC-305) calls this once per session and
 * caches the resolved value; helpers within a session never re-invoke the
 * factory.
 */
export async function resolveRecipient(r: RecipientLike): Promise<string> {
  if (typeof r === 'string') return r;
  return Promise.resolve(r());
}

/** Canonical config for the Tempo MPP rail. */
export interface TempoRailSpec {
  recipient: RecipientLike;
  network?: string;
  chainId?: number;
  token?: string;
  symbol?: string;
  decimals?: number;
  testnet?: boolean;
  recommend?: 'tempo' | 'agentscore-pay' | 'both';
}

/** Canonical config for the x402 EVM (Base) rail. */
export interface X402BaseRailSpec {
  recipient: RecipientLike;
  /** CAIP-2 canonical, e.g. `eip155:8453`. */
  network?: string;
  chainId?: number;
  token?: string;
  symbol?: string;
  decimals?: number;
  mode?: 'exact' | 'upto';
}

/**
 * Canonical config for the Solana MPP rail.
 *
 * `signer` is an optional fee-payer signer for server-side fee sponsorship —
 * typed as `unknown` to avoid hard-importing `@solana/kit` types here. Pass any
 * `TransactionPartialSigner`.
 */
export interface SolanaMppRailSpec {
  recipient: RecipientLike;
  network?: string;
  token?: string;
  symbol?: string;
  decimals?: number;
  rpcUrl?: string;
  signer?: unknown;
  tokenProgram?: string;
}

/**
 * Canonical config for the Stripe SPT rail.
 *
 * `recipient` is intentionally absent — Stripe rails use `profileId` as the
 * merchant-side network identifier the agent's SPT is scoped to; the
 * transaction recipient is the merchant's Stripe account, not an on-chain
 * address.
 */
export interface StripeRailSpec {
  profileId?: string | null;
  rails?: ('card' | 'link' | 'shared_payment_token')[];
  paymentMethodTypes?: string[];
  productName?: string;
  secretKey?: string;
}

/**
 * Canonical config for the Tempo session MPP rail (pay-as-you-go channels).
 *
 * `escrowContract` is the merchant-deployed on-chain escrow that holds channel
 * deposits + pays out cumulative vouchers on settlement. `store` is a
 * `ChannelStore` instance — typed as `unknown` to avoid hard-importing `mppx`'s
 * store interface here.
 */
export interface TempoSessionRailSpec {
  recipient: RecipientLike;
  escrowContract: string;
  store: unknown;
  currency?: string;
  testnet?: boolean;
  chains?: unknown;
}

/**
 * Default field values for each `*RailSpec`. Mirrors python-commerce's
 * `*RailSpec` dataclass defaults — callers can spread these into their spec
 * literal when they want defaults without typing them out. Sourced from the
 * USDC registry so they stay in sync with on-chain reality.
 */
export const RAIL_SPEC_DEFAULTS = {
  tempo: {
    network: 'tempo-mainnet',
    chainId: 4217,
    token: USDC.tempo.mainnet.address,
    symbol: 'USDC.e',
    decimals: 6,
    testnet: false,
    recommend: 'both' as const,
  },
  x402Base: {
    network: 'eip155:8453',
    chainId: 8453,
    token: USDC.base.mainnet.address,
    symbol: 'USDC',
    decimals: 6,
    mode: 'exact' as const,
  },
  solanaMpp: {
    network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    token: USDC.solana.mainnet.mint,
    symbol: 'USDC',
    decimals: 6,
  },
  stripe: {
    rails: ['card', 'link', 'shared_payment_token'] as ('card' | 'link' | 'shared_payment_token')[],
  },
  tempoSession: {
    currency: USDC.tempo.mainnet.address,
    testnet: false,
  },
} as const;
