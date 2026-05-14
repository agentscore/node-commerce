/**
 * Tests for `usdToAtomic` — converts USD amounts to bigint atomic units.
 *
 * The fixture corpus below is locked as the cross-language contract with the
 * Python sibling at `python-commerce/tests/test_amounts.py`. Both files reference
 * identical fixed-notation inputs + decimals + expected atomic values. A drift
 * in either language (rounding mode, encoding, edge-case handling) fails that
 * language's test against the locked value.
 */

import { describe, expect, it } from 'vitest';
import { usdToAtomic } from '../../src/payment/amounts.js';

// Cross-language fixtures: [input_string, decimals, expected_atomic].
// Inputs are fixed-notation strings so the Python sibling's Decimal and the
// Node regex-based parser produce identical results.
const FIXTURES: [string, number, bigint][] = [
  // Plain whole + simple decimals
  ['0', 6, 0n],
  ['1', 6, 1_000_000n],
  ['1.0', 6, 1_000_000n],
  ['1.00', 6, 1_000_000n],
  ['0.5', 6, 500_000n],
  ['10.00', 6, 10_000_000n],
  ['270.00', 6, 270_000_000n],
  // Exact decimal precision
  ['1.234567', 6, 1_234_567n],
  // Round-half-up at the boundary (USDC tail of 5)
  ['1.2345675', 6, 1_234_568n],
  ['1.2345674', 6, 1_234_567n],
  ['1.2345679', 6, 1_234_568n],
  // Sub-precision rounding
  ['0.0000005', 6, 1n],
  ['0.0000004', 6, 0n],
  // Different decimals tail
  ['1.23', 2, 123n],
  ['1.5', 0, 2n],
  ['1.4', 0, 1n],
  ['0.5', 0, 1n],
  ['0.4999999999', 0, 0n],
  ['0.5000000001', 0, 1n],
  // Leading-zero and trailing-dot forms
  ['.5', 6, 500_000n],
  ['5.', 6, 5_000_000n],
  ['001', 6, 1_000_000n],
];

describe('usdToAtomic', () => {
  it.each(FIXTURES)('locked cross-language fixture %j @ decimals=%i', (usd, decimals, expected) => {
    expect(usdToAtomic(usd, { decimals })).toBe(expected);
  });

  it('accepts number input', () => {
    expect(usdToAtomic(1.23, { decimals: 6 })).toBe(1_230_000n);
  });

  it('accepts integer number input', () => {
    expect(usdToAtomic(5, { decimals: 6 })).toBe(5_000_000n);
  });

  it('zero input returns 0n', () => {
    expect(usdToAtomic('0', { decimals: 6 })).toBe(0n);
    expect(usdToAtomic(0, { decimals: 6 })).toBe(0n);
  });

  it('decimals=0 returns rounded whole dollars', () => {
    expect(usdToAtomic('123.4', { decimals: 0 })).toBe(123n);
    expect(usdToAtomic('123.5', { decimals: 0 })).toBe(124n);
  });

  it('rejects negative string', () => {
    expect(() => usdToAtomic('-1.00', { decimals: 6 })).toThrow(/non-negative/);
  });

  it('rejects negative number', () => {
    expect(() => usdToAtomic(-1.0, { decimals: 6 })).toThrow(/non-negative/);
  });

  it('rejects NaN', () => {
    expect(() => usdToAtomic(Number.NaN, { decimals: 6 })).toThrow(/finite/);
  });

  it('rejects +Infinity', () => {
    expect(() => usdToAtomic(Number.POSITIVE_INFINITY, { decimals: 6 })).toThrow(/finite/);
  });

  it('rejects -Infinity', () => {
    expect(() => usdToAtomic(Number.NEGATIVE_INFINITY, { decimals: 6 })).toThrow();
  });

  it('rejects empty string', () => {
    expect(() => usdToAtomic('', { decimals: 6 })).toThrow(/invalid usd value/);
  });

  it('rejects garbage string', () => {
    expect(() => usdToAtomic('abc', { decimals: 6 })).toThrow(/invalid usd value/);
    expect(() => usdToAtomic('1.2.3', { decimals: 6 })).toThrow(/invalid usd value/);
  });

  it('rejects negative decimals', () => {
    expect(() => usdToAtomic('1.00', { decimals: -1 })).toThrow(/non-negative integer/);
  });

  it('rejects non-integer decimals', () => {
    expect(() => usdToAtomic('1.00', { decimals: 6.5 })).toThrow(/non-negative integer/);
  });
});
