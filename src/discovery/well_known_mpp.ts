export interface PaymentMethodConfig {
  /** MPP payment methods accepted, e.g., ['tempo', 'x402', 'stripe']. */
  methods: string[];
  /** x402-specific config (when 'x402' is in methods). */
  x402?: {
    networks: string[];
    scheme?: string;
    asset?: string;
    facilitator?: string;
    client_tooling?: string;
  };
  /** Identity headers accepted (e.g., ['X-Operator-Token', 'X-Wallet-Address']). */
  identity?: string[];
  /** Per-identity-path metadata for agents. */
  identity_paths?: {
    wallet?: { header: string; applies_to_rails: string[]; note?: string };
    operator_token?: { header: string; applies_to_rails: string[]; note?: string };
  };
  /** Compliance policy summary for agents to know what they need before purchasing. */
  compliance?: {
    require_kyc?: boolean;
    min_age?: number;
    allowed_jurisdictions?: string[];
    require_sanctions_clear?: boolean;
  };
  /** Required fields in the request body. */
  required_fields?: string[];
  /** Optional fields in the request body. */
  optional_fields?: string[];
  /** Vendor-specific extras merged into the purchase block (e.g., gift_note metadata). */
  extra?: Record<string, unknown>;
}

export interface WellKnownMppInput {
  /** Merchant display name. */
  name: string;
  /** Short description (1-2 sentences). */
  description?: string;
  /** Canonical merchant URL. */
  url: string;
  /** OpenAPI doc URL (typically `${url}/openapi.json`). */
  openapi?: string;
  /** Endpoints map: path → {method, url}. */
  endpoints: Record<string, { method: string; url: string }>;
  /** Catalog metadata (categories, etc). Optional. */
  catalog?: Record<string, unknown>;
  /** Purchase flow details (payment methods, identity, compliance). */
  purchase: PaymentMethodConfig;
  /** Shipping policy (countries, restrictions). */
  shipping?: Record<string, unknown>;
  /** Vendor-specific extra fields merged at the top level. */
  extra?: Record<string, unknown>;
}

/**
 * Build the standard `.well-known/mpp.json` discovery document. Lift the boilerplate
 * (payment.methods, payment.identity_paths, payment.compliance) into a typed config so
 * vendors get spec-compliance "for free"; merchant-specific fields (catalog, shipping)
 * pass through.
 *
 * Wire it in your framework like:
 *   app.get('/.well-known/mpp.json', (c) => c.json(buildWellKnownMpp({...})));
 */
export function buildWellKnownMpp(input: WellKnownMppInput): Record<string, unknown> {
  return {
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    url: input.url,
    ...(input.openapi ? { openapi: input.openapi } : {}),
    endpoints: input.endpoints,
    ...(input.catalog ? { catalog: input.catalog } : {}),
    purchase: {
      ...(input.purchase.required_fields ? { required_fields: input.purchase.required_fields } : {}),
      ...(input.purchase.optional_fields ? { optional_fields: input.purchase.optional_fields } : {}),
      ...(input.purchase.extra ?? {}),
      ...(input.purchase.identity ? { identity: input.purchase.identity } : {}),
      ...(input.purchase.identity_paths ? { identity_paths: input.purchase.identity_paths } : {}),
      payment_methods: input.purchase.methods,
      ...(input.purchase.x402 ? { x402: input.purchase.x402 } : {}),
      ...(input.purchase.compliance ? { compliance: input.purchase.compliance } : {}),
    },
    ...(input.shipping ? { shipping: input.shipping } : {}),
    ...(input.extra ?? {}),
  };
}
