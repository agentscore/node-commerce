/**
 * Tests for `zeroAmountCarveOut` — skips upstream verify+settle for $0 orders
 * and recovers the signer for wallet-capture attribution.
 *
 * Locked cross-language fixtures shared with the Python sibling at
 * `python-commerce/tests/test_zero_settle.py`. Both files reference identical
 * payload dicts / Authorization header values + expected `ZeroSettleResult`.
 * Drift in either language (DID parsing, dict-shape handling, address
 * validation) fails that language's test against the locked value.
 */

import { describe, expect, it } from 'vitest';
import { zeroAmountCarveOut, type ZeroSettleResult } from '../../src/payment/zero-settle.js';

const NULL_RESULT: ZeroSettleResult = {
  signerAddress: null,
  signerNetwork: null,
  txHash: null,
};

// ─── x402-base rail: payload is the verified outer dict (already base64-decoded) ────────

const X402_EVM_PAYLOAD = {
  payload: { authorization: { from: '0xABCDef1234567890123456789012345678901234' } },
};

const X402_FIXTURES: [string, Record<string, unknown> | null | string, ZeroSettleResult][] = [
  [
    'x402_evm_signer_recovered',
    X402_EVM_PAYLOAD,
    {
      signerAddress: '0xabcdef1234567890123456789012345678901234',
      signerNetwork: 'evm',
      txHash: null,
    },
  ],
  ['x402_payload_null', null, NULL_RESULT],
  ['x402_payload_not_object', 'not-a-dict', NULL_RESULT],
  ['x402_inner_payload_missing', {}, NULL_RESULT],
  ['x402_inner_payload_not_object', { payload: 'oops' }, NULL_RESULT],
  ['x402_authorization_missing', { payload: {} }, NULL_RESULT],
  ['x402_from_missing', { payload: { authorization: {} } }, NULL_RESULT],
  [
    'x402_from_not_evm_shape',
    { payload: { authorization: { from: 'not-an-address' } } },
    NULL_RESULT,
  ],
];

// ─── tempo / solana MPP rails: authorizationHeader carries the credential ──────────────

const MPP_TEMPO_AUTH =
  'Payment eyJzb3VyY2UiOiAiZGlkOnBraDplaXAxNTU6NDIxNzoweEFCQ0RlZjEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDEyMzQifQ==';
const MPP_SOLANA_AUTH =
  'Payment eyJjaGFsbGVuZ2UiOiB7InNvdXJjZSI6ICJkaWQ6cGtoOnNvbGFuYTo1ZXlrdDRVc0Z2OFA4TkpkVFJFcFkxdnpxS3FaS3ZkcFVrZkZwOjduUUVneHFFVzFiRHFhVDNrWldhOEtxVWs0V2ZoNFZiY3cifX0=';

const MPP_FIXTURES: [string, 'tempo' | 'solana', string | null, ZeroSettleResult][] = [
  [
    'mpp_tempo_signer_recovered',
    'tempo',
    MPP_TEMPO_AUTH,
    {
      signerAddress: '0xabcdef1234567890123456789012345678901234',
      signerNetwork: 'evm',
      txHash: null,
    },
  ],
  [
    'mpp_solana_signer_recovered',
    'solana',
    MPP_SOLANA_AUTH,
    {
      signerAddress: '7nQEgxqEW1bDqaT3kZWa8KqUk4Wfh4Vbcw',
      signerNetwork: 'solana',
      txHash: null,
    },
  ],
  ['mpp_auth_null', 'tempo', null, NULL_RESULT],
  ['mpp_auth_empty', 'tempo', '', NULL_RESULT],
  ['mpp_auth_not_payment_scheme', 'tempo', 'Bearer abc.def.ghi', NULL_RESULT],
  ['mpp_credential_without_source', 'tempo', 'Payment eyJmb28iOiAiYmFyIn0=', NULL_RESULT],
];

