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
  fee_payer_key?: string;
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

export interface TempoAcceptedMethodConfig {
  recipient: string;
  network?: string;
  chainId?: number;
  token?: string;
  symbol?: string;
  decimals?: number;
}

export interface X402BaseAcceptedMethodConfig {
  recipient: string;
  network?: string;
  chainId?: number;
  token?: string;
  symbol?: string;
  decimals?: number;
}

export interface SolanaMppAcceptedMethodConfig {
  recipient: string;
  network?: string;
  token?: string;
  symbol?: string;
  decimals?: number;
  feePayerKey?: string;
}

export interface StripeAcceptedMethodConfig {
  profileId?: string | null;
  rails?: ('card' | 'link' | 'shared_payment_token')[];
}

/**
 * Build the `accepted_methods[]` array for an enriched 402 body. Each rail entry is
 * conditionally included based on whether the vendor passed it. Per-rail shapes follow
 * a canonical 402 shape across rails.
 */
export function buildAcceptedMethods({
  tempo,
  x402_base,
  solana_mpp,
  stripe,
}: {
  tempo?: TempoAcceptedMethodConfig;
  x402_base?: X402BaseAcceptedMethodConfig;
  solana_mpp?: SolanaMppAcceptedMethodConfig;
  stripe?: StripeAcceptedMethodConfig;
}): AcceptedMethodEntry[] {
  const out: AcceptedMethodEntry[] = [];

  if (tempo) {
    out.push({
      method: 'tempo/charge',
      network: tempo.network ?? 'tempo-mainnet',
      chain_id: tempo.chainId ?? 4217,
      token: tempo.token ?? '0x20C000000000000000000000b9537d11c60E8b50',
      symbol: tempo.symbol ?? 'USDC.e',
      decimals: tempo.decimals ?? 6,
      pay_to: tempo.recipient,
    });
  }

  if (x402_base) {
    out.push({
      method: 'x402/exact',
      network: x402_base.network ?? 'eip155:8453',
      chain_id: x402_base.chainId ?? 8453,
      token: x402_base.token ?? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      symbol: x402_base.symbol ?? 'USDC',
      decimals: x402_base.decimals ?? 6,
      pay_to: x402_base.recipient,
    });
  }

  if (solana_mpp) {
    out.push({
      method: 'solana/charge',
      network: solana_mpp.network ?? 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      token: solana_mpp.token ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      symbol: solana_mpp.symbol ?? 'USDC',
      decimals: solana_mpp.decimals ?? 6,
      pay_to: solana_mpp.recipient,
      ...(solana_mpp.feePayerKey ? { fee_payer_key: solana_mpp.feePayerKey } : {}),
    });
  }

  if (stripe) {
    out.push({
      method: 'stripe/charge',
      rails: stripe.rails ?? ['card', 'link', 'shared_payment_token'],
      profile_id: stripe.profileId ?? null,
    });
  }

  return out;
}
