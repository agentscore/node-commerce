import { describe, expect, it } from 'vitest';
import { buildWellKnownMpp } from '../../src/discovery/well_known_mpp';

describe('buildWellKnownMpp', () => {
  it('builds a minimal manifest with name, url, endpoints, and payment_methods', () => {
    const manifest = buildWellKnownMpp({
      name: 'My Merchant',
      url: 'https://merchant.example',
      endpoints: { purchase: { method: 'POST', url: 'https://merchant.example/buy' } },
      purchase: { methods: ['tempo'] },
    });
    expect(manifest.name).toBe('My Merchant');
    expect(manifest.url).toBe('https://merchant.example');
    expect((manifest.purchase as { payment_methods: string[] }).payment_methods).toEqual(['tempo']);
  });

  it('includes optional fields conditionally', () => {
    const minimal = buildWellKnownMpp({
      name: 'X',
      url: 'https://x',
      endpoints: {},
      purchase: { methods: [] },
    });
    expect(minimal).not.toHaveProperty('description');
    expect(minimal).not.toHaveProperty('shipping');
    expect(minimal).not.toHaveProperty('catalog');
  });

  it('passes through identity_paths, x402, and compliance', () => {
    const manifest = buildWellKnownMpp({
      name: 'X',
      url: 'https://x',
      endpoints: {},
      purchase: {
        methods: ['tempo', 'x402', 'stripe'],
        x402: { networks: ['base', 'solana'], scheme: 'exact', asset: 'USDC' },
        identity_paths: {
          wallet: { header: 'X-Wallet-Address', applies_to_rails: ['tempo', 'x402'] },
          operator_token: { header: 'X-Operator-Token', applies_to_rails: ['tempo', 'x402', 'stripe'] },
        },
        compliance: { require_kyc: true, min_age: 21, allowed_jurisdictions: ['US'] },
      },
    });
    const purchase = manifest.purchase as Record<string, unknown>;
    expect(purchase.x402).toEqual({ networks: ['base', 'solana'], scheme: 'exact', asset: 'USDC' });
    expect(purchase.identity_paths).toBeDefined();
    expect(purchase.compliance).toEqual({ require_kyc: true, min_age: 21, allowed_jurisdictions: ['US'] });
  });

  it('merges extra fields at the top level', () => {
    const manifest = buildWellKnownMpp({
      name: 'X',
      url: 'https://x',
      endpoints: {},
      purchase: { methods: [] },
      extra: { custom_field: 'foo' },
    });
    expect(manifest.custom_field).toBe('foo');
  });

  it('populates every optional field when fully specified', () => {
    const manifest = buildWellKnownMpp({
      name: 'Full',
      description: 'A complete merchant manifest',
      url: 'https://full.example',
      openapi: 'https://full.example/openapi.json',
      endpoints: { purchase: { method: 'POST', url: 'https://full.example/buy' } },
      catalog: 'https://full.example/catalog.json',
      purchase: {
        required_fields: ['email', 'shipping_address'],
        optional_fields: ['gift_note'],
        extra: { custom_purchase_meta: 'bar' },
        identity: { type: 'wallet', required: true },
        methods: ['tempo'],
      },
      shipping: { countries: ['US'], states: { US: ['CA', 'NY'] } },
    });
    expect(manifest.description).toBe('A complete merchant manifest');
    expect(manifest.openapi).toBe('https://full.example/openapi.json');
    expect(manifest.catalog).toBe('https://full.example/catalog.json');
    expect(manifest.shipping).toEqual({ countries: ['US'], states: { US: ['CA', 'NY'] } });
    const purchase = manifest.purchase as Record<string, unknown>;
    expect(purchase.required_fields).toEqual(['email', 'shipping_address']);
    expect(purchase.optional_fields).toEqual(['gift_note']);
    expect(purchase.custom_purchase_meta).toBe('bar');
    expect(purchase.identity).toEqual({ type: 'wallet', required: true });
  });
});
