/**
 * Google A2A (Agent-to-Agent) Signed Agent Cards builder.
 *
 * Compose the JSON payload for an A2A v1.0 Signed Agent Card that includes the
 * agent's AgentScore identity claims. Returned object is the unsigned card body —
 * the merchant (or agent) signs it with their wallet / signing key before publishing.
 *
 * Why publish: A2A is a Linux Foundation standard with 150+ orgs (Microsoft, AWS,
 * Salesforce in production). Signed Agent Cards let any A2A-compatible reader discover
 * an agent's verified-identity claims without per-platform integration. AgentScore
 * publishing operator identity in this format means our identity travels with the agent
 * across A2A-aware ecosystems.
 *
 * Spec reference: https://a2a-protocol.org/latest/
 */

import type { AgentScoreData } from '../core';

export interface A2AAgentCardCapabilities {
  /** Endpoints the agent exposes — `[{ name: "purchase", path: "/purchase", method: "POST" }, ...]`. */
  endpoints?: { name: string; path?: string; method?: string }[];
  /** Free-form skill tags — `["product-purchase", "regulated-commerce", ...]`. */
  skills?: string[];
}

/** Per A2A v1.0: an entry in the card's top-level `extensions` array. UCP support
 *  is declared this way (UCP §A2A binding requires `https://ucp.dev/2026-04-08/specification/reference`). */
export interface A2AAgentCardExtension {
  /** Canonical extension URI — for UCP, `https://ucp.dev/2026-04-08/specification/reference`. */
  uri: string;
  /** Extension-specific params. UCP places `{ capabilities: { "<reverse-dns>": [{ version: "..." }, ...] } }` here. */
  params?: Record<string, unknown>;
}

/** Canonical UCP A2A extension URI — verifiers look for this exact URI in `extensions[]`
 *  to detect UCP support on the agent card. Pinned to the 2026-04-08 spec snapshot. */
export const UCP_A2A_EXTENSION_URI = 'https://ucp.dev/2026-04-08/specification/reference';

/** Build the canonical UCP entry for an A2A agent card's `extensions[]` array.
 *
 *  Per UCP §A2A binding: "Businesses supporting UCP must advertise the extension and
 *  any optional capabilities in their A2A Agent Card to allow platforms to activate
 *  the extension." Pass the `capabilities` map keyed by reverse-DNS service/capability
 *  name (e.g. `dev.ucp.shopping.checkout`), each value a list of `{ version }` records.
 *  Pass `{}` (or omit) when you serve UCP at the discovery layer but have no formal
 *  capability bindings yet — vendors that haven't implemented checkout/cart/etc. should
 *  declare the extension URI without claiming capabilities they don't service.
 */
export function ucpA2AExtension(
  capabilities: Record<string, Array<{ version: string }>> = {},
): A2AAgentCardExtension {
  return {
    uri: UCP_A2A_EXTENSION_URI,
    params: { capabilities },
  };
}

export interface A2AAgentCardIdentity {
  /** Issuer of the identity claims — always `"https://agentscore.sh"` for the AgentScore-issued card. */
  issuer: string;
  /** Operator id under AgentScore. */
  operator_id: string;
  /** KYC tier. */
  kyc_level: string;
  /** Sanctions screening result. */
  sanctions_clear: boolean;
  /** Age bracket. */
  age_bracket: string;
  /** Jurisdiction (ISO-3166-1 alpha-2 or empty). */
  jurisdiction: string;
  /** ISO-8601 timestamp of last verification refresh. */
  verified_at: string | null;
  /** Verify URL where the identity was minted. */
  verify_url: string;
}

export interface A2AAgentCard {
  /** A2A protocol version. v1.0 was donated to Linux Foundation. */
  protocol_version: string;
  /** Card schema version (this builder emits v1). */
  card_version: number;
  /** Agent's display name. */
  name: string;
  /** One-line description shown to A2A consumers. */
  description?: string;
  /** Agent's canonical URL (homepage, Discord, repo, etc.). */
  url?: string;
  /** Agent capabilities — endpoints + skills. */
  capabilities?: A2AAgentCardCapabilities;
  /** A2A v1.0 extensions array. Use `ucpA2AExtension()` to add the UCP entry. */
  extensions?: A2AAgentCardExtension[];
  /** AgentScore identity claims. Empty `null` when no identity is available (pre-KYC). */
  identity: A2AAgentCardIdentity | null;
  /** Vendor-specific extras merged at the top level. */
  extras?: Record<string, unknown>;
}

