import { describe, expect, it } from 'vitest';
import { buildPricingBlock } from '../../src/challenge/pricing';

describe('buildPricingBlock', () => {
  it('formats cents to dollar strings', () => {
    const result = buildPricingBlock({ subtotalCents: 25000 });
    expect(result.subtotal).toBe('250.00');
    expect(result.tax).toBe('0.00');
    expect(result.total).toBe('250.00');
  });

  it('computes total from subtotal + tax + shipping when totalCents not given', () => {
    const result = buildPricingBlock({
      subtotalCents: 25000,
      taxCents: 1875,
      shippingCents: 999,
    });
    expect(result.total).toBe('278.74');
  });

  it('respects explicit totalCents override', () => {
    const result = buildPricingBlock({
      subtotalCents: 25000,
      taxCents: 1875,
      totalCents: 50000,
    });
    expect(result.total).toBe('500.00');
  });

  it('omits shipping when shippingCents not provided', () => {
    const result = buildPricingBlock({ subtotalCents: 1000 });
    expect(result.shipping).toBeUndefined();
  });

  it('includes shipping="0.00" when shippingCents=0 (free shipping advertised explicitly)', () => {
    const result = buildPricingBlock({ subtotalCents: 1000, shippingCents: 0 });
    expect(result.shipping).toBe('0.00');
  });

  it('passes through tax_rate, tax_state, and currency when provided', () => {
    const result = buildPricingBlock({
      subtotalCents: 1000,
      taxRate: 0.0775,
      taxState: 'CA',
      currency: 'USD',
    });
    expect(result.tax_rate).toBe(0.0775);
    expect(result.tax_state).toBe('CA');
    expect(result.currency).toBe('USD');
  });

  it('omits tax_rate / tax_state / currency when not provided (don\'t leak undefined fields)', () => {
    const result = buildPricingBlock({ subtotalCents: 1000 });
    expect(result.tax_rate).toBeUndefined();
    expect(result.tax_state).toBeUndefined();
    expect(result.currency).toBeUndefined();
  });

  it('handles fractional cents-to-dollar correctly (no floating point drift)', () => {
    const result = buildPricingBlock({ subtotalCents: 1, taxCents: 1, shippingCents: 1 });
    expect(result.subtotal).toBe('0.01');
    expect(result.tax).toBe('0.01');
    expect(result.shipping).toBe('0.01');
    expect(result.total).toBe('0.03');
  });
});
