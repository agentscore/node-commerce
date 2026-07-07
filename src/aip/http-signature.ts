/**
 * RFC 9421 HTTP Message Signatures — the AIP-constrained subset.
 *
 * AIP (Agentic Identity Protocol) binds an Agent Identity Token (AIT) to the
 * agent that presents it: the agent signs each HTTP request with the private key whose
 * public half is carried in the AIT's `cnf.jwk` (RFC 7800). A verifier reconstructs the
 * RFC 9421 signature base, verifies it against `cnf.jwk`, and confirms the signature's
 * `keyid` equals the JWK thumbprint (RFC 7638) of that key. A stolen AIT is then useless
 * without the bound private key.
 *
 * This module implements ONLY the shape AIP uses, not the full RFC 9421 grammar:
 *
 *   - Covered components: the derived components `@method`, `@authority`, `@path`, plus the
 *     `agent-identity` header field. (The AIP "minimum required" set.) Extra components in a
 *     presented signature are accepted and covered if the caller supplies their values.
 *   - One labeled signature per request, tagged `tag="agent-identity"`. Web Bot Auth
 *     signatures (`tag="web-bot-auth"`) may coexist on the same request under a different
 *     label; we select ours by tag, ignoring the rest.
 *   - Algorithm: Ed25519 (EdDSA over OKP/Ed25519). AIP's default and only signing curve.
 *
 * The structured-field parsing here is deliberately narrow: it parses the AIP member of the
 * `Signature-Input` / `Signature` dictionaries (a parenthesized inner list + integer/string
 * params, and a single byte-sequence value). It is not a general RFC 8941 parser.
 */

import { calculateJwkThumbprint, importJWK, type JWK } from 'jose';

const { subtle } = globalThis.crypto;

/** Runtime-agnostic base64 (standard, not base64url) codecs. The verify path runs on every AIT
 *  check, including the Fetch-native web / nextjs adapters that target Cloudflare Workers / Vercel
 *  Edge where the Node `Buffer` global is undefined — so decode/encode via `atob`/`btoa`, which are
 *  available on every standards runtime (and Node ≥16). */
const b64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i); }
  return out;
};

const bytesToB64 = (bytes: Uint8Array): string => {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) { bin += String.fromCharCode(bytes[i]!); }
  return btoa(bin);
};

/** The AIP "minimum required" covered components, in canonical order. */
export const AIP_COVERED_COMPONENTS = ['@method', '@authority', '@path', 'agent-identity'] as const;

/** Tag that identifies the AIP signature among coexisting RFC 9421 signatures. */
export const AIP_SIGNATURE_TAG = 'agent-identity';

/** Default clock-skew tolerance (seconds) for `created` / `expires`. Aligned to the AIP spec's
 *  recommended 60s window (and to the JWT iat/exp tolerance) so the whole AIP check uses one value. */
const DEFAULT_MAX_SKEW_SECONDS = 60;

/** Hard ceiling on the PoP signature's own declared lifetime (`expires - created`), in seconds.
 *  Requiring `created`+`expires` bounds replay to the declared window — but with no ceiling a
 *  malicious trusted-issuer agent could set `expires = created + (AIT lifetime)` and replay for the
 *  full window. Cap it tightly so every accepted PoP is short-lived. First-party `pay` signs a 60s
 *  window, so it passes; this only bites a signer that declares an over-long PoP. Matches the
 *  authoritative API verifier's `MAX_POP_WINDOW_SECONDS` (the AgentScore API verifier) so the
 *  edge (standalone `aipGate`) and the API can't drift. (Distinct from the AIT JWT's `exp - iat`
 *  ceiling in verify.ts — this is the HTTP-signature layer.) */
export const MAX_POP_WINDOW_SECONDS = 120;

/** Parameters parsed from (or used to build) a `Signature-Input` member. */
export interface SignatureParams {
  components: string[];
  created?: number;
  expires?: number;
  keyid?: string;
  tag?: string;
  alg?: string;
}

