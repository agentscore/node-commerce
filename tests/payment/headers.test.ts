import { describe, expect, it } from 'vitest';
import { buildPaymentHeaders } from '../../src/payment/headers';

describe('buildPaymentHeaders', () => {
  it('emits a single www-authenticate with one directive when one rail given', () => {
    const result = buildPaymentHeaders({
      orderId: 'ord_1',
      realm: 'agents.example',
      rails: [{ rail: 'tempo-mainnet', amountUsd: 10, recipient: '0xrecipient' }],
    });
    expect(result['www-authenticate']).toContain('Payment ');
    expect(result['www-authenticate']).toContain('id="ord_1-tempo-mainnet"');
    expect(result['www-authenticate']).toContain('realm="agents.example"');
    expect(result['PAYMENT-REQUIRED']).toBeUndefined();
  });

  it('joins multiple directives with comma per RFC 7235 multi-challenge format', () => {
    const result = buildPaymentHeaders({
      orderId: 'ord_2',
      realm: 'agents.example',
      rails: [
        { rail: 'tempo-mainnet', amountUsd: 10, recipient: '0xtempo' },
        { rail: 'x402-base-mainnet', amountUsd: 10, recipient: '0xbase' },
      ],
    });
    // Two directives = at least one comma-separator between them.
    const directives = result['www-authenticate'].split(', ').filter((s) => s.startsWith('Payment '));
    expect(directives.length).toBe(2);
  });

  it('uses unique challenge ids per rail (orderId-rail) for retry correlation', () => {
    const result = buildPaymentHeaders({
      orderId: 'ord_3',
      realm: 'a.example',
      rails: [
        { rail: 'tempo-mainnet', amountUsd: 1, recipient: '0xa' },
        { rail: 'x402-solana-mainnet', amountUsd: 1, recipient: '0xb' },
      ],
    });
    expect(result['www-authenticate']).toContain('id="ord_3-tempo-mainnet"');
    expect(result['www-authenticate']).toContain('id="ord_3-x402-solana-mainnet"');
  });

  it('emits PAYMENT-REQUIRED header when x402.accepts is provided', () => {
    const result = buildPaymentHeaders({
      orderId: 'ord_4',
      realm: 'a.example',
      rails: [{ rail: 'x402-base-mainnet', amountUsd: 1, recipient: '0xa' }],
      x402: { accepts: [{ scheme: 'exact', network: 'eip155:8453' }], version: 1 },
    });
    expect(result['PAYMENT-REQUIRED']).toBeDefined();
    // base64-encoded JSON
    const decoded = JSON.parse(Buffer.from(result['PAYMENT-REQUIRED']!, 'base64').toString());
    expect(decoded.x402Version).toBe(1);
    expect(decoded.accepts).toEqual([{ scheme: 'exact', network: 'eip155:8453' }]);
  });

  it('defaults x402 version to 1 when not specified', () => {
    const result = buildPaymentHeaders({
      orderId: 'ord_5',
      realm: 'a.example',
      rails: [{ rail: 'x402-base-mainnet', amountUsd: 1, recipient: '0xa' }],
      x402: { accepts: [] },
    });
    const decoded = JSON.parse(Buffer.from(result['PAYMENT-REQUIRED']!, 'base64').toString());
    expect(decoded.x402Version).toBe(1);
  });

  it('passes through stripe networkId (instead of recipient) for stripe rail', () => {
    const result = buildPaymentHeaders({
      orderId: 'ord_6',
      realm: 'a.example',
      rails: [{ rail: 'stripe', amountUsd: 1, networkId: 'stripe_profile_x' }],
    });
    // The base64 request blob inside the directive will carry methodDetails.networkId
    const directive = result['www-authenticate'];
    const requestMatch = /request="([^"]+)"/.exec(directive);
    expect(requestMatch).toBeTruthy();
    const requestBlob = JSON.parse(
      Buffer.from(requestMatch![1]!, 'base64url').toString(),
    );
    expect(requestBlob.methodDetails?.networkId).toBe('stripe_profile_x');
  });

  it('forwards optional intent / expires to underlying directives', () => {
    const expires = '2099-12-31T23:59:59.000Z';
    const result = buildPaymentHeaders({
      orderId: 'ord_7',
      realm: 'a.example',
      rails: [{ rail: 'tempo-mainnet', amountUsd: 1, recipient: '0xa', intent: 'session', expires }],
    });
    expect(result['www-authenticate']).toContain('intent="session"');
    expect(result['www-authenticate']).toContain(`expires="${expires}"`);
  });
});
