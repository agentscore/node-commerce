/**
 * Operator-token hashing.
 *
 * Plaintext operator tokens (`opc_...`) never persist on disk. Merchants hash
 * them before storing in DB columns and before comparing against persisted
 * hashes. This helper exposes the canonical hash so every consumer agrees on
 * the shape.
 */

import { createHash } from 'node:crypto';

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
