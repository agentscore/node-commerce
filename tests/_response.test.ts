import { describe, expect, it } from 'vitest';
import { denialReasonToBody } from '../src/_response';
import type { DenialReason } from '../src/core';

// Minimal DenialReason factory — every field starts undefined so each test sets
// only what it's asserting.
const reason = (fields: Partial<DenialReason> = {}): DenialReason => ({
  code: 'missing_identity',
  ...fields,
}) as DenialReason;

describe('denialReasonToBody', () => {
  it('emits {error: {code, message}} with default per-code message for a bare denial', () => {
    const body = denialReasonToBody(reason());
    expect(body.error).toEqual({
      code: 'missing_identity',
      message: expect.stringContaining('No identity'),
    });
  });

  it('propagates decision/reasons/verify_url when present', () => {
    const body = denialReasonToBody(reason({
      code: 'wallet_not_trusted',
      decision: 'deny',
      reasons: ['kyc_required', 'age_insufficient'],
      verify_url: 'https://www.agentscore.com/verify?x=1',
    }));
    expect((body.error as { code: string }).code).toBe('wallet_not_trusted');
    expect(body.decision).toBe('deny');
    expect(body.reasons).toEqual(['kyc_required', 'age_insufficient']);
    expect(body.verify_url).toBe('https://www.agentscore.com/verify?x=1');
  });

  it('uses an explicit reason.message when provided, not the per-code default', () => {
    const body = denialReasonToBody(reason({ code: 'api_error', message: 'Custom downstream context' }));
    expect(body.error).toEqual({ code: 'api_error', message: 'Custom downstream context' });
  });

  it('propagates session_id / poll_secret / poll_url when present', () => {
    const body = denialReasonToBody(reason({
      code: 'identity_verification_required',
      session_id: 'sess_abc',
      poll_secret: 'poll_xyz',
      poll_url: 'https://api.agentscore.com/v1/sessions/sess_abc',
    }));
    expect(body.session_id).toBe('sess_abc');
    expect(body.poll_secret).toBe('poll_xyz');
    expect(body.poll_url).toBe('https://api.agentscore.com/v1/sessions/sess_abc');
  });

  it('propagates agent_instructions and agent_memory when present', () => {
    const body = denialReasonToBody(reason({
      code: 'token_expired',
      agent_instructions: '{"action":"deliver_verify_url_and_poll"}',
      agent_memory: {
        save_for_future_agentscore_gates: true,
        pattern_summary: 'test',
        quickstart: 'https://docs/agent-identity',
        identity_check_endpoint: 'https://api.agentscore.com/v1/credentials',
        identity_paths: { wallet: 'X-Wallet-Address', operator_token: 'X-Operator-Token' },
        bootstrap: 'Follow verify_url',
        do_not_persist_in_memory: ['operator_token'],
        persist_in_credential_store: ['operator_token'],
      },
    }));
    expect(body.agent_instructions).toBe('{"action":"deliver_verify_url_and_poll"}');
    expect(body.agent_memory).toBeDefined();
  });

  it('marshals all wallet-signer-mismatch fields', () => {
    const body = denialReasonToBody(reason({
      code: 'wallet_signer_mismatch',
      claimed_operator: 'op_victim',
      actual_signer_operator: 'op_attacker',
      expected_signer: '0xaaa0000000000000000000000000000000000000',
      actual_signer: '0xbbb0000000000000000000000000000000000000',
      linked_wallets: ['0xaaa0000000000000000000000000000000000000', '0xccc0000000000000000000000000000000000000'],
    }));
    expect(body.claimed_operator).toBe('op_victim');
    expect(body.actual_signer_operator).toBe('op_attacker');
    expect(body.expected_signer).toBe('0xaaa0000000000000000000000000000000000000');
    expect(body.actual_signer).toBe('0xbbb0000000000000000000000000000000000000');
    expect(body.linked_wallets).toEqual([
      '0xaaa0000000000000000000000000000000000000',
      '0xccc0000000000000000000000000000000000000',
    ]);
  });

  it('marshals actual_signer_operator: null explicitly (distinct from undefined)', () => {
    // null means "signer is a valid wallet but not linked to any operator" — the
    // gate must surface null rather than omit the field so agents can distinguish
    // "not linked" from "never checked".
    const body = denialReasonToBody(reason({
      code: 'wallet_signer_mismatch',
      claimed_operator: 'op_victim',
      actual_signer_operator: null,
    }));
    expect(body.actual_signer_operator).toBeNull();
    expect(Object.hasOwn(body, 'actual_signer_operator')).toBe(true);
  });

  it('omits linked_wallets when array is empty', () => {
    const body = denialReasonToBody(reason({
      code: 'wallet_signer_mismatch',
      linked_wallets: [],
    }));
    expect(body).not.toHaveProperty('linked_wallets');
  });

  it('merges extra fields onto the body (createSessionOnMissing.onBeforeSession hook)', () => {
    const body = denialReasonToBody(reason({
      code: 'identity_verification_required',
      extra: { order_id: 'ord_123', merchant_context: 'product-purchase' },
    }));
    expect(body.order_id).toBe('ord_123');
    expect(body.merchant_context).toBe('product-purchase');
  });

  it('injects canonical wallet_not_trusted agent_instructions when reason has none', () => {
    // wallet_not_trusted reaches the agent ONLY for unfixable reasons (sanctions / age /
    // jurisdiction_restricted). Fixable reasons (kyc_required, etc.) are rerouted to
    // identity_verification_required by the gate before they ever reach the marshaller.
    const body = denialReasonToBody(reason({
      code: 'wallet_not_trusted',
      reasons: ['sanctions_flagged'],
      verify_url: 'https://www.agentscore.com/dashboard/verify?address=0xabc&chain=base',
    }));
    const instructions = JSON.parse(body.agent_instructions as string);
    expect(instructions.action).toBe('contact_support');
    expect(instructions.steps).toBeInstanceOf(Array);
    expect(typeof instructions.user_message).toBe('string');
  });

  it('injects canonical payment_required agent_instructions when reason has none', () => {
    const body = denialReasonToBody(reason({ code: 'payment_required' }));
    const instructions = JSON.parse(body.agent_instructions as string);
    expect(instructions.action).toBe('contact_merchant');
  });

  it('injects fallback identity_verification_required instructions when reason has none', () => {
    const body = denialReasonToBody(reason({
      code: 'identity_verification_required',
      verify_url: 'https://www.agentscore.com/verify?session=sess_abc',
    }));
    const instructions = JSON.parse(body.agent_instructions as string);
    expect(instructions.action).toBe('deliver_verify_url_and_poll');
  });

  it('explicit reason.agent_instructions takes precedence over the default map', () => {
    const custom = JSON.stringify({ action: 'custom_action', steps: ['custom'] });
    const body = denialReasonToBody(reason({
      code: 'wallet_not_trusted',
      agent_instructions: custom,
    }));
    expect(body.agent_instructions).toBe(custom);
  });
});
