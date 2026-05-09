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

const JOSE_INSTALL_HINT = 'Install the optional peer dependency: `npm install jose@^5` (or `bun add jose`). Tested against jose v5.x.';

/** UCP §6 + RFC 8725 §3.1 — restrict accepted JWS algorithms. Anything outside this
 *  list (HS, RS, none, etc.) is rejected to prevent alg-confusion attacks where a
 *  hostile JWK published in the profile's signing_keys[] is used with an unintended
 *  algorithm. */
const ALLOWED_ALGS = ['EdDSA', 'ES256'] as const;
type AllowedAlg = (typeof ALLOWED_ALGS)[number];

/** UCP §6.2 — JWS protected header `typ` value. Verifiers SHOULD enforce this to
 *  prevent cross-protocol token reuse (RFC 8725 §3.11). */
const UCP_TYP = 'ucp-profile+jws';

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
    .setProtectedHeader({ alg, kid: opts.kid, typ: UCP_TYP })
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

  // Run compactVerify (which fires header validation via the key-resolver
  // callback: typ → alg → kid → JWK lookup) BEFORE canonicalizing the stripped
  // profile body. Header-level violations therefore take precedence over body
  // canonicalization errors, matching the Python sibling's _peek_jws_header
  // ordering. Cross-language parity means a profile with both a malformed body
  // AND a malformed JWS header surfaces the same `code` in both SDKs.
  let signedPayload: Uint8Array;
  try {
    const verified = await jose.compactVerify(
      sig,
      async (header) => {
        // Header check order is typ → alg → kid to match the Python sibling's
        // _peek_jws_header. A profile with multiple header faults (e.g. typ=JWT
        // AND alg=HS256) must surface the same `code` from both SDKs; the
        // `algorithms` option on compactVerify is intentionally omitted because
        // jose enforces it BEFORE invoking this resolver, which would short-circuit
        // typ before we could check it. The callback covers the same RFC 8725 §3.1
        // restriction below.
        // RFC 8725 §3.11 — enforce expected typ to prevent cross-protocol token reuse.
        if (header.typ !== UCP_TYP) {
          throw new UCPVerificationError('wrong_typ', `UCP signature typ must be "${UCP_TYP}"; got ${String(header.typ)}.`);
        }
        // RFC 8725 §3.1 — restrict to allow-listed algorithms before key resolution
        // so a hostile JWK can never be used with HS256/none/RS256/etc.
        if (!ALLOWED_ALGS.includes(header.alg as AllowedAlg)) {
          throw new UCPVerificationError('unsupported_alg', `UCP signing alg must be one of ${ALLOWED_ALGS.join(', ')}; got ${String(header.alg)}.`);
        }
        const kid = header.kid;
        // Strict string check — a non-string kid (number/bool/null) could
        // accidentally match a JWK with an equal-typed kid and mask attacks.
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
        const matchedKey = matches[0] as Record<string, unknown>;
        if (matchedKey.use !== undefined && matchedKey.use !== 'sig') {
          throw new UCPVerificationError('unusable_key', `JWK with kid=${kid} has use=${JSON.stringify(matchedKey.use)}; expected "sig".`);
        }
        // RFC 7517 §4.4: a JWK with a declared `alg` field constrains its use to that algorithm.
        if (matchedKey.alg !== undefined && matchedKey.alg !== header.alg) {
          throw new UCPVerificationError(
            'unusable_key',
            `JWK alg ${JSON.stringify(matchedKey.alg)} does not match JWS header alg ${JSON.stringify(header.alg)}.`,
          );
        }
        return jose.importJWK(matches[0] as Parameters<typeof jose.importJWK>[0], header.alg);
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
