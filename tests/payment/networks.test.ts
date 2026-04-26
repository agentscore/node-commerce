import { describe, expect, it } from 'vitest';
import { networks, networkFamily } from '../../src/payment/networks';

describe('networks registry', () => {
  it('exposes named CAIP-2 strings for each rail', () => {
    expect(networks.base.mainnet.caip2).toBe('eip155:8453');
    expect(networks.base.sepolia.caip2).toBe('eip155:84532');
    expect(networks.tempo.mainnet.caip2).toBe('eip155:4217');
    expect(networks.tempo.testnet.caip2).toBe('eip155:42431');
    expect(networks.solana.mainnet.caip2).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
    expect(networks.solana.devnet.caip2).toBe('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1');
  });

  it('exposes chainId for EVM-family networks', () => {
    expect(networks.base.mainnet.chainId).toBe(8453);
    expect(networks.tempo.mainnet.chainId).toBe(4217);
  });
});

describe('networkFamily', () => {
  it('maps known networks to their family', () => {
    expect(networkFamily('eip155:8453')).toBe('base');
    expect(networkFamily('eip155:4217')).toBe('tempo');
    expect(networkFamily('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toBe('solana');
  });

  it('falls back to "solana" for any unknown solana: prefix', () => {
    expect(networkFamily('solana:custom123')).toBe('solana');
  });

  it('returns null for unrecognized networks', () => {
    expect(networkFamily('eip155:1')).toBeNull();
    expect(networkFamily('eip155:137')).toBeNull();
    expect(networkFamily('unknown:foo')).toBeNull();
  });
});
