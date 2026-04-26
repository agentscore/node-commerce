import { describe, expect, it } from 'vitest';
import { wwwAuthenticateHeader, paymentRequiredHeader } from '../../src/payment/wwwauthenticate';

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
});
