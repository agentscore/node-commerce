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
 *     • `isFixableDenial` to branch fixable (KYC re-do) vs unfixable (sanctions/age) compliance fails
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
// covers steps 1-5 (present verify_url, poll, extract token, retry). We append steps 6-7
// describing how to RESUME a pending order with order_id + complete the eventual 402 payment.
const VERIFICATION_INSTRUCTIONS = verificationAgentInstructions({
  extraSteps: [
    'Retry the request with header X-Operator-Token set to the operator_token value AND include the order_id from this 403 in the body to resume the pending order.',
    'The retry returns 402 Payment Required with a payment challenge. Pay via tempo request or agentscore-pay pay.',
  ],
  orderTtl: 'Pending orders expire after 1 hour. If the order expires, start a new request.',
});

app.post(
  '/buy',
  agentscoreGate({
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

      // wallet_not_trusted = compliance fail. Branch on fixable vs not — fixable (KYC pending/
      // failed/required, jurisdiction) gets a fresh session; unfixable (sanctions, age) gets
      // contact-support.
      if (reason.code === 'wallet_not_trusted') {
        const reasons = reason.reasons ?? [];
        if (isFixableDenial(reasons)) {
          // In a real merchant: mint a new session for retry. Skipped here for brevity.
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
  }),
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
