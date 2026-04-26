/**
 * USDC token registry per network. Used by paymentDirective and rail definitions.
 * Lifted from agentscore-pay's constants.
 */
export const USDC = {
  base: {
    mainnet: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const, decimals: 6 },
    sepolia: { address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const, decimals: 6 },
  },
  solana: {
    mainnet: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
    devnet: { mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', decimals: 6 },
  },
  tempo: {
    mainnet: { address: '0x20C000000000000000000000b9537d11c60E8b50' as const, decimals: 6 },
    testnet: { address: '0x20c0000000000000000000000000000000000000' as const, decimals: 6 },
  },
} as const;
