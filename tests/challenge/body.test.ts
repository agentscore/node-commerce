import { describe, expect, it } from 'vitest';
import { build402Body } from '../../src/challenge/body';

describe('build402Body', () => {
  it('produces a minimal body with payment_required + accepted_methods', () => {
    const body = build402Body({
      acceptedMethods: [{ method: 'tempo/charge', network: 'tempo', chain_id: 4217, token: '0x', symbol: 'USDC.e', decimals: 6, pay_to: '0xabc' }],
    });
    expect(body.payment_required).toBe(true);
    expect(body.accepted_methods).toHaveLength(1);
  });

  it('spreads identity metadata at the top level', () => {
    const body = build402Body({
      acceptedMethods: [],
      identityMetadata: { identity_mode: 'wallet', required_signer: '0xabc', linked_wallets: ['0xabc'] },
    });
    expect(body.identity_mode).toBe('wallet');
    expect(body.required_signer).toBe('0xabc');
    expect(body.linked_wallets).toEqual(['0xabc']);
  });

  it('includes pricing/product/order_id/recommended when present', () => {
    const body = build402Body({
      acceptedMethods: [],
      amountUsd: '250.00',
      currency: 'USD',
      pricing: { subtotal: '231.93', tax: '18.07', tax_rate: 0.0779, tax_state: 'CA', total: '250.00' },
      orderId: 'ord_123',
      product: { id: 'wine-1', name: 'Cab Sauv 2021' },
      recommended: 'tempo',
    });
    expect(body.amount_usd).toBe('250.00');
    expect(body.currency).toBe('USD');
    expect(body.pricing).toBeDefined();
    expect(body.order_id).toBe('ord_123');
    expect(body.product).toEqual({ id: 'wine-1', name: 'Cab Sauv 2021' });
    expect(body.recommended).toBe('tempo');
  });

  it('includes x402 compliance fields when configured', () => {
    const body = build402Body({
      acceptedMethods: [],
      x402: { accepts: [{ scheme: 'exact' }], version: 1 },
    });
    expect(body.x402Version).toBe(1);
    expect(body.accepts).toEqual([{ scheme: 'exact' }]);
  });

  it('merges agent_memory + agent_instructions + extra', () => {
    const body = build402Body({
      acceptedMethods: [],
      agentMemory: { pattern: 'returning_customer' },
      agentInstructions: {
        how_to_pay: {},
        recommended_tools: [],
        wallet_compatibility: 'x',
        timeout_seconds: 300,
        warnings: [],
      },
      extra: { merchant_extra_field: 'foo' },
    });
    expect(body.agent_memory).toEqual({ pattern: 'returning_customer' });
    expect(body.agent_instructions).toBeDefined();
    expect(body.merchant_extra_field).toBe('foo');
  });
});
