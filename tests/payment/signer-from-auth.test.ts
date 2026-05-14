/**
 * Tests for `extractPaymentSignerFromAuth` re-exported from
 * `@agent-score/commerce/payment/signer`. Headers-only variant of
 * `extractPaymentSigner` for adapters that don't expose a Web Fetch
 * Request natively (Express, Fastify, ASGI-bridged frameworks).
 *
 * This file specifically verifies the re-export wiring + the x402 path
 * (which is fully inline and identical to the Python sibling). The MPP
 * path on Node delegates to `mppx.Credential.fromRequest`, so direct
 * byte-for-byte cross-language fixture parity for MPP is a non-goal here
 * — Python's MPP path uses inline base64+JSON parsing, and exact-match
 * parity would require a parallel inline path on Node (out of scope for
 * the re-export PR; tracked separately).
 */

import { describe, expect, it } from 'vitest';
import { extractPaymentSignerFromAuth } from '../../src/payment/signer.js';

// Locked cross-language x402 fixture. The base64 token decodes to:
//   { payload: { authorization: { from: "0x1234567890123456789012345678901234567890" } } }
// Identical input is used by the Python sibling at tests/test_payment_signer.py.
const X402_EVM_FIXTURE_HEADER =
  'eyJwYXlsb2FkIjogeyJhdXRob3JpemF0aW9uIjogeyJmcm9tIjogIjB4MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MCJ9fX0=';

describe('extractPaymentSignerFromAuth re-export from @agent-score/commerce/payment/signer', () => {
  it('is callable', () => {
    expect(typeof extractPaymentSignerFromAuth).toBe('function');
  });

  it('returns the EVM signer from a valid x402 EIP-3009 header', async () => {
    const result = await extractPaymentSignerFromAuth(null, X402_EVM_FIXTURE_HEADER);
    expect(result).toEqual({
      address: '0x1234567890123456789012345678901234567890',
      network: 'evm',
    });
  });

  it('returns null when both headers are missing', async () => {
    expect(await extractPaymentSignerFromAuth(null)).toBeNull();
    expect(await extractPaymentSignerFromAuth(undefined)).toBeNull();
    expect(await extractPaymentSignerFromAuth('')).toBeNull();
  });

  it('returns null for a malformed x402 header (not base64 or not JSON)', async () => {
    expect(await extractPaymentSignerFromAuth(null, '!!!not-base64!!!')).toBeNull();
  });

  it('returns null when the x402 payload has no authorization.from', async () => {
    // base64 of `{"payload":{}}` — well-formed JSON, no signer to recover.
    const empty = 'eyJwYXlsb2FkIjp7fX0=';
    expect(await extractPaymentSignerFromAuth(null, empty)).toBeNull();
  });

  it('does not throw on a Bearer authorization (not the Payment scheme)', async () => {
    expect(await extractPaymentSignerFromAuth('Bearer abc.def.ghi')).toBeNull();
  });

  it('returns null when only an empty Payment-scheme header is supplied', async () => {
    expect(await extractPaymentSignerFromAuth('Payment ')).toBeNull();
  });
});