export interface VerifyMessageSignatureInput {
  /** HTTP method, e.g. `POST`. Case-insensitive; normalized to upper. */
  method: string;
  /** Authority (host[:port]), e.g. `wine-merchant.com`. Lowercased; default ports dropped. */
  authority: string;
  /** Request path (no query), e.g. `/checkout`. */
  path: string;
  /** Raw value of the `Agent-Identity` header the signature covers. */
  agentIdentity: string;
  /** Raw `Signature-Input` header value. */
  signatureInput: string;
  /** Raw `Signature` header value. */
  signature: string;
  /** The agent's public key from the AIT's `cnf.jwk`. */
  cnfJwk: JWK;
  /** Wall-clock seconds; defaults to now. Injectable for tests. */
  now?: number;
  /** Skew tolerance for created/expires. Defaults to {@link DEFAULT_MAX_SKEW_SECONDS}. */
  maxSkewSeconds?: number;
  /** Extra covered-component values, keyed by component name (for components beyond the AIP minimum). */
  extraComponents?: Record<string, string>;
}

export type VerifyFailureReason =
  | 'no_aip_signature'
  | 'malformed_signature_input'
  | 'malformed_signature'
  | 'unsupported_alg'
  | 'missing_keyid'
  | 'keyid_mismatch'
  | 'missing_covered_component'
  | 'created_missing'
  | 'expires_missing'
  | 'pop_window_too_long'
  | 'created_in_future'
  | 'expired'
  | 'unsupported_cnf_key'
  | 'signature_invalid';

export type VerifyMessageSignatureResult =
  | { ok: true; params: SignatureParams }
  | { ok: false; reason: VerifyFailureReason };

/**
 * Normalize an authority for `@authority` per RFC 9421 §2.2.3: lowercase, drop the default
 * port for the scheme. We don't know the scheme here, so we drop the common defaults (80/443).
 */
export const normalizeAuthority = (authority: string): string => {
  const lower = authority.trim().toLowerCase();
  const colon = lower.lastIndexOf(':');
  if (colon === -1) { return lower; }
  // Guard against IPv6 literals like `[::1]` with no port.
  if (lower.includes(']') && colon < lower.indexOf(']')) { return lower; }
  const host = lower.slice(0, colon);
  const port = lower.slice(colon + 1);
  if (port === '80' || port === '443') { return host; }
  return lower;
};

/** Serialize one derived/header component value into its signature-base line value. */
const componentValue = (
  name: string,
  input: { method: string; authority: string; path: string; agentIdentity: string; extra?: Record<string, string> },
): string | null => {
  switch (name) {
    case '@method':
      return input.method.toUpperCase();
    case '@authority':
      return normalizeAuthority(input.authority);
    case '@path':
      return input.path;
    case 'agent-identity':
      return input.agentIdentity.trim();
    default:
      return input.extra?.[name] ?? null;
  }
};

/** Serialize the inner-list of covered components: `("@method" "@authority" ...)`. */
const serializeComponentList = (components: string[]): string =>
  `(${components.map((c) => `"${c}"`).join(' ')})`;

/** Serialize the `;k=v` params suffix in canonical order. */
const serializeParams = (p: SignatureParams): string => {
  const parts: string[] = [];
  if (p.created !== undefined) { parts.push(`created=${p.created}`); }
  if (p.expires !== undefined) { parts.push(`expires=${p.expires}`); }
  if (p.keyid !== undefined) { parts.push(`keyid="${p.keyid}"`); }
  if (p.alg !== undefined) { parts.push(`alg="${p.alg}"`); }
  if (p.tag !== undefined) { parts.push(`tag="${p.tag}"`); }
  return parts.map((s) => `;${s}`).join('');
};

/**
 * Build the RFC 9421 signature base: one line per covered component, then the
 * `@signature-params` line. Components are joined by `\n` with no trailing newline.
 * Throws if a covered component has no available value.
 *
 * On the VERIFY path, pass `rawSignatureParams` — the member value exactly as received from
 * `Signature-Input` — so the base reproduces the signer's serialization byte-for-byte regardless
 * of the order they emitted the params in (RFC 9421 §2.3 puts no order on them). Without it the
 * line is re-serialized in our canonical order (the SIGN path), which would wrongly reject a
 * spec-legal signer that ordered params differently.
 */
export const buildSignatureBase = (
  params: SignatureParams,
  input: { method: string; authority: string; path: string; agentIdentity: string; extra?: Record<string, string> },
  rawSignatureParams?: string,
): string => {
  const lines: string[] = [];
  for (const name of params.components) {
    const value = componentValue(name, input);
    if (value === null) {
      throw new MissingComponentError(name);
    }
    lines.push(`"${name}": ${value}`);
  }
  const paramsValue = rawSignatureParams ?? serializeComponentList(params.components) + serializeParams(params);
  lines.push(`"@signature-params": ${paramsValue}`);
  return lines.join('\n');
};

