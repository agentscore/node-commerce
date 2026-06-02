/**
 * AIP Agent Identity Token (AIT) verification pipeline — the verifier orchestrator.
 *
 * This is the function a merchant gate calls. It executes the spec's verification steps over
 * a presented request, composing the three foundation modules:
 *   - {@link ./jwks}        — trusted-issuer enforcement + key discovery
 *   - {@link ./http-signature} — RFC 9421 proof-of-possession over the request
 *   - {@link ./types}       — AIT structural contract
 *
 * Steps (per spec):
 *   1. read the `Agent-Identity` header (one or more)
 *   2. decode the JWT header (`kid`) + payload; confirm AIT shape (`cnf` + `agent`)
 *   3. resolve the IdP's signing key from its JWKS (trusted-issuer + HTTPS enforced)
 *   4. verify the IdP signature on the JWT (reject `alg:none`; key is Ed25519)
 *   5. check `exp` / `iat` with skew
 *   6. extract `cnf.jwk`
 *   7. verify the RFC 9421 HTTP Message Signature with `cnf.jwk`
 *   8. confirm the signature `keyid` == JWK thumbprint of `cnf.jwk`  (done inside step 7)
 *
 * On success it returns the validated, signature-checked claims. On failure it returns a
 * typed reason that maps onto AIP's wire error codes (the gate turns these into 401/403).
 */

