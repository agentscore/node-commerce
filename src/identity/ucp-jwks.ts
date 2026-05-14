/**
 * UCP profile signing helpers (JWKS + JWS).
 *
 * UCP §6 (https://ucp.dev/latest/specification/signatures/) requires that profiles
 * published at `/.well-known/ucp` carry a JWKS-backed signature for trust-mode clients
 * (Google AI Mode, Gemini commerce, future ChatGPT app shells). Without a signature,
 * trust-mode clients reject the profile.
 *
 * This module provides:
 *   - `generateUCPSigningKey()` — generate an Ed25519 keypair for signing
 *   - `signUCPProfile()` — sign a UCP profile body, returning a JWS-attached envelope
 *   - `verifyUCPProfile()` — verify a signed profile against a JWKS
 *   - `buildJWKSResponse()` — assemble a JWKS document for `/.well-known/jwks.json`
 *
 * Implementation rides on `jose` (peer-dep, optional). Merchants who don't sign their
 * profile (development) skip this module entirely; the unsigned `buildUCPProfile()`
 * path still works.
 *
 * Why Ed25519: smaller signatures (64 bytes vs 256+ for RSA), faster verification, no
 * curve-parameter ceremony. UCP also accepts ES256 (P-256 ECDSA) — pass `alg: 'ES256'`
 * to `signUCPProfile()` if your existing payment signing key is P-256.
 */

import type { UCPProfile, UCPSigningKey } from './ucp';

/** Output of `generateUCPSigningKey()`. The private key is what you sign with; the
 *  public JWK is what you publish at `/.well-known/jwks.json` and reference in the
 *  UCP profile's `signing_keys[]`.
 */
export interface GeneratedUCPKey {
  /** Private key (KeyLike, opaque) — pass to `signUCPProfile()`. Never publish. */
  privateKey: unknown;
  /** Public key as JWK — publish at `/.well-known/jwks.json` and inline in UCP `signing_keys[]`. */
  publicJWK: UCPSigningKey;
}

/** A JWKS document — `{ keys: [...] }` per RFC 7517. Serve at `/.well-known/jwks.json`. */
export interface JWKSResponse {
  keys: UCPSigningKey[];
}

/** Options for `signUCPProfile()`. */
export interface SignUCPProfileOptions {
  /** Private signing key — opaque KeyLike from `generateUCPSigningKey()` or `importJWK()`. */
  signingKey: unknown;
  /** Key ID (must match a `kid` in the profile's `signing_keys[]`). */
  kid: string;
  /** Signing algorithm — `EdDSA` (default) or `ES256`. */
  alg?: 'EdDSA' | 'ES256';
}

/** A signed UCP profile envelope. Same shape as `UCPProfile` plus the `signature` field
 *  carrying the JWS Compact Serialization over the canonicalized profile body. */
export interface SignedUCPProfile extends UCPProfile {
  /** JWS Compact Serialization (`<header>.<payload>.<signature>`) over the profile body
   *  with `signature` removed and keys sorted. Verifiers reconstruct the canonical body
   *  and validate against the JWK identified by `kid` in the JWS protected header. */
  signature: string;
}

const JOSE_INSTALL_HINT = 'Install the optional peer dependency: `npm install jose@^6` (or `bun add jose`). Tested against jose v6.x.';

/** UCP §6 + RFC 8725 §3.1 — restrict accepted JWS algorithms. Anything outside this
 *  list (HS, RS, none, etc.) is rejected to prevent alg-confusion attacks where a
 *  hostile JWK published in the profile's signing_keys[] is used with an unintended
 *  algorithm. */
const ALLOWED_ALGS = ['EdDSA', 'ES256'] as const;
type AllowedAlg = (typeof ALLOWED_ALGS)[number];

/** JWS protected header `typ` value. Vendor-namespaced because UCP §6 does not define
 *  a profile-as-JWS typ; the value advertises that this signed envelope follows the
 *  AgentScore extension semantics rather than a UCP-canonical signing convention.
 *  Verifiers SHOULD enforce this to prevent cross-protocol token reuse (RFC 8725 §3.11). */
const PROFILE_TYP = 'agentscore-profile+jws';