class MissingComponentError extends Error {
  constructor(public component: string) {
    super(`signature base missing covered component: ${component}`);
    this.name = 'MissingComponentError';
  }
}

/**
 * Parse a `Signature-Input` dictionary and return the member tagged `tag`. The tag is REQUIRED
 * (the AIP spec mandates `tag="agent-identity"`): an untagged member is skipped like any
 * wrong-tagged member. `rawParams` is the member's value exactly as received (the inner list +
 * its parameters, byte-for-byte, trimmed of surrounding OWS only) — the verifier echoes it into
 * the `"@signature-params"` base line so the signer's param order is preserved.
 * Returns null if no AIP member is found or the member is malformed.
 */
export const parseSignatureInput = (header: string, tag = AIP_SIGNATURE_TAG): { label: string; params: SignatureParams; rawParams: string } | null => {
  const members = splitDictionary(header);
  if (members.length === 0) { return null; }

  const parsed = members
    .map((m) => {
      const params = parseInnerListMember(m.value);
      return params ? { label: m.label, params, rawParams: m.value } : null;
    })
    .filter((x): x is { label: string; params: SignatureParams; rawParams: string } => x !== null);

  if (parsed.length === 0) { return null; }

  return parsed.find((p) => p.params.tag === tag) ?? null;
};

/**
 * Parse a `Signature` dictionary and return the byte-sequence value for `label`.
 * RFC 8941 byte sequences are `:<base64>:`.
 */
export const parseSignatureValue = (header: string, label: string): Uint8Array | null => {
  const members = splitDictionary(header);
  const member = members.find((m) => m.label === label);
  if (!member) { return null; }
  const v = member.value.trim();
  if (!v.startsWith(':') || !v.endsWith(':') || v.length < 2) { return null; }
  const b64 = v.slice(1, -1);
  try {
    return b64ToBytes(b64);
  } catch {
    return null;
  }
};

/** A single `label=value` member of a structured-field dictionary. */
interface DictMember { label: string; value: string; }

/**
 * Split a dictionary header into `label=value` members at top-level commas, respecting
 * parentheses (inner lists) and colon-delimited byte sequences so commas inside them
 * don't split. Narrow but correct for the AIP shapes we emit/consume.
 */
const splitDictionary = (header: string): DictMember[] => {
  const out: DictMember[] = [];
  let depth = 0;
  let inBytes = false;
  let inString = false;
  let current = '';
  for (let i = 0; i < header.length; i++) {
    const ch = header[i];
    if (inString) {
      current += ch;
      if (ch === '"' && header[i - 1] !== '\\') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; current += ch; continue; }
    if (ch === ':') { inBytes = !inBytes; current += ch; continue; }
    if (!inBytes && ch === '(') { depth++; current += ch; continue; }
    if (!inBytes && ch === ')') { depth = Math.max(0, depth - 1); current += ch; continue; }
    if (!inBytes && depth === 0 && ch === ',') {
      pushMember(out, current);
      current = '';
      continue;
    }
    current += ch;
  }
  pushMember(out, current);
  return out;
};

const pushMember = (out: DictMember[], raw: string): void => {
  const trimmed = raw.trim();
  if (!trimmed) { return; }
  const eq = trimmed.indexOf('=');
  if (eq === -1) { return; }
  const label = trimmed.slice(0, eq).trim();
  const value = trimmed.slice(eq + 1).trim();
  if (label) { out.push({ label, value }); }
};

/** Parse an inner-list member value: `("@method" ...);created=...;keyid="...";tag="..."`. */
const parseInnerListMember = (value: string): SignatureParams | null => {
  const open = value.indexOf('(');
  const close = value.indexOf(')', open + 1);
  if (open === -1 || close === -1) { return null; }
  const listBody = value.slice(open + 1, close).trim();
  const components = listBody.length === 0
    ? []
    : (listBody.match(/"[^"]*"/g) ?? []).map((s) => s.slice(1, -1));

  const params: SignatureParams = { components };
  const paramStr = value.slice(close + 1);
  // Match ;key=value where value is an integer or a quoted string.
  const re = /;\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*("(?:[^"\\]|\\.)*"|-?\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(paramStr)) !== null) {
    const key = match[1];
    const raw = match[2];
    const val = raw.startsWith('"') ? raw.slice(1, -1) : Number(raw);
    if (key === 'created') { params.created = val as number; }
    else if (key === 'expires') { params.expires = val as number; }
    else if (key === 'keyid') { params.keyid = val as string; }
    else if (key === 'tag') { params.tag = val as string; }
    else if (key === 'alg') { params.alg = val as string; }
  }
  return params;
};

