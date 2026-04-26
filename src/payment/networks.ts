/**
 * Named network registry. Vendors reference symbolic names (`networks.base.mainnet.caip2`)
 * instead of magic strings. Lifted from agentscore-pay's constants.
 */
export const networks = {
  base: {
    mainnet: { caip2: 'eip155:8453' as const, chainId: 8453 },
    sepolia: { caip2: 'eip155:84532' as const, chainId: 84532 },
  },
  solana: {
    mainnet: { caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' as const },
    devnet: { caip2: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as const },
  },
  tempo: {
    mainnet: { caip2: 'eip155:4217' as const, chainId: 4217 },
    testnet: { caip2: 'eip155:42431' as const, chainId: 42431 },
  },
} as const;

export type NetworkFamily = keyof typeof networks;

/**
 * Returns the family name (base/solana/tempo) for a given CAIP-2 network string,
 * or null if the network isn't in the registry. Useful for routing settlement
 * by network.
 */
export function networkFamily(caip2: string): NetworkFamily | null {
  if (caip2 === networks.base.mainnet.caip2 || caip2 === networks.base.sepolia.caip2) return 'base';
  if (caip2 === networks.solana.mainnet.caip2 || caip2 === networks.solana.devnet.caip2) return 'solana';
  if (caip2 === networks.tempo.mainnet.caip2 || caip2 === networks.tempo.testnet.caip2) return 'tempo';
  if (caip2.startsWith('solana:')) return 'solana';
  return null;
}
