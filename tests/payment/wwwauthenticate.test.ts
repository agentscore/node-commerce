import { describe, expect, it } from 'vitest';
import { aliasAmountFields, paymentRequiredHeader, wwwAuthenticateHeader } from '../../src/payment/wwwauthenticate';

describe('wwwAuthenticateHeader', () => {
  it('joins multiple directives with comma-space separator', () => {
    const a = 'Payment id="a", realm="r", method="tempo", intent="charge", expires="x", request="b"';
    const b = 'Payment id="c", realm="r", method="stripe", intent="charge", expires="x", request="d"';
    expect(wwwAuthenticateHeader([a, b])).toBe(`${a}, ${b}`);
  });

  it('returns empty string for empty array', () => {
    expect(wwwAuthenticateHeader([])).toBe('');
  });
});

describe('paymentRequiredHeader', () => {
  it('encodes the PaymentRequired object as base64 JSON', () => {
    const header = paymentRequiredHeader({
      x402Version: 2,
      accepts: [{ scheme: 'exact', network: 'eip155:8453' }],
      resource: { url: 'https://merchant.example/api', mimeType: 'application/json' },
    });
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf-8'));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts).toHaveLength(1);
    expect(decoded.resource.url).toBe('https://merchant.example/api');
  });

  it('emits both amount (v2) and maxAmountRequired (v1) so v1-only clients can read', () => {
    const header = paymentRequiredHeader({
      x402Version: 2,
      accepts: [{ scheme: 'exact', network: 'eip155:84532', amount: '110000' }],
    });
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf-8'));
    expect(decoded.accepts[0].amount).toBe('110000');
    expect(decoded.accepts[0].maxAmountRequired).toBe('110000');
  });
});

describe('aliasAmountFields', () => {
  it('adds maxAmountRequired when only amount is set (v2 → dual-version)', () => {
    const out = aliasAmountFields([{ scheme: 'exact', amount: '110000' }]);
    expect(out[0]).toEqual({ scheme: 'exact', amount: '110000', maxAmountRequired: '110000' });
  });

  it('adds amount when only maxAmountRequired is set (v1 → dual-version)', () => {
    const out = aliasAmountFields([{ scheme: 'exact', maxAmountRequired: '110000' }]);
    expect(out[0]).toEqual({ scheme: 'exact', maxAmountRequired: '110000', amount: '110000' });
  });

  it('idempotent: leaves entry alone when both fields already set', () => {
    const entry = { scheme: 'exact', amount: '110000', maxAmountRequired: '110000' };
    const out = aliasAmountFields([entry]);
    expect(out[0]).toEqual(entry);
  });

  it('passes through entries without amount fields unchanged', () => {
    const out = aliasAmountFields([{ scheme: 'exact', network: 'eip155:8453' }]);
    expect(out[0]).toEqual({ scheme: 'exact', network: 'eip155:8453' });
  });
});
