/**
 * OpenAPI snippets for AgentScore-related concepts. Vendors plug these into their own
 * OpenAPI 3.1 document (typically /openapi.json) so MPPScan and similar agent registries
 * can validate the merchant's auth + denial schemas correctly.
 *
 * Each helper returns a piece of an OpenAPI document — vendors compose them into their
 * full spec.
 */

/**
 * Standard AgentScore identity security schemes. Plug into `components.securitySchemes`.
 */
export function agentscoreSecuritySchemes(): Record<string, unknown> {
  return {
    OperatorToken: {
      type: 'apiKey',
      in: 'header',
      name: 'X-Operator-Token',
      description:
        'Operator-token-path identity (opc_...). Works on every payment rail; reusable across AgentScore merchants. If both X-Operator-Token and X-Wallet-Address are sent, this one wins.',
    },
    WalletAddress: {
      type: 'apiKey',
      in: 'header',
      name: 'X-Wallet-Address',
      description:
        'Wallet-path identity (0x... or base58). Only works on rails that carry a wallet signature (Tempo MPP, x402 EIP-3009, x402 SPL Token). The wallet you claim MUST sign the payment.',
    },
  };
}

/**
 * Standard AgentScore denial response schemas. Plug into `components.schemas` so OpenAPI
 * validators understand the 403 body shape across denial codes.
 */
export function agentscoreDenialSchemas(): Record<string, unknown> {
  return {
    AgentScoreDenialReason: {
      type: 'string',
      enum: [
        'missing_identity',
        'identity_verification_required',
        'token_expired',
        'invalid_credential',
        'wallet_signer_mismatch',
        'wallet_auth_requires_wallet_signing',
        'wallet_not_trusted',
        'api_error',
        'payment_required',
      ],
      description:
        "Denial code emitted by AgentScore's gate middleware in 403 responses. Every code carries a structured agent_instructions block describing recovery actions (per-code action: missing_identity → probe_identity_then_session, identity_verification_required / token_expired → deliver_verify_url_and_poll, invalid_credential → switch_token_or_restart_session, wallet_signer_mismatch → resign_or_switch_to_operator_token, wallet_auth_requires_wallet_signing → switch_to_operator_token, wallet_not_trusted → contact_support — UNFIXABLE compliance only (sanctions/age/jurisdiction_restricted); fixable reasons re-route to identity_verification_required, payment_required → contact_merchant).",
    },
    AgentScoreDenialBody: {
      type: 'object',
      properties: {
        error: { $ref: '#/components/schemas/AgentScoreDenialReason' },
        agent_instructions: {
          type: 'string',
          description:
            'JSON-encoded { action, steps, user_message } block. Always present on every denial; agents parse this to learn how to recover (e.g., poll verify_url, switch headers, re-sign).',
        },
        verify_url: { type: 'string', format: 'uri', description: "Present for missing_identity / identity_verification_required / token_expired denials. Agent shares this with the user to complete KYC or claim a wallet. Not present on wallet_not_trusted (UNFIXABLE compliance — re-verification won't change the outcome)." },
        session_id: { type: 'string' },
        poll_url: { type: 'string', format: 'uri' },
        poll_secret: { type: 'string' },
        agent_memory: { type: 'object', description: 'Cross-merchant pattern hint emitted on first-encounter denials.' },
      },
      required: ['error', 'agent_instructions'],
    },
  };
}

/**
 * Standard 402 PaymentRequired body schema (for AgentScore-extended 402 responses).
 * Includes the rails, identity metadata, agent_instructions, pricing, and x402-compliance
 * fields a typical merchant emits via build402Body.
 */
export function agentscorePaymentRequiredSchema(): Record<string, unknown> {
  return {
    AgentScorePaymentRequired: {
      type: 'object',
      properties: {
        payment_required: { type: 'boolean', enum: [true] },
        x402Version: { type: 'integer', enum: [1, 2] },
        accepts: { type: 'array', items: { type: 'object' }, description: 'x402 PaymentRequired.accepts entries.' },
        accepted_methods: {
          type: 'array',
          items: { type: 'object' },
          description: 'MPP method entries (tempo/charge, x402/exact, stripe/charge, ...).',
        },
        amount_usd: { type: 'string' },
        currency: { type: 'string' },
        pricing: {
          type: 'object',
          properties: {
            subtotal: { type: 'string' },
            tax: { type: 'string' },
            tax_rate: { type: 'number' },
            tax_state: { type: 'string' },
            total: { type: 'string' },
          },
        },
        identity_mode: { type: 'string', enum: ['wallet', 'operator_token'] },
        required_signer: { type: 'string' },
        linked_wallets: { type: 'array', items: { type: 'string' } },
        signer_constraint: { type: 'string' },
        agent_instructions: { type: 'object' },
        agent_memory: { type: 'object' },
      },
    },
  };
}

export interface BuildAgentScoreOpenApiSnippetsInput {
  /** Include security schemes in the snippet. Default true. */
  security?: boolean;
  /** Include denial schemas in the snippet. Default true. */
  denials?: boolean;
  /** Include the 402 PaymentRequired schema in the snippet. Default true. */
  paymentRequired?: boolean;
}

/**
 * Convenience: returns a `components` snippet ready to merge into an OpenAPI document.
 *
 *   const spec = {
 *     openapi: '3.1.0',
 *     info: { title: 'My Merchant API', version: '1.0' },
 *     paths: {...},
 *     components: { ...agentscoreOpenApiSnippets(), schemas: { ...mySchemas, ...agentscoreOpenApiSnippets().schemas } },
 *   };
 *
 * Or more idiomatically: `Object.assign(spec.components, agentscoreOpenApiSnippets())`.
 */
export function agentscoreOpenApiSnippets(
  opts: BuildAgentScoreOpenApiSnippetsInput = {},
): { securitySchemes?: Record<string, unknown>; schemas?: Record<string, unknown> } {
  const out: { securitySchemes?: Record<string, unknown>; schemas?: Record<string, unknown> } = {};
  if (opts.security !== false) {
    out.securitySchemes = agentscoreSecuritySchemes();
  }
  if (opts.denials !== false || opts.paymentRequired !== false) {
    out.schemas = {
      ...(opts.denials !== false ? agentscoreDenialSchemas() : {}),
      ...(opts.paymentRequired !== false ? agentscorePaymentRequiredSchema() : {}),
    };
  }
  return out;
}
