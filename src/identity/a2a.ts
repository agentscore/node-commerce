/**
 * Google A2A (Agent-to-Agent) v1.0 Agent Card builder.
 *
 * Compose the JSON payload for an A2A v1.0 Agent Card per the canonical proto at
 * https://github.com/a2aproject/A2A/blob/main/specification/a2a.proto. Returned object
 * is the unsigned card body — wrap with an A2A `AgentCardSignature` (RFC 7515 JWS)
 * to sign vendor-side before publishing at /.well-known/agent-card.json.
 *
 * Why publish: A2A is a Linux Foundation standard. Signed Agent Cards let any
 * A2A-compatible reader discover an agent's capabilities + protocol bindings without
 * per-platform integration. Per UCP §A2A binding, agents serving UCP via the A2A
 * transport MUST declare the canonical UCP extension URI in `capabilities.extensions[]`
 * so platforms detect UCP support without re-fetching the profile.
 *
 * Spec reference: https://a2a-protocol.org/latest/
 */

const PROTOCOL_VERSION = '1.0';
const DEFAULT_PROTOCOL_BINDING = 'HTTP+JSON';
const DEFAULT_INPUT_MODE = 'application/json';
const DEFAULT_OUTPUT_MODE = 'application/json';

/** Canonical UCP A2A extension URI — verifiers look for this exact URI in
 *  `capabilities.extensions[]` to detect UCP support on the agent card. Pinned
 *  to the 2026-04-08 spec snapshot. */
export const UCP_A2A_EXTENSION_URI = 'https://ucp.dev/2026-04-08/specification/reference';

/** Per spec §4.4.6. Each entry advertises one protocol binding the agent supports.
 *  `supported_interfaces[0]` is the preferred binding (ordered list). */
export interface A2AAgentInterface {
  /** Interface URL (https in production). */
  url: string;
  /** Open string — core values are `JSONRPC`, `GRPC`, `HTTP+JSON`. */
  protocol_binding: string;
  /** A2A protocol version, e.g. `"1.0"`. Distinct from the agent's own version. */
  protocol_version: string;
  tenant?: string;
}

/** Per spec §4.4.2. The org/service that provides the agent. */
export interface A2AAgentProvider {
  url: string;
  organization: string;
}

/** Per spec §4.4.5. A distinct capability or function the agent performs.
 *  Lives at the TOP LEVEL of AgentCard (not inside `capabilities`). */
export interface A2AAgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  input_modes?: string[];
  output_modes?: string[];
}

/** Per spec §4.4.4. A protocol extension the agent supports.
 *  Lives in `capabilities.extensions[]`. `description` and `required` are
 *  spec-mandated fields, not optional. */
export interface A2AAgentCardExtension {
  uri: string;
  description: string;
  required: boolean;
  params?: Record<string, unknown>;
}

/** Build the canonical UCP entry for an A2A agent card's `capabilities.extensions[]`
 *  array.
 *
 *  Per UCP §A2A binding: "Businesses supporting UCP must advertise the extension and
 *  any optional capabilities in their A2A Agent Card to allow platforms to activate
 *  the extension." Pass the `capabilities` map keyed by reverse-DNS service/capability
 *  name (e.g. `dev.ucp.shopping.checkout`), each value a list of `{ version }` records.
 *  Pass `{}` (or omit) when you serve UCP at the discovery layer but have no formal
 *  capability bindings yet.
 *
 *  `required: true` declares the platform must understand UCP to interoperate with
 *  this agent. Default `false`: UCP is offered but not mandatory.
 */
export function ucpA2AExtension(
  capabilities: Record<string, Array<{ version: string }>> = {},
  options: { required?: boolean } = {},
): A2AAgentCardExtension {
  return {
    uri: UCP_A2A_EXTENSION_URI,
    description: 'UCP support: this agent serves Universal Commerce Protocol bindings via the A2A transport.',
    required: options.required ?? false,
    params: { capabilities },
  };
}

/** Per spec §4.4.3. Optional capabilities the agent supports.
 *
 *  Per the canonical proto, `capabilities` declares: streaming, push_notifications,
 *  extensions (the protocol extensions the agent supports), and extended_agent_card.
 *  REST-style endpoint metadata does NOT belong here — A2A uses `supported_interfaces`
 *  on the AgentCard for protocol bindings, and `skills` (top-level) for capability
 *  descriptions. */
export interface A2AAgentCardCapabilities {
  streaming?: boolean;
  push_notifications?: boolean;
  extensions?: A2AAgentCardExtension[];
  extended_agent_card?: boolean;
}

/** Per spec §4.4.1. A2A v1.0 Agent Card body.
 *
 *  Identity claims live in a separate `AgentCardSignature` (RFC 7515 JWS) wrapping
 *  the serialized card, NOT in the card body itself. Per-vendor identity attestation
 *  can be expressed via a vendor extension entry inside `capabilities.extensions[]`. */