export interface BuildA2AAgentCardInput {
  /** Display name for the agent — e.g. a merchant brand or service name. */
  name: string;
  /** Optional one-line description. */
  description?: string;
  /** Agent's canonical URL. */
  url?: string;
  /** Capabilities — endpoints exposed + skill tags. */
  capabilities?: A2AAgentCardCapabilities;
  /** A2A v1.0 extensions to declare on the card. Build the UCP entry with
   *  `ucpA2AExtension()`. Other A2A extensions can be added the same way. */
  extensions?: A2AAgentCardExtension[];
  /** AgentScore assess data — what `getAgentScoreData(c)` returns or what `assess()` returned directly.
   *  Pass `null` to emit a card with no identity claims (publishable but unverified). */
  data?: AgentScoreData | null;
  /** Override the default issuer URL. Default `"https://agentscore.sh"`. */
  issuer?: string;
  /** Override the verify URL. */
  verifyUrl?: string;
  /** Vendor-specific extras merged at the card top level. */
  extras?: Record<string, unknown>;
}

const PROTOCOL_VERSION = '1.0';
const CARD_VERSION = 1;

/**
 * Compose an A2A Signed Agent Card body with AgentScore identity claims included.
 *
 * Returns the UNSIGNED card. The vendor signs it with their wallet (typically using
 * the same wallet they use for x402 / MPP payments) and publishes the signed envelope
 * to wherever A2A consumers discover cards (a hosted endpoint, on-chain registry,
 * agent-card-server, etc.). Signing is vendor-side because the agent's signing key
 * never leaves their environment.
 *
 * Example:
 * ```ts
 * import { buildA2AAgentCard } from '@agent-score/commerce/identity/hono';
 *
 * app.get('/.well-known/agent-card', async (c) => {
 *   const data = getAgentScoreData(c);
 *   const card = buildA2AAgentCard({
 *     name: 'Example Merchant Concierge',
 *     description: 'Buy regulated goods via agent payments.',
 *     url: 'https://agents.example.com',
 *     capabilities: {
 *       endpoints: [{ name: 'purchase', path: '/purchase', method: 'POST' }],
 *       skills: ['product-purchase', 'regulated-commerce'],
 *     },
 *     data,
 *   });
 *   const signed = await yourSign(card);
 *   return c.json(signed);
 * });
 * ```
 */
export function buildA2AAgentCard(input: BuildA2AAgentCardInput): A2AAgentCard {
  const issuer = input.issuer ?? 'https://agentscore.sh';

  let identity: A2AAgentCardIdentity | null = null;
  if (input.data) {
    const operatorId = (input.data.resolved_operator as string | undefined) ?? null;
    if (operatorId) {
      const operatorVerification = input.data.operator_verification;
      const accountVerification = input.data.account_verification;
      identity = {
        issuer,
        operator_id: operatorId,
        kyc_level: accountVerification?.kyc_level ?? operatorVerification?.level ?? 'none',
        sanctions_clear: accountVerification?.sanctions_clear === true,
        age_bracket: accountVerification?.age_bracket ?? 'unknown',
        jurisdiction: accountVerification?.jurisdiction ?? '',
        verified_at: accountVerification?.verified_at ?? operatorVerification?.verified_at ?? null,
        verify_url:
          input.verifyUrl
          ?? (input.data.verify_url as string | undefined)
          ?? `${issuer}/verify`,
      };
    }
  }

  const card: A2AAgentCard = {
    protocol_version: PROTOCOL_VERSION,
    card_version: CARD_VERSION,
    name: input.name,
    identity,
  };
  if (input.description !== undefined) card.description = input.description;
  if (input.url !== undefined) card.url = input.url;
  if (input.capabilities !== undefined) card.capabilities = input.capabilities;
  if (input.extensions && input.extensions.length > 0) card.extensions = input.extensions;
  if (input.extras !== undefined) card.extras = input.extras;
  return card;
}
