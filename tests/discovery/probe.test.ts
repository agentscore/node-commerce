import { describe, expect, it } from 'vitest';
import { buildDiscoveryProbeResponse, isDiscoveryProbeRequest } from '../../src/discovery/probe';

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
