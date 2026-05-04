import { describe, expect, it } from 'vitest';
import { networks } from '../../src/payment/networks';
import { validateX402NetworkConfig, verifyX402Request } from '../../src/payment/x402_validation';

const acceptedNetwork = networks.base.sepolia.caip2;

const evm = (header: string) =>
  new Request('https://m.example/x', { headers: { 'x-payment': header } });
const sig = (header: string) =>
  new Request('https://m.example/x', { headers: { 'payment-signature': header } });

describe('validateX402NetworkConfig', () => {
  it('throws when baseNetwork is unsupported and includes the supported list', () => {
    expect(() =>
      validateX402NetworkConfig({ baseNetwork: 'eip155:99999' }),
    ).toThrow(/X402_BASE_NETWORK=eip155:99999.*not supported.*eip155:8453/);
  });

  it('returns silently for a valid base network', () => {
    expect(() => validateX402NetworkConfig({ baseNetwork: acceptedNetwork })).not.toThrow();
  });
});

describe('verifyX402Request', () => {
  it('failure body always includes regenerate_payment_credential next_steps + warning', async () => {
    const res = await verifyX402Request({
      request: new Request('https://m.example/x'),
      isCachedAddress: async () => true,
      acceptedNetwork,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.body.error.code).toBe('payment_proof_invalid');
      expect(res.body.next_steps.action).toBe('regenerate_payment_credential');
      expect(res.body.next_steps.user_message).toMatch(/X-Payment|credential|fresh/);
      expect(res.body.next_steps.warning).toContain('tempo wallet transfer');
    }
  });

  it('returns ok:true for a valid evm payload', async () => {
    const payTo = '0x' + 'a'.repeat(40);
    const headerValue = Buffer.from(JSON.stringify({ accepted: { network: acceptedNetwork, payTo } })).toString('base64');
    const res = await verifyX402Request({
      request: evm(headerValue),
      isCachedAddress: async () => true,
      acceptedNetwork,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.signedPayTo).toBe(payTo);
    }
  });

  it('returns ok:true for a valid evm payload via payment-signature header', async () => {
    const payTo = '0x' + 'c'.repeat(40);
    const headerValue = Buffer.from(JSON.stringify({ accepted: { network: acceptedNetwork, payTo } })).toString('base64');
    const res = await verifyX402Request({
      request: sig(headerValue),
      isCachedAddress: async () => true,
      acceptedNetwork,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.signedNetwork).toBe(acceptedNetwork);
    }
  });

  it('returns ok:false when payload is not valid base64 JSON', async () => {
    const res = await verifyX402Request({
      request: evm('not-base64-json'),
      isCachedAddress: async () => true,
      acceptedNetwork,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.body.error.message).toMatch(/not valid base64 JSON/);
  });

  it('returns ok:false when accepted.network is missing', async () => {
    const headerValue = Buffer.from(JSON.stringify({ accepted: {} })).toString('base64');
    const res = await verifyX402Request({
      request: evm(headerValue),
      isCachedAddress: async () => true,
      acceptedNetwork,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.body.error.message).toContain('Unsupported x402 network');
  });

  it('returns ok:false when network is not the merchant accepted Base network', async () => {
    const headerValue = Buffer.from(
      JSON.stringify({ accepted: { network: 'eip155:1', payTo: '0x' + 'a'.repeat(40) } }),
    ).toString('base64');
    const res = await verifyX402Request({
      request: evm(headerValue),
      isCachedAddress: async () => true,
      acceptedNetwork,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.body.error.message).toContain('eip155:1');
  });

  it('returns ok:false for any solana payload (Solana is no longer supported under x402; route via MPP)', async () => {
    const headerValue = Buffer.from(
      JSON.stringify({ accepted: { network: networks.solana.mainnet.caip2, payTo: 'GEQg2TM4VL315Bd4LLkGrhBjdNfoatKjCJYHBDPM3D74' } }),
    ).toString('base64');
    const res = await verifyX402Request({
      request: evm(headerValue),
      isCachedAddress: async () => true,
      acceptedNetwork,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.body.error.message).toContain('Unsupported x402 network');
  });

  it('returns ok:false when payTo is malformed for EVM (wrong length)', async () => {
    const headerValue = Buffer.from(
      JSON.stringify({ accepted: { network: acceptedNetwork, payTo: '0xabc' } }),
    ).toString('base64');
    const res = await verifyX402Request({
      request: evm(headerValue),
      isCachedAddress: async () => true,
      acceptedNetwork,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.body.error.message).toMatch(/missing or malformed accepted.payTo/);
  });

  it('returns ok:false when payTo is missing entirely', async () => {
    const headerValue = Buffer.from(
      JSON.stringify({ accepted: { network: acceptedNetwork } }),
    ).toString('base64');
    const res = await verifyX402Request({
      request: evm(headerValue),
      isCachedAddress: async () => true,
      acceptedNetwork,
    });
    expect(res.ok).toBe(false);
  });

  it('returns ok:false when isCachedAddress returns false', async () => {
    const payTo = '0x' + 'b'.repeat(40);
    const headerValue = Buffer.from(JSON.stringify({ accepted: { network: acceptedNetwork, payTo } })).toString('base64');
    const res = await verifyX402Request({
      request: evm(headerValue),
      isCachedAddress: async () => false,
      acceptedNetwork,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.body.error.message).toMatch(/payTo address not found in cache/);
  });
});
