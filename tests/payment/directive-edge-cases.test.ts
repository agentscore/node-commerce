import { describe, expect, it } from 'vitest';
import { buildPaymentRequestBlob, paymentDirective, buildPaymentDirective } from '../../src/payment/directive';

describe('buildPaymentRequestBlob — defaults + edge cases', () => {
  it('defaults to 6 decimals + usd currency when no rail and no overrides', async () => {
    const blob = buildPaymentRequestBlob({ amountUsd: 1 });
    const decoded = JSON.parse(Buffer.from(blob, 'base64url').toString());
    expect(decoded.amount).toBe('1000000');
    expect(decoded.currency).toBe('usd');
    expect(decoded.methodDetails).toBeUndefined();
  });

  it('uses unknown rail without crashing — falls back to defaults', async () => {
    const blob = buildPaymentRequestBlob({ rail: 'not-a-real-rail', amountUsd: 1 });
    const decoded = JSON.parse(Buffer.from(blob, 'base64url').toString());
    expect(decoded.amount).toBe('1000000');
    expect(decoded.currency).toBe('usd');
  });

  it('coerces amount string to number', async () => {
    const blob = buildPaymentRequestBlob({ amountUsd: '2.5', decimals: 2 });
    const decoded = JSON.parse(Buffer.from(blob, 'base64url').toString());
    expect(decoded.amount).toBe('250');
  });

  it('omits methodDetails when neither chainId nor networkId is present', async () => {
    const blob = buildPaymentRequestBlob({ amountUsd: 1, currency: 'usd' });
    const decoded = JSON.parse(Buffer.from(blob, 'base64url').toString());
    expect(decoded.methodDetails).toBeUndefined();
  });
});

describe('paymentDirective — defaults', () => {
  it('defaults method to "unknown" when no rail is provided', async () => {
    const directive = paymentDirective({ id: 'chg', realm: 'ex.com', request: 'abc' });
    expect(directive).toContain('method="unknown"');
  });

  it('defaults expires to now + 5 minutes', async () => {
    const before = Date.now();
    const directive = paymentDirective({ id: 'chg', realm: 'ex.com', request: 'abc' });
    const after = Date.now();
    const match = directive.match(/expires="([^"]+)"/);
    expect(match).toBeTruthy();
    const expires = new Date(match![1]).getTime();
    expect(expires).toBeGreaterThanOrEqual(before + 5 * 60 * 1000 - 100);
    expect(expires).toBeLessThanOrEqual(after + 5 * 60 * 1000 + 100);
  });

  it('uses an unknown rail without crashing — defaults method to "unknown"', async () => {
    const directive = paymentDirective({ rail: 'not-a-real-rail', id: 'chg', realm: 'ex.com', request: 'abc' });
    expect(directive).toContain('method="unknown"');
  });
});

describe('buildPaymentDirective — convenience wrapper', () => {
  it('chains buildPaymentRequestBlob + paymentDirective with a rail', async () => {
    const directive = buildPaymentDirective({
      rail: 'tempo-mainnet',
      id: 'chg_1',
      realm: 'ex.com',
      amountUsd: 1.5,
      recipient: '0xabc',
    });
    expect(directive).toContain('method="tempo"');
    expect(directive).toContain('id="chg_1"');
    expect(directive).toContain('request=');
  });
});
