/**
 * UCP (Universal Commerce Protocol) profile builder.
 *
 * Compose the JSON payload published at `/.well-known/ucp` per the UCP spec.
 * Output shape matches the spec example: top-level `{ ucp: {...}, signing_keys: [...] }`
 * envelope, with `services` / `capabilities` / `payment_handlers` as MAPs keyed by
 * reverse-DNS service / capability / handler name. Verified against the live
 * production reference at `https://puravidabracelets.com/.well-known/ucp` (Shopify's
 * UCP integration, one of the launch reference brands).
 *
 * AgentScore identity claims layer over UCP via the `sh.agentscore.identity` capability
 * (vendor-namespaced; UCP doesn't define KYC/sanctions/age/jurisdiction natively). The
 * capability extends `dev.ucp.shopping.checkout` AND `dev.ucp.shopping.cart` (multi-parent,
 * matching Shopify's `dev.shopify.catalog.storefront` pattern in the live ecosystem).
 *
 * The unsigned profile body returned here is what merchants publish; pass it through
 * `signUCPProfile` to attach the `agentscore-profile+jws` signature for trust-mode
 * verifiers (vendor extension; UCP itself doesn't mandate profile-body signing).
 *
 * Spec reference: https://ucp.dev/
 */

import type { AgentScoreData } from '../core';

/**
 * UCP per-element shape note: each binding interface (`UCPServiceBinding`,
 * `UCPCapabilityBinding`, `UCPPaymentHandlerBinding`) carries the canonical UCP fields
 * plus arbitrary vendor extras flat on the same object via `[k: string]: unknown`. The
 * python sibling models these as dataclasses with an explicit `extras: dict` field. Both
 * designs offer equivalent guarantees through different mechanisms.
 */
export interface UCPSigningKey {
  /** JWK kid (key id). */
  kid: string;
  /** JWK kty (key type) — `EC`, `RSA`, or `OKP`. */
  kty: string;
  /** JWK alg (signing algorithm) — `ES256`, `RS256`, or `EdDSA`. */
  alg?: string;
  /** JWK use, typically `sig`. */
  use?: string;
  /** JWK crv (curve) for EC / OKP keys. */
  crv?: string;
  /** JWK x / y / n / e / etc. The full key material; passed through verbatim. */
  [k: string]: unknown;
}

/**
 * Construct a UCPSigningKey from a public JWK dict (e.g. the `publicJWK` returned by
 * `generateUCPSigningKey()`). Validates required fields and rejects symmetric keys that
 * can't publicly verify a JWS in trust-mode UCP. Symmetric to Python's
 * `UCPSigningKey.from_jwk(public_jwk)` classmethod.
 */
export function ucpSigningKeyFromJWK(jwk: Record<string, unknown>): UCPSigningKey {
  if (!jwk || typeof jwk !== 'object') {
    throw new Error(`ucpSigningKeyFromJWK expected a non-null object; got ${typeof jwk}.`);
  }
  if (typeof jwk.kid !== 'string' || !jwk.kid) {
    throw new Error('ucpSigningKeyFromJWK: JWK missing required field `kid` (or non-string).');
  }
  if (typeof jwk.kty !== 'string' || !jwk.kty) {
    throw new Error('ucpSigningKeyFromJWK: JWK missing required field `kty` (or non-string).');
  }
  if (jwk.kty !== 'OKP' && jwk.kty !== 'EC' && jwk.kty !== 'RSA') {
    throw new Error(
      `ucpSigningKeyFromJWK: kty=${JSON.stringify(jwk.kty)} is not a supported asymmetric key type (expected OKP, EC, or RSA). Symmetric \`oct\` keys are rejected because they cannot publicly verify a JWS in the trust-mode UCP flow.`,
    );
  }
  return jwk as unknown as UCPSigningKey;
}

/** Transport binding — keyed under a service name (e.g., `dev.ucp.shopping`). */
export interface UCPServiceBinding {
  /** Spec version, YYYY-MM-DD per UCP convention. REQUIRED. */
  version: string;
  /** URL to human-readable specification. REQUIRED. */
  spec: string;
  /** Transport — `rest` / `mcp` / `a2a` / `embedded`. REQUIRED. */
  transport: 'rest' | 'mcp' | 'a2a' | 'embedded';
  /** Endpoint URL — required for rest/mcp; A2A points at the agent-card.json URL. */
  endpoint?: string;
  /** URL to JSON Schema — required for rest/mcp/embedded per spec. */
  schema?: string;
  /** Optional id for entity-instance disambiguation. */
  id?: string;
  /** Entity-specific config. */
  config?: Record<string, unknown>;
  /** Vendor-specific extras. */
  [k: string]: unknown;
}

