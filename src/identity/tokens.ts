/**
 * Operator-token hashing.
 *
 * Plaintext operator tokens (`opc_...`) never persist on disk. Merchants hash
 * them before storing in DB columns and before comparing against persisted
 * hashes. This helper exposes the canonical hash so every consumer agrees on
 * the shape.
 */

import { createHash } from 'node:crypto';
import { asHeaders, readHeader, type HeadersLike } from '../payment/payment_header';

/**
 * sha256 hex digest of a plaintext operator token.
 *
 * Use at every persistence boundary (INSERT) AND every comparison boundary
 * (SELECT WHERE operator_token_id = ...) so plaintext tokens never land in
 * durable storage.
 */
export function hashOperatorToken(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

export type OwnerScope = {
  walletAddress?: string;
  operatorTokenHash?: string;
};

/**
 * Pull the canonical owner identity from request headers so caller-scoped
 * lookups never see the plaintext operator token. Reads `X-Wallet-Address` and
 * `X-Operator-Token`; returns the wallet address verbatim and the
 * sha256 hash of the token. Either or both may be undefined.
 *
 * Use at owner-scoped resource queries (`GET /orders/:id`, `GET /receipts/:id`,
 * ...) so persistence + lookup agree on the hashed column shape and plaintext
 * tokens never leave the request.
 */
export function extractOwnerScope(input: Request | HeadersLike): OwnerScope {
  const headers = asHeaders(input);
  const walletAddress = readHeader(headers, 'x-wallet-address');
  const operatorToken = readHeader(headers, 'x-operator-token');
  return {
    ...(walletAddress ? { walletAddress } : {}),
    ...(operatorToken ? { operatorTokenHash: hashOperatorToken(operatorToken) } : {}),
  };
}