describe('zeroAmountCarveOut x402-base rail', () => {
  it.each(X402_FIXTURES)('locked cross-language fixture: %s', async (_label, payload, expected) => {
    const result = zeroAmountCarveOut({
      rail: 'x402-base',
      payload: payload as Record<string, unknown> | null,
    });
    expect(result).toEqual(expected);
  });
});

describe('zeroAmountCarveOut tempo/solana MPP rails', () => {
  it.each(MPP_FIXTURES)('locked cross-language fixture: %s', async (_label, rail, auth, expected) => {
    const result = zeroAmountCarveOut({ rail, authorizationHeader: auth });
    expect(result).toEqual(expected);
  });
});

describe('zeroAmountCarveOut invariants', () => {
  it('txHash is always null', async () => {
    const result = zeroAmountCarveOut({ rail: 'x402-base', payload: X402_EVM_PAYLOAD });
    expect(result.txHash).toBeNull();
  });

  it('x402-base rail ignores authorizationHeader', async () => {
    const result = zeroAmountCarveOut({
      rail: 'x402-base',
      payload: X402_EVM_PAYLOAD,
      authorizationHeader: MPP_SOLANA_AUTH,
    });
    expect(result.signerAddress).toBe('0xabcdef1234567890123456789012345678901234');
    expect(result.signerNetwork).toBe('evm');
  });

  it('tempo/solana MPP rails ignore payload', async () => {
    const result = zeroAmountCarveOut({
      rail: 'tempo',
      payload: X402_EVM_PAYLOAD,
      authorizationHeader: MPP_TEMPO_AUTH,
    });
    expect(result.signerAddress).toBe('0xabcdef1234567890123456789012345678901234');
    expect(result.signerNetwork).toBe('evm');
  });

  it('no credential provided returns null result', async () => {
    expect(zeroAmountCarveOut({ rail: 'x402-base' })).toEqual(NULL_RESULT);
    expect(zeroAmountCarveOut({ rail: 'tempo' })).toEqual(NULL_RESULT);
    expect(zeroAmountCarveOut({ rail: 'solana' })).toEqual(NULL_RESULT);
  });

  const encodePaymentCredential = (cred: unknown): string =>
    `Payment ${Buffer.from(JSON.stringify(cred)).toString('base64')}`;

  it('returns null for a DID with an unrecognized key family (neither eip155 nor solana)', async () => {
    const auth = encodePaymentCredential({ source: 'did:pkh:cosmos:cosmoshub-4:cosmos1abc' });
    expect(zeroAmountCarveOut({ rail: 'tempo', authorizationHeader: auth })).toEqual(NULL_RESULT);
  });

  it('returns null for a DID with too few segments (malformed prefix)', async () => {
    const auth = encodePaymentCredential({ source: 'did:pkh:eip155' });
    expect(zeroAmountCarveOut({ rail: 'tempo', authorizationHeader: auth })).toEqual(NULL_RESULT);
  });

  it('returns null for an eip155 DID whose address is not a valid 0x address', async () => {
    const auth = encodePaymentCredential({ source: 'did:pkh:eip155:4217:not-an-address' });
    expect(zeroAmountCarveOut({ rail: 'tempo', authorizationHeader: auth })).toEqual(NULL_RESULT);
  });

  it('returns null for a credential that base64-decodes to a non-object', async () => {
    const auth = `Payment ${Buffer.from(JSON.stringify('just-a-string')).toString('base64')}`;
    expect(zeroAmountCarveOut({ rail: 'tempo', authorizationHeader: auth })).toEqual(NULL_RESULT);
  });

  it('returns null for the "payment " scheme with only whitespace after it', async () => {
    expect(zeroAmountCarveOut({ rail: 'tempo', authorizationHeader: 'Payment    ' })).toEqual(NULL_RESULT);
  });

  it('returns the null result for an unrecognized rail (defensive default branch)', async () => {
    // The public type only permits the three known rails; a forced bad value
    // hits the trailing `return NULL_RESULT` guard.
    expect(
      zeroAmountCarveOut({ rail: 'unknown-rail' as unknown as 'tempo', authorizationHeader: 'Payment x' }),
    ).toEqual(NULL_RESULT);
  });
});
