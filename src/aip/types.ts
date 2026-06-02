/**
 * AIP (Agentic Identity Protocol) token types and the claim contract.
 *
 * An Agent Identity Token (AIT) is a JWT signed by an Identity Provider (IdP). It binds a
 * verified human's identity to the specific agent presenting it (via `cnf`, RFC 7800) and
 * carries the trust level, authentication method, optional intent, and optional identity
 * claims the IdP attests to.
 *
 * This module is the single source of truth for the claim shape on the verifier side. It
 * encodes the spec's required / recommended / optional claims plus the AgentScore extension
 * claims (sanctions, jurisdiction, structured id-verification, cross-merchant graph, payment
 * signer) we carry when we act as a compliance IdP.
 *
 * Extensibility contract (per spec): the `identity` object is open. If a claim is present,
 * the IdP attests to it; verifiers ignore claims they don't recognize. Absence is the
 * "unknown" signal — IdPs do not ship `null` for "not checked".
 */

import type { JWK } from 'jose';

/** Degree of human involvement in issuing this specific AIT. */
export type TrustLevel = 'autonomous' | 'human_present' | 'human_confirmed';

/**
 * Authentication Method Reference values (RFC 8176 / IANA AMR registry). Open set — these
 * are the values relevant to agent identity; others are valid and pass through.
 */
export type AmrValue = 'face' | 'fpt' | 'hwk' | 'otp' | 'pin' | 'pwd' | 'sms' | 'swk' | 'user' | 'mfa';

/** RFC 7800 confirmation claim: binds the AIT to the agent's signing key. */
interface CnfClaim {
  jwk: JWK;
}

/** Agent metadata. `provider` is required; `instance` is recommended. */
interface AgentClaim {
  provider: string;
  instance?: string;
}

/** How the user authorized THIS AIT (not prior authentication history). */
interface AuthClaim {
  amr?: AmrValue[] | string[];
  /** When the user authenticated for this token (Unix seconds). Mirrors OIDC `auth_time`. */
  time?: number;
}

/** What the agent intends to do. Optional; verifiers may require it for non-read actions. */
export interface IntentClaim {
  actions?: string[];
  description?: string;
}

/** AgentScore wallet-binding extension (orthogonal to `cnf`, which binds the agent key). */
interface PaymentSignerClaim {
  address: string;
  network: 'evm' | 'solana';
  /** Relationship the IdP attests between signer and the operator graph. */
  match?: 'linked_operator' | 'claimed_operator';
}

interface PaymentClaim {
  signer?: PaymentSignerClaim;
}

/**
 * Identity claims (presence == IdP attestation). Spec-defined fields plus AgentScore
 * compliance extension claims. Open by contract — unknown fields are allowed and ignored.
 */
export interface IdentityClaim {
  email?: string;
  email_verified?: boolean;
  name?: string;
  phone?: string;
  phone_verified?: boolean;
  age_over_18?: boolean;
  age_over_21?: boolean;
  id_verified?: boolean;

  // --- AgentScore compliance extensions ---
  id_verification?: {
    provider?: string;
    method?: string;
    document_type?: string;
    verified_at?: number;
  };
  /** ISO 3166-1 alpha-2, optionally with ISO 3166-2 subdivision (e.g. "US-CA"). */
  jurisdiction?: string;
  sanctions_clear?: boolean;
  sanctions_checked_at?: number;
  sanctions_providers?: string[];
  linked_wallets?: Array<{ address: string; network: 'evm' | 'solana' }>;
  merchants_paid?: number;
  first_seen?: number;

  // Open extension space.
  [claim: string]: unknown;
}

/** The decoded AIT JWT payload. */
export interface AitPayload {
  aip_version: string;
  iss: string;
  sub: string;
  iat: number;
  exp: number;
  cnf: CnfClaim;
  agent: AgentClaim;
  trust_level?: TrustLevel;
  auth?: AuthClaim;
  intent?: IntentClaim;
  identity?: IdentityClaim;
  payment?: PaymentClaim;
  [claim: string]: unknown;
}

/** The decoded AIT JWT header. */
export interface AitHeader {
  alg: string;
  typ?: string;
  kid?: string;
  [param: string]: unknown;
}

/**
 * Structural validation of a decoded AIT payload. Confirms the required claims are present
 * and well-typed, and enforces the one normative conditional in the spec: a
 * `human_confirmed` token MUST carry at least one `auth.amr` value.
 *
 * This is shape/contract validation only — it does NOT verify signatures (that's the
 * verifier pipeline) and does NOT apply trust policy (that's the gate / `/v1/assess`).
 */
export type AitValidationResult =
  | { ok: true; payload: AitPayload }
  | { ok: false; reason: AitValidationFailure };

type AitValidationFailure =
  | 'not_an_object'
  | 'missing_aip_version'
  | 'missing_iss'
  | 'missing_sub'
  | 'missing_iat'
  | 'missing_exp'
  | 'missing_cnf'
  | 'missing_agent_provider'
  | 'human_confirmed_without_amr';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * Detect whether a decoded JWT payload is an AIT: per spec, an AIT is discriminated by the
 * presence of `cnf` + `agent` claims (not the `typ` header).
 */
export const isAitShape = (payload: unknown): boolean =>
  isObject(payload) && isObject(payload.cnf) && isObject(payload.agent);

/** Validate the structural contract of a decoded AIT payload. */
export const validateAitPayload = (payload: unknown): AitValidationResult => {
  if (!isObject(payload)) { return { ok: false, reason: 'not_an_object' }; }
  if (!isNonEmptyString(payload.aip_version)) { return { ok: false, reason: 'missing_aip_version' }; }
  if (!isNonEmptyString(payload.iss)) { return { ok: false, reason: 'missing_iss' }; }
  if (!isNonEmptyString(payload.sub)) { return { ok: false, reason: 'missing_sub' }; }
  if (typeof payload.iat !== 'number') { return { ok: false, reason: 'missing_iat' }; }
  if (typeof payload.exp !== 'number') { return { ok: false, reason: 'missing_exp' }; }
  if (!isObject(payload.cnf) || !isObject((payload.cnf as Record<string, unknown>).jwk)) {
    return { ok: false, reason: 'missing_cnf' };
  }
  if (!isObject(payload.agent) || !isNonEmptyString((payload.agent as Record<string, unknown>).provider)) {
    return { ok: false, reason: 'missing_agent_provider' };
  }

  // Normative conditional: human_confirmed requires auth.amr with at least one value.
  if (payload.trust_level === 'human_confirmed') {
    const auth = payload.auth;
    const amr = isObject(auth) ? auth.amr : undefined;
    if (!Array.isArray(amr) || amr.length === 0) {
      return { ok: false, reason: 'human_confirmed_without_amr' };
    }
  }

  return { ok: true, payload: payload as AitPayload };
};
