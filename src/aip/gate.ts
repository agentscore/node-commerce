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

export interface AipGateOptions {
  jwks: JwksCache;
  now?: number;
  maxSkewSeconds?: number;
}

export type AipGateResult =
  | { ok: true; ait: VerifiedAit }
  | { ok: false; failure: VerifyAitFailure };

/** Verify the AIP credential from a pre-built context. Shared by all adapter entry points. */
const verifyFromContext = async (ctx: VerifyRequestContext, opts: AipGateOptions): Promise<AipGateResult> => {
  const result = await verifyAit(ctx, { jwks: opts.jwks, now: opts.now, maxSkewSeconds: opts.maxSkewSeconds });
  return result.ok ? { ok: true, ait: result.ait } : { ok: false, failure: result.reason };
};

/** Verify the AIP credential on a standard Fetch `Request` (Hono / Web / Next.js). */
export const verifyAitRequest = (req: Request, opts: AipGateOptions): Promise<AipGateResult> =>
  verifyFromContext(buildVerifyContextFromRequest(req), opts);

/** Verify the AIP credential from Express/Fastify-style parts (Node header map + method + url). */
export const verifyAitParts = (
  parts: { method: string; url: string; headers: Record<string, string | string[] | undefined>; authority?: string },
  opts: AipGateOptions,
): Promise<AipGateResult> => verifyFromContext(buildVerifyContextFromParts(parts), opts);

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

/**
 * Build an RFC 9457 problem-details body for an AIP verify failure. Adapters serialize this
 * as `application/problem+json` with {@link aipErrorStatus}.
 */
export const buildAipErrorBody = (failure: VerifyAitFailure): {
  type: string;
  title: string;
  status: number;
  detail: string;
} => {
  const code = aipErrorCode(failure);
  return {
    type: `urn:aip:error:${code}`,
    title: code.replace(/_/g, ' '),
    status: aipErrorStatus(failure),
    detail: aipErrorDetail(failure),
  };
};
