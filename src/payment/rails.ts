import { networks } from './networks';
import { USDC } from './usdc';

/**
 * Symbolic rail names mapped to their protocol details. Vendors pass `rail: 'tempo-mainnet'`
 * to the directive builder and the SDK fills in method/network/decimals/currency from this
 * registry. Custom rails not in this registry can be passed by setting the lower-level
 * fields directly on the directive builder.
 */
export const rails = {
  'tempo-mainnet': {
    method: 'tempo',
    network: networks.tempo.mainnet.caip2,
    chainId: networks.tempo.mainnet.chainId,
    currency: USDC.tempo.mainnet.address,
    decimals: USDC.tempo.mainnet.decimals,
    asset: USDC.tempo.mainnet.address,
  },
  'tempo-testnet': {
    method: 'tempo',
    network: networks.tempo.testnet.caip2,
    chainId: networks.tempo.testnet.chainId,
    currency: USDC.tempo.testnet.address,
    decimals: USDC.tempo.testnet.decimals,
    asset: USDC.tempo.testnet.address,
  },
  'x402-base-mainnet': {
    method: 'x402',
    network: networks.base.mainnet.caip2,
    chainId: networks.base.mainnet.chainId,
    currency: USDC.base.mainnet.address,
    decimals: USDC.base.mainnet.decimals,
    asset: USDC.base.mainnet.address,
  },
  'x402-base-sepolia': {
    method: 'x402',
    network: networks.base.sepolia.caip2,
    chainId: networks.base.sepolia.chainId,
    currency: USDC.base.sepolia.address,
    decimals: USDC.base.sepolia.decimals,
    asset: USDC.base.sepolia.address,
  },
  // Upto rails — pay UP TO a max amount (Permit2-based, vs EIP-3009 for exact). Use for
  // variable-cost APIs where the actual cost depends on output (LLM tokens, bandwidth, etc.).
  // Only available on EVM networks; Solana svm doesn't ship an upto scheme yet.
  'x402-base-mainnet-upto': {
    method: 'x402-upto',
    network: networks.base.mainnet.caip2,
    chainId: networks.base.mainnet.chainId,
    currency: USDC.base.mainnet.address,
    decimals: USDC.base.mainnet.decimals,
    asset: USDC.base.mainnet.address,
  },
  'x402-base-sepolia-upto': {
    method: 'x402-upto',
    network: networks.base.sepolia.caip2,
    chainId: networks.base.sepolia.chainId,
    currency: USDC.base.sepolia.address,
    decimals: USDC.base.sepolia.decimals,
    asset: USDC.base.sepolia.address,
  },
  'mpp-solana-mainnet': {
    method: 'solana',
    network: networks.solana.mainnet.caip2,
    currency: USDC.solana.mainnet.mint,
    decimals: USDC.solana.mainnet.decimals,
    asset: USDC.solana.mainnet.mint,
  },
  'mpp-solana-devnet': {
    method: 'solana',
    network: networks.solana.devnet.caip2,
    currency: USDC.solana.devnet.mint,
    decimals: USDC.solana.devnet.decimals,
    asset: USDC.solana.devnet.mint,
  },
  'stripe-spt': {
    method: 'stripe',
    currency: 'usd',
    decimals: 2,
  },
} as const;

export type RailName = keyof typeof rails;

export interface RailDefinition {
  method: string;
  network?: string;
  chainId?: number;
  currency: string;
  decimals: number;
  asset?: string;
}

/**
 * Lookup a rail definition by symbolic name. Returns undefined if the rail isn't in
 * the registry — vendors with custom rails should pass the low-level fields directly.
 */
export function lookupRail(name: string): RailDefinition | undefined {
  return rails[name as RailName] as RailDefinition | undefined;
}
