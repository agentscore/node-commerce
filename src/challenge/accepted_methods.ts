import {
  RAIL_SPEC_DEFAULTS,
  type SolanaMppRailSpec,
  type StripeRailSpec,
  type TempoRailSpec,
  type X402BaseRailSpec,
  resolveRecipient,
} from '../payment/rail_spec';

export interface TempoMethodEntry {
  method: 'tempo/charge';
  network: string;
  chain_id: number;
  token: string;
  symbol: string;
  decimals: number;
  pay_to: string;
}

export interface X402MethodEntry {
  method: 'x402/exact';
  network: string;
  chain_id?: number;
  token: string;
  symbol: string;
  decimals: number;
  pay_to: string;
}

export interface SolanaMppMethodEntry {
  method: 'solana/charge';
  network: string;
  token: string;
  symbol: string;
  decimals: number;
  pay_to: string;
}

export interface StripeMethodEntry {
  method: 'stripe/charge';
  rails: ('card' | 'link' | 'shared_payment_token')[];
  profile_id: string | null;
}

export type AcceptedMethodEntry =
  | TempoMethodEntry
  | X402MethodEntry
  | SolanaMppMethodEntry
  | StripeMethodEntry;

/**
 * Build the `accepted_methods[]` array for an enriched 402 body. Each rail entry
 * is conditionally included when the vendor passes a `*RailSpec` for that rail.
 * Each spec's `recipient` is resolved via `resolveRecipient` so per-order
 * factories (e.g. Stripe-multichain mints fresh deposits per PaymentIntent)
 * flow through identically to static-treasury strings.
 */
export async function buildAcceptedMethods({
  tempo,
  x402_base,
  solana_mpp,
  stripe,
}: {
  tempo?: TempoRailSpec;
  x402_base?: X402BaseRailSpec;
  solana_mpp?: SolanaMppRailSpec;
  stripe?: StripeRailSpec;
}): Promise<AcceptedMethodEntry[]> {
  const out: AcceptedMethodEntry[] = [];

  if (tempo) {
    out.push({
      method: 'tempo/charge',
      network: tempo.network ?? RAIL_SPEC_DEFAULTS.tempo.network,
      chain_id: tempo.chainId ?? RAIL_SPEC_DEFAULTS.tempo.chainId,
      token: tempo.token ?? RAIL_SPEC_DEFAULTS.tempo.token,
      symbol: tempo.symbol ?? RAIL_SPEC_DEFAULTS.tempo.symbol,
      decimals: tempo.decimals ?? RAIL_SPEC_DEFAULTS.tempo.decimals,
      pay_to: await resolveRecipient(tempo.recipient),
    });
  }

  if (x402_base) {
    out.push({
      method: 'x402/exact',
      network: x402_base.network ?? RAIL_SPEC_DEFAULTS.x402Base.network,
      chain_id: x402_base.chainId ?? RAIL_SPEC_DEFAULTS.x402Base.chainId,
      token: x402_base.token ?? RAIL_SPEC_DEFAULTS.x402Base.token,
      symbol: x402_base.symbol ?? RAIL_SPEC_DEFAULTS.x402Base.symbol,
      decimals: x402_base.decimals ?? RAIL_SPEC_DEFAULTS.x402Base.decimals,
      pay_to: await resolveRecipient(x402_base.recipient),
    });
  }

  if (solana_mpp) {
    out.push({
      method: 'solana/charge',
      network: solana_mpp.network ?? RAIL_SPEC_DEFAULTS.solanaMpp.network,
      token: solana_mpp.token ?? RAIL_SPEC_DEFAULTS.solanaMpp.token,
      symbol: solana_mpp.symbol ?? RAIL_SPEC_DEFAULTS.solanaMpp.symbol,
      decimals: solana_mpp.decimals ?? RAIL_SPEC_DEFAULTS.solanaMpp.decimals,
      pay_to: await resolveRecipient(solana_mpp.recipient),
    });
  }

  if (stripe) {
    out.push({
      method: 'stripe/charge',
      rails: stripe.rails ?? [...RAIL_SPEC_DEFAULTS.stripe.rails],
      profile_id: stripe.profileId ?? null,
    });
  }

  return out;
}