/** Capability binding — keyed under a capability name (e.g., `dev.ucp.shopping.checkout`). */
export interface UCPCapabilityBinding {
  /** Capability version, YYYY-MM-DD. REQUIRED. */
  version: string;
  /** URL to human-readable specification. REQUIRED. */
  spec: string;
  /** URL to JSON Schema. REQUIRED. */
  schema: string;
  /** Optional id for entity-instance disambiguation. */
  id?: string;
  /** Entity-specific config (feature flags, callback URLs, etc). */
  config?: Record<string, unknown>;
  /** Parent capability(ies) extended — single string or array for multi-parent. */
  extends?: string | string[];
  /** Optional version requirements per UCP §6.5. */
  requires?: {
    protocol?: { min: string; max?: string };
    capabilities?: Record<string, { min: string; max?: string }>;
  };
  /** Vendor-specific extras (e.g., AgentScore claims block on `sh.agentscore.identity`). */
  [k: string]: unknown;
}

/** Payment handler binding — keyed under a handler reverse-DNS name (e.g., `com.google.pay`). */
export interface UCPPaymentHandlerBinding {
  /** Handler instance id (short, human-readable, e.g., `gpay`, `tempo`, `x402`). REQUIRED. */
  id: string;
  /** Handler spec version, YYYY-MM-DD. REQUIRED. */
  version: string;
  /** URL to handler spec. REQUIRED. */
  spec: string;
  /** URL to handler config schema. REQUIRED. */
  schema: string;
  /** Available instruments — type + per-type constraints (cards, wallets, etc.). */
  available_instruments?: Array<{ type: string; constraints?: Record<string, unknown>; [k: string]: unknown }>;
  /** Handler config — gateway IDs, merchant IDs, public keys, etc. */
  config?: Record<string, unknown>;
  /** Vendor-specific extras. */
  [k: string]: unknown;
}

/** UCP body — nested under the `ucp` key of the published profile. */
export interface UCPProfileBody {
  /** UCP spec version (YYYY-MM-DD). */
  version: string;
  /** Display name for the merchant / agent surface. */
  name?: string;
  /** Services — keyed by service name (e.g., `dev.ucp.shopping`). Each value is an
   *  array of transport bindings (one merchant typically advertises multiple transports
   *  under one service name). */
  services: Record<string, UCPServiceBinding[]>;
  /** Capabilities — keyed by capability name (e.g., `dev.ucp.shopping.checkout`). */
  capabilities: Record<string, UCPCapabilityBinding[]>;
  /** Payment handlers — keyed by handler reverse-DNS name (e.g., `com.google.pay`). */
  payment_handlers: Record<string, UCPPaymentHandlerBinding[]>;
  /** Optional `supported_versions` map linking historical version-specific profile URLs.
   *  Pattern: `{ "2026-01-23": "https://merchant/.well-known/ucp/2026-01-23", ... }`. */
  supported_versions?: Record<string, string>;
  /** Vendor-specific extras inside the `ucp` envelope. */
  [k: string]: unknown;
}

/** Full UCP profile body as published at `/.well-known/ucp`. Top-level shape:
 *  `{ ucp: {...}, signing_keys: [...], signature?: "..." }`. */
export interface UCPProfile {
  /** UCP body. ALL UCP-spec fields nest here per spec. */
  ucp: UCPProfileBody;
  /** JWKS — public keys at the OUTER level per UCP spec. Verifiers fetch this profile,
   *  match the kid from a JWS / RFC 9421 signature header against this list, and validate. */
  signing_keys: UCPSigningKey[];
  /** Set when JWS-signed via `signUCPProfile` — JWS Compact Serialization with detached
   *  payload (header..signature; payload is the canonicalized body minus this field). */
  signature?: string;
  /** Top-level vendor-specific extras (outside the `ucp` envelope). */
  [k: string]: unknown;
}

