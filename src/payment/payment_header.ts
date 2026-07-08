/** Detects whether a request is a "settle leg" (carries a payment credential)
 *  vs a "discovery leg" (no payment credential, expects a 402).
 *
 *  Used by the gate-conditional mount pattern documented in CLAUDE.md: mount
 *  `agentscoreGate` on a route only when payment is being attempted, so the
 *  discovery leg flows through unauthenticated and gets a 402 with all rails.
 *
 *  Three credential channels are checked:
 *   - `Payment-Signature` — MPP credentials (Tempo, Solana, Stripe SPT)
 *   - `X-Payment` — x402 v1 EIP-3009 credentials
 *   - `Authorization: Payment <jwt>` — x402 v2 / paymentauth.org credentials
 */

type WebHeaders = { get(name: string): string | null };
type RecordHeaders = Record<string, string | string[] | undefined>;
export type HeadersLike = WebHeaders | RecordHeaders | Headers;

function toTitleCase(name: string): string {
  return name.replace(/(^|-)([a-z])/g, (_m, sep: string, c: string) => sep + c.toUpperCase());
}

export function readHeader(headers: HeadersLike, name: string): string | null {
  if (typeof (headers as Partial<WebHeaders>).get === 'function') {
    return (headers as WebHeaders).get(name);
  }
  const rec = headers as RecordHeaders;
  const v = rec[name] ?? rec[name.toLowerCase()] ?? rec[toTitleCase(name)];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return null;
}

export function asHeaders(input: Request | HeadersLike): HeadersLike {
  return typeof (input as Partial<Request>).headers === 'object' && input instanceof Request
    ? input.headers
    : (input as HeadersLike);
}

/** True when the request carries any of the payment-credential headers we
 *  recognize. Accepts a Web Fetch `Headers`, a Web Fetch `Request` (uses
 *  `request.headers`), or a plain header record (Express/Fastify-shaped).
 *
 *  Use this to gate the `agentscoreGate` middleware so anonymous discovery
 *  legs flow through and get a 402 with all rails. See CLAUDE.md
 *  "Anonymous discovery" pattern.
 */
export function hasPaymentHeader(input: Request | HeadersLike): boolean {
  const headers = asHeaders(input);
  return Boolean(
    readHeader(headers, 'payment-signature') ||
    readHeader(headers, 'x-payment') ||
    readHeader(headers, 'authorization')?.startsWith('Payment '),
  );
}

/** True when the request carries an x402 payment credential (`X-Payment` or
 *  `Payment-Signature`). Use to dispatch to the x402 settle path. */
export function hasX402Header(input: Request | HeadersLike): boolean {
  const headers = asHeaders(input);
  return Boolean(readHeader(headers, 'payment-signature') || readHeader(headers, 'x-payment'));
}

/** True when the request carries an mppx payment credential
 *  (`Authorization: Payment <jwt>`). Use to dispatch to the MPP settle path. */
export function hasMppxHeader(input: Request | HeadersLike): boolean {
  const headers = asHeaders(input);
  return Boolean(readHeader(headers, 'authorization')?.startsWith('Payment '));
}

/** Matches the three-segment base64url shape of a JWT (Stripe SPT and other
 *  token-style credentials ride `Authorization: Payment <jwt>`). */
const JWT_SHAPE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function decodesToJsonObject(token: string): boolean {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

export interface MalformedPaymentCredential {
  /** Which credential channel carried the malformed value. */
  channel: 'x402' | 'mpp';
  message: string;
}

/**
 * Wire-shape gate for payment credentials, cheap enough to run before any
 * merchant hook. A request whose payment header cannot possibly be a
 * credential (not base64/base64url JSON, not a JWT-shaped token) is rejected
 * up front, so junk headers never trigger per-request hooks (`preValidate`,
 * pricing, recipient minting) or the identity-gate API call.
 *
 * This is deliberately a SHAPE check only. Signature verification, payTo
 * binding, and challenge validation stay where they are (the x402 validator
 * and the mppx settle path) — those need per-request state the hooks produce.
 * A well-formed-but-invalid credential still reaches the real validators and
 * fails there.
 *
 * Returns `null` when every present credential channel is plausibly shaped
 * (or no payment header is present).
 */
export function malformedPaymentCredential(
  input: Request | HeadersLike,
): MalformedPaymentCredential | null {
  const headers = asHeaders(input);
  const x402Token = readHeader(headers, 'payment-signature') ?? readHeader(headers, 'x-payment');
  if (x402Token !== null && x402Token.length > 0) {
    if (!decodesToJsonObject(x402Token)) {
      return {
        channel: 'x402',
        message: 'X-Payment header is not decodable base64 JSON.',
      };
    }
    return null;
  }
  const auth = readHeader(headers, 'authorization');
  if (auth !== null && auth.startsWith('Payment ')) {
    const token = auth.slice('Payment '.length).trim();
    if (token.length === 0 || (!decodesToJsonObject(token) && !JWT_SHAPE_RE.test(token))) {
      return {
        channel: 'mpp',
        message:
          'Authorization: Payment credential is neither base64-encoded JSON nor a token-shaped value.',
      };
    }
  }
  return null;
}
