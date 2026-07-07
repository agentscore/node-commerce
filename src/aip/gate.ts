/**
 * Framework-agnostic AIP gate orchestration.
 *
 * `verifyAitRequest` is the one call a framework adapter makes: hand it a standard `Request`
 * plus a {@link JwksCache}, and it returns the verified AIT claims or a typed failure. The
 * helpers here also map that failure onto the AIP wire contract — HTTP status + error code +
 * an RFC 9457 problem-details body — so every adapter renders denials identically.
 *
 * This layer does identity *verification* only (is this a real, key-bound AIT from a trusted
 * IdP?). Policy enrichment — sanctions, jurisdiction, cross-merchant graph — happens when the
 * merchant additionally feeds the verified claims to `/v1/assess`; that's the gate's choice,
 * not something this module forces.
 */

import { buildVerifyContextFromParts, buildVerifyContextFromRequest } from './request';
import { verifyAit, type VerifiedAit, type VerifyAitFailure, type VerifyRequestContext } from './verify';
import type { JwksCache } from './jwks';
import type { TrustLevel } from './types';

export interface AipGateOptions {
  jwks: JwksCache;
  now?: number;
  maxSkewSeconds?: number;
  /** Expected `@authority` (public hostname) the RFC 9421 signature must cover. When set, the
   *  verifier binds the signature to this value instead of trusting the inbound `Host` header —
   *  pin it to your real public host (e.g. `'wine.example.com'`) when behind a proxy or
   *  multi-vhost listener that does not normalize `Host`, to prevent a captured AIT+signature
   *  from being replayed to a different virtual host on the same origin. Same semantics as
   *  Checkout's `AipGateConfig.authority`. */
  authority?: string;
  /** Minimum `trust_level` (autonomous < human_present < human_confirmed) the AIT must assert —
   *  the spec's human-presence gate. Insufficient → 403 weak_auth with `required_trust_level`.
   *  Enforced by {@link evaluateAipRequest} / {@link evaluateAipParts}. Unset = any trust level. */
  requireTrustLevel?: TrustLevel;
  /** Acceptable `auth.amr` methods (RFC 8176); the AIT must carry ≥1. Insufficient → 403 weak_auth
   *  with `required_amr`. Unset = not enforced. */
  requireAmr?: string[];
  /** Identity claims the endpoint needs — surfaced as `required_claims` on insufficient_claims
   *  denials so the agent can self-correct. Advisory only (enforce by feeding the verified claims
   *  to your own policy / `/v1/assess`; this gate does identity + trust_level/amr). */
  requiredClaims?: string[];
  /** Trusted issuer URLs surfaced as `trusted_issuers` on untrusted_issuer denials. */
  trustedIssuers?: string[];
}

export type AipGateResult =
  | { ok: true; ait: VerifiedAit }
  | { ok: false; failure: VerifyAitFailure };

/** Verify the AIP credential from a pre-built context. Shared by all adapter entry points. */
const verifyFromContext = async (ctx: VerifyRequestContext, opts: AipGateOptions): Promise<AipGateResult> => {
  const result = await verifyAit(ctx, { jwks: opts.jwks, now: opts.now, maxSkewSeconds: opts.maxSkewSeconds });
  return result.ok ? { ok: true, ait: result.ait } : { ok: false, failure: result.reason };
};

/** Apply the gate's configured `authority` pin to a parts object: an explicit per-call
 *  `parts.authority` (e.g. Checkout's) wins, then the gate option, then the inbound `Host`. */
const partsWithAuthority = (
  parts: { method: string; url: string; headers: Record<string, string | string[] | undefined>; authority?: string },
  opts: AipGateOptions,
): typeof parts => {
  const authority = parts.authority ?? opts.authority;
  return authority !== undefined ? { ...parts, authority } : parts;
};

/** Verify the AIP credential on a standard Fetch `Request` (Hono / Web / Next.js). */
export const verifyAitRequest = (req: Request, opts: AipGateOptions): Promise<AipGateResult> =>
  verifyFromContext(buildVerifyContextFromRequest(req, opts.authority), opts);

/** Verify the AIP credential from Express/Fastify-style parts (Node header map + method + url). */
export const verifyAitParts = (
  parts: { method: string; url: string; headers: Record<string, string | string[] | undefined>; authority?: string },
  opts: AipGateOptions,
): Promise<AipGateResult> => verifyFromContext(buildVerifyContextFromParts(partsWithAuthority(parts, opts)), opts);

