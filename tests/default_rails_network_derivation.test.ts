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
