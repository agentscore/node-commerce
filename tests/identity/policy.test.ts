/**
 * Per-product / per-tier compliance policy helpers.
 */

import { describe, expect, it, vi } from 'vitest';
import { CheckoutValidationError } from '../../src/errors.js';
import {
  buildGateFromPolicy,
  isSanctionsDenial,
  runGateWithEnforcement,
  shippingCountryAllowed,
  shippingStateAllowed,
  validateShippingAgainstPolicy,
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

// ── buildGateFromPolicy ─────────────────────────────────────────────────────

describe('buildGateFromPolicy', () => {
  it('returns null for null policy', () => {
    expect(buildGateFromPolicy(null, { apiKey: 'as_test' })).toBeNull();
  });

  it('returns null when policy has no enforcement', () => {
    expect(buildGateFromPolicy({}, { apiKey: 'as_test' })).toBeNull();
  });

  it('returns options when enforcement is set', () => {
    const opts = buildGateFromPolicy(
      {
        enforcement: 'hard',
        requireKyc: true,
        requireSanctionsClear: true,
        minAge: 21,
        blockedJurisdictions: ['RU', 'KP'],
        allowedJurisdictions: ['US'],
      },
      { apiKey: 'as_test' },
    );
    expect(opts).not.toBeNull();
    expect(opts!.apiKey).toBe('as_test');
    expect(opts!.requireKyc).toBe(true);
    expect(opts!.minAge).toBe(21);
    expect(opts!.blockedJurisdictions).toEqual(['RU', 'KP']);
    expect(opts!.allowedJurisdictions).toEqual(['US']);
  });

  it('forwards blockedJurisdictions independently of allowedJurisdictions (fresh array copy)', () => {
    const blocked = ['RU'];
    const opts = buildGateFromPolicy({ enforcement: 'hard', blockedJurisdictions: blocked }, { apiKey: 'as_test' });
    expect(opts!.blockedJurisdictions).toEqual(['RU']);
    expect(opts!.blockedJurisdictions).not.toBe(blocked); // spread copy, not the caller's ref
    expect(Object.prototype.hasOwnProperty.call(opts, 'allowedJurisdictions')).toBe(false);
  });

  it('passes baseUrl through when given', () => {
    const opts = buildGateFromPolicy(
      { enforcement: 'soft' },
      { apiKey: 'as_test', baseUrl: 'https://api.example.com' },
    );
    expect(opts!.baseUrl).toBe('https://api.example.com');
  });

  it('omits absent fields rather than passing undefined', () => {
    const opts = buildGateFromPolicy({ enforcement: 'soft' }, { apiKey: 'as_test' });
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

  it('hard mode propagates a structured denial reason when present', async () => {
    const result = await runGateWithEnforcement('hard', async () => ({
      ok: false,
      status: 403,
      body: { error: { code: 'kyc_required' } },
      reason: { code: 'kyc_required', verify_url: 'https://www.agentscore.com/v/x' },
    }));
    expect(result.status).toBe('denied');
    expect(result.denialReason).toMatchObject({ code: 'kyc_required', verify_url: 'https://www.agentscore.com/v/x' });
  });

  it('soft mode carries through the denial reason while staying unverified', async () => {
    const result = await runGateWithEnforcement('soft', async () => ({
      ok: false,
      status: 403,
      body: { error: { code: 'kyc_required' } },
      reason: { code: 'kyc_required' },
    }));
    expect(result.status).toBe('unverified');
    expect(result.denialReason).toMatchObject({ code: 'kyc_required' });
  });

  it('soft mode swallows a wallet_not_trusted deny carrying only fixable reasons', async () => {
    // KYC/age/jurisdiction misses downgrade to unverified under soft so the order completes
    // with a degraded identity_status. (Sanctions are the sole exception — see below.)
    const body = { error: { code: 'wallet_not_trusted' }, reasons: ['kyc_required'] };
    const result = await runGateWithEnforcement('soft', async () => ({ ok: false, status: 403, body }));
    expect(result.status).toBe('unverified');
    expect(result.denialStatus).toBe(403);
    expect(result.denialBody).toEqual(body);
  });

  it('soft mode does NOT swallow a sanctions deny (reasons: sanctions_flagged) — stays terminal', async () => {
    // CRITICAL strict-liability floor: soft enforcement must NEVER swallow an OFAC SDN deny. A
    // wallet_not_trusted deny whose reasons carry `sanctions_flagged` stays denied even under
    // soft, so a sanctioned wallet is never settled.
    const body = { error: { code: 'wallet_not_trusted' }, reasons: ['sanctions_flagged'] };
    const result = await runGateWithEnforcement('soft', async () => ({ ok: false, status: 403, body }));
    expect(result.status).toBe('denied');
    expect(result.denialStatus).toBe(403);
    expect(result.denialBody).toEqual(body);
  });

  it('soft mode does NOT swallow the fail-closed sanctions_check_unavailable variant', async () => {
    const body = { error: { code: 'wallet_not_trusted' }, reasons: ['sanctions_check_unavailable'] };
    const result = await runGateWithEnforcement('soft', async () => ({ ok: false, status: 403, body }));
    expect(result.status).toBe('denied');
    expect(result.denialBody).toEqual(body);
  });

  it('soft mode does NOT swallow a sanctions deny surfaced via decision_reasons', async () => {
    const body = { error: { code: 'wallet_not_trusted' }, decision_reasons: ['sanctions_flagged'] };
    const result = await runGateWithEnforcement('soft', async () => ({ ok: false, status: 403, body }));
    expect(result.status).toBe('denied');
  });

  it('soft mode does NOT swallow a signer-sanctions deny surfaced via top-level error.code', async () => {
    // A signer-sanctions SDN deny may surface as a top-level error.code (not in reasons); it is
    // still recognised as a sanctions deny and stays terminal under soft.
    const body = { error: { code: 'sanctions_flagged', message: 'signer on SDN list' } };
    const result = await runGateWithEnforcement('soft', async () => ({ ok: false, status: 403, body }));
    expect(result.status).toBe('denied');
  });
});

// ── isSanctionsDenial ────────────────────────────────────────────────────────

describe('isSanctionsDenial', () => {
  it('false for null / undefined body', () => {
    expect(isSanctionsDenial(null)).toBe(false);
    expect(isSanctionsDenial(undefined)).toBe(false);
  });

  it('false for a non-sanctions deny', () => {
    expect(isSanctionsDenial({ error: { code: 'wallet_not_trusted' }, reasons: ['kyc_required'] })).toBe(false);
  });

  it('true when reasons carries sanctions_flagged', () => {
    expect(isSanctionsDenial({ reasons: ['sanctions_flagged'] })).toBe(true);
  });

  it('true when reasons carries sanctions_check_unavailable', () => {
    expect(isSanctionsDenial({ reasons: ['sanctions_check_unavailable'] })).toBe(true);
  });

  it('true when decision_reasons carries a sanctions reason', () => {
    expect(isSanctionsDenial({ decision_reasons: ['sanctions_flagged'] })).toBe(true);
  });

  it('true when the top-level error.code is a sanctions reason', () => {
    expect(isSanctionsDenial({ error: { code: 'sanctions_flagged' } })).toBe(true);
  });
});

// ── validateShippingAgainstPolicy ────────────────────────────────────────────

describe('validateShippingAgainstPolicy', () => {
  it('no-ops when policy is null', () => {
    expect(() => validateShippingAgainstPolicy({ country: 'AQ', state: '', policy: null })).not.toThrow();
  });

  it('no-ops when policy has no allowlist', () => {
    expect(() =>
      validateShippingAgainstPolicy({
        country: 'JP',
        state: '',
        policy: { requireKyc: true },
      }),
    ).not.toThrow();
  });

  it('renders <unset> when the disallowed country string is empty (default message)', () => {
    try {
      validateShippingAgainstPolicy({
        country: '',
        state: '',
        policy: { allowedShippingCountries: ['US'] },
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CheckoutValidationError).message).toContain('<unset>');
    }
  });

  it('renders <unset> when the disallowed state string is empty (default message)', () => {
    try {
      validateShippingAgainstPolicy({
        country: 'US',
        state: '',
        policy: { allowedShippingCountries: ['US'], allowedShippingStates: ['CA'] },
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CheckoutValidationError).message).toContain('<unset>');
    }
  });

  it('throws CheckoutValidationError on disallowed country', () => {
    expect(() =>
      validateShippingAgainstPolicy({
        country: 'JP',
        state: '',
        policy: { allowedShippingCountries: ['US'] },
      }),
    ).toThrowError(
      expect.objectContaining({
        constructor: CheckoutValidationError,
        code: 'unsupported_jurisdiction',
        action: 'change_shipping_state',
      }) as unknown as Error,
    );
  });

  it('throws on disallowed state with the state in the message', () => {
    try {
      validateShippingAgainstPolicy({
        country: 'US',
        state: 'UT',
        policy: { allowedShippingCountries: ['US'], allowedShippingStates: ['CA', 'NY'] },
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CheckoutValidationError);
      expect((err as CheckoutValidationError).message).toContain('UT');
    }
  });

  it('includes productName in the message when provided', () => {
    try {
      validateShippingAgainstPolicy({
        country: 'JP',
        state: '',
        policy: { allowedShippingCountries: ['US'] },
        productName: 'Reserve Cabernet',
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CheckoutValidationError).message).toContain('Reserve Cabernet');
    }
  });

  it('countryMessage / stateMessage override defaults verbatim', () => {
    try {
      validateShippingAgainstPolicy({
        country: 'JP',
        state: '',
        policy: { allowedShippingCountries: ['US'] },
        countryMessage: 'Sorry, regulations.',
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CheckoutValidationError).message).toBe('Sorry, regulations.');
    }
    try {
      validateShippingAgainstPolicy({
        country: 'US',
        state: 'UT',
        policy: { allowedShippingCountries: ['US'], allowedShippingStates: ['CA'] },
        stateMessage: "Fulfillment partner doesn't cover that area.",
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CheckoutValidationError).message).toBe(
        "Fulfillment partner doesn't cover that area.",
      );
    }
  });

  it('errorCode / errorAction override defaults', () => {
    try {
      validateShippingAgainstPolicy({
        country: 'JP',
        state: '',
        policy: { allowedShippingCountries: ['US'] },
        errorCode: 'ships_us_only',
        errorAction: 'contact_support',
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CheckoutValidationError).code).toBe('ships_us_only');
      expect((err as CheckoutValidationError).action).toBe('contact_support');
    }
  });
});