/** Map an internal verify failure to the AIP wire error code (per spec error taxonomy). */
export const aipErrorCode = (failure: VerifyAitFailure): string => {
  switch (failure) {
    case 'no_token':
    case 'pop_signature_missing':
      return 'agent_identity_required';
    case 'untrusted_issuer':
      return 'untrusted_issuer';
    case 'expired_token':
      return 'expired_token';
    case 'invalid_claims':
      return 'insufficient_claims';
    case 'key_unavailable':
      // The IdP's JWKS could not be fetched/resolved — our infra couldn't reach a trusted
      // issuer, not a client-side auth failure. Distinct code so agents back off + retry
      // rather than uselessly re-signing.
      return 'idp_unavailable';
    case 'malformed_token':
    case 'idp_signature_invalid':
    case 'pop_signature_invalid':
      return 'invalid_signature';
    default:
      return 'invalid_signature';
  }
};

/** HTTP status for an AIP verify failure: 503 when our infra couldn't reach the IdP (retryable),
 *  403 for trust/claims, 401 for auth-presence/signature. */
export const aipErrorStatus = (failure: VerifyAitFailure): 401 | 403 | 503 => {
  switch (failure) {
    case 'key_unavailable':
      return 503;
    case 'untrusted_issuer':
    case 'invalid_claims':
      return 403;
    default:
      return 401;
  }
};

/** Human-readable detail for the failure, for the problem-details body. */
const aipErrorDetail = (failure: VerifyAitFailure): string => {
  switch (failure) {
    case 'no_token':
      return 'No Agent-Identity token was presented.';
    case 'pop_signature_missing':
      return 'The request is missing the RFC 9421 HTTP Message Signature that proves possession of the token-bound key.';
    case 'untrusted_issuer':
      return "The token's issuer is not in this service's trusted-issuer list.";
    case 'expired_token':
      return 'The Agent Identity Token has expired.';
    case 'invalid_claims':
      return 'The token is missing required claims for this endpoint.';
    case 'malformed_token':
      return 'The Agent-Identity header could not be parsed as an Agent Identity Token.';
    case 'idp_signature_invalid':
      return "The identity provider's signature on the token failed verification.";
    case 'pop_signature_invalid':
      return 'The request signature did not match the key bound to the token.';
    case 'key_unavailable':
      return "The identity provider's signing key could not be resolved.";
    default:
      return 'Token verification failed.';
  }
};

/** RFC 9457 problem-details body for an AIP denial. Known fields are typed; `required_*` /
 *  `trusted_issuers` escalation extensions ride in the index signature. */
export type AipErrorBody = { type: string; title: string; status: number; detail: string; [k: string]: unknown };

/** Merchant requirements attached to an AIP escalation body so the agent can self-correct. */
export interface AipErrorRequirements {
  trustedIssuers?: string[];
  requiredClaims?: string[];
  requiredTrustLevel?: TrustLevel;
  requiredAmr?: string[];
}

/**
 * Build an RFC 9457 problem-details body for an AIP verify failure. Adapters serialize this as
 * `application/problem+json` with {@link aipErrorStatus}. Optionally carries the merchant's
 * requirements — `trusted_issuers` on untrusted_issuer; `required_claims` / `required_trust_level` /
 * `required_amr` on insufficient_claims — so the agent learns what would satisfy the gate.
 */
export const buildAipErrorBody = (failure: VerifyAitFailure, requirements?: AipErrorRequirements): AipErrorBody => {
  const code = aipErrorCode(failure);
  const body: AipErrorBody = {
    type: `urn:aip:error:${code}`,
    title: code.replace(/_/g, ' '),
    status: aipErrorStatus(failure),
    detail: aipErrorDetail(failure),
  };
  if (requirements) {
    if (code === 'untrusted_issuer' && requirements.trustedIssuers?.length) {
      body.trusted_issuers = requirements.trustedIssuers;
    }
    if (code === 'insufficient_claims') {
      if (requirements.requiredClaims?.length) body.required_claims = requirements.requiredClaims;
      if (requirements.requiredTrustLevel !== undefined) body.required_trust_level = requirements.requiredTrustLevel;
      if (requirements.requiredAmr?.length) body.required_amr = requirements.requiredAmr;
    }
  }
  return body;
};

/**
 * Map an AgentScore *policy-deny* code (a `/v1/assess` decision, NOT a verify failure) to its
 * spec AIP error code + HTTP status. This is the policy-side counterpart to {@link aipErrorCode}
 * (which maps the verify-FAILURE taxonomy). On the AIT-input path a denied `/v1/assess` decision
 * surfaces as one of these AgentScore codes; the spec's fixed error set expresses each as:
 *  - `token_expired` → `expired_token` (401)
 *  - `invalid_credential` → `invalid_signature` (401)
 *  - `api_error` → `idp_unavailable` (503, transient — the claims couldn't be evaluated)
 *  - everything else (compliance: `wallet_not_trusted` + `sanctions_flagged` / `age_insufficient`
 *    / `jurisdiction_restricted` / `kyc_*`) → `insufficient_claims` (403): the AIT did not attest
 *    (or attested a failing value for) the required compliance claim.
 */
