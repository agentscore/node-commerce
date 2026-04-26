import { describe, expect, it } from 'vitest';
import { extractPaymentSigner, readX402PaymentHeader } from '../../src/payment/signer';

const EVM_LOWER = '0xabcdef0123456789abcdef0123456789abcdef01';
const EVM_MIXED = '0xABCDEF0123456789ABCDEF0123456789ABCDEF01';

const encodeX402 = (payload: unknown): string => Buffer.from(JSON.stringify(payload)).toString('base64');
const makeRequest = (headers: Record<string, string> = {}): Request =>
  new Request('https://example.com/purchase', { headers });

describe('extractPaymentSigner — returns {address, network} for x402 EVM', () => {
  it('returns evm network for an EIP-3009 payload with eip155 network', async () => {
    const header = encodeX402({
      accepted: { network: 'eip155:8453' },
      payload: { authorization: { from: EVM_MIXED } },
    });
    const result = await extractPaymentSigner(makeRequest(), header);
    expect(result).toEqual({ address: EVM_LOWER, network: 'evm' });
  });

  it('falls back to evm when the payload has no accepted.network but a valid EVM `from`', async () => {
    const header = encodeX402({ payload: { authorization: { from: EVM_MIXED } } });
    const result = await extractPaymentSigner(makeRequest(), header);
    expect(result).toEqual({ address: EVM_LOWER, network: 'evm' });
  });

  it('returns null for a malformed x402 header', async () => {
    expect(await extractPaymentSigner(makeRequest(), '!!!not-base64!!!')).toBeNull();
  });

  it('returns null when no x402 header and no Authorization header', async () => {
    expect(await extractPaymentSigner(makeRequest())).toBeNull();
  });
});

describe('extractPaymentSigner — Solana SVM path', () => {
  it('returns null when the SVM payload has no transaction (no payer recoverable)', async () => {
    const header = encodeX402({ accepted: { network: 'solana:abc' }, payload: {} });
    expect(await extractPaymentSigner(makeRequest(), header)).toBeNull();
  });
});

describe('readX402PaymentHeader (re-export from /payment)', () => {
  it('reads payment-signature header', () => {
    expect(readX402PaymentHeader(makeRequest({ 'payment-signature': 'abc' }))).toBe('abc');
  });
});
