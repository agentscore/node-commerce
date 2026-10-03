/**
 * Google A2A (Agent-to-Agent) v1.0 Agent Card builder.
 *
 * Compose the JSON payload for an A2A v1.0 Agent Card matching the canonical
 * `AgentCard` type from `@a2a-js/sdk`. Returned object is the unsigned card body:
 * wrap with an `A2AAgentCardSignature` (RFC 7515 JWS) to sign vendor-side before
 * publishing at /.well-known/agent-card.json.
 *
 * Why publish: A2A is a Linux Foundation standard. Agent Cards let any
 * A2A-compatible reader discover an agent's capabilities + protocol bindings without
 * per-platform integration. Per UCP §A2A binding, agents serving UCP via the A2A
 * transport MUST declare the canonical UCP extension URI in `capabilities.extensions[]`
 * so platforms detect UCP support without re-fetching the profile.
 *
 * Spec reference: https://a2a-protocol.org/latest/
 * Authoritative types: https://www.npmjs.com/package/@a2a-js/sdk (interface `AgentCard`).
 */

const PROTOCOL_VERSION = '1.0';
const DEFAULT_TRANSPORT = 'JSONRPC';
const DEFAULT_INPUT_MODE = 'application/json';
const DEFAULT_OUTPUT_MODE = 'application/json';

/** Canonical UCP A2A extension URI: verifiers look for this exact URI in
 *  `capabilities.extensions[]` to detect UCP support on the agent card. Pinned
 *  to the 2026-08-25 spec snapshot. */
export const UCP_A2A_EXTENSION_URI = 'https://ucp.dev/2026-08-25/specification/reference';

/** Canonical URI for the AIP (Agentic Identity Protocol) A2A agent-card extension: points at the
 *  issuer-discovery well-known so a reader can resolve the protocol. */
export const AIP_A2A_EXTENSION_URI = 'https://www.agentscore.com/.well-known/agent-identity';

/** One transport+URL combination beyond the primary `url`, passed as `additionalInterfaces`;
 *  each becomes a `supportedInterfaces` entry after the primary one. */
export interface A2AAgentInterface {
  /** Open string: core values are `JSONRPC`, `GRPC`, `HTTP+JSON`. */
  transport: string;
  /** Absolute URL where this transport is available. */
  url: string;
}

/** Org/service that provides the agent. */
export interface A2AAgentProvider {
  organization: string;
  url: string;
}

/** A distinct capability or function the agent performs. Lives at the TOP LEVEL of
 *  `AgentCard.skills[]` (not inside `capabilities`). */
export interface A2AAgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
  /** Security schemes scoped to this skill. List = OR of ANDs (each entry is a set of
   *  schemes that must all be satisfied). Follows OpenAPI 3.0 Security Requirement Object. */
  security?: Record<string, string[]>[];
}

/** A protocol extension the agent supports. Lives in `capabilities.extensions[]`.
 *  Canonical type marks `description` and `required` optional, but we keep them in the
 *  builder to make UCP discovery deterministic. */
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

/** Build the AIP entry for an A2A agent card's `capabilities.extensions[]`. Advertises that the
 *  agent accepts an Agent Identity Token (JWT) in an `Agent-Identity` header plus an RFC 9421
 *  proof-of-possession signature: so an agent discovering via the agent-card learns it can present
 *  an AIT (matching what the merchant's mpp.json / llms.txt / skill.md already advertise). Optional
 *  `requiredTrustLevel` / `requiredAmr` surface a gate's human-presence requirement. */
export function aipA2AExtension(
  opts: {
    trustedIssuers?: string[];
    requiredTrustLevel?: 'autonomous' | 'human_present' | 'human_confirmed';
    requiredAmr?: string[];
    required?: boolean;
  } = {},
): A2AAgentCardExtension {
  return {
    uri: AIP_A2A_EXTENSION_URI,
    description:
      'AIP support: present an Agent Identity Token (JWT) in an Agent-Identity header plus an RFC 9421 ' +
      'HTTP Message Signature (over @method @authority @path agent-identity) proving possession of the ' +
      'token-bound cnf key. `agentscore-pay pay --identity aip` attaches it automatically.',
    required: opts.required ?? false,
    params: {
      header: 'Agent-Identity',
      signature: 'RFC 9421',
      ...(opts.trustedIssuers !== undefined && opts.trustedIssuers.length > 0 && { trusted_issuers: opts.trustedIssuers }),
      ...(opts.requiredTrustLevel !== undefined && { required_trust_level: opts.requiredTrustLevel }),
      ...(opts.requiredAmr !== undefined && opts.requiredAmr.length > 0 && { required_amr: opts.requiredAmr }),
    },
  };
}