export interface BuildUCPProfileInput {
  /** UCP spec version. Default `'2026-04-17'`. */
  version?: string;
  /** Display name for the merchant / agent surface. */
  name?: string;
  /** Services map, keyed by service name. UCP-shopping merchants typically advertise
   *  bindings under `'dev.ucp.shopping'`. */
  services?: Record<string, UCPServiceBinding[]>;
  /** Capabilities map, keyed by capability name. The `sh.agentscore.identity` capability
   *  is auto-added when `data` is provided. */
  capabilities?: Record<string, UCPCapabilityBinding[]>;
  /** Payment handlers map, keyed by handler reverse-DNS name. */
  payment_handlers?: Record<string, UCPPaymentHandlerBinding[]>;
  /** JWKS — public keys the merchant signs with. REQUIRED by spec. */
  signing_keys: UCPSigningKey[];
  /** AgentScore assess data — adds an `sh.agentscore.identity` capability + claims
   *  block when present. */
  data?: AgentScoreData | null;
  /** Optional override for the AgentScore capability schema URL. Field is snake_cased
   *  for cross-language parity with the Python sibling. */
  agentscore_schema_url?: string;
  /** Optional override for the AgentScore capability spec URL. */
  agentscore_spec_url?: string;
  /** `supported_versions` map at the profile root. Pattern matches Pura Vida's
   *  production profile (`{ "<date>": "<base>/.well-known/ucp/<date>" }`). */
  supported_versions?: Record<string, string>;
  /** Vendor-specific extras at the OUTER level (alongside `ucp` + `signing_keys`). */
  extras?: Record<string, unknown>;
  /** Vendor-specific extras INSIDE the `ucp` envelope (alongside `version`, `services`, etc.). */
  ucp_extras?: Record<string, unknown>;
}

const DEFAULT_VERSION = '2026-04-17';
// Reverse-DNS namespacing per UCP convention (`^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$`).
// The bare `agentscore-identity` form fails the spec regex; vendor-namespacing under
// `sh.agentscore` is honest about the capability being our extension, not UCP-canonical.
const AGENTSCORE_CAPABILITY_NAME = 'sh.agentscore.identity';
const AGENTSCORE_CAPABILITY_VERSION = '1';
const AGENTSCORE_DEFAULT_SPEC_URL = 'https://agentscore.sh/specification/identity';
const AGENTSCORE_DEFAULT_SCHEMA_URL = 'https://agentscore.sh/schemas/ucp/sh-agentscore-identity-v1.json';
// Multi-parent extension — `sh.agentscore.identity` carries claims relevant at both
// checkout-build (compliance gate) and cart-build (price-gate eligibility, jurisdiction-
// restricted items in cart) time. Mirrors the multi-parent convention in the live
// ecosystem (Shopify's `dev.shopify.catalog.storefront` extends both `catalog.search`
// and `catalog.lookup`; UCP-canonical `dev.ucp.shopping.discount` extends both checkout
// and cart).
const AGENTSCORE_EXTENDS = ['dev.ucp.shopping.checkout', 'dev.ucp.shopping.cart'];

