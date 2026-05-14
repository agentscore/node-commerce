/**
 * Tests for `classifyOrchestrationError` — string-match classification of
 * arbitrary thrown errors during the 402 orchestration.
 *
 * Locked cross-language fixtures shared with the Python sibling at
 * `python-commerce/tests/test_classify_orchestration_error.py`. Both files
 * reference identical error messages + expected ClassifiedX402Error codes /
 * statuses. Drift in either language (matcher list, case-insensitivity,
 * null-on-unknown) fails that language's test against the locked value.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyOrchestrationError,
  type ClassifiedX402Error,
} from '../../src/payment/x402_settle.js';

// Cross-language fixtures: [label, errorMessage, expectedCodeOrNull].
const FIXTURES: [string, string, ClassifiedX402Error['code'] | null][] = [
  // payment_proof_invalid family
  ['x402version_lowercase', 'Unsupported x402Version 3', 'payment_proof_invalid'],
  ['x402version_uppercase', 'UNSUPPORTED X402VERSION 3', 'payment_proof_invalid'],
  ['invalid_payment', 'Invalid payment payload', 'payment_proof_invalid'],
  ['unsupported_x402', 'Unsupported x402 method', 'payment_proof_invalid'],
  // payment_provider_unavailable family
  ['stripe_lowercase', 'Stripe API returned 502', 'payment_provider_unavailable'],
  ['facilitator_lowercase', 'Facilitator unreachable', 'payment_provider_unavailable'],
  ['cdp_lowercase', 'CDP JWT expired', 'payment_provider_unavailable'],
  ['stripe_uppercase', 'STRIPE timeout', 'payment_provider_unavailable'],
  // Unknown — caller rethrows
  ['database_error', 'duplicate key value violates unique constraint', null],
  ['network_error', 'ECONNREFUSED', null],
  ['empty_string', '', null],
  ['generic_unknown', 'something went wrong', null],
];

describe('classifyOrchestrationError', () => {
  it.each(FIXTURES)('locked cross-language fixture: %s', (_label, message, expectedCode) => {
    const result = classifyOrchestrationError(message);
    if (expectedCode === null) {
      expect(result).toBeNull();
    } else {
      expect(result).not.toBeNull();
      expect(result!.code).toBe(expectedCode);
    }
  });

  it('accepts an Error instance', () => {
    const err = new Error('Unsupported x402Version 3');
    const result = classifyOrchestrationError(err);
    expect(result).not.toBeNull();
    expect(result!.code).toBe('payment_proof_invalid');
  });

  it('accepts a TypeError or other Error subclass', () => {
    const err = new TypeError('stripe API error');
    const result = classifyOrchestrationError(err);
    expect(result).not.toBeNull();
    expect(result!.code).toBe('payment_provider_unavailable');
  });

  it('returns 400 for payment_proof_invalid', () => {
    const result = classifyOrchestrationError('x402Version mismatch');
    expect(result?.status).toBe(400);
  });

  it('returns 503 for payment_provider_unavailable', () => {
    const result = classifyOrchestrationError('Stripe error');
    expect(result?.status).toBe(503);
  });

  it('classified payment_proof carries regenerate_payment_credential next steps', () => {
    const result = classifyOrchestrationError('invalid payment');
    expect(result?.nextSteps.action).toBe('regenerate_payment_credential');
    expect(result?.nextSteps.user_message).toBeTruthy();
  });

  it('classified provider error carries retry_after_seconds', () => {
    const result = classifyOrchestrationError('CDP facilitator timeout');
    expect(result?.nextSteps.retry_after_seconds).toBe(10);
  });

  it('payment_proof takes precedence when both keyword families match', () => {
    const result = classifyOrchestrationError('Unsupported x402Version returned by stripe');
    expect(result?.code).toBe('payment_proof_invalid');
  });

  it('returns null for non-string non-Error input', () => {
    expect(classifyOrchestrationError(null)).toBeNull();
    expect(classifyOrchestrationError(undefined)).toBeNull();
    expect(classifyOrchestrationError(42)).toBeNull();
    expect(classifyOrchestrationError({})).toBeNull();
  });
});