export const aipPolicyDenyCode = (code: string): { code: string; status: 401 | 403 | 503 } => {
  switch (code) {
    case 'token_expired':
      return { code: 'expired_token', status: 401 };
    case 'invalid_credential':
      return { code: 'invalid_signature', status: 401 };
    case 'api_error':
      return { code: 'idp_unavailable', status: 503 };
    default:
      return { code: 'insufficient_claims', status: 403 };
  }
};

/**
 * Wrap an AgentScore AIT-path denial body in the RFC 9457 + AIP-spec superset.
 *
 * Reuses {@link buildAipErrorBody}'s SHAPE convention (`type`/`title`/`status`/`detail` +
 * escalation extensions) but for the *policy-deny* case — a verified AIT that `/v1/assess` then
 * denied — which carries an AgentScore compliance/credential code, not a verify-failure reason.
 *
 * The result is a SUPERSET: the canonical `{ error, agent_instructions, ... }` body is spread in
 * verbatim (so existing consumers keep parsing `error.code`), with the RFC 9457 envelope layered
 * on top. `detail` names the precise AgentScore reason(s); `error.code` stays the AgentScore code.
 * Escalation fields (`required_claims` / `required_trust_level` / `required_amr` on
 * insufficient_claims, `trusted_issuers` on untrusted_issuer) ride along when known.
 */
export const buildAipPolicyDenyBody = (
  code: string,
  reasons: string[] | undefined,
  body: Record<string, unknown>,
  requirements?: AipErrorRequirements,
): Record<string, unknown> => {
  const spec = aipPolicyDenyCode(code);
  const reasonList = reasons ?? [];
  const detail =
    spec.code === 'insufficient_claims'
      ? reasonList.length > 0
        ? `The Agent Identity Token did not attest a passing value for the required compliance claim(s). AgentScore decision: ${code} (${reasonList.join(', ')}).`
        : `The Agent Identity Token did not satisfy the merchant's compliance policy. AgentScore decision: ${code}.`
      : `AgentScore decision: ${code}.`;
  const superset: Record<string, unknown> = {
    type: `urn:aip:error:${spec.code}`,
    title: spec.code.replace(/_/g, ' '),
    status: spec.status,
    detail,
  };
  // Escalation extensions, scoped exactly as the spec mandates: `required_claims` /
  // `required_trust_level` / `required_amr` on insufficient_claims. `trusted_issuers` belongs to
  // untrusted_issuer — a VERIFY failure that never reaches the policy-deny path — so it is not
  // emitted here (the edge-deny `buildAipErrorBody` owns that one).
  if (requirements && spec.code === 'insufficient_claims') {
    if (requirements.requiredClaims?.length) superset.required_claims = requirements.requiredClaims;
    if (requirements.requiredTrustLevel !== undefined) superset.required_trust_level = requirements.requiredTrustLevel;
    if (requirements.requiredAmr?.length) superset.required_amr = requirements.requiredAmr;
  }
  // Spread the canonical body LAST so `error` / `agent_instructions` / `reasons` win verbatim —
  // the RFC 9457 fields are additive and never clobber the rich AgentScore scheme. The envelope
  // fields themselves (`type` / `title` / `status` / `detail`) are RESERVED the other way: the
  // canonical body never carries them legitimately, but a merchant `onBeforeSession` hook's
  // `extra` rides through `denialReasonToBody` unfiltered — strip them so a smuggled `status`
  // can't rewrite the problem+json envelope (or the HTTP status Checkout derives from it).
  const { type: _type, title: _title, status: _status, detail: _detail, ...rest } = body;
  return { ...superset, ...rest };
};

/** Trust-level ordering: a token satisfies a requirement when its level ≥ the required level. */
const TRUST_RANK: Record<string, number> = { autonomous: 0, human_present: 1, human_confirmed: 2 };

/**
 * Check a verified AIT against the gate's `trust_level` / `auth.amr` requirements (the spec's
 * human-presence gate). Returns a detail string when insufficient (→ weak_auth), else null.
 */