const RESERVED_TOP_LEVEL = new Set([
  'ucp',
  'signing_keys',
  'signature',
  '__proto__',
  'constructor',
  'prototype',
]);
const RESERVED_UCP_FIELDS = new Set([
  'version',
  'name',
  'services',
  'capabilities',
  'payment_handlers',
  'supported_versions',
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * Compose a UCP profile body for `/.well-known/ucp` publication. Returns the spec-
 * compliant shape: `{ ucp: { version, services, capabilities, payment_handlers, ... },
 * signing_keys: [...] }`. Pass through `signUCPProfile` to attach a JWS signature for
 * trust-mode verifiers.
 *
 * Auto-injects `sh.agentscore.identity` as a vendor capability extending both
 * `dev.ucp.shopping.checkout` and `dev.ucp.shopping.cart` when `data` carries a
 * resolved operator. Verifiers that recognize the AgentScore namespace can parse
 * the `claims` block; vanilla UCP agents see a normal extension capability.
 *
 * Example:
 * ```ts
 * import { buildUCPProfile } from '@agent-score/commerce';
 *
 * const profile = buildUCPProfile({
 *   name: 'Example Merchant',
 *   services: {
 *     'dev.ucp.shopping': [
 *       { version: '2026-04-08', spec: 'https://ucp.dev/2026-04-08/specification/overview',
 *         transport: 'mcp', endpoint: 'https://merchant.example/api/ucp/mcp',
 *         schema: 'https://ucp.dev/services/shopping/openrpc.json' },
 *     ],
 *   },
 *   payment_handlers: {
 *     'sh.agentscore.payment.tempo': [{
 *       id: 'tempo',
 *       version: '2026-04-08',
 *       spec: 'https://agentscore.sh/specification/payment-handlers/tempo',
 *       schema: 'https://agentscore.sh/schemas/payment-handlers/tempo.json',
 *       config: { recipient: TEMPO_ADDR },
 *     }],
 *   },
 *   signing_keys: [signingKey],
 * });
 * ```
 */
export function buildUCPProfile(input: BuildUCPProfileInput): UCPProfile {
  // Deep-clone the capabilities map so we can safely mutate (auto-add the AgentScore
  // identity capability) without altering the caller's input.
  const capabilities: Record<string, UCPCapabilityBinding[]> = {};
  for (const [name, bindings] of Object.entries(input.capabilities ?? {})) {
    capabilities[name] = [...bindings];
  }

  if (input.data) {
    const operatorId = input.data.resolved_operator;
    if (operatorId) {
      const operatorVerification = input.data.operator_verification;
      const accountVerification = input.data.account_verification;
      // `||` (not `??`) coerces both null/undefined AND empty string to the default,
      // matching the python sibling. The API can return `account_verification` with
      // either null or `""` for un-set fields; profiles signed in one language must
      // verify in the other across both shapes.
      const claims: Record<string, unknown> = {
        operator_id: operatorId,
        kyc_level: accountVerification?.kyc_level || operatorVerification?.level || 'none',
        sanctions_clear: accountVerification?.sanctions_clear === true,
        age_bracket: accountVerification?.age_bracket || 'unknown',
        jurisdiction: accountVerification?.jurisdiction || '',
        verified_at: accountVerification?.verified_at || operatorVerification?.verified_at || null,
        verify_url: input.data.verify_url ?? null,
        issuer: 'https://agentscore.sh',
      };
      const agentscoreBinding: UCPCapabilityBinding = {
        version: AGENTSCORE_CAPABILITY_VERSION,
        spec: input.agentscore_spec_url ?? AGENTSCORE_DEFAULT_SPEC_URL,
        schema: input.agentscore_schema_url ?? AGENTSCORE_DEFAULT_SCHEMA_URL,
        extends: AGENTSCORE_EXTENDS,
        // `claims` is our vendor extra on the binding; allowed per spec via the
        // `[k: string]: unknown` index signature on UCPCapabilityBinding.
        claims,
      };
      const existing = capabilities[AGENTSCORE_CAPABILITY_NAME];
      if (existing) existing.push(agentscoreBinding);
      else capabilities[AGENTSCORE_CAPABILITY_NAME] = [agentscoreBinding];
    }
  }

  const ucp: UCPProfileBody = {
    version: input.version ?? DEFAULT_VERSION,
    services: input.services ?? {},
    capabilities,
    payment_handlers: input.payment_handlers ?? {},
  };
  if (input.name !== undefined) ucp.name = input.name;
  if (input.supported_versions !== undefined) ucp.supported_versions = input.supported_versions;
  if (input.ucp_extras) {
    for (const k of Object.keys(input.ucp_extras)) {
      if (RESERVED_UCP_FIELDS.has(k)) {
        throw new Error(`buildUCPProfile: ucp_extras key "${k}" collides with a reserved \`ucp\` field; rejected.`);
      }
    }
    Object.assign(ucp, input.ucp_extras);
  }

  const profile: UCPProfile = {
    ucp,
    signing_keys: input.signing_keys,
  };
  if (input.extras) {
    // `__proto__`, `constructor`, `prototype` reserved so vendor extras can't slip
    // prototype-pollution payloads into the canonical body.
    for (const k of Object.keys(input.extras)) {
      if (RESERVED_TOP_LEVEL.has(k)) {
        throw new Error(`buildUCPProfile: extras key "${k}" collides with a reserved profile field; rejected.`);
      }
    }
    Object.assign(profile, input.extras);
  }

  return profile;
}

export const AGENTSCORE_UCP_CAPABILITY = AGENTSCORE_CAPABILITY_NAME;
