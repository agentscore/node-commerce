import { describe, expect, it } from 'vitest';
import {
  buildDiscoveryProbeResponse,
  isDiscoveryProbeRequest,
  sampleX402AcceptForNetwork,
} from '../../src/discovery/probe';
import { networks } from '../../src/payment/networks';
import { USDC } from '../../src/payment/usdc';

function decodeBlob(b64: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(b64, 'base64url').toString('utf-8'));
}

describe('buildDiscoveryProbeResponse', () => {
  it('returns a 402 with a valid Payment directive in the WWW-Authenticate header', () => {
    const probe = buildDiscoveryProbeResponse({
      realm: 'merchant.example',
      sampleRail: 'tempo-mainnet',
      sampleAmountUsd: 1.0,
      sampleRecipient: '0x0000000000000000000000000000000000000000',
    });
    expect(probe.status).toBe(402);
    expect(probe.headers['content-type']).toBe('application/json');
    const auth = probe.headers['www-authenticate'];
    expect(auth).toBeTruthy();
    expect(auth).toContain('Payment id="probe_');
    expect(auth).toContain('method="tempo"');
    expect(auth).toContain('realm="merchant.example"');
  });

  it('encodes a spec-compliant request blob (raw integer amount + chainId)', () => {
    const probe = buildDiscoveryProbeResponse({
      realm: 'merchant.example',
      sampleRail: 'tempo-mainnet',
      sampleAmountUsd: 1.0,
      sampleRecipient: '0xdeadbeef',
    });
    const requestMatch = probe.headers['www-authenticate']!.match(/request="([^"]+)"/);
    const blob = decodeBlob(requestMatch![1]!);
    expect(blob.amount).toBe('1000000');
    expect(blob.recipient).toBe('0xdeadbeef');
    expect(blob.methodDetails).toEqual({ chainId: 4217 });
  });

  it('includes docs URL in body when provided', () => {
    const probe = buildDiscoveryProbeResponse({
      realm: 'merchant.example',
      sampleRail: 'tempo-mainnet',
      sampleAmountUsd: 1,
      sampleRecipient: '0x0',
      docsUrl: 'https://merchant.example/llms.txt',
    });
    const body = JSON.parse(probe.body);
    expect(body.docs).toBe('https://merchant.example/llms.txt');
    expect(body.discovery).toBe(true);
  });
});

describe('isDiscoveryProbeRequest', () => {
  function makeReq(opts: { method: string; auth?: string; body?: string }) {
    return {
      method: opts.method,
      headers: {
        get(name: string): string | null {
          if (name.toLowerCase() === 'authorization') return opts.auth ?? null;
          return null;
        },
      },
      clone(): { text(): Promise<string> } {
        return { text: async () => opts.body ?? '' };
      },
    };
  }

  it('returns true for empty-body POST without auth', async () => {
    expect(await isDiscoveryProbeRequest(makeReq({ method: 'POST' }))).toBe(true);
    expect(await isDiscoveryProbeRequest(makeReq({ method: 'POST', body: '' }))).toBe(true);
    expect(await isDiscoveryProbeRequest(makeReq({ method: 'POST', body: '{}' }))).toBe(true);
  });

  it('returns false for non-POST', async () => {
    expect(await isDiscoveryProbeRequest(makeReq({ method: 'GET' }))).toBe(false);
  });

  it('returns false when Authorization: Payment is present', async () => {
    expect(
      await isDiscoveryProbeRequest(makeReq({ method: 'POST', auth: 'Payment id="x"' })),
    ).toBe(false);
  });

  it('returns false for non-empty body', async () => {
    expect(await isDiscoveryProbeRequest(makeReq({ method: 'POST', body: '{"x":1}' }))).toBe(false);
  });
});

