import { describe, expect, it } from 'vitest';
import {
  hasMppxHeader,
  hasPaymentHeader,
  hasX402Header,
  readHeader,
} from '../src/payment/payment_header';

describe('payment_header case-insensitive Record lookup', () => {
  it('readHeader matches title-case keys on plain Records', () => {
    expect(readHeader({ 'Payment-Signature': 'abc' }, 'payment-signature')).toBe('abc');
    expect(readHeader({ 'X-Payment': 'xyz' }, 'x-payment')).toBe('xyz');
    expect(readHeader({ 'Authorization': 'Payment foo' }, 'authorization')).toBe('Payment foo');
  });

  it('readHeader returns the first element of a string[] header value (Node multi-value shape)', () => {
    // Node/Fastify expose repeated headers as string arrays; readHeader takes the
    // first string element.
    expect(readHeader({ 'x-payment': ['first', 'second'] }, 'x-payment')).toBe('first');
  });

  it('readHeader returns null for an array whose first element is not a string', () => {
    expect(readHeader({ 'x-payment': [] }, 'x-payment')).toBeNull();
    expect(readHeader({ 'x-payment': [undefined as unknown as string] }, 'x-payment')).toBeNull();
  });

  it('hasPaymentHeader / hasX402Header / hasMppxHeader match title-case keys', () => {
    expect(hasPaymentHeader({ 'Payment-Signature': 'abc' })).toBe(true);
    expect(hasX402Header({ 'Payment-Signature': 'abc' })).toBe(true);
    expect(hasX402Header({ 'X-Payment': 'xyz' })).toBe(true);
    expect(hasMppxHeader({ 'Authorization': 'Payment foo' })).toBe(true);
  });
});
