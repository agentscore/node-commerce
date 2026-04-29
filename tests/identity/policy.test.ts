/**
 * Per-product / per-tier compliance policy helpers.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  policyToGateOptions,
  runGateWithEnforcement,
  shippingCountryAllowed,
  shippingStateAllowed,
} from '../../src/identity/policy.js';

// ── shipping helpers ────────────────────────────────────────────────────────

describe('shippingCountryAllowed', () => {
  it('null policy → ship anywhere', () => {
    expect(shippingCountryAllowed('JP', null)).toBe(true);
  });

  it('null allowlist → ship anywhere', () => {
    expect(shippingCountryAllowed('JP', { enforcement: 'hard' })).toBe(true);
  });

  it('empty allowlist → ship anywhere', () => {
    expect(shippingCountryAllowed('JP', { allowedShippingCountries: [] })).toBe(true);
  });

  it('country in allowlist', () => {
    expect(shippingCountryAllowed('US', { allowedShippingCountries: ['US'] })).toBe(true);
  });

  it('country not in allowlist', () => {
    expect(shippingCountryAllowed('GB', { allowedShippingCountries: ['US'] })).toBe(false);
  });

  it('case-insensitive', () => {
    expect(shippingCountryAllowed('us', { allowedShippingCountries: ['US'] })).toBe(true);
  });
});

describe('shippingStateAllowed', () => {
  it('null policy → ship anywhere', () => {
    expect(shippingStateAllowed('UT', 'US', null)).toBe(true);
  });

  it('only enforced for US shipments', () => {
    expect(shippingStateAllowed('LN', 'GB', { allowedShippingStates: ['CA'] })).toBe(true);
  });

  it('US state in allowlist', () => {
    expect(shippingStateAllowed('CA', 'US', { allowedShippingStates: ['CA', 'NY'] })).toBe(true);
  });

  it('US state not in allowlist', () => {
    expect(shippingStateAllowed('UT', 'US', { allowedShippingStates: ['CA', 'NY'] })).toBe(false);
  });

  it('case-insensitive', () => {
    expect(shippingStateAllowed('ca', 'US', { allowedShippingStates: ['CA'] })).toBe(true);
  });
});

// ── policyToGateOptions ─────────────────────────────────────────────────────

describe('policyToGateOptions', () => {
  it('returns null for null policy', () => {
    expect(policyToGateOptions(null, { apiKey: 'as_test' })).toBeNull();
  });

  it('returns null when policy has no enforcement', () => {
    expect(policyToGateOptions({}, { apiKey: 'as_test' })).toBeNull();
  });

  it('returns options when enforcement is set', () => {
    const opts = policyToGateOptions(
      {
        enforcement: 'hard',
        requireKyc: true,
        requireSanctionsClear: true,
        minAge: 21,
        allowedJurisdictions: ['US'],
      },
      { apiKey: 'as_test' },
    );
    expect(opts).not.toBeNull();
    expect(opts!.apiKey).toBe('as_test');
    expect(opts!.requireKyc).toBe(true);
    expect(opts!.minAge).toBe(21);
    expect(opts!.allowedJurisdictions).toEqual(['US']);
  });

  it('passes baseUrl through when given', () => {
    const opts = policyToGateOptions(
      { enforcement: 'soft' },
      { apiKey: 'as_test', baseUrl: 'https://api.example.com' },
    );
    expect(opts!.baseUrl).toBe('https://api.example.com');
  });

  it('omits absent fields rather than passing undefined', () => {
    const opts = policyToGateOptions({ enforcement: 'soft' }, { apiKey: 'as_test' });
    expect(opts).not.toBeNull();
    expect(Object.prototype.hasOwnProperty.call(opts, 'requireKyc')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(opts, 'minAge')).toBe(false);
  });
});

// ── runGateWithEnforcement ──────────────────────────────────────────────────

describe('runGateWithEnforcement', () => {
  it('anonymous when runGate is null', async () => {
    const result = await runGateWithEnforcement('hard', null);
    expect(result).toEqual({ status: 'anonymous' });
  });

  it('anonymous when enforcement is undefined', async () => {
    const runGate = vi.fn();
    const result = await runGateWithEnforcement(undefined, runGate);
    expect(result).toEqual({ status: 'anonymous' });
    expect(runGate).not.toHaveBeenCalled();
  });

  it('verified on accept', async () => {
    const result = await runGateWithEnforcement('hard', async () => ({ ok: true }));
    expect(result.status).toBe('verified');
  });

  it('hard mode propagates denial', async () => {
    const result = await runGateWithEnforcement('hard', async () => ({
      ok: false,
      status: 403,
      body: { error: { code: 'missing_identity' } },
    }));
    expect(result.status).toBe('denied');
    expect(result.denialStatus).toBe(403);
    expect(result.denialBody).toEqual({ error: { code: 'missing_identity' } });
  });

  it('soft mode swallows denial', async () => {
    const result = await runGateWithEnforcement('soft', async () => ({
      ok: false,
      status: 403,
      body: { error: { code: 'missing_identity' } },
    }));
    expect(result.status).toBe('unverified');
    expect(result.denialStatus).toBe(403);
  });
});
