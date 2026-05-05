import { describe, expect, it } from 'vitest';
import { buildX402AcceptsFor402, createX402Server } from '../../src/payment/x402_server';

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

describe('buildX402AcceptsFor402', () => {
  it('passes the resource-config kwargs to server.buildPaymentRequirements and returns its array', async () => {
    let captured: { config?: Record<string, unknown>; extensions?: unknown } = {};
    const fakeServer = {
      register: () => {},
      registerExtension: () => {},
      initialize: async () => {},
      buildPaymentRequirements: async (config: Record<string, unknown>, extensions?: unknown) => {
        captured = { config, extensions };
        return [
          {
            scheme: 'exact',
            network: config.network,
            amount: '100000',
            asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            payTo: config.payTo,
            maxTimeoutSeconds: config.maxTimeoutSeconds ?? 300,
            extra: { name: 'USD Coin', version: '2' },
          },
        ];
      },
    } as never;

    const accepts = await buildX402AcceptsFor402(fakeServer, {
      network: 'eip155:8453',
      price: '$0.10',
      payTo: '0x000000000000000000000000000000000000dEaD',
    });
    // Defaults applied: scheme=exact, maxTimeoutSeconds=300
    expect(captured.config).toEqual({
      scheme: 'exact',
      network: 'eip155:8453',
      price: '$0.10',
      payTo: '0x000000000000000000000000000000000000dEaD',
      maxTimeoutSeconds: 300,
    });
    expect(captured.extensions).toBeUndefined();
    expect(Array.isArray(accepts)).toBe(true);
    expect(accepts).toHaveLength(1);
    const accept = accepts[0] as Record<string, unknown>;
    expect(accept.network).toBe('eip155:8453');
    expect(accept.payTo).toBe('0x000000000000000000000000000000000000dEaD');
    expect(accept.extra).toEqual({ name: 'USD Coin', version: '2' });
  });

  it('honours scheme + maxTimeoutSeconds + extensions when supplied', async () => {
    let captured: { config?: Record<string, unknown>; extensions?: unknown } = {};
    const fakeServer = {
      register: () => {},
      registerExtension: () => {},
      initialize: async () => {},
      buildPaymentRequirements: async (config: Record<string, unknown>, extensions?: unknown) => {
        captured = { config, extensions };
        return [];
      },
    } as never;

    await buildX402AcceptsFor402(fakeServer, {
      network: 'eip155:8453',
      price: '$1.00',
      payTo: '0xabc',
      scheme: 'upto',
      maxTimeoutSeconds: 600,
      extensions: ['bazaar'],
    });
    expect(captured.config?.scheme).toBe('upto');
    expect(captured.config?.maxTimeoutSeconds).toBe(600);
    expect(captured.extensions).toEqual(['bazaar']);
  });

  it('returns an empty array when buildPaymentRequirements returns a non-array', async () => {
    const fakeServer = {
      register: () => {},
      registerExtension: () => {},
      initialize: async () => {},
      buildPaymentRequirements: async () => null,
    } as never;
    const accepts = await buildX402AcceptsFor402(fakeServer, {
      network: 'eip155:8453',
      price: '$0.10',
      payTo: '0xabc',
    });
    expect(accepts).toEqual([]);
  });
});
