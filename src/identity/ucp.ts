/**
 * UCP (Universal Commerce Protocol) profile builder.
 *
 * Compose the JSON payload published at `/.well-known/ucp` per the UCP spec, with
 * AgentScore identity claims attached as a capability. Returned object is the unsigned
 * profile body — the merchant signs it (or wraps it in their JWKS-backed envelope)
 * before publishing.
 *
 * Why publish: UCP is the Google-led cross-vendor standard (announced Jan 2026 at NRF
 * with Shopify, Etsy, Wayfair, Target, Walmart, Adyen, Mastercard, Stripe, Visa, Amex,
 * etc.). Every UCP-aware platform discovers a merchant via `/.well-known/ucp`, so
 * shipping this profile means AgentScore-gated merchants are discoverable through the
 * same surface every other UCP merchant uses.
 *
 * Spec reference: https://ucp.dev/
 *
 * UCP profiles do NOT carry KYC / sanctions / age / jurisdiction claims natively —
 * identity in the UCP spec is "who signed this" (JWKS-backed). AgentScore claims layer
 * over UCP via a custom capability so consumers who care about verified-buyer identity
 * can read them; consumers who don't care just see a normal UCP profile.
 */

import type { AgentScoreData } from '../core';

export interface UCPSigningKey {
  /** JWK kid (key id). */
  kid: string;
  /** JWK kty (key type) — typically `EC`, `RSA`, or `OKP`. */
  kty: string;
  /** JWK alg (signing algorithm) — typically `ES256`, `RS256`, or `EdDSA`. */
  alg?: string;
  /** JWK use — typically `sig`. */
  use?: string;
  /** JWK crv (curve) for EC / OKP keys. */
  crv?: string;
  /** JWK x / y / n / e / etc. The full key material; passed through verbatim. */
  [k: string]: unknown;
}

/**
 * Construct a UCPSigningKey from a public JWK dict (e.g. the `publicJWK`
 * returned by `generateUCPSigningKey()`). Validates the JWK has required
 * fields (`kid`, `kty`) and rejects symmetric (`oct`) keys, which can't
 * publicly verify a JWS in trust-mode UCP.
 *
 * Symmetric to Python's `UCPSigningKey.from_jwk(public_jwk)` classmethod.
 *
 * Example:
 * ```ts
 * const { publicJWK } = await generateUCPSigningKey({ kid: 'merchant-2026-05' });
 * const profile = buildUCPProfile({ ..., signing_keys: [ucpSigningKeyFromJWK(publicJWK)] });
 * ```
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

export interface UCPService {
  /** Transport binding — `rest` / `mcp` / `a2a` / `embedded`. */
  type: string;
  /** Service URL (or path for embedded). */
  url?: string;
  /** Optional version pin. */
  version?: string;
  /** Vendor-specific extras for the binding. */
  [k: string]: unknown;
}

export interface UCPCapability {
  /** Capability name — `checkout`, `catalog`, `agentscore-identity`, etc. */
  name: string;
  /** URL of the JSON Schema describing this capability's payload. */
  schema?: string;
  /** Capability version — semver or date-stamp per UCP convention. */
  version?: string;
  /** Vendor-specific extras for the capability. */
  [k: string]: unknown;
}

export interface UCPPaymentHandler {
  /** Handler name — `stripe`, `tempo`, `x402-base`, `solana`, etc. */
  name: string;
  /** Handler config — recipient address, profile id, etc. */
  config?: Record<string, unknown>;
}

export interface UCPProfile {
  /** UCP spec version (date-stamped). */
  version: string;
  /** URL of the UCP spec. */
  spec: string;
  /** URL of this profile's JSON schema. */
  schema?: string;
  /** Display name of the merchant / agent surface. */
  name?: string;
  /** Service bindings — REST, MCP, A2A, embedded transports. */
  services: UCPService[];
  /** Capabilities offered (with schema URLs). */
  capabilities: UCPCapability[];
  /** Payment handlers offered — typically the rails the merchant accepts. */
  payment_handlers: UCPPaymentHandler[];
  /** JWKS — REQUIRED by spec. The merchant signs requests with a private key whose
   *  public counterpart is listed here. Verifiers fetch this profile, find the kid, and
   *  validate signatures. */
  signing_keys: UCPSigningKey[];
  /** Vendor-specific extras at the top level. */
  [k: string]: unknown;
}

