import { describe, expect, it } from 'vitest';
import { isEvmNetwork, isSolanaNetwork } from '../../src/payment/network_kind';

describe('isEvmNetwork', () => {
  it('detects CAIP-2 EVM strings', () => {
    expect(isEvmNetwork('eip155:8453')).toBe(true);
    expect(isEvmNetwork('eip155:84532')).toBe(true);
    expect(isEvmNetwork('eip155:1')).toBe(true);
  });

  it('rejects non-EVM strings', () => {
    expect(isEvmNetwork('solana:5eykt')).toBe(false);
    expect(isEvmNetwork('')).toBe(false);
    expect(isEvmNetwork('eth')).toBe(false);
  });

  it('reads rail-spec objects', () => {
    expect(isEvmNetwork({ network: 'eip155:8453' })).toBe(true);
    expect(isEvmNetwork({ network: 'solana:abc' })).toBe(false);
  });

  it('handles null / undefined / number / object without network', () => {
    expect(isEvmNetwork(null)).toBe(false);
    expect(isEvmNetwork(undefined)).toBe(false);
    expect(isEvmNetwork({})).toBe(false);
    expect(isEvmNetwork({ network: 42 } as never)).toBe(false);
  });
});

describe('isSolanaNetwork', () => {
  it('detects CAIP-2 Solana strings', () => {
    expect(isSolanaNetwork('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toBe(true);
    expect(isSolanaNetwork('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1')).toBe(true);
  });

  it('rejects bare "solana" (mppx-internal label, not CAIP-2)', () => {
    expect(isSolanaNetwork('solana')).toBe(false);
  });

  it('rejects EVM + empty', () => {
    expect(isSolanaNetwork('eip155:8453')).toBe(false);
    expect(isSolanaNetwork('')).toBe(false);
  });

  it('reads rail-spec objects', () => {
    expect(isSolanaNetwork({ network: 'solana:abc' })).toBe(true);
    expect(isSolanaNetwork({})).toBe(false);
  });

  it('handles null / undefined / number', () => {
    expect(isSolanaNetwork(null)).toBe(false);
    expect(isSolanaNetwork(undefined)).toBe(false);
    expect(isSolanaNetwork({ network: 42 } as never)).toBe(false);
  });
});
