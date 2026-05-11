/**
 * Example: regulated-goods merchant showcasing the gate + denial helpers
 *
 * Scenario: you sell something that needs identity gating — wine (age 21+, US-only),
 * cannabis (age 21+, state allowlist), high-value items (KYC + sanctions). The agent
 * needs to know how to recover from each kind of denial.
 *
 * What this example demonstrates:
 *   - `agentscoreGate` with full compliance policy (KYC + sanctions + age + jurisdiction)
 *   - `createSessionOnMissing` with `getSessionOptions` + `onBeforeSession` hooks for
 *     per-product session context + pre-create-pending-order recovery flow
 *   - Custom `onDenied` that composes commerce helpers:
 *     • `verificationAgentInstructions` for the canonical poll-and-retry instructions
 *     • `isFixableDenial` defensive fallback for fixable (KYC re-do) vs unfixable (sanctions/age/jurisdiction_restricted) compliance fails. Gate normally re-routes fixable reasons to identity_verification_required upstream — this branch only fires if the /v1/sessions mint blipped.
 *     • `buildContactSupportNextSteps` for the unfixable branch
 *     • `denialReasonToBody` + `denialReasonStatus` for the standard fall-through (token_expired,
 *       invalid_credential, api_error get the right status + body for free)
 *   - `verifyWalletSignerMatch` + `buildSignerMismatchBody` for wallet-auth signer verification
 *
 * The pattern: vendors only write the BUSINESS-SPECIFIC denial branches (custom message for
 * compliance_denied, custom recovery flow for missing_identity). Everything else is a
 * one-line helper call.
 *
 * Peer deps:
 *   bun add @agent-score/commerce hono
 *
 * Env vars:
 *   AGENTSCORE_API_KEY — your API key from agentscore.sh/dashboard
 *
 * Run: bun run examples/compliance-merchant.ts
 */
import {
  agentscoreGate,
  buildContactSupportNextSteps,
  buildSignerMismatchBody,
  denialReasonStatus,
  denialReasonToBody,
  getAgentScoreData,
  isFixableDenial,
  verificationAgentInstructions,
  verifyWalletSignerMatch,
} from '@agent-score/commerce/identity/hono';
import { Hono } from 'hono';

const app = new Hono();
const SUPPORT_EMAIL = 'support@example.com';

// Vendor-specific extension of the canonical agent_instructions block. The commerce default
// covers steps 1-4 (present verify_url, poll, user verifies, extract token) plus a generic
// "retry the original merchant request" at step 5. `retryStep` REPLACES that generic step 5
// with our merchant-specific retry (include order_id to resume the pending order). `extraSteps`
// adds the genuinely-additional 402-payment step that comes AFTER retry.
const VERIFICATION_INSTRUCTIONS = verificationAgentInstructions({
  retryStep:
    'Retry the request with header X-Operator-Token set to the operator_token value AND include the order_id from this 403 in the body to resume the pending order.',
  extraSteps: [
    'The retry returns 402 Payment Required with a payment challenge. Pay via tempo request or agentscore-pay pay.',
  ],
  orderTtl: 'Pending orders expire after 1 hour. If the order expires, start a new request.',
});