export interface A2AAgentCard {
  name: string;
  description: string;
  /** Ordered; first entry is preferred. */
  supported_interfaces: A2AAgentInterface[];
  /** Agent's own version, e.g. `"1.0.0"`. Distinct from the A2A protocol version,
   *  which lives on each `A2AAgentInterface.protocol_version`. */
  version: string;
  capabilities: A2AAgentCardCapabilities;
  default_input_modes: string[];
  default_output_modes: string[];
  provider?: A2AAgentProvider;
  documentation_url?: string;
  skills?: A2AAgentSkill[];
  security_schemes?: Record<string, unknown>;
  security_requirements?: unknown[];
  /** Vendor-specific extras merged at top level. */
  [k: string]: unknown;
}

export interface BuildA2AAgentCardInput {
  /** Agent display name. REQUIRED. */
  name: string;
  /** Agent purpose/description. REQUIRED per spec. */
  description: string;
  /** The primary interface URL — becomes `supported_interfaces[0].url` (with
   *  `protocol_binding=HTTP+JSON`, `protocol_version=1.0` by default). For
   *  multi-binding agents, construct `A2AAgentCard` directly. */
  url: string;
  /** Agent's own version, e.g. `"1.0.0"`. Distinct from the A2A protocol version. */
  version?: string;
  /** Top-level skill declarations — what the agent can do. */
  skills?: A2AAgentSkill[];
  /** A2A v1.0 capability extensions. Build the UCP entry with `ucpA2AExtension()`. */
  extensions?: A2AAgentCardExtension[];
  /** Capability flag: agent supports streaming responses. */
  streaming?: boolean;
  /** Capability flag: agent supports push notifications for async task updates. */
  push_notifications?: boolean;
  /** Capability flag: agent serves an extended (more detailed) card when authenticated. */
  extended_agent_card?: boolean;
  /** Provider org for the agent. */
  provider?: A2AAgentProvider;
  /** URL to additional human-readable documentation. */
  documentation_url?: string;
  /** Default input media types (defaults to `["application/json"]`). */
  default_input_modes?: string[];
  /** Default output media types (defaults to `["application/json"]`). */
  default_output_modes?: string[];
  /** Override the protocol binding for the auto-built primary interface (default `"HTTP+JSON"`). */
  protocol_binding?: string;
  /** Override the A2A protocol version for the auto-built primary interface (default `"1.0"`). */
  a2a_protocol_version?: string;
  /** Per-scheme security details (key = scheme name). */
  security_schemes?: Record<string, unknown>;
  /** Required security requirements for invoking the agent. */
  security_requirements?: unknown[];
  /** Vendor-specific extras merged at the card top level. */
  extras?: Record<string, unknown>;
}

/**
 * Compose an A2A v1.0 Agent Card body per the canonical proto.
 *
 * Returns the UNSIGNED card. To attach identity claims, sign the serialized body
 * as an RFC 7515 JWS (`AgentCardSignature`). Vendors can also add an identity-flavored
 * extension to `capabilities.extensions[]`.
 *
 * The single `url` argument becomes the primary `supported_interfaces[0].url`
 * (with `protocol_binding=HTTP+JSON`, `protocol_version=1.0` by default).
 *
 * Example:
 * ```ts
 * import { buildA2AAgentCard, ucpA2AExtension } from '@agent-score/commerce';
 *
 * const card = buildA2AAgentCard({
 *   name: 'Example Merchant Concierge',
 *   description: 'Buy regulated goods via agent payments.',
 *   url: 'https://agents.example.com',
 *   version: '1.0.0',
 *   skills: [
 *     { id: 'purchase', name: 'Purchase', description: 'Buy products via agent payments.', tags: ['commerce', 'payment'] },
 *   ],
 *   extensions: [ucpA2AExtension()],
 * });
 * const signed = await yourJWSSign(card);
 * ```
 */
export function buildA2AAgentCard(input: BuildA2AAgentCardInput): A2AAgentCard {
  const capabilities: A2AAgentCardCapabilities = {};
  if (input.streaming !== undefined) capabilities.streaming = input.streaming;
  if (input.push_notifications !== undefined) capabilities.push_notifications = input.push_notifications;
  if (input.extensions && input.extensions.length > 0) capabilities.extensions = input.extensions;
  if (input.extended_agent_card !== undefined) capabilities.extended_agent_card = input.extended_agent_card;

  const primaryInterface: A2AAgentInterface = {
    url: input.url,
    protocol_binding: input.protocol_binding ?? DEFAULT_PROTOCOL_BINDING,
    protocol_version: input.a2a_protocol_version ?? PROTOCOL_VERSION,
  };

  const card: A2AAgentCard = {
    name: input.name,
    description: input.description,
    supported_interfaces: [primaryInterface],
    version: input.version ?? '1.0.0',
    capabilities,
    default_input_modes: input.default_input_modes ?? [DEFAULT_INPUT_MODE],
    default_output_modes: input.default_output_modes ?? [DEFAULT_OUTPUT_MODE],
  };
  if (input.provider !== undefined) card.provider = input.provider;
  if (input.documentation_url !== undefined) card.documentation_url = input.documentation_url;
  if (input.skills && input.skills.length > 0) card.skills = input.skills;
  if (input.security_schemes !== undefined) card.security_schemes = input.security_schemes;
  if (input.security_requirements !== undefined) card.security_requirements = input.security_requirements;
  if (input.extras) {
    for (const [k, v] of Object.entries(input.extras)) {
      card[k] = v;
    }
  }
  return card;
}
