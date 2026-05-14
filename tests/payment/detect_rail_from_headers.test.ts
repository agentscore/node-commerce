/**
 * Tests for `detectRailFromHeaders` — reports which payment-protocol family
 * the inbound request carries.
 *
 * The fixture corpus below is locked as the cross-language contract with the
 * Python sibling at `python-commerce/tests/test_dispatch.py`. Both files
 * reference identical header maps + expected results. A drift in either
 * language (case-handling, empty-value treatment, scheme-prefix matching)
 * fails that language's test against the locked value.
 */

import { describe, expect, it } from 'vitest';
import { detectRailFromHeaders } from '../../src/payment/dispatch.js';

type Expected = 'x402' | 'mpp' | null;

// Cross-language fixtures: [label, headers_dict, expected_rail].
const FIXTURES: [string, Record<string, string>, Expected][] = [
  ['empty', {}, null],
  ['payment_signature_only', { 'payment-signature': 'abc' }, 'x402'],
  ['x_payment_only', { 'x-payment': 'abc' }, 'x402'],
  ['authorization_payment', { authorization: 'Payment abc' }, 'mpp'],
  ['authorization_bearer', { authorization: 'Bearer xyz' }, null],
  ['authorization_lowercase_scheme', { authorization: 'payment abc' }, 'mpp'],
  ['authorization_uppercase_name', { Authorization: 'Payment abc' }, 'mpp'],
  ['x_payment_uppercase_name', { 'X-Payment': 'abc' }, 'x402'],
  ['empty_values_dont_count', { 'payment-signature': '', 'x-payment': '' }, null],
  [
    'mpp_wins_when_both_present',
    { 'x-payment': 'abc', authorization: 'Payment xyz' },
    'mpp',
  ],
  ['payment_without_space_is_not_mpp', { authorization: 'PaymentNoSpace' }, null],
  ['payment_with_only_space_is_mpp', { authorization: 'Payment ' }, 'mpp'],
  ['mixed_case_authorization_name', { AUTHORIZATION: 'Payment abc' }, 'mpp'],
  ['authorization_uppercase_scheme', { authorization: 'PAYMENT abc' }, 'mpp'],
];

describe('detectRailFromHeaders', () => {
  it.each(FIXTURES)('locked cross-language fixture: %s', (_label, headers, expected) => {
    expect(detectRailFromHeaders(headers)).toBe(expected);
  });

  it('accepts a Headers instance (native case-insensitive lookup)', () => {
    const h = new Headers({ 'X-Payment': 'abc' });
    expect(detectRailFromHeaders(h)).toBe('x402');
  });

  it('accepts a Headers instance for the mpp case', () => {
    const h = new Headers({ Authorization: 'Payment xyz' });
    expect(detectRailFromHeaders(h)).toBe('mpp');
  });

  it('returns x402 for non-empty truthy value like "0"', () => {
    expect(detectRailFromHeaders({ 'x-payment': '0' })).toBe('x402');
  });

  it('does not mutate the input headers object', () => {
    const headers = { 'X-Payment': 'abc', Authorization: 'Payment xyz' };
    const snapshot = JSON.stringify(headers);
    detectRailFromHeaders(headers);
    expect(JSON.stringify(headers)).toBe(snapshot);
  });

  it('handles array header values (Node http style) by reading the first', () => {
    const headers: Record<string, string | string[]> = {
      'x-payment': ['abc', 'def'],
    };
    expect(detectRailFromHeaders(headers)).toBe('x402');
  });

  it('treats undefined values as absent', () => {
    const headers: Record<string, string | undefined> = {
      'x-payment': undefined,
      authorization: 'Bearer xyz',
    };
    expect(detectRailFromHeaders(headers)).toBe(null);
  });

  it('treats null values as absent (plain-JS callers may bypass TS types)', () => {
    // Cast through unknown to bypass the TS input type that excludes null.
    const headers = { 'x-payment': null, authorization: 'Bearer xyz' } as unknown as Record<
      string,
      string | undefined
    >;
    expect(detectRailFromHeaders(headers)).toBe(null);
  });
});
