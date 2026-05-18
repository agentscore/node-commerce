/** Factory for the standard `onDenied` callback shape used by Checkout's
 *  gate config. Replaces the ~100-line switch every consumer codebase
 *  (sayer, martin, sandbox) wrote by hand.
 *
 *  The shape is framework-neutral (`{status, body, headers?}`) — matches
 *  `Checkout`'s `onDenied` signature directly. For per-framework gate
 *  middleware (`agentscoreGate(...)`) the merchant adapts at the call site
 *  with `c.json(body, status, headers)` / equivalent.
 */

import { buildContactSupportNextSteps, buildSignerMismatchBody } from '../_denial';
import { denialReasonToBody } from '../_response';
import type { DenialReason } from '../core';

export interface CreateDefaultOnDeniedOptions {
  /** Display name used in the wallet_not_trusted body ("Identity check did
   *  not satisfy policy for <merchantName>"). */
  merchantName: string;
  /** Support email surfaced in `next_steps.action: "contact_support"`. */
  supportEmail: string;
  /** Optional override for the support-context blurb. Defaults to
   *  "Contact support if you believe this denial is in error.". */
  supportContext?: string;
  /** Optional override for the payment_required error message. Defaults to
   *  "AgentScore tier does not support assess. Contact support.". */
  paymentRequiredMessage?: string;
  /** Optional override for the wallet_not_trusted (unfixable) error message.
   *  Defaults to `"Identity check did not satisfy policy for <merchantName>."`. */
  walletNotTrustedMessage?: string;
}

export interface DefaultOnDeniedResult {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** Build the canonical `onDenied(ctx, reason)` callback. Returns
 *  framework-neutral `{status, body, headers?}` matching `Checkout`'s
 *  `onDenied` signature. The `ctx` arg is ignored — pass `_ctx`-style if
 *  unused.
 *
 *  Branch table (matches the hand-rolled version in every consumer):
 *   - `wallet_signer_mismatch` / `wallet_auth_requires_wallet_signing` →
 *     `buildSignerMismatchBody(...)`, status 403
 *   - `wallet_not_trusted` → custom compliance_denied body + contact-support
 *     next steps, status 403
 *   - `payment_required` → denial body + compliance_error message, status 403
 *   - `token_expired` / `invalid_credential` → 401
 *   - `api_error` → 503 + `Cache-Control: no-store`
 *   - default → 403
 */
export function createDefaultOnDenied(opts: CreateDefaultOnDeniedOptions): (reason: DenialReason) => DefaultOnDeniedResult {
  const supportContext = opts.supportContext ?? 'Contact support if you believe this denial is in error.';
  const paymentRequiredMessage = opts.paymentRequiredMessage ?? 'AgentScore tier does not support assess. Contact support.';
  const walletNotTrustedMessage = opts.walletNotTrustedMessage ?? `Identity check did not satisfy policy for ${opts.merchantName}.`;

  return function defaultOnDenied(reason: DenialReason): DefaultOnDeniedResult {
    if (reason.code === 'wallet_signer_mismatch' || reason.code === 'wallet_auth_requires_wallet_signing') {
      const body = buildSignerMismatchBody({
        result: {
          kind: reason.code,
          claimedOperator: reason.claimed_operator ?? null,
          actualSignerOperator: reason.actual_signer_operator ?? null,
          expectedSigner: reason.expected_signer ?? '',
          actualSigner: reason.actual_signer ?? '',
          linkedWallets: reason.linked_wallets ?? [],
          agentInstructions: reason.agent_instructions ?? '',
          claimedWallet: reason.expected_signer ?? '',
        } as Parameters<typeof buildSignerMismatchBody>[0]['result'],
      });
      return { status: 403, body: body ?? (denialReasonToBody(reason) as Record<string, unknown>) };
    }

    if (reason.code === 'wallet_not_trusted') {
      return {
        status: 403,
        body: {
          error: { code: 'compliance_denied', message: walletNotTrustedMessage },
          reasons: reason.reasons ?? [],
          policy_result: reason.data?.policy_result,
          verify_url: reason.verify_url,
          next_steps: buildContactSupportNextSteps(opts.supportEmail, supportContext),
        },
      };
    }

    if (reason.code === 'payment_required') {
      return {
        status: 403,
        body: {
          ...denialReasonToBody(reason),
          error: { code: 'compliance_error', message: paymentRequiredMessage },
        },
      };
    }

    const status = reason.code === 'token_expired' || reason.code === 'invalid_credential' ? 401
      : reason.code === 'api_error' ? 503 : 403;
    return {
      status,
      body: denialReasonToBody(reason) as Record<string, unknown>,
      ...(status >= 500 && { headers: { 'Cache-Control': 'no-store' } }),
    };
  };
}

/** Canonical `onDenied` for read-only resource gates (e.g. `GET /orders/:id`).
 *
 *  Collapses every denial code to **401 `unauthorized`** while still spreading
 *  `denialReasonToBody(reason)` so `agent_instructions` / `verify_url` /
 *  session-mint fields ride through for the agent's recovery path. Stamps
 *  `Cache-Control: no-store` because RFC 7234 makes 4xx responses
 *  heuristically cacheable; transient denials (api_error, token_expired)
 *  must not be replayed by a shared cache.
 *
 *  Pair with `agentscoreGate({ onDenied: defaultReadOnlyOnDenied })` on routes
 *  where the resource owner is the only authorized identity (full compliance
 *  policy already ran at /purchase time; the read-back leg only needs
 *  presence-of-valid-credential).
 */
export function defaultReadOnlyOnDenied(reason: DenialReason): DefaultOnDeniedResult {
  const message = reason.code === 'missing_identity'
    ? 'X-Wallet-Address or X-Operator-Token header required'
    : 'Invalid identity';
  return {
    status: 401,
    body: {
      ...(denialReasonToBody(reason) as Record<string, unknown>),
      error: { code: 'unauthorized', message },
    },
    headers: { 'Cache-Control': 'no-store' },
  };
}
