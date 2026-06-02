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
 *
 * Includes `siwx` (Sign-In With X) per the x402scan discovery spec so identity-gated
 * operations can declare `security: [{ siwx: [] }]` and stay classified as identity-only,
 * not paid.
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
    AgentIdentity: {
      type: 'apiKey',
      in: 'header',
      name: 'Agent-Identity',
      description:
        'AIP Agent Identity Token path (a JWT from a trusted issuer; AgentScore is always trusted). Opt-in. The token is bound to the agent key via `cnf`; the request MUST also carry an RFC 9421 HTTP Message Signature (`Signature-Input` + `Signature` over `@method @authority @path agent-identity`, tag `agent-identity`) proving possession. A verified AIT is the sole identity and is evaluated against the merchant policy via its attested claims.',
    },
    siwx: siwxSecurityScheme(),
  };
}

/**
 * Sign-In With X security scheme entry, per the x402scan discovery spec.
 *
 * Reference it on identity-gated (but free) operations as
 * `security: [{ siwx: [] }]`. Do NOT also attach `x-payment-info` to those routes,
 * x402scan will misclassify them as paid.
 */
export function siwxSecurityScheme(): Record<string, unknown> {
  return {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'SIWX',
    description:
      'Sign-In With X wallet authentication. Agent signs a challenge with their wallet (any supported chain) and presents the proof in the Authorization header. Used for identity-gated free endpoints; payment-required endpoints declare x-payment-info instead.',
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

/**
 * Per-operation `x-payment-info` extension, per the x402scan discovery spec.
 *
 * Every payment-required OpenAPI operation should carry this block alongside a
 * 402 response. Tells discovery crawlers (x402scan, agent CLIs) the static price
 * and which protocols the route accepts. Runtime 402 behavior is authoritative
 * over this static metadata; the static side is for indexability.
 *
 * @example fixed price across x402 + MPP Tempo
 * ```ts
 * Object.assign(operation, {
 *   ...xPaymentInfoExtension({
 *     price: { mode: 'fixed', currency: 'USD', amount: '0.10' },
 *     protocols: [
 *       { x402: {} },
 *       { mpp: { method: 'tempo/charge', intent: 'pay', currency: 'USD' } },
 *     ],
 *   }),
 *   responses: {
 *     '200': {...},
 *     '402': { description: 'Payment Required' },
 *   },
 * });
 * ```
 */
export interface XPaymentInfoFixedPrice {
  mode: 'fixed';
  currency: string;
  amount: string;
}

export interface XPaymentInfoDynamicPrice {
  mode: 'dynamic';
  currency: string;
  min: string;
  max: string;
}

export type XPaymentInfoPrice = XPaymentInfoFixedPrice | XPaymentInfoDynamicPrice;

export interface XPaymentInfoX402Protocol {
  x402: Record<string, unknown>;
}

export interface XPaymentInfoMppProtocol {
  mpp: { method: string; intent: string; currency?: string; [key: string]: unknown };
}

export type XPaymentInfoProtocol = XPaymentInfoX402Protocol | XPaymentInfoMppProtocol;

export interface XPaymentInfoBlock {
  authMode: 'payment';
  price: XPaymentInfoPrice;
  protocols: XPaymentInfoProtocol[];
  description?: string;
}

export function xPaymentInfoExtension({
  price,
  protocols,
  description,
}: {
  price: XPaymentInfoPrice;
  protocols: XPaymentInfoProtocol[];
  description?: string;
}): { 'x-payment-info': XPaymentInfoBlock } {
  return {
    'x-payment-info': {
      authMode: 'payment',
      price,
      protocols,
      ...(description !== undefined && { description }),
    },
  };
}

/**
 * `info.x-guidance` extension, per the x402scan discovery spec. Spread into your
 * OpenAPI document's `info` block to give agents a high-level prose description
 * of how to use the API. Discovery crawlers surface this on the listing page.
 *
 * @example
 * ```ts
 * const spec = {
 *   openapi: '3.1.0',
 *   info: {
 *     title: 'My Merchant API',
 *     version: '1.0',
 *     ...xGuidanceExtension('Wine merchant. POST /purchase with a verified operator token...'),
 *   },
 * };
 * ```
 */
export function xGuidanceExtension(text: string): { 'x-guidance': string } {
  return { 'x-guidance': text };
}

/**
 * `x-service-info` extension for the OpenAPI document's root. Discovery
 * crawlers (x402scan, agent CLIs) read this to categorize the service and
 * follow links to human-side docs. Spread into the OpenAPI doc's root
 * alongside `paths`, `info`, etc.
 *
 * @example
 * ```ts
 * const spec = {
 *   openapi: '3.1.0',
 *   info: {...},
 *   ...xServiceInfoExtension({
 *     categories: ['commerce', 'wine'],
 *     docs: { homepage: 'https://www.martinestate.com', llms: 'https://agents.martinestate.com/llms.txt' },
 *   }),
 *   paths: {...},
 * };
 * ```
 */
export function xServiceInfoExtension(opts: {
  categories: string[];
  docs?: Record<string, string>;
}): { 'x-service-info': { categories: string[]; docs?: Record<string, string> } } {
  return {
    'x-service-info': {
      categories: opts.categories,
      ...(opts.docs !== undefined && { docs: opts.docs }),
    },
  };
}

/**
 * Derive an `x-payment-info` extension from a configured `Checkout` instance.
 *
 * Walks `checkout.rails` and emits one entry in `protocols[]` per rail —
 * Tempo MPP, x402 (Base), Solana MPP, Stripe SPT. Saves merchants from
 * enumerating protocols by hand and keeps the OpenAPI doc in sync with the
 * actual rails the Checkout serves.
 *
 * `price` is merchant-supplied (the rail registry doesn't carry per-merchant
 * pricing; rates live on each Checkout's `computePricing` hook). Per-rail
 * extras (client commands, asset names) can be merged via `protocolExtras`
 * keyed by rail slug (`tempo`, `base`, `solana`, `stripe`).
 */
export function xPaymentInfoFromCheckout(opts: {
  checkout: {
    rails: Record<
      string,
      { network?: string; recipient?: unknown; currency?: unknown; token?: unknown; profileId?: unknown }
    >;
  };
  price: XPaymentInfoPrice;
  description?: string;
  protocolExtras?: Partial<{
    tempo: Record<string, unknown>;
    base: Record<string, unknown>;
    solana: Record<string, unknown>;
    stripe: Record<string, unknown>;
  }>;
}): { 'x-payment-info': XPaymentInfoBlock } {
  const protocols: XPaymentInfoProtocol[] = [];
  const extras = opts.protocolExtras ?? {};
  for (const spec of Object.values(opts.checkout.rails)) {
    const isStripe = !('recipient' in spec);
    const network = typeof spec.network === 'string' ? spec.network : '';
    // MPP protocols emit `currency` = on-chain token contract (Tempo USDC.e
    // address, Solana USDC mint). `spec.currency` wins when set explicitly;
    // `spec.token` is the RailSpec canonical name and is the typical source.
    const tokenCurrency =
      (typeof spec.currency === 'string' ? spec.currency : '') ||
      (typeof spec.token === 'string' ? spec.token : '');
    if (isStripe) {
      protocols.push({ mpp: { method: 'stripe', intent: 'charge', currency: 'usd', ...(extras.stripe ?? {}) } });
    } else if (network.startsWith('eip155:')) {
      protocols.push({
        x402: {
          scheme: 'exact',
          network: 'base',
          asset: 'USDC',
          ...(extras.base ?? {}),
        },
      });
    } else if (network.startsWith('solana:')) {
      // Per MPP solana/charge spec (paymentauth.org/draft-solana-charge-00):
      // `currency` = SPL mint address (base58) for tokens, `"sol"` for native.
      // No `asset` field in the spec — token symbols are not part of the
      // discovery contract.
      protocols.push({
        mpp: {
          method: 'solana',
          intent: 'charge',
          ...(tokenCurrency ? { currency: tokenCurrency } : {}),
          ...(extras.solana ?? {}),
        },
      });
    } else {
      protocols.push({
        mpp: {
          method: 'tempo',
          intent: 'charge',
          ...(tokenCurrency ? { currency: tokenCurrency } : {}),
          ...(extras.tempo ?? {}),
        },
      });
    }
  }
  return xPaymentInfoExtension({
    price: opts.price,
    protocols,
    ...(opts.description !== undefined && { description: opts.description }),
  });
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
export function agentscoreOpenApiSnippets({
  security = true,
  denials = true,
  paymentRequired = true,
}: {
  /** Include security schemes in the snippet. Default true. */
  security?: boolean;
  /** Include denial schemas in the snippet. Default true. */
  denials?: boolean;
  /** Include the 402 PaymentRequired schema in the snippet. Default true. */
  paymentRequired?: boolean;
} = {}): { securitySchemes?: Record<string, unknown>; schemas?: Record<string, unknown> } {
  const out: { securitySchemes?: Record<string, unknown>; schemas?: Record<string, unknown> } = {};
  if (security) {
    out.securitySchemes = agentscoreSecuritySchemes();
  }
  if (denials || paymentRequired) {
    out.schemas = {
      ...(denials ? agentscoreDenialSchemas() : {}),
      ...(paymentRequired ? agentscorePaymentRequiredSchema() : {}),
    };
  }
  return out;
}
