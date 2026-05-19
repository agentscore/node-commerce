/**
 * Tests for `buildVerificationRequiredBody` — the canonical body builder for
 * `identity_verification_required` denials. Collapses the per-merchant body
 * mapping into one call (verify_url / session_id / poll_secret / poll_url /
 * agent_instructions spread from the reason; merchant supplies message +
 * agentInstructions + extras).
 */

import { describe, expect, it } from 'vitest';
import { buildVerificationRequiredBody } from '../src/_response';
import type { DenialReason } from '../src/core';

const REASON: DenialReason = {
  code: 'identity_verification_required',
  verify_url: 'https://verify.example/sess_x',
  session_id: 'sess_x',
  poll_secret: 'poll_x',
  poll_url: 'https://verify.example/poll/sess_x',
};

describe('buildVerificationRequiredBody', () => {
  it('returns the canonical envelope with default message', () => {
    const body = buildVerificationRequiredBody(REASON);
    expect(body.error).toEqual({
      code: 'operator_verification_required',
      message: 'Identity verification is required.',
    });
    expect(body.verify_url).toBe('https://verify.example/sess_x');
    expect(body.session_id).toBe('sess_x');
    expect(body.poll_secret).toBe('poll_x');
    expect(body.poll_url).toBe('https://verify.example/poll/sess_x');
  });

  it('overrides the default message when opts.message is supplied', () => {
    const body = buildVerificationRequiredBody(REASON, {
      message: 'KYC required to purchase regulated goods.',
    });
    expect((body.error as { message: string }).message).toBe(
      'KYC required to purchase regulated goods.',
    );
  });

  it('overrides agent_instructions when opts.agentInstructions is supplied', () => {
    const custom = JSON.stringify({ action: 'merchant_specific', steps: ['foo'] });
    const body = buildVerificationRequiredBody(REASON, { agentInstructions: custom });
    expect(body.agent_instructions).toBe(custom);
  });

  it('leaves reason.agent_instructions intact when opts.agentInstructions is omitted', () => {
    const reasonWithInstructions: DenialReason = {
      ...REASON,
      agent_instructions: '{"action":"poll_for_credential","user_message":"go verify"}',
    };
    const body = buildVerificationRequiredBody(reasonWithInstructions);
    expect(body.agent_instructions).toBe(reasonWithInstructions.agent_instructions);
  });

  it('spreads opts.extra fields into the body (e.g. order_id for goods merchants)', () => {
    const body = buildVerificationRequiredBody(REASON, {
      message: 'Identity verification is required to purchase wine.',
      extra: { order_id: 'ord_42', custom_field: 'whatever' },
    });
    expect(body.order_id).toBe('ord_42');
    expect(body.custom_field).toBe('whatever');
  });

  it('keeps reason.extra passthrough from denialReasonToBody', () => {
    const reasonWithExtra: DenialReason = {
      ...REASON,
      extra: { order_id: 'from-gate-extra' },
    };
    const body = buildVerificationRequiredBody(reasonWithExtra);
    expect(body.order_id).toBe('from-gate-extra');
  });

  it('opts.extra wins over reason.extra when both define the same key', () => {
    const reasonWithExtra: DenialReason = {
      ...REASON,
      extra: { order_id: 'from-reason' },
    };
    const body = buildVerificationRequiredBody(reasonWithExtra, {
      extra: { order_id: 'from-opts' },
    });
    expect(body.order_id).toBe('from-opts');
  });
});