/**
 * Verify an AIP HTTP Message Signature. Performs the full check:
 *   1. select the AIP-tagged member of `Signature-Input`
 *   2. confirm the AIP minimum covered components are present
 *   3. REQUIRE both `created` and `expires`, reject an over-long declared window
 *      (`expires - created` > MAX_POP_WINDOW_SECONDS → `pop_window_too_long`), then enforce them
 *      against `now` with skew tolerance. Both are mandatory: an optional time bound is no time
 *      bound — without `expires` a captured `(token, Signature-Input, Signature)` triple is
 *      replayable for the whole AIT lifetime. A signature omitting either is rejected
 *      (`created_missing` / `expires_missing`). This matches the authoritative API verifier
 *      (the AgentScore API verifier) so a merchant running `aipGate` STANDALONE (the
 *      crypto-identity-only deployment with no `/v1/assess`) gets the same replay defense.
 *   4. confirm `keyid` equals the RFC 7638 thumbprint of `cnf.jwk`
 *   5. reconstruct the signature base and verify Ed25519 over it
 *
 * NOTE: this is a STATELESS verifier — it bounds the replay WINDOW but does not dedupe within it.
 * A captured triple can still be replayed until `expires` (≤ MAX_POP_WINDOW_SECONDS + skew from
 * `created`). A stateful seen-signature cache (as in the authoritative API) is out of scope for the
 * SDK edge; the tight window bound is the meaningful mitigation here.
 */
export const verifyMessageSignature = async (
  input: VerifyMessageSignatureInput,
): Promise<VerifyMessageSignatureResult> => {
  const selected = parseSignatureInput(input.signatureInput);
  if (!selected) { return { ok: false, reason: 'no_aip_signature' }; }
  const { label, params, rawParams } = selected;

  // The `alg` param is optional in RFC 9421 (the verifier derives the algorithm from the key);
  // when a signer does include it, the registered HTTP-sig label is `ed25519`. Accept that plus the
  // JWS spelling `EdDSA`, case-insensitively, so a spec-loose external signer isn't wrongly rejected
  // — the actual key type is still pinned to OKP/Ed25519 below, so this only affects the label.
  if (params.alg !== undefined && !['ed25519', 'eddsa'].includes(params.alg.toLowerCase())) {
    return { ok: false, reason: 'unsupported_alg' };
  }

  // All AIP-minimum components must be covered.
  for (const required of AIP_COVERED_COMPONENTS) {
    if (!params.components.includes(required)) {
      return { ok: false, reason: 'missing_covered_component' };
    }
  }

  // REQUIRE both `created` and `expires`. Treating them as optional leaves an unbounded replay
  // window — a captured signature with no `expires` is valid for the AIT's full lifetime. Reject
  // when either is absent so every accepted PoP carries an explicit, enforceable time bound. (Our
  // pay signer always emits both with a 60s window; this only rejects spec-loose external signers.)
  if (params.created === undefined) { return { ok: false, reason: 'created_missing' }; }
  if (params.expires === undefined) { return { ok: false, reason: 'expires_missing' }; }

  // Bound the PoP's own declared lifetime. created+expires alone only bound replay to whatever
  // window the SIGNER chose — a malicious trusted-issuer agent could declare a window as wide as the
  // AIT lifetime and replay for all of it. Reject an over-long window so every accepted PoP is
  // short-lived. (pay signs 60s; this only bites a signer declaring > MAX_POP_WINDOW_SECONDS.)
  // A NEGATIVE window (expires before created) is equally malformed — without the explicit check
  // it would slip under the cap (negative < 120).
  if (params.expires < params.created || params.expires - params.created > MAX_POP_WINDOW_SECONDS) {
    return { ok: false, reason: 'pop_window_too_long' };
  }

  const now = input.now ?? Math.floor(Date.now() / 1000);
  const skew = input.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
  if (params.created > now + skew) {
    return { ok: false, reason: 'created_in_future' };
  }
  if (params.expires < now - skew) {
    return { ok: false, reason: 'expired' };
  }

  if (!params.keyid) { return { ok: false, reason: 'missing_keyid' }; }

  // The RFC 9421 proof-of-possession is verified with the agent's `cnf` key, which AIP binds as
  // Ed25519 (OKP). Validate the key shape BEFORE thumbprinting / importing: a malformed JWK
  // (missing or non-string `x`) makes `calculateJwkThumbprint` throw, and a non-OKP key (e.g. a
  // P-256 EC cnf) makes `importJWK(... 'EdDSA')` throw JOSENotSupported. Neither call site below
  // catches, so an unguarded throw would crash the gate — reject with a typed failure instead.
  // (Note: the JWT alg allowlist permits ES256 for the IDP *issuer* signing key, a different key.)
  const cnf = input.cnfJwk as { kty?: unknown; crv?: unknown; x?: unknown };
  if (cnf.kty !== 'OKP' || cnf.crv !== 'Ed25519' || typeof cnf.x !== 'string' || cnf.x.length === 0) {
    return { ok: false, reason: 'unsupported_cnf_key' };
  }

  let thumbprint: string;
  try {
    thumbprint = await calculateJwkThumbprint(input.cnfJwk, 'sha256');
  } catch {
    return { ok: false, reason: 'unsupported_cnf_key' };
  }
  if (params.keyid !== thumbprint) { return { ok: false, reason: 'keyid_mismatch' }; }

  const sig = parseSignatureValue(input.signature, label);
  if (!sig) { return { ok: false, reason: 'malformed_signature' }; }

  let base: string;
  try {
    base = buildSignatureBase(params, {
      method: input.method,
      authority: input.authority,
      path: input.path,
      agentIdentity: input.agentIdentity,
      extra: input.extraComponents,
    }, rawParams);
  } catch (err) {
    if (err instanceof MissingComponentError) { return { ok: false, reason: 'missing_covered_component' }; }
    throw err;
  }

  // cnf key shape (OKP/Ed25519 with a string `x`) was validated above, before thumbprinting.
  let valid: boolean;
  try {
    const key = await importJWK(input.cnfJwk, 'EdDSA');
    if (!(key instanceof CryptoKey)) {
      // jose returns a Uint8Array for symmetric keys; Ed25519 public is always a CryptoKey.
      return { ok: false, reason: 'signature_invalid' };
    }
    valid = await subtle.verify(
      { name: 'Ed25519' },
      key,
      sig as unknown as ArrayBuffer,
      new TextEncoder().encode(base) as unknown as ArrayBuffer,
    );
  } catch {
    // Any crypto/import failure is a verification failure, never an uncaught throw.
    return { ok: false, reason: 'signature_invalid' };
  }
  return valid ? { ok: true, params } : { ok: false, reason: 'signature_invalid' };
};

