/**
 * Universal denial helpers shared across every adapter.
 *
 * What lives here:
 *   - `FIXABLE_DENIAL_REASONS` / `isFixableDenial` — classifier for compliance reasons that can
 *     be resolved by re-completing KYC (vs sanctions / age failures which are permanent).
 *   - `denialReasonStatus` — picks the right HTTP status code per denial code (401 for credential
 *     problems, 503 for transient API errors, 403 for everything else).
 *   - `buildSignerMismatchBody` — produces the standard 403 body for a `verifyWalletSignerMatch`
 *     non-pass result.
 *   - `buildContactSupportNextSteps` — standard `next_steps.action: "contact_support"` shape for
 *     unfixable compliance denials.
 *   - `verificationAgentInstructions` — the canned `agent_instructions` block for
 *     identity-verification 403s. Vendors can override individual fields.
 *
 * Adapters use `denialReasonStatus` inside their default `onDenied` so vendors get the right
 * status code for free. The body builders are exported from each adapter so vendors who write
 * a custom `onDenied` can compose them without copy-paste.
 */

import type { DenialReason, VerifyWalletSignerResult } from './core';

/**
 * Compliance denial reasons that can be resolved by re-completing KYC. Sanctions hits and
 * age-not-verified are NOT in this set — they're permanent policy failures on an
 * otherwise-verified identity and require contact-support, not retry.
 */
export const FIXABLE_DENIAL_REASONS: ReadonlySet<string> = new Set([
  'kyc_required',
  'kyc_pending',
  'kyc_failed',
  'jurisdiction_restricted',
]);

/**
 * Returns true when a `wallet_not_trusted` denial's reasons are all "fixable" (the user can
 * re-verify and retry). False when any reason is permanent (sanctions, age).
 *
 * Empty reasons array is treated as fixable on the assumption that an empty-reason denial
 * means a generic policy fail that's worth retrying — vendors can override by checking the
 * specific reasons themselves.
 */
export function isFixableDenial(reasons: readonly string[] | undefined): boolean {
  if (!reasons || reasons.length === 0) return true;
  return reasons.every((r) => FIXABLE_DENIAL_REASONS.has(r));
}

/**
 * The right HTTP status code for a denial. `defaultOnDenied` in every adapter uses this so
 * vendors get correct status codes without writing per-code branches.
 *
 *   - 401 for credential problems the agent can recover from (`token_expired`, `invalid_credential`)
 *   - 503 for transient `api_error`
 *   - 403 for everything else (identity required, compliance fail, signer mismatch, etc.)
 */
export function denialReasonStatus(reason: DenialReason): 401 | 403 | 503 {
  if (reason.code === 'token_expired' || reason.code === 'invalid_credential') return 401;
  if (reason.code === 'api_error') return 503;
  return 403;
}

export interface SignerMismatchBodyInput {
  /** Result from `verifyWalletSignerMatch`. The function only emits a body for non-pass results. */
  result: VerifyWalletSignerResult;
  /** Optional override for the human-facing `next_steps.user_message`. */
  userMessage?: string;
  /** Optional override for `next_steps.learn_more_url`. Default: AgentScore agent-identity guide. */
  learnMoreUrl?: string;
}

/**
 * Standard 403 body for a non-pass `verifyWalletSignerMatch` result. Returns null for `pass` /
 * `api_error` so vendors can call it unconditionally:
 *
 *   const result = await verifyWalletSignerMatch(c);
 *   const mismatchBody = buildSignerMismatchBody({ result });
 *   if (mismatchBody) return c.json(mismatchBody, 403);
 *
 * Body shape mirrors the gate's denial bodies: top-level error.code, all signer-match fields
 * (`claimed_operator`, `actual_signer_operator`, `expected_signer`, `actual_signer`,
 * `linked_wallets`), plus a `next_steps` action describing the recovery path.
 */
export function buildSignerMismatchBody(input: SignerMismatchBodyInput): Record<string, unknown> | null {
  const { result } = input;
  if (result.kind === 'pass' || result.kind === 'api_error') return null;

  const learnMoreUrl = input.learnMoreUrl ?? 'https://docs.agentscore.sh/guides/agent-identity';

  if (result.kind === 'wallet_signer_mismatch') {
    const linkedWallets = result.linkedWallets ?? [];
    const userMessage = input.userMessage ?? (linkedWallets.length > 0
      ? `Sign the payment with one of the wallets linked to this operator: ${linkedWallets.join(', ')}. Then retry.`
      : 'Sign the payment with the same wallet you claimed via X-Wallet-Address, or switch to X-Operator-Token for rail-independent identity.');
    return {
      error: {
        code: 'wallet_signer_mismatch',
        message:
          'Payment signer does not match the wallet claimed via X-Wallet-Address. The signer and the claimed wallet must both resolve to the same AgentScore operator.',
      },
      claimed_operator: result.claimedOperator,
      actual_signer_operator: result.actualSignerOperator ?? null,
      expected_signer: result.expectedSigner,
      actual_signer: result.actualSigner,
      linked_wallets: linkedWallets,
      next_steps: {
        action: 'regenerate_payment_from_linked_wallet',
        user_message: userMessage,
        learn_more_url: learnMoreUrl,
      },
    };
  }

  // wallet_auth_requires_wallet_signing
  return {
    error: {
      code: 'wallet_auth_requires_wallet_signing',
      message:
        'Wallet-auth requires a payment rail that carries a wallet signature (Tempo MPP, x402). Stripe SPT and card rails have no wallet signer; switch to X-Operator-Token to use those.',
    },
    next_steps: {
      action: 'switch_to_operator_token',
      user_message:
        input.userMessage ??
        'Drop the X-Wallet-Address header and retry with X-Operator-Token (works on every payment rail).',
      learn_more_url: learnMoreUrl,
    },
  };
}