export const checkTrustRequirements = (
  payload: { trust_level?: string | undefined; auth?: { amr?: string[] | undefined } | undefined },
  requiredTrustLevel?: TrustLevel,
  requiredAmr?: string[],
): string | null => {
  if (requiredTrustLevel !== undefined) {
    const have = TRUST_RANK[payload.trust_level ?? 'autonomous'] ?? 0;
    const need = TRUST_RANK[requiredTrustLevel] ?? 0;
    if (have < need) {
      return `This endpoint requires trust_level '${requiredTrustLevel}'; the token asserts '${payload.trust_level ?? 'autonomous'}'. Re-mint an AIT at the required trust level (human confirmation).`;
    }
  }
  if (requiredAmr !== undefined && requiredAmr.length > 0) {
    const amr = Array.isArray(payload.auth?.amr) ? payload.auth!.amr! : [];
    if (!amr.some((m) => requiredAmr.includes(m))) {
      return `This endpoint requires an authentication method in [${requiredAmr.join(', ')}]; the token carries [${amr.join(', ') || 'none'}].`;
    }
  }
  return null;
};

/** Build an RFC 9457 `weak_auth` body for a token that failed the trust_level / auth.amr gate. */
export const buildAipWeakAuthBody = (opts: {
  detail: string;
  requiredTrustLevel?: TrustLevel;
  requiredAmr?: string[];
  trustedIssuers?: string[];
}): AipErrorBody => ({
  type: 'urn:aip:error:weak_auth',
  title: 'weak auth',
  status: 403,
  detail: opts.detail,
  ...(opts.requiredTrustLevel !== undefined && { required_trust_level: opts.requiredTrustLevel }),
  ...(opts.requiredAmr !== undefined && opts.requiredAmr.length > 0 && { required_amr: opts.requiredAmr }),
  ...(opts.trustedIssuers !== undefined && opts.trustedIssuers.length > 0 && { trusted_issuers: opts.trustedIssuers }),
});

/** A verified AIT, or a ready-to-render RFC 9457 denial body (HTTP status on `body.status`). */
export type AipGateEvaluation =
  | { ok: true; ait: VerifiedAit }
  | { ok: false; body: AipErrorBody };

/** Collect the merchant's requirements from gate options, for attaching to denial bodies. */
const requirementsFromOptions = (opts: AipGateOptions): AipErrorRequirements => ({
  ...(opts.trustedIssuers !== undefined && { trustedIssuers: opts.trustedIssuers }),
  ...(opts.requiredClaims !== undefined && { requiredClaims: opts.requiredClaims }),
  ...(opts.requireTrustLevel !== undefined && { requiredTrustLevel: opts.requireTrustLevel }),
  ...(opts.requireAmr !== undefined && { requiredAmr: opts.requireAmr }),
});

/**
 * Verify the AIP credential AND enforce the gate's trust_level / auth.amr requirement in one call —
 * the standalone-adapter counterpart to {@link verifyAitRequest}. Returns the verified AIT, or an
 * RFC 9457 denial body (a verify failure → its wire code; trust insufficient → weak_auth) carrying
 * the merchant's `required_*` / `trusted_issuers` so the agent can self-correct.
 */
const evaluateFromContext = async (ctx: VerifyRequestContext, opts: AipGateOptions): Promise<AipGateEvaluation> => {
  const result = await verifyAit(ctx, { jwks: opts.jwks, now: opts.now, maxSkewSeconds: opts.maxSkewSeconds });
  if (!result.ok) {
    return { ok: false, body: buildAipErrorBody(result.reason, requirementsFromOptions(opts)) };
  }
  const weak = checkTrustRequirements(result.ait.payload, opts.requireTrustLevel, opts.requireAmr);
  if (weak !== null) {
    return {
      ok: false,
      body: buildAipWeakAuthBody({
        detail: weak,
        ...(opts.requireTrustLevel !== undefined && { requiredTrustLevel: opts.requireTrustLevel }),
        ...(opts.requireAmr !== undefined && { requiredAmr: opts.requireAmr }),
        ...(opts.trustedIssuers !== undefined && { trustedIssuers: opts.trustedIssuers }),
      }),
    };
  }
  return { ok: true, ait: result.ait };
};

/** Verify + trust-enforce on a standard Fetch `Request` (Hono / Web / Next.js adapters). */
export const evaluateAipRequest = (req: Request, opts: AipGateOptions): Promise<AipGateEvaluation> =>
  evaluateFromContext(buildVerifyContextFromRequest(req, opts.authority), opts);

/** Verify + trust-enforce from Express/Fastify-style parts (Node header map + method + url). */
export const evaluateAipParts = (
  parts: { method: string; url: string; headers: Record<string, string | string[] | undefined>; authority?: string },
  opts: AipGateOptions,
): Promise<AipGateEvaluation> => evaluateFromContext(buildVerifyContextFromParts(partsWithAuthority(parts, opts)), opts);