export interface SignMessageInput {
  method: string;
  authority: string;
  path: string;
  agentIdentity: string;
  /** Agent private key (Ed25519 JWK with `d`). */
  privateJwk: JWK;
  /** Agent public key; used to derive `keyid` (thumbprint). */
  publicJwk: JWK;
  created?: number;
  expires?: number;
  /** Signature dictionary label. Defaults to `ait`. */
  label?: string;
  components?: string[];
  extraComponents?: Record<string, string>;
}

/** Build the `Signature-Input` and `Signature` header values for an AIP request. */
export const signMessage = async (
  input: SignMessageInput,
): Promise<{ signatureInput: string; signature: string }> => {
  const label = input.label ?? 'ait';
  const components = input.components ?? [...AIP_COVERED_COMPONENTS];
  const created = input.created ?? Math.floor(Date.now() / 1000);
  const keyid = await calculateJwkThumbprint(input.publicJwk, 'sha256');

  const params: SignatureParams = {
    components,
    created,
    expires: input.expires,
    keyid,
    tag: AIP_SIGNATURE_TAG,
  };

  const base = buildSignatureBase(params, {
    method: input.method,
    authority: input.authority,
    path: input.path,
    agentIdentity: input.agentIdentity,
    extra: input.extraComponents,
  });

  const key = await importJWK(input.privateJwk, 'EdDSA');
  if (!(key instanceof CryptoKey)) {
    throw new Error('signMessage: expected an Ed25519 private CryptoKey');
  }
  const sigBytes = await subtle.sign(
    'Ed25519',
    key,
    new TextEncoder().encode(base) as unknown as ArrayBuffer,
  );
  const b64 = bytesToB64(new Uint8Array(sigBytes));

  const signatureInput = `${label}=${serializeComponentList(components)}${serializeParams(params)}`;
  const signature = `${label}=:${b64}:`;
  return { signatureInput, signature };
};
