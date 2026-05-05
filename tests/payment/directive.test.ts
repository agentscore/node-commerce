import { describe, expect, it } from 'vitest';
import {
  buildPaymentRequestBlob,
  paymentDirective,
  buildPaymentDirective,
} from '../../src/payment/directive';

function decodeBlob(b64: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(b64, 'base64url').toString('utf-8'));
}

describe('buildPaymentRequestBlob', () => {
  it('encodes amount as raw integer using rail decimals', () => {
    const blob = decodeBlob(buildPaymentRequestBlob({ rail: 'tempo-mainnet', amountUsd: 2 }));
    expect(blob.amount).toBe('2000000');
    expect(blob.currency).toBe('0x20C000000000000000000000b9537d11c60E8b50');
    expect(blob.methodDetails).toEqual({ chainId: 4217 });
  });

  it('respects explicit decimals override (USD has 2)', () => {
    const blob = decodeBlob(buildPaymentRequestBlob({ rail: 'stripe-spt', amountUsd: 25.0 }));
    expect(blob.amount).toBe('2500');
    expect(blob.currency).toBe('usd');
  });

  it('emits methodDetails.networkId for stripe (camelCase per link-cli decoder)', () => {
    const blob = decodeBlob(
      buildPaymentRequestBlob({ rail: 'stripe-spt', amountUsd: 10, networkId: 'acct_test_123' }),
    );
    expect(blob.methodDetails).toEqual({ networkId: 'acct_test_123' });
  });

  it('includes recipient when provided', () => {
    const blob = decodeBlob(
      buildPaymentRequestBlob({ rail: 'tempo-mainnet', amountUsd: 1, recipient: '0xabc' }),
    );
    expect(blob.recipient).toBe('0xabc');
  });

  it('omits methodDetails entirely when no chainId or networkId', () => {
    const blob = decodeBlob(
      buildPaymentRequestBlob({ amountUsd: 1, currency: 'usd', decimals: 2 }),
    );
    expect('methodDetails' in blob).toBe(false);
  });

  it('low-level fields override rail defaults', () => {
    const blob = decodeBlob(
      buildPaymentRequestBlob({
        rail: 'tempo-mainnet',
        amountUsd: 1,
        chainId: 9999,
        currency: 'custom-token',
        decimals: 4,
      }),
    );
    expect(blob.amount).toBe('10000');
    expect(blob.currency).toBe('custom-token');
    expect(blob.methodDetails).toEqual({ chainId: 9999 });
  });
});

describe('paymentDirective', () => {
  it('emits a spec-compliant Payment directive string', () => {
    const directive = paymentDirective({
      rail: 'tempo-mainnet',
      id: 'chg_001',
      realm: 'merchant.example',
      expires: '2026-04-26T00:00:00.000Z',
      request: 'eyJhbW91bnQiOiIxIn0',
    });
    expect(directive).toBe(
      'Payment id="chg_001", realm="merchant.example", method="tempo", intent="charge", expires="2026-04-26T00:00:00.000Z", request="eyJhbW91bnQiOiIxIn0"',
    );
  });

  it('defaults intent to "charge" and method from rail', () => {
    const directive = paymentDirective({
      rail: 'stripe-spt',
      id: 'x',
      realm: 'r',
      expires: '2026-01-01T00:00:00.000Z',
      request: 'q',
    });
    expect(directive).toContain('method="stripe"');
    expect(directive).toContain('intent="charge"');
  });

  it('explicit method overrides rail', () => {
    const directive = paymentDirective({
      rail: 'tempo-mainnet',
      id: 'x',
      realm: 'r',
      method: 'custom-method',
      expires: '2026-01-01T00:00:00.000Z',
      request: 'q',
    });
    expect(directive).toContain('method="custom-method"');
  });
});

describe('buildPaymentDirective (convenience)', () => {
  it('builds blob + directive in one call', () => {
    const directive = buildPaymentDirective({
      rail: 'tempo-mainnet',
      id: 'chg_001',
      realm: 'example.com',
      amountUsd: 2,
      recipient: '0xrecipient',
      expires: '2026-04-26T00:00:00.000Z',
    });
    expect(directive).toContain('method="tempo"');
    expect(directive).toContain('id="chg_001"');
    const requestMatch = directive.match(/request="([^"]+)"/);
    expect(requestMatch).toBeTruthy();
    const blob = decodeBlob(requestMatch![1]!);
    expect(blob.amount).toBe('2000000');
    expect(blob.recipient).toBe('0xrecipient');
  });
});
