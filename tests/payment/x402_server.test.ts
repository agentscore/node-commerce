import { describe, expect, it } from 'vitest';
import { createX402Server } from '../../src/payment/x402_server';

describe('createX402Server', () => {
  it('returns an x402ResourceServer with HTTP facilitator by default', async () => {
    const server = await createX402Server({ initialize: false });
    expect(server).toBeDefined();
    expect(typeof server.register).toBe('function');
    expect(typeof server.registerExtension).toBe('function');
  });

  it('registers ExactEvmScheme on both v1 and v2 for x402 base rails', async () => {
    const server = await createX402Server({ rails: ['x402-base-mainnet'], initialize: false });
    expect(server).toBeDefined();
  });

  it('registers UptoEvmScheme for upto rails', async () => {
    const server = await createX402Server({ rails: ['x402-base-mainnet-upto'], initialize: false });
    expect(server).toBeDefined();
  });

  it('uses the Coinbase CDP facilitator when facilitator: "coinbase"', async () => {
    const server = await createX402Server({ facilitator: 'coinbase', initialize: false });
    expect(server).toBeDefined();
  });

  it('accepts a custom facilitator object', async () => {
    const customFacilitator = { custom: true };
    const server = await createX402Server({ facilitator: customFacilitator, initialize: false });
    expect(server).toBeDefined();
  });

  it('registers schemes from the schemes option in addition to rails', async () => {
    const server = await createX402Server({
      schemes: [{ network: 'eip155:1', scheme: { custom: true } }],
      initialize: false,
    });
    expect(server).toBeDefined();
  });

  it('registers the Bazaar discovery extension when bazaar: true', async () => {
    const server = await createX402Server({ bazaar: true, initialize: false });
    expect(server).toBeDefined();
  });

  it('registers multiple Base rails in one call (mainnet + sepolia)', async () => {
    const server = await createX402Server({
      rails: ['x402-base-mainnet', 'x402-base-sepolia'],
      initialize: false,
    });
    expect(server).toBeDefined();
  });
});