/** Optional capabilities the agent supports (A2A 1.0 `AgentCapabilities`). */
export interface A2AAgentCardCapabilities {
  extensions?: A2AAgentCardExtension[];
  pushNotifications?: boolean;
  streaming?: boolean;
  /** The agent serves an extended card to authenticated callers (1.0 moved this here from the
   *  card's top level, where 0.3 called it `supportsAuthenticatedExtendedCard`). */
  extendedAgentCard?: boolean;
}

/** One endpoint and the protocol binding it speaks (A2A 1.0 `AgentInterface`). */
export interface A2ASupportedInterface {
  url: string;
  /** `JSONRPC`, `GRPC` or `HTTP+JSON`. */
  protocolBinding: string;
  protocolVersion: string;
  tenant?: string;
}

/** A2A 1.0 `SecurityRequirement`: scheme name to the scopes it needs. */
export interface A2ASecurityRequirement {
  schemes: Record<string, { list: string[] }>;
}

/** JWS signature embedded in an Agent Card. Multiple signatures MAY be attached;
 *  verifiers reconstruct the card body without `signatures` to verify each entry.
 *  Format follows RFC 7515. */
export interface A2AAgentCardSignature {
  /** Base64url-encoded JSON of the protected JWS header. REQUIRED. */
  protected: string;
  /** Base64url-encoded computed signature. REQUIRED. */
  signature: string;
  /** Optional unprotected JWS header values. */
  header?: Record<string, unknown>;
}

/** A2A 1.0 Agent Card body, matching `message AgentCard` in the A2A specification
 *  (`specification/a2a.proto`) and `AgentCard` in `@a2a-js/sdk`. */
export interface A2AAgentCard {
  name: string;
  description: string;
  /** Every endpoint the agent serves, first one preferred. REQUIRED, and where 1.0 moved the
   *  endpoint URL, transport and protocol version that 0.3 carried at the top level. */
  supportedInterfaces: A2ASupportedInterface[];
  /** Agent's own version, e.g. `"1.0.0"`. */
  version: string;
  capabilities: A2AAgentCardCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  /** REQUIRED non-empty. */
  skills: A2AAgentCardSkill[];
  provider?: A2AAgentProvider;
  documentationUrl?: string;
  iconUrl?: string;
  /** JWS signatures embedded in the card. Compute over the canonical card body MINUS
   *  this field, then attach. */
  signatures?: A2AAgentCardSignature[];
  /** Any one of these requirements satisfies the card (OR); each names the schemes it needs (AND). */
  securityRequirements?: A2ASecurityRequirement[];
  /** Map of security scheme definitions (key = scheme name). */
  securitySchemes?: Record<string, unknown>;
  /** Vendor-specific extras merged at top level. */
  [k: string]: unknown;
}

/** A skill as the 1.0 card carries it: `security` became `securityRequirements`. */
export type A2AAgentCardSkill = Omit<A2AAgentSkill, 'security'> & { securityRequirements?: A2ASecurityRequirement[] };

interface BuildA2AAgentCardInput {
  /** Agent display name. REQUIRED. */
  name: string;
  /** Agent purpose/description. REQUIRED per spec. */
  description: string;
  /** Primary endpoint URL, the first entry of `supportedInterfaces`, speaking
   *  `preferredTransport` (default `HTTP+JSON`). */
  url: string;
  /** Top-level skill declarations: what the agent can do. REQUIRED per spec
   *  (proto field 12 [field_behavior=REQUIRED]); must have ≥1 entry. */
  skills: A2AAgentSkill[];
  /** Agent's own version, e.g. `"1.0.0"`. Distinct from the A2A `protocolVersion`. */
  version?: string;
  /** Protocol binding at `url`. Defaults to `"HTTP+JSON"` for our merchants. */
  preferredTransport?: string;
  /** A2A protocol version each interface declares. Defaults to `"1.0"`. */
  protocolVersion?: string;
  /** Further endpoints beyond `url`, each with its own binding; they follow it in `supportedInterfaces`. */
  additionalInterfaces?: A2AAgentInterface[];
  /** A2A capability extensions. Build the UCP entry with `ucpA2AExtension()`. */
  extensions?: A2AAgentCardExtension[];
  /** Capability flag: agent supports streaming responses (SSE). */
  streaming?: boolean;
  /** Capability flag: agent supports push notifications for async task updates. */
  pushNotifications?: boolean;
  /** Capability flag: agent serves an extended card to authenticated callers. */
  extendedAgentCard?: boolean;
  /** Provider org for the agent. */
  provider?: A2AAgentProvider;
  /** URL to additional human-readable documentation. */
  documentationUrl?: string;
  /** URL to an icon for the agent. */
  iconUrl?: string;
  /** JWS signatures embedded in the card. */
  signatures?: A2AAgentCardSignature[];
  /** Default input media types (defaults to `["application/json"]`). */
  defaultInputModes?: string[];
  /** Default output media types (defaults to `["application/json"]`). */
  defaultOutputModes?: string[];
  /** Security requirements in the OpenAPI form (OR of ANDs, scheme name to scopes); emitted as
   *  1.0 `securityRequirements`. */
  security?: Record<string, string[]>[];
  /** Per-scheme security details (key = scheme name). */
  securitySchemes?: Record<string, unknown>;
  /** Vendor-specific extras merged at the card top level. */
  extras?: Record<string, unknown>;
}

