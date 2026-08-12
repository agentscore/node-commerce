import { describe, expect, it } from 'vitest';
import { classifyMppxFailure } from '../../src/payment/mppx_failures';
import { runWithMppxFailureCapture } from '../../src/payment/mppx_server';

describe('classifyMppxFailure', () => {
  it('returns null when reason is null / undefined / empty', () => {
    expect(classifyMppxFailure(null)).toBeNull();
    expect(classifyMppxFailure(undefined)).toBeNull();
    expect(classifyMppxFailure('')).toBeNull();
  });

  it('returns null for unrecognized reasons', () => {
    expect(classifyMppxFailure('insufficient funds')).toBeNull();
    expect(classifyMppxFailure('Transaction reverted: ERC20: transfer amount exceeds balance')).toBeNull();
  });

  describe('Solana confirmation timeout (broadcast-then-unconfirmed)', () => {
    it('classifies a confirmation timeout as pending, NOT as regenerate/pay-again', () => {
      const out = classifyMppxFailure('Transaction confirmation timeout');
      expect(out).not.toBeNull();
      expect(out?.code).toBe('payment_pending_confirmation');
      // 504, not 402: a 402 would trigger x402 clients to auto-repay, which is
      // exactly the double-charge this guards against.
      expect(out?.status).toBe(504);
      expect(out?.status).not.toBe(402);
      // The action must never tell the agent to regenerate the credential.
      expect(out?.nextSteps.action).not.toBe('regenerate_payment_credential');
      expect(out?.nextSteps.action).toBe('check_settlement_before_retry');
      expect(out?.extra?.chain).toBe('solana');
      expect(out?.extra?.broadcast).toBe(true);
    });

    it('matches the status-recovery-failed variant too', () => {
      const out = classifyMppxFailure(
        'Transaction confirmation timeout (status recovery failed: RPC error)',
      );
      expect(out?.code).toBe('payment_pending_confirmation');
    });

    it('warns the buyer not to pay twice and to check the balance first', () => {
      const msg = classifyMppxFailure('Transaction confirmation timeout')!.nextSteps.user_message;
      expect(msg.toLowerCase()).toContain('confirmation timed out');
      expect(msg.toLowerCase()).toMatch(/check your (wallet )?balance/);
      expect(msg.toLowerCase()).toMatch(/not pay again|only resubmit/);
    });
  });

  it('classifies Tempo keychain rejection by literal pattern', () => {
    const out = classifyMppxFailure(
      'RPC Request failed. (keychain validation failed: AccountKeychainError(KeyNotFound(KeyNotFound)))',
    );
    expect(out).not.toBeNull();
    expect(out?.code).toBe('tempo_key_not_registered');
    expect(out?.status).toBe(401);
    expect(out?.nextSteps.action).toBe('register_tempo_key');
    expect(out?.extra?.upstream_error).toBe('KeyNotFound');
    expect(out?.extra?.chain).toBe('tempo');
  });

  it('matches `KeyNotFound` case-insensitively without the full keychain phrase', () => {
    const out = classifyMppxFailure('Some shorter message containing KeyNotFound somewhere');
    expect(out?.code).toBe('tempo_key_not_registered');
  });

  it('user_message names both recovery paths (enroll + switch rail)', () => {
    const out = classifyMppxFailure('keychain validation failed: KeyNotFound');
    const msg = out!.nextSteps.user_message;
    expect(msg).toContain('tempo wallet login');
    expect(msg).toMatch(/Base|Solana/);
  });
});

describe('runWithMppxFailureCapture', () => {
  it('captures shortMessage + details from a viem-shaped error logged by mppx', async () => {
    const { result, failureReason } = await runWithMppxFailureCapture(async () => {
      console.error('mppx: internal verification error', {
        shortMessage: 'RPC Request failed.',
        details: 'keychain validation failed: KeyNotFound',
      });
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(failureReason).toContain('RPC Request failed.');
    expect(failureReason).toContain('keychain validation failed: KeyNotFound');
  });

  it('falls back to .message when shortMessage is absent', async () => {
    const { failureReason } = await runWithMppxFailureCapture(async () => {
      console.error('mppx: internal verification error', { message: 'plain Error message' });
      return null;
    });
    expect(failureReason).toBe('plain Error message');
  });

  it('returns null failureReason when no mppx error was logged in the scope', async () => {
    const { result, failureReason } = await runWithMppxFailureCapture(async () => 42);
    expect(result).toBe(42);
    expect(failureReason).toBeNull();
  });

  it('ignores unrelated console.error calls (different first arg)', async () => {
    const { failureReason } = await runWithMppxFailureCapture(async () => {
      console.error('some other error', { shortMessage: 'unrelated' });
      return null;
    });
    expect(failureReason).toBeNull();
  });
});
