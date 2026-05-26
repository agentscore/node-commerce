/**
 * Example: regulated-goods merchant showcasing the gate + denial helpers.
 *
 * Scenario: you sell something that needs identity gating; wine (age 21+,
 * US-only), cannabis (age 21+, state allowlist), high-value items (KYC +
 * sanctions). The agent needs to know how to recover from each kind of denial.
 *
 * What this example demonstrates:
 *
 * - `Checkout(gate: CheckoutGateConfig)` runs the SDK gate on the settle leg.
 * - Custom `onDenied` callback composes the canonical denial helpers:
 *     • `verificationAgentInstructions` for the poll-and-retry block
 *     • `isFixableDenial` for fixable (KYC re-do) vs unfixable (sanctions /
 *       age / jurisdiction_restricted) compliance fails. The gate auto-routes
 *       fixable reasons upstream; the fixable branch here is a defensive
 *       fallback if /v1/sessions mint blipped.
 *     • `buildContactSupportNextSteps` for the unfixable branch
 *     • `denialReasonToBody` + `denialReasonStatus` for the standard
 *       fall-through (token_expired, invalid_credential, api_error get the
 *       right status + body for free).
 * - Signer-match enforcement (wallet_signer_mismatch /
 *   wallet_auth_requires_wallet_signing) is now automatic inside the gate;
 *   consumers don't call `buildSignerMismatchBody` from inside the handler.
 *
 * Pattern: vendors only write the BUSINESS-SPECIFIC denial branches.
 * Everything else is a one-line helper call.
 *
 * Peer deps:
 *   bun add @agent-score/commerce hono
 *
 * Env vars:
 *   AGENTSCORE_API_KEY — your AgentScore API key
 *
 * Run: bun run examples/compliance-merchant.ts
 */
import {
  Checkout,
  type CheckoutContext,
  type CheckoutGateConfig,
  type DenialReason,
  type PricingResult,
  type SettleOutcome,
  type TempoRailSpec,
  buildContactSupportNextSteps,
  buildVerificationRequiredBody,
  denialReasonStatus,
  denialReasonToBody,
  getIdentityStatus,
  isFixableDenial,
  verificationAgentInstructions,
} from '@agent-score/commerce';
import { rateLimitHono } from '@agent-score/commerce/middleware/hono';
import { Hono, type Context } from 'hono';

const AGENTSCORE_API_KEY = process.env.AGENTSCORE_API_KEY!;
const SUPPORT_EMAIL = 'support@example.com';

// Vendor-specific extension of the canonical agent_instructions block.
// `retryStep` REPLACES the generic step 5; `extraSteps` adds the 402-payment
// step that comes AFTER retry.
const VERIFICATION_INSTRUCTIONS = verificationAgentInstructions({
  retryStep:
    'Retry the request with header X-Operator-Token set to the operator_token value AND ' +
    'include the order_id from this 403 in the body to resume the pending order.',
  extraSteps: [
    'The retry returns 402 Payment Required with a payment challenge. ' +
      'Pay via tempo request or agentscore-pay pay.',
  ],
  orderTtl: 'Pending orders expire after 1 hour. If the order expires, start a new request.',
});

async function _onDenied(
  _ctx: CheckoutContext,
  reason: DenialReason,
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  // missing_identity → bare 403; agent must bootstrap.
  if (reason.code === 'missing_identity') {
    return {
      status: 403,
      body: {
        ...denialReasonToBody(reason),
        error: { code: 'identity_required', message: 'Identity verification is required for this purchase.' },
      },
    };
  }

  // identity_verification_required → gate auto-minted a session. Use the
  // canonical body builder + overlay vendor-specific agent_instructions.
  if (reason.code === 'identity_verification_required') {
    return {
      status: 403,
      body: buildVerificationRequiredBody(reason, {
        message: 'Identity verification is required for this purchase.',
        agentInstructions: JSON.stringify(VERIFICATION_INSTRUCTIONS),
      }),
    };
  }

  // wallet_not_trusted = UNFIXABLE compliance fail (sanctions / age /
  // jurisdiction_restricted). The gate auto-routes fixable reasons upstream;
  // the isFixableDenial branch here is a defensive fallback.
  if (reason.code === 'wallet_not_trusted') {
    const reasons = reason.reasons ?? [];
    if (isFixableDenial(reasons)) {
      return {
        status: 403,
        body: {
          error: { code: 'compliance_recoverable', message: 'Re-verify identity and retry.' },
          reasons,
          verify_url: reason.verify_url,
        },
      };
    }
    return {
      status: 403,
      body: {
        error: {
          code: 'compliance_denied',
          message: 'Purchase denied by compliance policy. Not resolvable through re-verification.',
        },
        reasons,
        next_steps: buildContactSupportNextSteps(SUPPORT_EMAIL),
      },
    };
  }

  // token_expired (401), invalid_credential (401), api_error (503) → standard
  // body+status from commerce.
  return { status: denialReasonStatus(reason), body: denialReasonToBody(reason) };
}

async function _computePricing(_ctx: CheckoutContext): Promise<PricingResult> {
  return { amountUsd: 250.0 }; // vendor pricing logic goes here.
}

async function _onSettled(ctx: CheckoutContext, outcome: SettleOutcome): Promise<Record<string, unknown>> {
  return {
    ok: true,
    reference_id: ctx.referenceId,
    tx_hash: outcome.txHash,
    identity_status: getIdentityStatus(ctx),
  };
}

const checkout = new Checkout({
  // Minimal rails so the 402 emit path has something to advertise; vendor
  // swaps in their real rails (multi-rail, Stripe-anchored, etc.).
  rails: {
    tempo: {
      recipient: process.env.TEMPO_RECIPIENT ?? '0xfeedface',
      network: 'tempo-mainnet',
    } as TempoRailSpec,
  },
  url: 'https://api.example.com/buy',
  computePricing: _computePricing,
  onSettled: _onSettled,
  gate: {
    apiKey: AGENTSCORE_API_KEY,
    merchantName: 'Compliance Demo',
    requireKyc: true,
    requireSanctionsClear: true,
    minAge: 21,
    allowedJurisdictions: ['US'],
    onDenied: _onDenied,
  } satisfies CheckoutGateConfig,
});

const app = new Hono();
app.use('*', rateLimitHono());

app.post('/buy', (c: Context) => checkout.handleHono(c));

export default app;
