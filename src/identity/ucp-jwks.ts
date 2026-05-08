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

const JOSE_INSTALL_HINT = 'Install the optional peer dependency: `npm install jose@^5` (or `bun add jose`).';

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

/** Deterministic JSON.stringify with lexicographic key ordering at every level. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
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
 * import { generateUCPSigningKey } from '@agent-score/commerce/identity/ucp-jwks';
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

  const canonicalBody = canonicalizeProfile(profile);
  const payloadBytes = new TextEncoder().encode(canonicalBody);

  const signature = await new jose.CompactSign(payloadBytes)
    .setProtectedHeader({ alg, kid: opts.kid, typ: 'ucp-profile+jws' })
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
  const jose = await loadJose();

  const stripped = { ...profile } as Partial<SignedUCPProfile>;
  const sig = stripped.signature;
  delete stripped.signature;
  if (!sig) throw new Error('UCP profile has no `signature` field; expected JWS Compact Serialization.');

  const canonicalBody = canonicalizeProfile(stripped as UCPProfile);
  const expectedPayload = new TextEncoder().encode(canonicalBody);

  const { payload: signedPayload } = await jose.compactVerify(sig, async (header) => {
    const kid = header.kid;
    if (!kid) throw new Error('UCP signature header missing `kid`.');
    const jwk = jwks.keys.find((k) => (k as Record<string, unknown>).kid === kid);
    if (!jwk) throw new Error(`No JWK in JWKS matching kid=${kid}.`);
    return jose.importJWK(jwk as Parameters<typeof jose.importJWK>[0], header.alg);
  });

  // Compare the bytes that were actually signed against the canonical body of the
  // profile we received. `compactVerify` validates the JWS against the bytes embedded
  // in the JWS payload segment — but the profile body could have been swapped after
  // signing while the JWS stayed unchanged. Body-vs-payload comparison closes that
  // gap.
  if (!constantTimeEqual(signedPayload, expectedPayload)) {
    throw new Error('UCP profile body does not match the signed payload (tampered or non-canonical).');
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
 * import { buildJWKSResponse } from '@agent-score/commerce/identity/ucp-jwks';
 *
 * app.get('/.well-known/jwks.json', (c) =>
 *   c.json(buildJWKSResponse([publicJWK]))
 * );
 * ```
 */
export function buildJWKSResponse(keys: UCPSigningKey[]): JWKSResponse {
  return { keys };
}