import { decodeJwt, decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import { verifyMessageSignature } from './http-signature';
import { isAitShape, validateAitPayload, type AitPayload } from './types';
import type { JwksCache } from './jwks';

/** Header that carries the AIT JWT. */
export const AGENT_IDENTITY_HEADER = 'agent-identity';

/** Request fields the verifier needs. Framework-agnostic; adapters map their req onto this. */
export interface VerifyRequestContext {
  method: string;
  authority: string;
  path: string;
  /** All `Agent-Identity` header values present on the request (one per IdP). */
  agentIdentityHeaders: string[];
  signatureInput: string | null;
  signature: string | null;
}

export interface VerifyAitOptions {
  jwks: JwksCache;
  now?: number;
  maxSkewSeconds?: number;
}

/**
 * Failure reasons, aligned with AIP wire error codes. The gate maps:
 *   no_token / malformed_token / invalid_signature / expired_token  → 401
 *   untrusted_issuer / weak_auth / invalid_claims                   → 403
 */
export type VerifyAitFailure =
  | 'no_token'
  | 'malformed_token'
  | 'untrusted_issuer'
  | 'key_unavailable'
  | 'idp_signature_invalid'
  | 'expired_token'
  | 'invalid_claims'
  | 'pop_signature_missing'
  | 'pop_signature_invalid';

export interface VerifiedAit {
  payload: AitPayload;
  /** The issuer (canonical, as presented). */
  iss: string;
  /** The agent's bound public key (`cnf.jwk`). */
  cnfJwk: AitPayload['cnf']['jwk'];
  /** The raw JWT string that verified (the winning `Agent-Identity` header value, Bearer
   *  prefix stripped). Lets a gate forward the exact token to `/v1/assess` as `aip_token`. */
  token: string;
}

export type VerifyAitResult =
  | { ok: true; ait: VerifiedAit }
  | { ok: false; reason: VerifyAitFailure };

/**
 * Verify the AIP credential on a request. When multiple `Agent-Identity` headers are present,
 * each is tried; the first that fully verifies AND whose `cnf.jwk` matches the request's
 * RFC 9421 signature wins (all AITs on one request must share the same `cnf` key, so the PoP
 * signature is checked once against the winning key).
 */
export const verifyAit = async (
  ctx: VerifyRequestContext,
  opts: VerifyAitOptions,
): Promise<VerifyAitResult> => {
  if (ctx.agentIdentityHeaders.length === 0) {
    return { ok: false, reason: 'no_token' };
  }
  if (!ctx.signatureInput || !ctx.signature) {
    return { ok: false, reason: 'pop_signature_missing' };
  }

  let lastFailure: VerifyAitFailure = 'malformed_token';

  for (const raw of ctx.agentIdentityHeaders) {
    const token = stripBearer(raw);

    // Step 2: decode header + payload, confirm AIT shape.
    let header: { alg?: string; kid?: string };
    let payload: unknown;
    try {
      header = decodeProtectedHeader(token);
      payload = decodeJwt(token);
    } catch {
      lastFailure = 'malformed_token';
      continue;
    }
    if (header.alg === undefined || header.alg.toLowerCase() === 'none') {
      lastFailure = 'malformed_token';
      continue;
    }
    if (!isAitShape(payload)) {
      lastFailure = 'malformed_token';
      continue;
    }

    // Structural contract (incl. human_confirmed→amr).
    const validated = validateAitPayload(payload);
    if (!validated.ok) {
      lastFailure = 'invalid_claims';
      continue;
    }
    const claims = validated.payload;

    // Step 3: resolve IdP key (trusted-issuer + HTTPS enforced inside).
    const keyLookup = await opts.jwks.getKey(claims.iss, header.kid);
    if (!keyLookup.ok) {
      // `untrusted_issuer` (not on the allowlist) and `insecure_issuer` (http:// issuer) are both
      // PERMANENT trust failures → 403, not the retryable 503 of `key_unavailable` (a transient
      // JWKS-fetch problem). Don't tell an agent to retry a config error it can't fix.
      lastFailure =
        keyLookup.reason === 'untrusted_issuer' || keyLookup.reason === 'insecure_issuer'
          ? 'untrusted_issuer'
          : 'key_unavailable';
      continue;
    }

    // Step 4 + 5: verify IdP signature; enforce alg match + expiry/skew. The JWT iat/exp tolerance
    // and the RFC 9421 PoP `created`/`expires` window are both 60s (the AIP spec's recommended
    // window). An explicit `maxSkewSeconds` override, when set, applies to both.
    const jwtClockTolerance = opts.maxSkewSeconds ?? 60;
    try {
      const idpKey = await importJWK(keyLookup.key, normalizeAlg(header.alg));
      await jwtVerify(token, idpKey, {
        // Pin the signature algorithm allowlist (RFC 8725 §3.1) — also rejects `alg:none`. Without
        // this, jose accepts whatever alg the resolved JWK supports, so a trusted IdP publishing a
        // non-Ed25519 (e.g. RSA/EC) `use:sig` key would let an attacker present an RS256/ES256
        // token that verifies. Matches the server-side allowlist in core/api aip-verify.
        algorithms: AIT_SIGNING_ALGS,
        clockTolerance: jwtClockTolerance,
        currentDate: opts.now !== undefined ? new Date(opts.now * 1000) : undefined,
      });
    } catch (err) {
      lastFailure = isExpiry(err) ? 'expired_token' : 'idp_signature_invalid';
      continue;
    }

    // Spec step 5 also requires `iat` not be in the future. jose's `jwtVerify` validates `exp`/`nbf`
    // but does not reject a future `iat` by default, so check it explicitly (same skew tolerance).
    const nowSec = opts.now ?? Math.floor(Date.now() / 1000);
    if (claims.iat > nowSec + jwtClockTolerance) {
      lastFailure = 'expired_token';
      continue;
    }

    // Step 6 + 7 + 8: PoP — verify the RFC 9421 signature against cnf.jwk.
    const popResult = await verifyMessageSignature({
      method: ctx.method,
      authority: ctx.authority,
      path: ctx.path,
      agentIdentity: raw,
      signatureInput: ctx.signatureInput,
      signature: ctx.signature,
      cnfJwk: claims.cnf.jwk,
      now: opts.now,
      maxSkewSeconds: opts.maxSkewSeconds,
    });
    if (!popResult.ok) {
      lastFailure = 'pop_signature_invalid';
      continue;
    }

    return { ok: true, ait: { payload: claims, iss: claims.iss, cnfJwk: claims.cnf.jwk, token } };
  }

  return { ok: false, reason: lastFailure };
};

/** Strip an optional `Bearer ` prefix from a header value. */
const stripBearer = (value: string): string => {
  const trimmed = value.trim();
  return /^bearer\s+/i.test(trimmed) ? trimmed.replace(/^bearer\s+/i, '') : trimmed;
};

/** Map a JWT header `alg` to the JOSE alg name jose expects for key import. */
/** Allowed AIT JWT signature algorithms (RFC 8725 §3.1 allowlist). EdDSA is AIP's default; ES256
 *  is permitted for parity with the server-side verifier. Anything else (RS*, HS*, none) is
 *  rejected at `jwtVerify`, regardless of what alg the token header claims or the resolved JWK
 *  supports. */
const AIT_SIGNING_ALGS = ['EdDSA', 'ES256'];

const normalizeAlg = (alg: string): string => (alg.toLowerCase() === 'eddsa' ? 'EdDSA' : alg);

/** jose throws JWTExpired with code 'ERR_JWT_EXPIRED' on expiry. */
const isExpiry = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ERR_JWT_EXPIRED';
