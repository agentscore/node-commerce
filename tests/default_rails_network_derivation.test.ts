/** Behavior contract for `buildDefaultCheckoutRails` network → token derivation.
 *
 *  When the merchant overrides `network` without pinning `token` / `chainId`,
 *  the helper derives the right token (and chainId for EVM) from the network:
 *  Base Sepolia → Sepolia USDC, Base mainnet → mainnet USDC, Solana devnet →
 *  devnet USDC mint. Explicit `token` overrides always win. Mirrors python's
 *  `X402BaseRailSpec.__post_init__` / `SolanaMppRailSpec.__post_init__`.
 */
import { describe, expect, it } from 'vitest';
import { buildDefaultCheckoutRails } from '../src/payment/default_rails';
import { networks } from '../src/payment/networks';
import { USDC } from '../src/payment/usdc';

describe('buildDefaultCheckoutRails — x402Base network/token derivation', () => {
  it('Sepolia override flips chainId + token to Sepolia USDC even when token not pinned', () => {
    const rails = buildDefaultCheckoutRails({
      x402Base: { network: networks.base.sepolia.caip2 },
    });
    expect(rails.x402_base?.network).toBe(networks.base.sepolia.caip2);
    expect(rails.x402_base?.chainId).toBe(networks.base.sepolia.chainId);
    expect(rails.x402_base?.token).toBe(USDC.base.sepolia.address);
  });

  it('mainnet default keeps mainnet USDC + chainId', () => {
    const rails = buildDefaultCheckoutRails({ x402Base: {} });
    expect(rails.x402_base?.network).toBe(networks.base.mainnet.caip2);
    expect(rails.x402_base?.chainId).toBe(networks.base.mainnet.chainId);
    expect(rails.x402_base?.token).toBe(USDC.base.mainnet.address);
  });

  it('explicit token override wins over network-derived default', () => {
    const rails = buildDefaultCheckoutRails({
      x402Base: { network: networks.base.sepolia.caip2, token: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
    });
    expect(rails.x402_base?.token).toBe('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  });

  it('explicit chainId override on Sepolia is preserved (chainId-defined branch)', () => {
    const rails = buildDefaultCheckoutRails({
      x402Base: { network: networks.base.sepolia.caip2, chainId: 99999 },
    });
    expect(rails.x402_base?.chainId).toBe(99999);
    // token still derived since it was not pinned
    expect(rails.x402_base?.token).toBe(USDC.base.sepolia.address);
  });

  it('a non-Base network is left untouched (neither sepolia nor mainnet branch)', () => {
    // An EVM network that is neither Base Sepolia nor Base mainnet skips both
    // derivation arms; token/chainId stay at whatever was merged from defaults.
    const rails = buildDefaultCheckoutRails({
      x402Base: { network: 'eip155:10', token: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', chainId: 10 },
    });
    expect(rails.x402_base?.network).toBe('eip155:10');
    expect(rails.x402_base?.chainId).toBe(10);
    expect(rails.x402_base?.token).toBe('0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85');
  });

  it('explicit chainId + token override on mainnet are preserved (mainnet defined-branch)', () => {
    const rails = buildDefaultCheckoutRails({
      x402Base: {
        network: networks.base.mainnet.caip2,
        chainId: 8453,
        token: '0xcafecafecafecafecafecafecafecafecafecafe',
      },
    });
    expect(rails.x402_base?.chainId).toBe(8453);
    expect(rails.x402_base?.token).toBe('0xcafecafecafecafecafecafecafecafecafecafe');
  });
});

describe('buildDefaultCheckoutRails — tempo testnet field-pinned branches', () => {
  it('testnet: true with explicit token/chainId/network keeps the overrides (defined branches)', () => {
    const rails = buildDefaultCheckoutRails({
      tempo: {
        testnet: true,
        network: 'tempo-custom',
        chainId: 12345,
        token: '0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed',
      },
    });
    expect(rails.tempo?.network).toBe('tempo-custom');
    expect(rails.tempo?.chainId).toBe(12345);
    expect(rails.tempo?.token).toBe('0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed');
  });

  it('solana devnet with explicit token keeps the override (token-defined branch)', () => {
    const rails = buildDefaultCheckoutRails({
      solanaMpp: { network: 'devnet', token: 'CustomMint1111111111111111111111111111111111' },
    });
    expect(rails.solana_mpp?.token).toBe('CustomMint1111111111111111111111111111111111');
  });
});

describe('buildDefaultCheckoutRails — solanaMpp network/mint derivation', () => {
  it('devnet CAIP-2 flips mint to devnet USDC', () => {
    const rails = buildDefaultCheckoutRails({
      solanaMpp: { network: networks.solana.devnet.caip2 },
    });
    expect(rails.solana_mpp?.token).toBe(USDC.solana.devnet.mint);
  });

  it("raw 'devnet' string (the @solana/mpp form) flips mint to devnet USDC", () => {
    const rails = buildDefaultCheckoutRails({
      solanaMpp: { network: 'devnet' },
    });
    expect(rails.solana_mpp?.token).toBe(USDC.solana.devnet.mint);
  });

  it('mainnet default keeps mainnet mint', () => {
    const rails = buildDefaultCheckoutRails({ solanaMpp: {} });
    expect(rails.solana_mpp?.token).toBe(USDC.solana.mainnet.mint);
  });
});
