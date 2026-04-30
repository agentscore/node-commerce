import { describe, expect, it } from 'vitest';
import {
  FIXABLE_DENIAL_REASONS,
  buildContactSupportNextSteps,
  buildSignerMismatchBody,
  denialReasonStatus,
  isFixableDenial,
  verificationAgentInstructions,
} from '../src/_denial';
import type { DenialReason, VerifyWalletSignerResult } from '../src/core';

describe('denialReasonStatus', () => {
  it('returns 401 for token_expired', () => {
    expect(denialReasonStatus({ code: 'token_expired' } as DenialReason)).toBe(401);
  });
  it('returns 401 for invalid_credential', () => {
    expect(denialReasonStatus({ code: 'invalid_credential' } as DenialReason)).toBe(401);
  });
  it('returns 503 for api_error', () => {
    expect(denialReasonStatus({ code: 'api_error' } as DenialReason)).toBe(503);
  });
  it('returns 403 for everything else', () => {
    for (const code of ['missing_identity', 'identity_verification_required', 'wallet_not_trusted', 'wallet_signer_mismatch', 'wallet_auth_requires_wallet_signing', 'payment_required']) {
      expect(denialReasonStatus({ code } as DenialReason)).toBe(403);
    }
  });
});

describe('FIXABLE_DENIAL_REASONS / isFixableDenial', () => {
  it('classifies known fixable reasons', () => {
    for (const r of ['kyc_required', 'kyc_pending', 'kyc_failed']) {
      expect(FIXABLE_DENIAL_REASONS.has(r)).toBe(true);
    }
  });

  it('jurisdiction_restricted is UNFIXABLE', () => {
    // The API only emits jurisdiction_restricted AFTER KYC is verified — meaning the
    // user's KYC'd country is in the merchant's blocked list. Re-doing KYC won't change
    // the country, same shape as sanctions_flagged / age_insufficient.
    expect(FIXABLE_DENIAL_REASONS.has('jurisdiction_restricted')).toBe(false);
  });

  it('returns false for empty/undefined reasons (default to bare denial)', () => {
    expect(isFixableDenial(undefined)).toBe(false);
    expect(isFixableDenial([])).toBe(false);
  });

  it('returns true when every reason is fixable', () => {
    expect(isFixableDenial(['kyc_required', 'kyc_pending'])).toBe(true);
  });

  it('returns false when ANY reason is permanent (sanctions, age, jurisdiction_restricted)', () => {
    expect(isFixableDenial(['sanctions_flagged'])).toBe(false);
    expect(isFixableDenial(['age_insufficient'])).toBe(false);
    expect(isFixableDenial(['jurisdiction_restricted'])).toBe(false);
    expect(isFixableDenial(['kyc_required', 'sanctions_flagged'])).toBe(false);
    expect(isFixableDenial(['kyc_required', 'jurisdiction_restricted'])).toBe(false);
  });
});

describe('buildSignerMismatchBody', () => {
  it('returns null for pass / api_error results', () => {
    expect(buildSignerMismatchBody({ result: { kind: 'pass' } as VerifyWalletSignerResult })).toBeNull();
    expect(buildSignerMismatchBody({ result: { kind: 'api_error' } as VerifyWalletSignerResult })).toBeNull();
  });

  it('builds the standard 403 body for wallet_signer_mismatch with linked wallets', () => {
    const result: VerifyWalletSignerResult = {
      kind: 'wallet_signer_mismatch',
      claimedOperator: 'op_victim',
      actualSignerOperator: 'op_attacker',
      expectedSigner: '0xVictim',
      actualSigner: '0xAttacker',
      linkedWallets: ['0xLinked1', '0xLinked2'],
    };
    const body = buildSignerMismatchBody({ result });
    expect(body).toMatchObject({
      error: { code: 'wallet_signer_mismatch' },
      claimed_operator: 'op_victim',
      actual_signer_operator: 'op_attacker',
      expected_signer: '0xVictim',
      actual_signer: '0xAttacker',
      linked_wallets: ['0xLinked1', '0xLinked2'],
    });
    expect((body!.next_steps as { user_message: string }).user_message).toContain('0xLinked1');
  });

  it('produces a fallback user_message when no linked wallets are present', () => {
    const result: VerifyWalletSignerResult = {
      kind: 'wallet_signer_mismatch',
      claimedOperator: 'op_v',
      actualSignerOperator: null,
      expectedSigner: '0xClaim',
      actualSigner: '0xSigner',
      linkedWallets: [],
    };
    const body = buildSignerMismatchBody({ result });
    expect((body!.next_steps as { user_message: string }).user_message).toContain('X-Operator-Token');
  });

  it('builds the standard body for wallet_auth_requires_wallet_signing', () => {
    const body = buildSignerMismatchBody({
      result: { kind: 'wallet_auth_requires_wallet_signing' } as VerifyWalletSignerResult,
    });
    expect(body).toMatchObject({
      error: { code: 'wallet_auth_requires_wallet_signing' },
      next_steps: { action: 'switch_to_operator_token' },
    });
  });

  it('respects custom userMessage and learnMoreUrl overrides', () => {
    const body = buildSignerMismatchBody({
      result: { kind: 'wallet_auth_requires_wallet_signing' } as VerifyWalletSignerResult,
      userMessage: 'Custom message',
      learnMoreUrl: 'https://my.docs',
    });
    expect((body!.next_steps as { user_message: string; learn_more_url: string }).user_message).toBe('Custom message');
    expect((body!.next_steps as { learn_more_url: string }).learn_more_url).toBe('https://my.docs');
  });
});

