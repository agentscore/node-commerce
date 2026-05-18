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