export interface BuildUCPProfileInput {
  /** UCP spec version. Default `"2026-04-17"` (current at time of writing). */
  version?: string;
  /** Display name for the merchant / agent surface. */
  name?: string;
  /** Service transport bindings. At minimum, the agent's primary REST endpoint. */
  services: UCPService[];
  /** Capabilities offered. AgentScore identity is auto-added as a capability when `data` is provided. */
  capabilities?: UCPCapability[];
  /** Payment handlers — rails the merchant accepts. */
  payment_handlers?: UCPPaymentHandler[];
  /** JWKS — public keys the merchant signs requests with. REQUIRED by spec. */
  signing_keys: UCPSigningKey[];
  /** AgentScore assess data — adds an `agentscore-identity` capability + claims block when present. */
  data?: AgentScoreData | null;
  /** Optional override for the AgentScore capability schema URL. */
  agentscoreSchemaUrl?: string;
  /** Vendor-specific extras at the top level. */
  extras?: Record<string, unknown>;
}

const DEFAULT_VERSION = '2026-04-17';
const SPEC_URL = 'https://ucp.dev/';
const AGENTSCORE_CAPABILITY_NAME = 'agentscore-identity';
const AGENTSCORE_CAPABILITY_VERSION = '1';

/**
 * Compose a UCP profile body for `/.well-known/ucp` publication. Merges AgentScore
 * identity claims into the `capabilities` array as an `agentscore-identity` capability
 * so UCP-aware consumers can discover verified-buyer claims alongside the standard
 * UCP transport metadata.
 *
 * Example:
 * ```ts
 * import { buildUCPProfile } from '@agent-score/commerce';
 *
 * app.get('/.well-known/ucp', async (c) => {
 *   const data = getAgentScoreData(c);
 *   return c.json(buildUCPProfile({
 *     name: 'Example Merchant',
 *     services: [{ type: 'rest', url: 'https://agents.example.com' }],
 *     payment_handlers: [
 *       { name: 'tempo', config: { recipient: TEMPO_ADDR } },
 *       { name: 'stripe', config: { profile_id: STRIPE_PROFILE_ID } },
 *     ],
 *     signing_keys: [{ kid: 'merchant-2026-04', kty: 'EC', alg: 'ES256', crv: 'P-256', x: '...', y: '...' }],
 *     data,
 *   }));
 * });
 * ```
 */
export function buildUCPProfile(input: BuildUCPProfileInput): UCPProfile {
  const baseCapabilities: UCPCapability[] = [...(input.capabilities ?? [])];

  if (input.data) {
    const operatorId = input.data.resolved_operator;
    if (operatorId) {
      const operatorVerification = input.data.operator_verification;
      const accountVerification = input.data.account_verification;
      // `||` (not `??`) coerces both null/undefined AND empty string to the default,
      // matching the python sibling. The API can return `account_verification` with
      // either null or `""` for un-set fields depending on the row state, and a
      // profile signed in one language must verify in the other across both shapes.
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
      baseCapabilities.push({
        name: AGENTSCORE_CAPABILITY_NAME,
        version: AGENTSCORE_CAPABILITY_VERSION,
        schema: input.agentscoreSchemaUrl ?? 'https://agentscore.sh/schemas/ucp/agentscore-identity.v1.json',
        claims,
      });
    }
  }

  const profile: UCPProfile = {
    version: input.version ?? DEFAULT_VERSION,
    spec: SPEC_URL,
    services: input.services,
    capabilities: baseCapabilities,
    payment_handlers: input.payment_handlers ?? [],
    signing_keys: input.signing_keys,
  };

  if (input.name !== undefined) profile.name = input.name;
  if (input.extras) {
    // Reserved-field collisions are rejected so a careless `extras: { signing_keys: [...] }`
    // can't silently destroy the explicit field. `__proto__`, `constructor`, and `prototype`
    // are reserved so vendor extras can't slip prototype-pollution payloads into the canonical
    // body and surprise downstream consumers.
    const RESERVED = new Set([
      'version',
      'spec',
      'services',
      'capabilities',
      'payment_handlers',
      'signing_keys',
      'name',
      'signature',
      '__proto__',
      'constructor',
      'prototype',
    ]);
    for (const k of Object.keys(input.extras)) {
      if (RESERVED.has(k)) {
        throw new Error(`buildUCPProfile: extras key "${k}" collides with a reserved profile field; rejected.`);
      }
    }
    Object.assign(profile, input.extras);
  }

  return profile;
}

export const AGENTSCORE_UCP_CAPABILITY = AGENTSCORE_CAPABILITY_NAME;