describe('buildContactSupportNextSteps', () => {
  it('builds a contact_support next_steps with default message', () => {
    expect(buildContactSupportNextSteps('hello@merchant.com')).toEqual({
      action: 'contact_support',
      support_email: 'hello@merchant.com',
      user_message: expect.stringContaining('hello@merchant.com'),
    });
  });

  it('respects a custom message', () => {
    const ns = buildContactSupportNextSteps('hello@merchant.com', 'Try our support portal first.');
    expect(ns.user_message).toBe('Try our support portal first.');
  });
});

describe('verificationAgentInstructions', () => {
  it('returns the canonical instructions block with sane defaults', () => {
    const inst = verificationAgentInstructions();
    expect(inst.action).toBe('poll_for_credential');
    expect(inst.poll_interval_seconds).toBe(5);
    expect(inst.poll_secret_header).toBe('X-Poll-Secret');
    expect(inst.retry_token_header).toBe('X-Operator-Token');
    expect(inst.timeout_seconds).toBe(3600);
    expect(inst.steps.length).toBeGreaterThan(3);
    expect(inst.steps[0]).toContain('verify_url');
  });

  it('honors poll cadence + timeout overrides', () => {
    const inst = verificationAgentInstructions({ pollIntervalSeconds: 10, timeoutSeconds: 1800 });
    expect(inst.poll_interval_seconds).toBe(10);
    expect(inst.timeout_seconds).toBe(1800);
    expect(inst.steps[1]).toContain('every 10 seconds');
  });

  it('appends extra steps + arbitrary fields + order_ttl', () => {
    const inst = verificationAgentInstructions({
      extraSteps: ['Resume by including order_id in the retry body.'],
      orderTtl: 'Pending orders expire after 1 hour.',
      extra: { vendor_field: 'value' },
    });
    expect(inst.steps[inst.steps.length - 1]).toBe('Resume by including order_id in the retry body.');
    expect(inst.order_ttl).toContain('1 hour');
    expect(inst.vendor_field).toBe('value');
  });

  it('retryStep replaces the canonical retry step (no duplicate retry instruction)', () => {
    const customRetry = 'Retry POST /purchase with X-Operator-Token AND include order_id from this response.';
    const inst = verificationAgentInstructions({ retryStep: customRetry });
    // Step at index 4 (5th step) is the retry step.
    expect(inst.steps[4]).toBe(customRetry);
    // The default phrase must NOT appear anywhere in steps.
    expect(inst.steps.some((s) => s === 'Retry the original merchant request with header X-Operator-Token set to the operator_token value.')).toBe(false);
  });

  it('retryStep + extraSteps compose: retry replaces step 5, extras append after', () => {
    const inst = verificationAgentInstructions({
      retryStep: 'Custom retry instruction.',
      extraSteps: ['Then do X.', 'Then do Y.'],
    });
    expect(inst.steps).toHaveLength(7);
    expect(inst.steps[4]).toBe('Custom retry instruction.');
    expect(inst.steps[5]).toBe('Then do X.');
    expect(inst.steps[6]).toBe('Then do Y.');
  });
});