// Gate runs CONDITIONALLY — only when a payment credential is already attached.
// Anonymous discovery (no payment header) is allowed through to the handler so the
// agent gets a real 402 challenge with rails + pricing without an account. The full
// compliance check (KYC + sanctions + age + jurisdiction) fires on the retry leg when
// the agent submits X-Payment / Authorization: Payment. createSessionOnMissing still
// auto-mints a verification session if identity is absent at settle time so the agent
// can bootstrap KYC and replay the same payment authorization within its TTL window.
const _complianceGate = agentscoreGate({
  apiKey: process.env.AGENTSCORE_API_KEY!,
  requireKyc: true,
  requireSanctionsClear: true,
  minAge: 21,
  allowedJurisdictions: ['US'],
  createSessionOnMissing: {
    apiKey: process.env.AGENTSCORE_API_KEY!,
    context: 'regulated_purchase',
    // Per-request session context — tells the verify page WHAT product the agent was buying.
    getSessionOptions: async (c) => {
      const body = await c.req.json().catch(() => ({}));
      return { productName: body.product_name ?? 'a regulated good' };
    },
    // Pre-create a pending order so the agent can resume after KYC by sending {operator_token, order_id}.
    onBeforeSession: async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const orderId = await yourDb.insertPendingOrder({ product_id: body.product_id });
      return { order_id: orderId };  // appears in the 403 body
    },
  },
  onDenied: (c, reason) => {
      // missing_identity → bare 403 (no auto-session created — agent must bootstrap).
      if (reason.code === 'missing_identity') {
        return c.json({
          error: { code: 'identity_required', message: 'Identity verification is required for this purchase.' },
          ...denialReasonToBody(reason),  // includes agent_instructions + agent_memory from gate
        }, 403);
      }

      // identity_verification_required → gate auto-minted a session. Overlay vendor-specific
      // agent_instructions on top of the commerce body.
      if (reason.code === 'identity_verification_required') {
        return c.json({
          ...denialReasonToBody(reason),
          agent_instructions: VERIFICATION_INSTRUCTIONS,
        }, 403);
      }

      // wallet_not_trusted = UNFIXABLE compliance fail (sanctions / age / jurisdiction_restricted).
      // The gate auto-routes fixable reasons (kyc_required / kyc_pending / kyc_failed) to
      // identity_verification_required upstream — by the time onDenied sees wallet_not_trusted,
      // the reasons should be unfixable. The isFixableDenial branch below is a defensive
      // fallback in case the gate's /v1/sessions mint blipped and fell back to bare denial.
      if (reason.code === 'wallet_not_trusted') {
        const reasons = reason.reasons ?? [];
        if (isFixableDenial(reasons)) {
          // Defensive: gate normally bootstraps these into identity_verification_required.
          // If we hit this branch, the gate's /v1/sessions mint failed — surface verify_url
          // so the agent can recover via the manual session flow.
          return c.json({
            error: { code: 'compliance_recoverable', message: 'Re-verify identity and retry.' },
            reasons,
            verify_url: reason.verify_url,
          }, 403);
        }
        return c.json({
          error: { code: 'compliance_denied', message: 'Purchase denied by compliance policy. Not resolvable through re-verification.' },
          reasons,
          next_steps: buildContactSupportNextSteps(SUPPORT_EMAIL),
        }, 403);
      }

      // token_expired (401), invalid_credential (401), api_error (503) → standard body+status
      // from commerce. Vendors get the right shape for free.
      return c.json(denialReasonToBody(reason), denialReasonStatus(reason));
    },
});

// Conditional wrapper — fires the gate only when a payment header is present so anonymous
// discovery can return a 402 challenge without an account.
const complianceGateOnSettle: import('hono').MiddlewareHandler = async (c, next) => {
  const hasPaymentHeader = Boolean(
    c.req.header('payment-signature') ||
    c.req.header('x-payment') ||
    c.req.header('authorization')?.startsWith('Payment '),
  );
  if (!hasPaymentHeader) { await next(); return; }
  return _complianceGate(c, next);
};

app.post(
  '/buy',
  complianceGateOnSettle,
  async (c) => {
    const data = getAgentScoreData(c);

    // Wallet-auth: verify the payment signer matches the claimed wallet (or a same-operator
    // linked wallet). Skips for operator_token requests. Replace the inline signer-extraction
    // with extractPaymentSigner from commerce/payment for real x402/MPP credentials.
    const signerMatch = await verifyWalletSignerMatch(c);
    const mismatchBody = buildSignerMismatchBody({ result: signerMatch });
    if (mismatchBody) return c.json(mismatchBody, 403);

    // Compliance + signer-match passed. Run the actual purchase.
    return c.json({ ok: true, identity_method: data?.identity_method });
  },
);

// Stub so the file compiles standalone. Real merchants wire to Postgres / etc.
const yourDb = {
  insertPendingOrder: async (_args: { product_id: string }): Promise<string> => 'ord_stub',
};

export default app;
