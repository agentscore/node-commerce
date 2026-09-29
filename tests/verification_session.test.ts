import { describe, expect, it } from 'vitest';
import { buildIdentityBootstrap } from '../src/challenge/identity';
import {
  VERIFICATION_SESSION_HEADER,
  hasIdentityHeader,
  requestsVerificationSession,
  shouldRunConditionalGate,
} from '../src/payment/payment_header';

describe('verification-session request helpers', () => {
  it('recognizes the header in any case, trimmed', () => {
    expect(requestsVerificationSession({ 'x-verification-session': 'create' })).toBe(true);
    expect(requestsVerificationSession({ [VERIFICATION_SESSION_HEADER]: ' CREATE ' })).toBe(true);
    expect(requestsVerificationSession(new Headers({ 'X-Verification-Session': 'Create' }))).toBe(true);
  });

  it('rejects other values and a missing header', () => {
    expect(requestsVerificationSession({ 'x-verification-session': 'yes' })).toBe(false);
    expect(requestsVerificationSession({})).toBe(false);
  });

  it('does not request a session when an identity or a payment credential is present', () => {
    const base = { 'x-verification-session': 'create' };
    expect(requestsVerificationSession({ ...base, 'x-operator-token': 'opc_x' })).toBe(false);
    expect(requestsVerificationSession({ ...base, 'x-wallet-address': '0xabc' })).toBe(false);
    expect(requestsVerificationSession({ ...base, 'agent-identity': 'eyJ.e30.sig' })).toBe(false);
    expect(requestsVerificationSession({ ...base, authorization: 'Payment abc' })).toBe(false);
    expect(requestsVerificationSession({ ...base, 'x-payment': 'abc' })).toBe(false);
  });

  it('treats an empty Agent-Identity value as no identity', () => {
    expect(hasIdentityHeader({ 'agent-identity': ' , ' })).toBe(false);
    expect(hasIdentityHeader({ 'agent-identity': 'eyJ.e30.sig' })).toBe(true);
  });

  it('runs the conditional gate on a payment credential or a session request, and not otherwise', () => {
    expect(shouldRunConditionalGate({ authorization: 'Payment abc' })).toBe(true);
    expect(shouldRunConditionalGate({ 'payment-signature': 'abc' })).toBe(true);
    expect(shouldRunConditionalGate({ 'x-verification-session': 'create' })).toBe(true);
    expect(shouldRunConditionalGate({})).toBe(false);
    expect(shouldRunConditionalGate({ 'x-operator-token': 'opc_x' })).toBe(false);
  });

  it('builds the identity_bootstrap block naming the header', () => {
    const block = buildIdentityBootstrap();
    expect(block.header).toBe(VERIFICATION_SESSION_HEADER);
    expect(block.value).toBe('create');
    expect(block.instructions).toContain(`${VERIFICATION_SESSION_HEADER}: create`);
    expect(block.instructions).toContain('verify_url');
  });
});
