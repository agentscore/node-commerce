/**
 * Shared DenialReason → response body serialization for all adapters.
 *
 * Keeps Hono / Express / Fastify / Web / Next.js defaults aligned — a field added
 * here shows up in every adapter's 403 body automatically, and there's one place
 * to test the marshaling.
 *
 * Body shape: `{ error: { code, message }, ... }` — matches the canonical AgentScore
 * core API response shape (`core/api/src/lib/auth.ts`, `lib/rate-limit.ts`, etc.) and
 * martin-estate's pre-commerce shape, so downstream agents see one consistent
 * `error.code` + `error.message` pair regardless of which layer produced the denial.
 */

import type { DenialCode, DenialReason } from './core.js';

const DEFAULT_MESSAGES: Record<DenialCode, string> = {
  missing_identity:
    'No identity provided. Send X-Wallet-Address (wallet) or X-Operator-Token (credential).',
  identity_verification_required:
    'Identity verification is required to access this resource. Visit verify_url to complete KYC.',
  wallet_not_trusted:
    'The wallet does not meet the merchant compliance policy.',
  api_error:
    'AgentScore is unreachable. This is transient — retry in a few seconds.',
  payment_required:
    'AgentScore tier does not support assess. Contact support.',
  wallet_signer_mismatch:
    'Payment signer does not match the wallet claimed via X-Wallet-Address. The signer and the claimed wallet must both resolve to the same AgentScore operator.',
  wallet_auth_requires_wallet_signing:
    'X-Wallet-Address was sent with a rail that has no wallet signature (Stripe SPT / card). Switch to X-Operator-Token, or use a wallet-signing rail (Tempo MPP, x402).',
  token_expired:
    'The operator token is expired or revoked. A fresh verification session has been minted — visit verify_url to mint a new token.',
  invalid_credential:
    'The operator token is not recognized. Switch to a different stored token, or drop the header to bootstrap a fresh session.',
};

// Field names the gate claims authority over. Merchant-provided `extra` (from the
// onBeforeSession hook) MUST NOT override these — a buggy or malicious hook could
// otherwise replace `verify_url` with a phishing URL or drop agent_instructions.
const RESERVED_FIELDS = new Set([
  'error',
  'decision',
  'reasons',
  'verify_url',
  'session_id',
  'poll_secret',
  'poll_url',
  'agent_instructions',
  'agent_memory',
  'claimed_operator',
  'actual_signer_operator',
  'expected_signer',
  'actual_signer',
  'linked_wallets',
]);

export function denialReasonToBody(reason: DenialReason): Record<string, unknown> {
  const message = reason.message ?? DEFAULT_MESSAGES[reason.code];
  const body: Record<string, unknown> = { error: { code: reason.code, message } };
  if (reason.decision) body.decision = reason.decision;
  if (reason.reasons) body.reasons = reason.reasons;
  if (reason.verify_url) body.verify_url = reason.verify_url;
  if (reason.session_id) body.session_id = reason.session_id;
  if (reason.poll_secret) body.poll_secret = reason.poll_secret;
  if (reason.poll_url) body.poll_url = reason.poll_url;
  if (reason.agent_instructions) body.agent_instructions = reason.agent_instructions;
  if (reason.agent_memory) body.agent_memory = reason.agent_memory;
  if (reason.claimed_operator) body.claimed_operator = reason.claimed_operator;
  if (reason.code === 'wallet_signer_mismatch') body.actual_signer_operator = reason.actual_signer_operator ?? null;
  if (reason.expected_signer) body.expected_signer = reason.expected_signer;
  if (reason.actual_signer) body.actual_signer = reason.actual_signer;
  if (reason.linked_wallets && reason.linked_wallets.length > 0) body.linked_wallets = reason.linked_wallets;
  // api_error denials get a default retry hint so agents know it's transient. Vendors can
  // override by spreading their own next_steps into a custom onDenied body.
  if (reason.code === 'api_error' && !(reason.extra && (reason.extra as Record<string, unknown>).next_steps)) {
    body.next_steps = { action: 'retry', retry_after_seconds: 5 };
  }
  if (reason.extra) {
    for (const [key, value] of Object.entries(reason.extra)) {
      if (RESERVED_FIELDS.has(key)) {
        console.warn(`[gate] onBeforeSession returned reserved field "${key}" — ignoring to preserve gate authority`);
        continue;
      }
      body[key] = value;
    }
  }
  return body;
}
