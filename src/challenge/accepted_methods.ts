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

export interface BuildAcceptedMethodsInput {
  tempo?: {
    recipient: string;
    network?: string;
    chainId?: number;
    token?: string;
    symbol?: string;
    decimals?: number;
  };
  x402_base?: {
    recipient: string;
    network?: string;
    chainId?: number;
    token?: string;
    symbol?: string;
    decimals?: number;
  };
  solana_mpp?: {
    recipient: string;
    network?: string;
    token?: string;
    symbol?: string;
    decimals?: number;
    feePayerKey?: string;
  };
  stripe?: {
    profileId?: string | null;
    rails?: ('card' | 'link' | 'shared_payment_token')[];
  };
}

/**
 * Build the `accepted_methods[]` array for an enriched 402 body. Each rail entry is
 * conditionally included based on whether the vendor passed it. Per-rail shapes follow
 * the conventions established in martin-estate's reference 402.
 */
export function buildAcceptedMethods(input: BuildAcceptedMethodsInput): AcceptedMethodEntry[] {
  const out: AcceptedMethodEntry[] = [];

  if (input.tempo) {
    out.push({
      method: 'tempo/charge',
      network: input.tempo.network ?? 'tempo-mainnet',
      chain_id: input.tempo.chainId ?? 4217,
      token: input.tempo.token ?? '0x20C000000000000000000000b9537d11c60E8b50',
      symbol: input.tempo.symbol ?? 'USDC.e',
      decimals: input.tempo.decimals ?? 6,
      pay_to: input.tempo.recipient,
    });
  }

  if (input.x402_base) {
    out.push({
      method: 'x402/exact',
      network: input.x402_base.network ?? 'eip155:8453',
      chain_id: input.x402_base.chainId ?? 8453,
      token: input.x402_base.token ?? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      symbol: input.x402_base.symbol ?? 'USDC',
      decimals: input.x402_base.decimals ?? 6,
      pay_to: input.x402_base.recipient,
    });
  }

  if (input.solana_mpp) {
    out.push({
      method: 'solana/charge',
      network: input.solana_mpp.network ?? 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      token: input.solana_mpp.token ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      symbol: input.solana_mpp.symbol ?? 'USDC',
      decimals: input.solana_mpp.decimals ?? 6,
      pay_to: input.solana_mpp.recipient,
      ...(input.solana_mpp.feePayerKey ? { fee_payer_key: input.solana_mpp.feePayerKey } : {}),
    });
  }

  if (input.stripe) {
    out.push({
      method: 'stripe/charge',
      rails: input.stripe.rails ?? ['card', 'link', 'shared_payment_token'],
      profile_id: input.stripe.profileId ?? null,
    });
  }

  return out;
}
