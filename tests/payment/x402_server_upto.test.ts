import { describe, expect, it } from 'vitest';
import { createX402Server } from '../../src/payment/x402_server';

describe('createX402Server — upto scheme support', () => {
  it('successfully registers an UptoEvmScheme on x402 base rails', async () => {
    const server = await createX402Server({ rails: ['x402-base-mainnet-upto'], initialize: false });
    expect(server).toBeDefined();
  });

  it('successfully registers an UptoEvmScheme on x402 base sepolia rails', async () => {
    const server = await createX402Server({ rails: ['x402-base-sepolia-upto'], initialize: false });
    expect(server).toBeDefined();
  });
});
