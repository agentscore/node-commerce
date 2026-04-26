import type { AcceptedMethodEntry } from './accepted_methods';
import type { AgentInstructions } from './agent_instructions';
import type { IdentityMetadataBlock } from './identity';
import type { PricingBlock as _PricingBlock } from './pricing';

// PricingBlock has moved to ./pricing — re-exported here for backwards compat.
// Future code should import from `@agent-score/commerce/challenge` (or `./pricing`).
export type { PricingBlock } from './pricing';

export interface Build402BodyInput {
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
  };
  /** Vendor-specific extra fields merged at the top level. */
  extra?: Record<string, unknown>;
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
export function build402Body(input: Build402BodyInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    payment_required: true,
    accepted_methods: input.acceptedMethods,
  };

  if (input.x402) {
    body.x402Version = input.x402.version ?? 1;
    body.accepts = input.x402.accepts;
  }

  if (input.amountUsd !== undefined) body.amount_usd = input.amountUsd;
  if (input.currency) body.currency = input.currency;
  if (input.pricing) body.pricing = input.pricing;
  if (input.orderId !== undefined) body.order_id = input.orderId;
  if (input.product) body.product = input.product;
  if (input.recommended) body.recommended = input.recommended;
  if (input.retryBody !== undefined) body.retry_body = input.retryBody;

  if (input.identityMetadata) {
    Object.assign(body, input.identityMetadata);
  }

  if (input.agentInstructions) body.agent_instructions = input.agentInstructions;
  if (input.agentMemory !== undefined) body.agent_memory = input.agentMemory;

  if (input.extra) Object.assign(body, input.extra);

  return body;
}