/**
 * Standard `next_steps` block for unfixable compliance denials (sanctions, age, etc.). Vendors
 * spread this into a 403 body alongside the usual `error`/`reasons` fields.
 *
 *   return c.json({
 *     error: { code: 'compliance_denied', message: '...' },
 *     reasons,
 *     next_steps: buildContactSupportNextSteps('support@martinestate.com'),
 *   }, 403);
 */
export function buildContactSupportNextSteps(
  supportEmail: string,
  message?: string,
): { action: 'contact_support'; support_email: string; user_message: string } {
  return {
    action: 'contact_support',
    support_email: supportEmail,
    user_message:
      message ??
      `If you believe this denial is in error, contact support at ${supportEmail} with your order details.`,
  };
}

export interface VerificationAgentInstructionsInput {
  /** Override the user-facing message. */
  userAction?: string;
  /** Replace the generic "Retry the original merchant request..." step with a merchant-specific
   *  one (e.g. "Retry POST /purchase with X-Operator-Token AND include order_id..."). When set,
   *  this REPLACES baseSteps[4] rather than appending — use it instead of `extraSteps[0]` when
   *  your retry instruction is a refinement of the canonical retry, not an additional step. */
  retryStep?: string;
  /** Append additional steps after the retry step. Use this for genuinely additional steps
   *  (e.g. "After payment the same call returns 200 with the order"), not for re-stating the
   *  retry — use `retryStep` for that. */
  extraSteps?: string[];
  /** Override the poll cadence. Default 5 seconds. */
  pollIntervalSeconds?: number;
  /** Override how long the agent should keep polling. Default 3600 seconds (1 hour). */
  timeoutSeconds?: number;
  /** Optional `order_ttl` note describing how long pending orders survive. */
  orderTtl?: string;
  /** Arbitrary additional fields merged into the instructions object. */
  extra?: Record<string, unknown>;
}

/**
 * The canonical `agent_instructions` block for identity-verification 403s. Tells the agent how to
 * present the verify_url, poll for the operator_token, and retry the original request. Universal
 * across every AgentScore-gated merchant — overrides let vendors add merchant-specific steps
 * (e.g. "include order_id when retrying").
 */
export function verificationAgentInstructions(input: VerificationAgentInstructionsInput = {}): {
  action: 'poll_for_credential';
  user_action: string;
  steps: string[];
  poll_interval_seconds: number;
  poll_secret_header: 'X-Poll-Secret';
  retry_token_header: 'X-Operator-Token';
  timeout_seconds: number;
  order_ttl?: string;
  [key: string]: unknown;
} {
  const baseSteps = [
    'Present the verify_url directly to the user — it is a complete, ready-to-open URL with the session token already embedded (e.g. https://agentscore.sh/verify?session=sess_...). Do NOT modify or construct the URL yourself.',
    `Immediately begin polling poll_url every ${input.pollIntervalSeconds ?? 5} seconds with header X-Poll-Secret set to poll_secret. The user will complete verification in their browser while you poll in the background.`,
    'The user visits the URL, signs in, completes identity verification (photo ID + selfie via Stripe Identity), and closes the tab. They do NOT need to copy or paste anything back to you.',
    'When your poll returns status "verified", extract operator_token from the response. This is a one-time value — save it immediately. Subsequent polls return status "consumed" without the token.',
    input.retryStep ?? 'Retry the original merchant request with header X-Operator-Token set to the operator_token value.',
  ];

  return {
    action: 'poll_for_credential',
    user_action:
      input.userAction ??
      'The user must visit verify_url to complete identity verification before this request can proceed',
    steps: input.extraSteps ? [...baseSteps, ...input.extraSteps] : baseSteps,
    poll_interval_seconds: input.pollIntervalSeconds ?? 5,
    poll_secret_header: 'X-Poll-Secret',
    retry_token_header: 'X-Operator-Token',
    timeout_seconds: input.timeoutSeconds ?? 3600,
    ...(input.orderTtl ? { order_ttl: input.orderTtl } : {}),
    ...(input.extra ?? {}),
  };
}
