/**
 * Rewrite a URL's scheme to the proxy's original protocol.
 *
 * Behind a TLS-terminating edge proxy (ALB / CloudFront / nginx) the inbound
 * request arrives as `http://`, but x402 discovery — and the mppx client's
 * resource-match check — require the public `https://`. Honor `X-Forwarded-Proto`
 * (the scheme the client actually used) so the emitted `resource.url` matches
 * the URL the client fetched.
 *
 * `forwardedProto` may carry a comma-separated proxy chain (`https, http`); the
 * first hop is the client-facing scheme. A missing/blank value leaves the URL
 * untouched (direct HTTP in local dev stays `http://`).
 */
export function applyForwardedProto(url: string, forwardedProto: string | null | undefined): string {
  const proto = typeof forwardedProto === 'string' ? forwardedProto.split(',')[0]?.trim() : undefined;
  if (!proto) return url;
  try {
    const u = new URL(url);
    u.protocol = `${proto}:`;
    return u.toString();
  } catch {
    return url;
  }
}

/** Read `X-Forwarded-Proto` from a header bag regardless of casing. Accepts the
 *  Web `Headers` object (compute-first / web adapters) or a plain `Record`
 *  (the `Checkout` request shape every framework adapter normalizes into). */
export function readForwardedProto(
  headers: Headers | Record<string, string | string[] | undefined>,
): string | undefined {
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get('x-forwarded-proto') ?? undefined;
  }
  const rec = headers as Record<string, string | string[] | undefined>;
  const raw = rec['x-forwarded-proto'] ?? rec['X-Forwarded-Proto'];
  return Array.isArray(raw) ? raw[0] : raw;
}
