import type { AcceptedMethodEntry } from './accepted_methods';
import type { AgentInstructions } from './agent_instructions';
import type { IdentityMetadataBlock } from './identity';
import type { PricingBlock as _PricingBlock } from './pricing';

export type { PricingBlock } from './pricing';

/**
 * x402 v2 `ResourceInfo`: resource metadata surfaced on the 402 body (and the
 * PAYMENT-REQUIRED header) so spec-compliant crawlers and discovery clients can
 * read what the paid resource is. Mirrors `@x402/core`'s `ResourceInfoSchema`.
 */
export interface X402ResourceInfo {
  /** Canonical URL of the paid resource. */
  url: string;
  /** Human-readable description of what the resource returns. */
  description?: string;
  /** MIME type of the response (e.g. 'application/json'). */
  mimeType?: string;
  /** Short service name (max 32 printable-ASCII chars). */
  serviceName?: string;
  /** Up to 5 capability tags (max 32 printable-ASCII chars each). */
  tags?: string[];
  /** Icon URL (max 2048 chars). */
  iconUrl?: string;
}

/**
 * Assemble the full enriched 402 response body. Combines accepted_methods, agent_instructions,
 * identity metadata, pricing, x402 compliance fields, and any vendor-specific extras into a
 * single object suitable for `JSON.stringify`. Vendors pass only what they have; the builder
 * conditionally includes each section.
 *
 * Pair this with a Response that sets:
 *   - 'content-type: application/json'
 *   - 'www-authenticate: <wwwAuthenticateHeader([...])>' from `payment/wwwauthenticate`
 *   - 'PAYMENT-REQUIRED: <paymentRequiredHeader({...})>' for x402 clients
 */
export function build402Body({
  acceptedMethods,
  agentInstructions,
  identityMetadata,
  agentMemory,
  pricing,
  amountUsd,
  currency,
  orderId,
  product,
  retryBody,
  recommended,
  x402,
  extra,
}: {
  /** From buildAcceptedMethods — list of MPP method entries. */
  acceptedMethods: AcceptedMethodEntry[];
  /** From buildAgentInstructions — wraps how_to_pay + warnings + recommended_tools. */
  agentInstructions?: AgentInstructions;
  /** From buildIdentityMetadata — wallet-mode echoer. Spread into the body when present. */
  identityMetadata?: IdentityMetadataBlock;
  /** Cross-merchant agent_memory hint (from gate). */
  agentMemory?: unknown;
  /** Pricing breakdown. */
  pricing?: _PricingBlock;
  /** Total amount in USD as a string (e.g., '250.00'). */
  amountUsd?: string;
  /** Currency code. Default 'USD'. */
  currency?: string;
  /** Order id for retry correlation. */
  orderId?: string | null;
  /** Product info — surfaced on the 402 so agents can confirm what they're buying. */
  product?: { id: string; name: string };
  /** The body the agent should retry with after payment (e.g., the original request body). */
  retryBody?: unknown;
  /** Recommended rail — agent's default if multiple are listed. */
  recommended?: string;
  /** x402-compliance fields (paired with the PAYMENT-REQUIRED header from `payment/wwwauthenticate`). */
  x402?: {
    accepts: unknown[];
    version?: 1 | 2;
    /** x402 v2 `resource` field: resource metadata (url + serviceName / tags /
     *  description / mimeType / iconUrl). Surfaces on the 402 body as `resource`
     *  so spec-compliant crawlers and discovery clients can read what's sold. */
    resource?: X402ResourceInfo;
    /** x402 spec `extensions` field. Per-endpoint declared extensions (e.g.
     *  `bazaar` discovery schema from `createBazaarDiscovery({...})`). Surfaces
     *  on the 402 body as `extensions` so spec-compliant crawlers can read it. */
    extensions?: Record<string, unknown>;
  };
  /** Vendor-specific extra fields merged at the top level. */
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    payment_required: true,
    accepted_methods: acceptedMethods,
  };

  if (x402) {
    body.x402Version = x402.version ?? 2;
    body.accepts = x402.accepts;
    if (x402.resource !== undefined) body.resource = x402.resource;
    if (x402.extensions !== undefined && Object.keys(x402.extensions).length > 0) {
      body.extensions = x402.extensions;
    }
  }

  if (amountUsd !== undefined) body.amount_usd = amountUsd;
  if (currency) body.currency = currency;
  if (pricing) body.pricing = pricing;
  if (orderId !== undefined) body.order_id = orderId;
  if (product) body.product = product;
  if (recommended) body.recommended = recommended;
  if (retryBody !== undefined) body.retry_body = retryBody;

  if (identityMetadata) {
    Object.assign(body, identityMetadata);
  }

  if (agentInstructions) body.agent_instructions = agentInstructions;
  if (agentMemory !== undefined) body.agent_memory = agentMemory;

  if (extra) Object.assign(body, extra);

  return body;
}
