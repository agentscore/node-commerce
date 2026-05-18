import { describe, expect, it } from 'vitest';
import { hasPaymentHeader } from '../../src/payment/payment_header';

describe('hasPaymentHeader', () => {
  it('detects Payment-Signature header', () => {
    expect(hasPaymentHeader({ 'payment-signature': 'deadbeef' } as Record<string, string>)).toBe(true);
  });

  it('detects X-Payment header', () => {
    expect(hasPaymentHeader({ 'x-payment': '<base64>' } as Record<string, string>)).toBe(true);
  });

  it('detects Authorization: Payment scheme', () => {
    expect(hasPaymentHeader({ authorization: 'Payment <jwt>' } as Record<string, string>)).toBe(true);
  });

  it('rejects Authorization: Bearer', () => {
    expect(hasPaymentHeader({ authorization: 'Bearer abc' } as Record<string, string>)).toBe(false);
  });

  it('returns false when no payment credential present', () => {
    expect(hasPaymentHeader({} as Record<string, string>)).toBe(false);
    expect(hasPaymentHeader({ 'user-agent': 'test' } as Record<string, string>)).toBe(false);
  });

  it('accepts Web Fetch Request', () => {
    const reqWith = new Request('https://x', { headers: { 'x-payment': 'abc' } });
    const reqWithout = new Request('https://x');
    expect(hasPaymentHeader(reqWith)).toBe(true);
    expect(hasPaymentHeader(reqWithout)).toBe(false);
  });

  it('accepts Web Fetch Headers directly', () => {
    expect(hasPaymentHeader(new Headers({ 'x-payment': 'abc' }))).toBe(true);
    expect(hasPaymentHeader(new Headers())).toBe(false);
  });
});
