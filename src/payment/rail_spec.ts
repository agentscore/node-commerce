/**
 * Canonical `*RailSpec` types — one shape per rail, consumed by every helper.
 *
 * A merchant accepting Tempo + Base + Solana + Stripe declares one `*RailSpec`
 * per rail and passes it to every helper (`buildAcceptedMethods`,
 * `buildHowToPay`, `mppPaymentHandler`, `createMppxServer`, ...). One canonical
 * shape per rail means the recipient address, network identifier, and token
 * defaults are declared once and reused everywhere.
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
 * (awaited once). Helpers call this on every invocation; callers that want
 * once-per-session resolution should cache externally.
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
  /** Whether the recipient's ATA may be auto-created on first payment. **Default `true`.**
   *
   *  When `true` (default), the SDK passes
   *  `splits: [{ recipient, amount: '0', ataCreationRequired: true }]` to
   *  `solana.charge`, which puts the recipient in the MPP spec §13.6
   *  `allowedAtaOwners` allow-list. Required on `@solana/mpp >= 0.6.0` with a
   *  sponsored (fee-payer) setup — without it, every settle that emits a
   *  `CreateIdempotent` ATA instruction is rejected. On `@solana/mpp 0.5.x`
   *  the field is unknown and silently ignored, so the default is safe across
   *  versions.
   *
   *  Opt out (`false`) only when every recipient's ATA is guaranteed to exist
   *  out-of-band — typically when the merchant pre-creates the ATA from an
   *  external wallet (one-time USDC transfer of any amount) and refuses to
   *  let the fee-payer fund creation. Rare; mainly useful for low-margin
   *  endpoints that use a stable merchant-owned recipient via
   *  `staticRecipients` and want to guarantee zero rent per call.
   *
   *  Economic note: with rotating recipients (Stripe-multichain per-PI deposit
   *  addresses), the sponsor pays ~0.002 SOL (~$0.50) of rent per call into
   *  accounts the merchant can't close. Acceptable when settle amounts
   *  dominate ($50+ transactions); not viable for sub-dollar merchants —
   *  those should pair `ataCreationRequired: false` with a static recipient
   *  whose ATA has been pre-created (one-time external USDC transfer). */
  ataCreationRequired?: boolean;
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
 * Default field values for each `*RailSpec` — callers can spread these into
 * their spec literal when they want defaults without typing them out. Sourced
 * from the USDC registry so they stay in sync with on-chain reality.
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