describe('sampleX402AcceptForNetwork', () => {
  it('returns Base mainnet USDC accept for the Base mainnet CAIP-2', () => {
    const a = sampleX402AcceptForNetwork(networks.base.mainnet.caip2);
    expect(a).toEqual({
      scheme: 'exact',
      network: networks.base.mainnet.caip2,
      amount: '1000000',
      asset: USDC.base.mainnet.address,
      payTo: '0x0000000000000000000000000000000000000000',
      maxTimeoutSeconds: 300,
      extra: { name: 'USDC', version: '2' },
    });
  });

  it('returns Base sepolia USDC accept with custom amountAtomic', () => {
    const a = sampleX402AcceptForNetwork(networks.base.sepolia.caip2, '500000');
    expect(a?.network).toBe(networks.base.sepolia.caip2);
    expect(a?.asset).toBe(USDC.base.sepolia.address);
    expect(a?.amount).toBe('500000');
    expect(a?.extra).toEqual({ name: 'USDC', version: '2' });
  });

  it('returns Solana mainnet USDC accept (no extra) for the Solana mainnet CAIP-2', () => {
    const a = sampleX402AcceptForNetwork(networks.solana.mainnet.caip2);
    expect(a?.network).toBe(networks.solana.mainnet.caip2);
    expect(a?.asset).toBe(USDC.solana.mainnet.mint);
    expect(a?.payTo).toBe('11111111111111111111111111111111');
    expect(a).not.toHaveProperty('extra');
  });

  it('returns Solana devnet USDC accept for the Solana devnet CAIP-2', () => {
    const a = sampleX402AcceptForNetwork(networks.solana.devnet.caip2);
    expect(a?.network).toBe(networks.solana.devnet.caip2);
    expect(a?.asset).toBe(USDC.solana.devnet.mint);
  });

  it('returns null for an unknown CAIP-2', () => {
    expect(sampleX402AcceptForNetwork('eip155:99999')).toBeNull();
  });
});

describe('buildDiscoveryProbeResponse — x402Sample branch', () => {
  it('emits payment-required header + body accepts when networks shorthand is supplied', () => {
    const probe = buildDiscoveryProbeResponse({
      realm: 'merchant.example',
      sampleRail: 'tempo-mainnet',
      sampleAmountUsd: 1,
      sampleRecipient: '0x0',
      x402Sample: {
        networks: [networks.base.mainnet.caip2, networks.solana.mainnet.caip2],
        resourceUrl: 'https://merchant.example/purchase',
      },
    });
    expect(probe.headers['payment-required']).toBeTruthy();
    const body = JSON.parse(probe.body);
    expect(body.x402Version).toBe(2);
    expect(Array.isArray(body.accepts)).toBe(true);
    expect(body.accepts.length).toBe(2);
    expect(body.accepts[0].network).toBe(networks.base.mainnet.caip2);
  });

  it('skips unknown CAIP-2 networks in shorthand silently', () => {
    const probe = buildDiscoveryProbeResponse({
      realm: 'merchant.example',
      sampleRail: 'tempo-mainnet',
      sampleAmountUsd: 1,
      sampleRecipient: '0x0',
      x402Sample: { networks: [networks.base.mainnet.caip2, 'eip155:99999'] },
    });
    const body = JSON.parse(probe.body);
    expect(body.accepts.length).toBe(1);
  });

  it('uses caller-supplied accepts directly (no networks resolution) and respects version=1', () => {
    const custom = [{ scheme: 'exact', network: 'custom:1', amount: '42', payTo: '0xabc' }];
    const probe = buildDiscoveryProbeResponse({
      realm: 'merchant.example',
      sampleRail: 'tempo-mainnet',
      sampleAmountUsd: 1,
      sampleRecipient: '0x0',
      x402Sample: { accepts: custom, version: 1 },
    });
    const body = JSON.parse(probe.body);
    expect(body.x402Version).toBe(1);
    expect(body.accepts).toHaveLength(1);
    expect(body.accepts[0].network).toBe('custom:1');
  });

  it('uses custom amountAtomic for networks-shorthand entries', () => {
    const probe = buildDiscoveryProbeResponse({
      realm: 'merchant.example',
      sampleRail: 'tempo-mainnet',
      sampleAmountUsd: 1,
      sampleRecipient: '0x0',
      x402Sample: { networks: [networks.base.mainnet.caip2], amountAtomic: '5000000' },
    });
    const body = JSON.parse(probe.body);
    expect(body.accepts[0].amount).toBe('5000000');
  });

  it('uses caller-supplied message in body', () => {
    const probe = buildDiscoveryProbeResponse({
      realm: 'merchant.example',
      sampleRail: 'tempo-mainnet',
      sampleAmountUsd: 1,
      sampleRecipient: '0x0',
      message: 'Custom probe message',
      ttlSeconds: 60,
      intent: 'subscribe',
    });
    const body = JSON.parse(probe.body);
    expect(body.error.message).toBe('Custom probe message');
    expect(probe.headers['www-authenticate']).toContain('expires=');
  });
});
