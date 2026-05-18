import { describe, expect, it } from 'vitest';
import { createDefaultOnDenied } from '../../src/identity/default_denied';
import type { DenialReason } from '../../src/core';

const baseOpts = { merchantName: 'Test Merchant', supportEmail: 'support@example.com' };

describe('createDefaultOnDenied', () => {
  it('wallet_signer_mismatch → 403 with signer body', () => {
    const onDenied = createDefaultOnDenied(baseOpts);
    const reason: DenialReason = {
      code: 'wallet_signer_mismatch',
      claimed_operator: 'op_abc',
      expected_signer: '0xclaim',
      actual_signer: '0xactual',
      linked_wallets: ['0xclaim', '0xactual'],
    };
    const result = onDenied(reason);
    expect(result.status).toBe(403);
    expect(result.body).toHaveProperty('error');
  });

  it('wallet_auth_requires_wallet_signing → 403', () => {
    const onDenied = createDefaultOnDenied(baseOpts);
    const result = onDenied({ code: 'wallet_auth_requires_wallet_signing' } as DenialReason);
    expect(result.status).toBe(403);
  });

  it('wallet_not_trusted → compliance_denied body, overridable copy', () => {
    const onDenied = createDefaultOnDenied({
      ...baseOpts,
      walletNotTrustedMessage: 'Custom denial copy.',
    });
    const result = onDenied({
      code: 'wallet_not_trusted',
      reasons: ['sanctions_flagged'],
      verify_url: 'https://verify.example.com',
    } as DenialReason);
    expect(result.status).toBe(403);
    expect((result.body.error as { message: string }).message).toBe('Custom denial copy.');
  });

  it('payment_required → 403 compliance_error', () => {
    const onDenied = createDefaultOnDenied(baseOpts);
    const result = onDenied({ code: 'payment_required' } as DenialReason);
    expect(result.status).toBe(403);
    expect((result.body.error as { code: string }).code).toBe('compliance_error');
  });

  it('token_expired → 401', () => {
    const onDenied = createDefaultOnDenied(baseOpts);
    expect(onDenied({ code: 'token_expired' } as DenialReason).status).toBe(401);
  });

  it('invalid_credential → 401', () => {
    const onDenied = createDefaultOnDenied(baseOpts);
    expect(onDenied({ code: 'invalid_credential' } as DenialReason).status).toBe(401);
  });

  it('api_error → 503 with Cache-Control: no-store', () => {
    const onDenied = createDefaultOnDenied(baseOpts);
    const result = onDenied({ code: 'api_error' } as DenialReason);
    expect(result.status).toBe(503);
    expect(result.headers).toEqual({ 'Cache-Control': 'no-store' });
  });

  it('unknown code → 403 default', () => {
    const onDenied = createDefaultOnDenied(baseOpts);
    expect(onDenied({ code: 'missing_identity' } as DenialReason).status).toBe(403);
  });

  it('uses default messages when overrides omitted', () => {
    const onDenied = createDefaultOnDenied(baseOpts);
    const result = onDenied({
      code: 'wallet_not_trusted',
      reasons: [],
    } as unknown as DenialReason);
    expect((result.body.error as { message: string }).message).toContain('Test Merchant');
  });
});