/** Discriminated error class so consumers can branch on failure mode without
 *  parsing message strings or importing jose internals. */
export class UCPVerificationError extends Error {
  constructor(
    public readonly code:
      | 'no_signature'
      | 'missing_kid'
      | 'kid_not_found'
      | 'duplicate_kid'
      | 'unsupported_alg'
      | 'wrong_typ'
      | 'signature_invalid'
      | 'body_mismatch'
      | 'malformed_jws'
      | 'malformed_jwks'
      | 'unrecognized_critical_header'
      | 'unusable_key',
    message: string,
  ) {
    super(message);
    this.name = 'UCPVerificationError';
  }
}

async function loadJose(): Promise<typeof import('jose')> {
  try {
    return await import('jose');
  } catch (err) {
    throw new Error(
      `UCP signing requires the \`jose\` library, which is an optional peer dependency. ${JOSE_INSTALL_HINT}\nOriginal error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Canonicalize a UCP profile for signing. Removes the `signature` field (if present),
 * sorts keys deterministically, and returns the JSON string. Both signer and verifier
 * compute the same bytes.
 *
 * Implementation note: UCP §6.2 specifies "the JSON-serialized profile body, with
 * `signature` removed and keys ordered lexicographically at every nesting level." This
 * is JCS-style canonicalization without the full RFC 8785 numeric handling — UCP
 * profiles don't contain floats so the simpler key-sort is sufficient.
 */
function canonicalizeProfile(profile: UCPProfile): string {
  const stripped = { ...profile } as Record<string, unknown>;
  delete stripped.signature;
  return stableStringify(stripped);
}

/** Deterministic JSON.stringify with lexicographic key ordering at every level.
 *  Rejects ANY non-finite Number (NaN, Infinity, -Infinity) and any Number
 *  whose value has a fractional part OR whose JSON representation may diverge
 *  cross-language. Cross-language float canonicalization (RFC 8785 §3.2.2.3)
 *  is not stable between Node's JSON.stringify and Python's json.dumps
 *  (e.g. `1.0` → `1` vs `1.0`, `1e-7` → `1e-7` vs `1e-07`). UCP profiles
 *  must use decimal strings for monetary or fractional fields to preserve
 *  byte parity with the Python sibling. */
function stableStringify(value: unknown): string {
  if (value === undefined) {
    throw new Error(
      'stableStringify: undefined values are not allowed in canonicalized JSON. ' +
        'Object fields with no value must be omitted.',
    );
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`stableStringify: ${typeof value} values are not allowed in canonicalized JSON.`);
  }
  if (typeof value === 'bigint') {
    throw new Error('stableStringify: BigInt values are not allowed; use a decimal string.');
  }
  if (value instanceof Date) {
    throw new Error(
      'stableStringify: Date instances are not allowed; serialize to an ISO string before passing.',
    );
  }
  if (value instanceof Map || value instanceof Set || value instanceof WeakMap || value instanceof WeakSet) {
    throw new Error(
      `stableStringify: ${value.constructor.name} values are not allowed; convert to a plain object/array first.`,
    );
  }
  if (ArrayBuffer.isView(value)) {
    throw new Error('stableStringify: typed arrays are not allowed; convert to a plain array first.');
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(
        `UCP profile canonicalization rejects non-finite Number ${value}. Use a decimal string for any value that may be NaN/Infinity.`,
      );
    }
    if (!Number.isInteger(value)) {
      throw new Error(
        `UCP profile canonicalization rejects non-integer Number ${value}. Use a decimal string (e.g. "9.99") for monetary or fractional fields to preserve cross-language byte-parity.`,
      );
    }
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `stableStringify: integer ${value} exceeds Number.MAX_SAFE_INTEGER. ` +
          'For values >2^53, use a decimal string to preserve cross-language byte parity.',
      );
    }
  }
  if (typeof value === 'string') {
    // Cross-language byte parity: pre-ES2019 V8 (and any environment whose
    // JSON.stringify still escapes U+2028 / U+2029) emits \u2028 / \u2029
    // for these codepoints, while Python's json.dumps with ensure_ascii=False
    // emits them raw. A string carrying either would canonicalize to different
    // bytes across the Node and Python siblings and break signature
    // verification at the language boundary. Mirror the rejection in
    // core/api/src/lib/canonicalize.ts so the contract stays symmetric.
    if (value.includes('\u2028') || value.includes('\u2029')) {
      throw new Error(
        'stableStringify: strings containing U+2028 (LINE SEPARATOR) or U+2029 (PARAGRAPH SEPARATOR) are not allowed; cross-language byte parity requires neither be present (Node JSON.stringify on older V8 escapes them; Python json.dumps with ensure_ascii=False does not).',
      );
    }
    return JSON.stringify(value);
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort((a, b) => {
    const aPoints = [...a].map((c) => c.codePointAt(0)!);
    const bPoints = [...b].map((c) => c.codePointAt(0)!);
    const len = Math.min(aPoints.length, bPoints.length);
    for (let i = 0; i < len; i += 1) {
      if (aPoints[i] !== bPoints[i]) return aPoints[i] - bPoints[i];
    }
    return aPoints.length - bPoints.length;
  });
  // Cross-language byte parity: same rejection rationale as the string-value
  // branch above. Object keys flow through JSON.stringify(k) at the pairs line
  // below, so without this check a key carrying U+2028 / U+2029 would pass on
  // modern V8 but Python's _reject_unsafe_numbers (which recurses into dict
  // keys) would throw at verify time.
  for (const k of keys) {
    if (k.includes(' ') || k.includes(' ')) {
      throw new Error(
        'stableStringify: object keys containing U+2028 (LINE SEPARATOR) or U+2029 (PARAGRAPH SEPARATOR) are not allowed; cross-language byte parity (Node JSON.stringify on older V8 escapes them; Python json.dumps with ensure_ascii=False does not).',
      );
    }
  }
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${pairs.join(',')}}`;
}

/**
 * Generate a fresh Ed25519 (default) or ES256 keypair for signing UCP profiles.
 *
 * The `privateKey` is an opaque KeyLike — store it server-side and pass to
 * `signUCPProfile()`. Never log or transmit the private key.
 *
 * The `publicJWK` is what you publish at `/.well-known/jwks.json` and inline in the
 * UCP profile's `signing_keys[]` array.
 *
 * Example:
 * ```ts
 * import { generateUCPSigningKey } from '@agent-score/commerce';
 *
 * const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: 'merchant-2026-05' });
 * // Persist privateKey securely (env var, KMS, secret manager).
 * // Publish publicJWK at /.well-known/jwks.json and reference it in your UCP profile.
 * ```
 */
export async function generateUCPSigningKey(opts: {
  /** Key ID (kid). Must be unique per key; you'll reference this in the UCP profile's `signing_keys[]`. */
  kid: string;
  /** Signing algorithm. Default `EdDSA`. */
  alg?: 'EdDSA' | 'ES256';
}): Promise<GeneratedUCPKey> {
  const jose = await loadJose();
  const alg = opts.alg ?? 'EdDSA';
  const { privateKey, publicKey } = await jose.generateKeyPair(alg, { extractable: true });
  const exportedJwk = await jose.exportJWK(publicKey);

  const publicJWK: UCPSigningKey = {
    kid: opts.kid,
    alg,
    use: 'sig',
    ...exportedJwk,
  } as UCPSigningKey;

  return { privateKey, publicJWK };
}

/**
 * Sign a UCP profile, returning a new envelope with the JWS attached as `signature`.
 *
 * The signature covers the canonicalized profile body (everything except `signature`
 * itself, with keys sorted at every level). Trust-mode UCP verifiers reconstruct the
 * canonical body, look up the key referenced by the JWS header's `kid`, and validate.
 *
 * The profile's `signing_keys[]` MUST already include a JWK with the matching `kid`
 * — otherwise verifiers can't find the public key. Add the `publicJWK` from
 * `generateUCPSigningKey()` to your `signing_keys[]` before calling this.
 *
 * Example:
 * ```ts
 * const profile = buildUCPProfile({ ..., signing_keys: [publicJWK] });
 * const signed = await signUCPProfile(profile, { signingKey: privateKey, kid: 'merchant-2026-05' });
 * c.json(signed);
 * ```
 */
export async function signUCPProfile(
  profile: UCPProfile,
  opts: SignUCPProfileOptions,
): Promise<SignedUCPProfile> {
  const jose = await loadJose();
  const alg = opts.alg ?? 'EdDSA';

  if (!ALLOWED_ALGS.includes(alg as AllowedAlg)) {
    throw new Error(
      `signUCPProfile: alg ${JSON.stringify(opts.alg)} is not in the supported set [${ALLOWED_ALGS.join(', ')}].`,
    );
  }

  // Sign-time kid sanity check: the profile's `signing_keys[]` MUST contain a
  // JWK with the matching kid; otherwise verifiers can't resolve the public
  // key and the profile is dead-on-arrival. Catch this at sign-time rather
  // than at verifier-time in production.
  if (typeof opts.kid !== 'string' || !opts.kid) {
    throw new Error('signUCPProfile: opts.kid must be a non-empty string.');
  }
  const kids = (profile.signing_keys ?? []).map((k) => (k as Record<string, unknown>).kid);
  if (!kids.includes(opts.kid)) {
    throw new Error(
      `signUCPProfile: kid ${JSON.stringify(opts.kid)} is not present in profile.signing_keys[] (declared kids: ${JSON.stringify(kids)}). Verifiers will not find the key.`,
    );
  }

  const canonicalBody = canonicalizeProfile(profile);
  const payloadBytes = new TextEncoder().encode(canonicalBody);

  const signature = await new jose.CompactSign(payloadBytes)
    .setProtectedHeader({ alg, kid: opts.kid, typ: PROFILE_TYP })
    .sign(opts.signingKey as Parameters<typeof jose.CompactSign.prototype.sign>[0]);

  return { ...profile, signature };
}

/**
 * Verify a signed UCP profile against a JWKS. Returns `true` when the JWS validates
 * against a matching key in `jwks`; throws on signature mismatch, missing key, or
 * canonicalization drift.
 *
 * Round-trip helper for tests and for cross-merchant verification flows. Trust-mode
 * UCP clients use the same algorithm.
 *
 * Example:
 * ```ts
 * const ok = await verifyUCPProfile(signedProfile, { keys: [publicJWK] });
 * ```
 */
export async function verifyUCPProfile(
  profile: SignedUCPProfile,
  jwks: JWKSResponse,
): Promise<boolean> {
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new UCPVerificationError(
      'no_signature',
      `UCP profile must be a JSON object; got ${profile === null ? 'null' : Array.isArray(profile) ? 'array' : typeof profile}.`,
    );
  }

  const jose = await loadJose();

  // JWKS shape guard so a malformed argument emits a typed UCPVerificationError
  // rather than a raw TypeError on `.filter is not a function`.
  if (!jwks || typeof jwks !== 'object' || !Array.isArray((jwks as { keys?: unknown }).keys)) {
    throw new UCPVerificationError(
      'malformed_jwks',
      `UCP verifier expected JWKS shape { keys: [...] }; got ${jwks === null ? 'null' : typeof jwks === 'object' ? 'object without keys[] array' : typeof jwks}.`,
    );
  }

  const stripped = { ...profile } as Partial<SignedUCPProfile>;
  const sig = stripped.signature;
  delete stripped.signature;
  if (typeof sig !== 'string' || !sig) {
    throw new UCPVerificationError(
      'no_signature',
      `UCP profile signature must be a non-empty string; got ${sig === undefined ? 'undefined' : typeof sig}.`,
    );
  }

  // Pre-decode the protected header so typ → alg → kid → crit checks run BEFORE
  // jose's compactVerify. jose enforces `crit` internally ahead of the key-resolver
  // callback, which would surface `unrecognized_critical_header` on a JWS that
  // also has a wrong typ; the python-commerce sibling's `_peek_jws_header` decodes
  // the header manually and checks typ first. Mirroring that ordering here means
  // a JWS with multiple header faults emits the same `code` in both SDKs.
  let header: { alg?: unknown; kid?: unknown; typ?: unknown; crit?: unknown };
  try {
    const protectedB64 = sig.split('.')[0];
    if (!protectedB64) throw new Error('JWS protected header segment is empty.');
    const headerJson = new TextDecoder().decode(jose.base64url.decode(protectedB64));
    const parsed = JSON.parse(headerJson);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('JWS protected header is not a JSON object.');
    }
    header = parsed as { alg?: unknown; kid?: unknown; typ?: unknown; crit?: unknown };
  } catch (err) {
    throw new UCPVerificationError(
      'malformed_jws',
      `JWS protected header is not valid base64url-encoded JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Header check order is typ → alg → kid → crit to match the Python sibling's
  // _peek_jws_header. RFC 8725 §3.11: enforce expected typ to prevent
  // cross-protocol token reuse.
  if (header.typ !== PROFILE_TYP) {
    throw new UCPVerificationError('wrong_typ', `UCP signature typ must be "${PROFILE_TYP}"; got ${String(header.typ)}.`);
  }
  // RFC 8725 §3.1: restrict to allow-listed algorithms before key resolution
  // so a hostile JWK can never be used with HS256/none/RS256/etc.
  if (!ALLOWED_ALGS.includes(header.alg as AllowedAlg)) {
    throw new UCPVerificationError('unsupported_alg', `UCP signing alg must be one of ${ALLOWED_ALGS.join(', ')}; got ${String(header.alg)}.`);
  }
  // Strict string check: a non-string kid (number/bool/null) could accidentally
  // match a JWK with an equal-typed kid and mask attacks.
  if (typeof header.kid !== 'string' || !header.kid) {
    throw new UCPVerificationError(
      'missing_kid',
      `UCP signature header kid must be a non-empty string; got ${header.kid === undefined ? 'undefined' : typeof header.kid}.`,
    );
  }
  // RFC 7515 §4.1.11: `crit` MUST be a non-empty array of strings if present.
  // Shape-check first (matches python-commerce's malformed_jws split) so that
  // explicit `crit: null` / `crit: []` / `crit: "foo"` / `crit: [42]` aren't
  // silently accepted; only well-formed crit arrays fall through to the
  // unrecognized-extension check (RFC 8725 §3.10 — UCP defines no crit headers).
  if ('crit' in header) {
    const crit = (header as { crit?: unknown }).crit;
    if (!Array.isArray(crit) || crit.length === 0 || !crit.every((c) => typeof c === 'string')) {
      throw new UCPVerificationError(
        'malformed_jws',
        `JWS protected header crit must be a non-empty array of strings; got ${JSON.stringify(crit)}.`,
      );
    }
    throw new UCPVerificationError(
      'unrecognized_critical_header',
      `JWS protected header advertises unrecognized crit headers: ${JSON.stringify(crit)}.`,
    );
  }

  let signedPayload: Uint8Array;
  try {
    const verified = await jose.compactVerify(
      sig,
      async (h) => {
        // typ/alg/kid/crit were validated up-front against the pre-decoded header;
        // this resolver only handles JWK lookup. Re-checking kid here keeps the
        // jose API satisfied and provides defense-in-depth against any header
        // re-parse divergence between this code path and jose's internals.
        const kid = h.kid;
        if (typeof kid !== 'string' || !kid) {
          throw new UCPVerificationError(
            'missing_kid',
            `UCP signature header kid must be a non-empty string; got ${kid === undefined ? 'undefined' : typeof kid}.`,
          );
        }
        const matches = jwks.keys.filter(
          (k) => k != null && typeof k === 'object' && (k as Record<string, unknown>).kid === kid,
        );
        if (matches.length === 0) throw new UCPVerificationError('kid_not_found', `No JWK in JWKS matching kid=${JSON.stringify(kid)}.`);
        if (matches.length > 1) throw new UCPVerificationError('duplicate_kid', `JWKS contains ${matches.length} keys with kid=${JSON.stringify(kid)}; expected exactly one.`);
        // RFC 7517 §4.2: reject keys not intended for signature verification.
        // `use` and `alg` are optional per RFC 7517; an explicit JSON null is
        // out-of-spec but treat it as absent (skip-on-null) so a JWK with
        // `"use": null` matches Python's `is not None` semantics in
        // ucp_jwks.py and the two languages stay symmetric.
        const matchedKey = matches[0] as Record<string, unknown>;
        if (matchedKey.use != null && matchedKey.use !== 'sig') {
          throw new UCPVerificationError('unusable_key', `JWK with kid=${kid} has use=${JSON.stringify(matchedKey.use)}; expected "sig".`);
        }
        // RFC 7517 §4.4: a JWK with a declared `alg` field constrains its use to that algorithm.
        if (matchedKey.alg != null && matchedKey.alg !== h.alg) {
          throw new UCPVerificationError(
            'unusable_key',
            `JWK alg ${JSON.stringify(matchedKey.alg)} does not match JWS header alg ${JSON.stringify(h.alg)}.`,
          );
        }
        return jose.importJWK(matches[0] as Parameters<typeof jose.importJWK>[0], h.alg);
      },
    );
    signedPayload = verified.payload;
  } catch (err) {
    if (err instanceof UCPVerificationError) throw err;
    if (err instanceof Error && err.name === 'JOSEAlgNotAllowed') {
      throw new UCPVerificationError('unsupported_alg', `UCP signing alg not allowed: ${err.message}`);
    }
    if (err instanceof Error && err.name === 'JWSSignatureVerificationFailed') {
      throw new UCPVerificationError('signature_invalid', `UCP signature verification failed: ${err.message}`);
    }
    if (err instanceof Error && err.name === 'JWSInvalid') {
      throw new UCPVerificationError('malformed_jws', `Malformed JWS: ${err.message}`);
    }
    // RFC 7515 §4.1.11 / RFC 8725 §3.10: a verifier MUST reject any JWS whose
    // `crit` header carries an extension the implementation doesn't understand.
    // jose throws JOSENotSupported; wrap so callers see the typed error.
    if (err instanceof Error && err.name === 'JOSENotSupported') {
      throw new UCPVerificationError('unrecognized_critical_header', `UCP signing rejected unrecognized critical header: ${err.message}`);
    }
    throw err;
  }

  let canonicalBody: string;
  try {
    canonicalBody = canonicalizeProfile(stripped as UCPProfile);
  } catch (err) {
    throw new UCPVerificationError(
      'body_mismatch',
      `Failed to canonicalize received profile for verification: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const expectedPayload = new TextEncoder().encode(canonicalBody);

  // Compare the bytes that were actually signed against the canonical body of the
  // profile we received. `compactVerify` validates the JWS against the bytes embedded
  // in the JWS payload segment, but the profile body could have been swapped after
  // signing while the JWS stayed unchanged. Body-vs-payload comparison closes that
  // gap.
  if (!constantTimeEqual(signedPayload, expectedPayload)) {
    throw new UCPVerificationError('body_mismatch', 'UCP profile body does not match the signed payload (tampered or non-canonical).');
  }

  return true;
}

/** Constant-time byte comparison to avoid leaking length / position info on mismatch. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/**
 * Build a JWKS document for `/.well-known/jwks.json`.
 *
 * Example:
 * ```ts
 * import { buildJWKSResponse } from '@agent-score/commerce';
 *
 * app.get('/.well-known/jwks.json', (c) =>
 *   c.json(buildJWKSResponse([publicJWK]))
 * );
 * ```
 */
export function buildJWKSResponse(keys: UCPSigningKey[]): JWKSResponse {
  return { keys };
}

// ── env-driven loader (extracted from store + martin + signed_ucp_merchant) ──

interface ResolvedLoadUCPSigningKeyOpts {
  envJwkVar: string;
  envKidVar: string;
  envAlgVar: string;
  defaultKid: string;
  defaultAlg: 'EdDSA' | 'ES256';
}

const DEFAULT_LOAD_OPTS: ResolvedLoadUCPSigningKeyOpts = {
  envJwkVar: 'UCP_SIGNING_KEY_JWK_PRIVATE',
  envKidVar: 'UCP_SIGNING_KEY_KID',
  envAlgVar: 'UCP_SIGNING_KEY_ALG',
  defaultKid: 'merchant-default',
  defaultAlg: 'EdDSA',
};

function readEnvTrimmed(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function detectAlgFromJwk(jwk: Record<string, unknown>): 'EdDSA' | 'ES256' | null {
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') return 'EdDSA';
  if (jwk.kty === 'EC' && jwk.crv === 'P-256') return 'ES256';
  return null;
}

// Cache entries are keyed by the full resolved opts (so different opts get separate
// entries) and store the IN-FLIGHT Promise — concurrent first-callers with the same
// opts await the same key generation rather than racing to produce different ephemeral
// keys (a losing keypair signing a JWS that the published JWKS then rejects).
const envLoaderCache = new Map<string, Promise<GeneratedUCPKey>>();

function cacheKey(opts: ResolvedLoadUCPSigningKeyOpts): string {
  return `${opts.envJwkVar}|${opts.envKidVar}|${opts.envAlgVar}|${opts.defaultKid}|${opts.defaultAlg}`;
}

async function buildEnvSigningKey(
  opts: ResolvedLoadUCPSigningKeyOpts,
): Promise<GeneratedUCPKey> {
  const kidDefault = readEnvTrimmed(opts.envKidVar) ?? opts.defaultKid;
  // Case-insensitive env-alg comparison: secret configs commonly carry casing drift
  // (`"es256"`, `" ES256 "`, `"eS256"`). Strict exact-match would silently downgrade
  // to the default and operators would publish a JWKS with the wrong key family.
  const rawAlg = (readEnvTrimmed(opts.envAlgVar) ?? '').toUpperCase();
  const algFallback: 'EdDSA' | 'ES256' = rawAlg === 'ES256' ? 'ES256' : opts.defaultAlg;

  const envJwk = readEnvTrimmed(opts.envJwkVar);
  if (envJwk) {
    let jwkDict: Record<string, unknown>;
    try {
      jwkDict = JSON.parse(envJwk) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `${opts.envJwkVar} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!jwkDict || typeof jwkDict !== 'object' || Array.isArray(jwkDict) || Object.keys(jwkDict).length === 0) {
      throw new Error(`${opts.envJwkVar} must be a non-empty JWK object.`);
    }

    const detectedAlg = detectAlgFromJwk(jwkDict);
    if (!detectedAlg) {
      throw new Error(
        `${opts.envJwkVar} has unsupported kty/crv (got kty=${String(jwkDict.kty)} crv=${String(jwkDict.crv)}); ` +
          'expected OKP+Ed25519 or EC+P-256.',
      );
    }

    // Project the env JWK to its canonical key fields before importing. Unknown
    // env-JWK fields (`key_ops`, `x5c`, `x5t`, `x5u`, etc.) trip Node's
    // createPublicKey with NotSupportedError on some runtimes; canonical-only
    // input is stable across Node + Bun + browser WebCrypto.
    const canonicalPrivateJwk: Record<string, unknown> =
      detectedAlg === 'EdDSA'
        ? { kty: jwkDict.kty, crv: jwkDict.crv, x: jwkDict.x, d: jwkDict.d }
        : { kty: jwkDict.kty, crv: jwkDict.crv, x: jwkDict.x, y: jwkDict.y, d: jwkDict.d };

    // Import the private key. Sanitize errors so JWK byte material can never reach logs.
    const { importJWK } = await import('jose');
    const { createPublicKey } = await import('node:crypto');
    let privateKey: Awaited<ReturnType<typeof importJWK>>;
    let publicNodeKey: ReturnType<typeof createPublicKey>;
    try {
      privateKey = await importJWK(
        canonicalPrivateJwk as unknown as Parameters<typeof importJWK>[0],
        detectedAlg,
      );
      publicNodeKey = createPublicKey({ key: canonicalPrivateJwk as never, format: 'jwk' });
    } catch (err) {
      const className = err instanceof Error ? err.constructor.name : typeof err;
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as { code?: unknown }).code)
          : null;
      const codeSuffix = code ? ` [${code}]` : '';
      throw new Error(
        `${opts.envJwkVar} has malformed key material (${className}${codeSuffix}). ` +
          'Verify the JWK is well-formed and matches the declared kty/crv. ' +
          'Underlying details suppressed to avoid leaking key bytes.',
      );
    }

    // Derive a canonical public JWK from the public node key — drops `d` and any other
    // private-only fields (and unknown env JWK fields like key_ops, x5c, x5t).
    const publicJWK = publicNodeKey.export({ format: 'jwk' }) as unknown as UCPSigningKey;
    // Empty-string kid in env JWK falls through to the configured default —
    // publishing `"kid": ""` breaks every kid-pinning verifier.
    publicJWK.kid = (jwkDict.kid as string | undefined) || kidDefault;
    publicJWK.alg = detectedAlg;
    publicJWK.use = 'sig';

    return { privateKey, publicJWK };
  }

  // Ephemeral fallback — generate a fresh keypair.
  return generateUCPSigningKey({ kid: kidDefault, alg: algFallback });
}

/**
 * Load the merchant's UCP signing key from env, with concurrent-safe caching.
 *
 * On first call (per `opts`): reads `opts.envJwkVar`, parses it as a JWK, validates
 * `kty`/`crv` (OKP+Ed25519 or EC+P-256), and projects to a canonical public JWK.
 * Falls back to an ephemeral keypair when the env var is missing or whitespace-only.
 *
 * Subsequent calls with the same `opts` return the cached key without re-reading env.
 * Concurrent first-callers await the same in-flight Promise so only one key generation
 * runs (preventing the race where two callers each generate an independent ephemeral
 * pair and one signs a JWS the published JWKS then rejects).
 *
 * Different `opts` values get separate cache entries.
 *
 * Env-driven precedence:
 *
 * - Embedded `kid` in the JWK wins over `opts.envKidVar` env value;
 *   empty-string `kid` in the env JWK falls through to `opts.defaultKid`.
 * - Structural `kty`+`crv` in the JWK wins over `opts.envAlgVar` env value
 *   (which is only consulted in the ephemeral fallback path).
 *
 * @throws Error with a sanitized message for malformed env JWKs; raw exception
 *   detail is intentionally suppressed so key bytes can never reach logs.
 */
export async function loadUCPSigningKeyFromEnv({
  envJwkVar,
  envKidVar,
  envAlgVar,
  defaultKid,
  defaultAlg,
}: {
  /** Env var name carrying the JSON-encoded private JWK. Default `UCP_SIGNING_KEY_JWK_PRIVATE`. */
  envJwkVar?: string;
  /** Env var name carrying an explicit kid override. Default `UCP_SIGNING_KEY_KID`. */
  envKidVar?: string;
  /** Env var name carrying the alg in the ephemeral fallback. Default `UCP_SIGNING_KEY_ALG`. */
  envAlgVar?: string;
  /** Kid to publish when neither the env JWK nor `envKidVar` carries one. Default `merchant-default`. */
  defaultKid?: string;
  /** Alg for the ephemeral fallback path. Default `EdDSA`. */
  defaultAlg?: 'EdDSA' | 'ES256';
} = {}): Promise<GeneratedUCPKey> {
  const resolved: ResolvedLoadUCPSigningKeyOpts = {
    ...DEFAULT_LOAD_OPTS,
    ...(envJwkVar !== undefined && { envJwkVar }),
    ...(envKidVar !== undefined && { envKidVar }),
    ...(envAlgVar !== undefined && { envAlgVar }),
    ...(defaultKid !== undefined && { defaultKid }),
    ...(defaultAlg !== undefined && { defaultAlg }),
  };
  const key = cacheKey(resolved);
  let cached = envLoaderCache.get(key);
  if (cached) return cached;
  // Pin the in-flight Promise so concurrent first-callers await the same generation.
  cached = buildEnvSigningKey(resolved).catch((err) => {
    // Clear on rejection so a transient malformed env doesn't permanently poison
    // every future call — the next caller retries the build.
    envLoaderCache.delete(key);
    throw err;
  });
  envLoaderCache.set(key, cached);
  return cached;
}

/** Test-only: clear the env-loader cache.
 *
 *  Use after stubbing `process.env.UCP_SIGNING_KEY_*` to force the next
 *  {@link loadUCPSigningKeyFromEnv} call to re-read the env state. */
export function _resetUCPSigningKeyCache(): void {
  envLoaderCache.clear();
}