/** OpenAPI-form requirements (OR of ANDs) in the A2A 1.0 shape. */
export function toSecurityRequirements(security: Record<string, string[]>[]): A2ASecurityRequirement[] {
  return security.map((req) => ({ schemes: Object.fromEntries(Object.entries(req).map(([name, scopes]) => [name, { list: scopes }])) }));
}

/**
 * Compose an A2A 1.0 Agent Card body (`message AgentCard` in the A2A specification).
 *
 * Returns the UNSIGNED card. To attach identity claims, sign the serialized body
 * as an RFC 7515 JWS (`A2AAgentCardSignature`). Vendors can also add an identity-flavored
 * extension to `capabilities.extensions[]`.
 *
 * `url` becomes the first entry of `supportedInterfaces`, speaking `preferredTransport`
 * (default `HTTP+JSON`); `additionalInterfaces` follow it.
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
  if (!input.skills || input.skills.length === 0) {
    throw new Error(
      'buildA2AAgentCard: `skills` MUST be a non-empty list. Per spec §4.4.1 (proto field 12 [field_behavior=REQUIRED]), every Agent Card must declare at least one AgentSkill. Construct A2AAgentCard directly to bypass.',
    );
  }

  const protocolVersion = input.protocolVersion ?? PROTOCOL_VERSION;
  const capabilities: A2AAgentCardCapabilities = {};
  if (input.streaming !== undefined) capabilities.streaming = input.streaming;
  if (input.pushNotifications !== undefined) capabilities.pushNotifications = input.pushNotifications;
  if (input.extendedAgentCard !== undefined) capabilities.extendedAgentCard = input.extendedAgentCard;
  if (input.extensions && input.extensions.length > 0) capabilities.extensions = input.extensions;

  const card: A2AAgentCard = {
    name: input.name,
    description: input.description,
    supportedInterfaces: [
      { url: input.url, protocolBinding: input.preferredTransport ?? 'HTTP+JSON', protocolVersion },
      ...(input.additionalInterfaces ?? []).map((i) => ({ url: i.url, protocolBinding: i.transport, protocolVersion })),
    ],
    version: input.version ?? '1.0.0',
    capabilities,
    defaultInputModes: input.defaultInputModes ?? [DEFAULT_INPUT_MODE],
    defaultOutputModes: input.defaultOutputModes ?? [DEFAULT_OUTPUT_MODE],
    skills: input.skills.map(({ security, ...skill }) => (security ? { ...skill, securityRequirements: toSecurityRequirements(security) } : skill)),
  };
  if (input.provider !== undefined) card.provider = input.provider;
  if (input.documentationUrl !== undefined) card.documentationUrl = input.documentationUrl;
  if (input.iconUrl !== undefined) card.iconUrl = input.iconUrl;
  if (input.signatures !== undefined && input.signatures.length > 0) card.signatures = input.signatures;
  if (input.security !== undefined) card.securityRequirements = toSecurityRequirements(input.security);
  if (input.securitySchemes !== undefined) card.securitySchemes = input.securitySchemes;
  if (input.extras) {
    for (const [k, v] of Object.entries(input.extras)) {
      card[k] = v;
    }
  }
  return card;
}

// A2A_DEFAULT_TRANSPORT is the protocol's own default binding (JSONRPC). buildA2AAgentCard
// defaults to HTTP+JSON instead, since our merchants serve REST-shaped endpoints.
export const A2A_PROTOCOL_VERSION = PROTOCOL_VERSION;
export const A2A_DEFAULT_TRANSPORT = DEFAULT_TRANSPORT;
