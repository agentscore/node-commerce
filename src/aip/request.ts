/**
 * Build an AIP {@link VerifyRequestContext} from a standard WHATWG `Request`.
 *
 * Every framework adapter ultimately has (or can produce) a `Request`: Hono exposes
 * `c.req.raw`, Next.js / Web Fetch hand you one directly, and Express/Fastify can be shimmed.
 * This helper centralizes the header + URL extraction so adapters stay thin and the parsing
 * rules (authority derivation, multiple `Agent-Identity` headers) live in one place.
 */

import { AGENT_IDENTITY_HEADER, type VerifyRequestContext } from './verify';

/**
 * Read all values of a possibly-repeated header. The Fetch `Headers` object folds repeated
 * headers into a single comma-joined value; for `Agent-Identity` we must split them back out
 * because each AIT is an independent JWT. JWTs are base64url dot-separated and never contain a
 * bare comma, so splitting on `,` is safe.
 */
const readAgentIdentityHeaders = (headers: Headers): string[] => {
  const raw = headers.get(AGENT_IDENTITY_HEADER);
  if (!raw) { return []; }
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
};

/**
 * Derive `@authority` for RFC 9421. Prefer the `Host` header (what the client addressed);
 * fall back to the URL host. Returned as-is; {@link normalizeAuthority} canonicalizes during
 * signature-base construction.
 */
const deriveAuthority = (req: Request, url: URL): string => req.headers.get('host') ?? url.host;

/** Build the framework-agnostic verify context from a standard `Request`. A configured
 *  `authority` pin (e.g. `AipGateOptions.authority`) wins over the inbound `Host` header. */
export const buildVerifyContextFromRequest = (req: Request, authority?: string): VerifyRequestContext => {
  const url = new URL(req.url);
  return {
    method: req.method,
    authority: authority ?? deriveAuthority(req, url),
    path: url.pathname,
    agentIdentityHeaders: readAgentIdentityHeaders(req.headers),
    signatureInput: req.headers.get('signature-input'),
    signature: req.headers.get('signature'),
  };
};

/** True when the request carries an AIP credential (at least one `Agent-Identity` header). */
export const hasAgentIdentityHeader = (req: Request): boolean =>
  readAgentIdentityHeaders(req.headers).length > 0;

/** Read a header from a Node-style header map (value may be string | string[] | undefined). */
const readNodeHeader = (
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined => {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (v === undefined) { return undefined; }
  return Array.isArray(v) ? v.join(', ') : v;
};

/** True when a Node-style header map carries an `Agent-Identity` header. */
export const hasAgentIdentityHeaderNode = (
  headers: Record<string, string | string[] | undefined>,
): boolean => {
  const raw = readNodeHeader(headers, 'agent-identity');
  return raw !== undefined && raw.split(',').some((s) => s.trim().length > 0);
};

/**
 * Build the verify context from Express/Fastify-style parts (Node header map + method + URL).
 * These frameworks don't expose a Fetch `Request`, so adapters pass raw pieces here.
 */
export const buildVerifyContextFromParts = (parts: {
  method: string;
  /** Full request URL, or just the path. Used to derive `@path`. */
  url: string;
  /** Node header map. */
  headers: Record<string, string | string[] | undefined>;
  /** Authority override; falls back to the `host` header. */
  authority?: string;
}): VerifyRequestContext => {
  const agentIdentityRaw = readNodeHeader(parts.headers, 'agent-identity');
  const agentIdentityHeaders = agentIdentityRaw
    ? agentIdentityRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    : [];
  const host = parts.authority ?? readNodeHeader(parts.headers, 'host') ?? '';
  // url may be an absolute URL or an origin-form target ("/checkout?...", possibly "//x"). Build
  // the URL by APPENDING the target to the origin (not resolving it as a reference) so a leading
  // "//" is treated as PATH — `new URL('//x', base)` would mis-read "//x" as a protocol-relative
  // authority and drop it, diverging from the signer's `URL.pathname` and failing PoP.
  // Always assigned in both branches below, so no initializer (avoids a dead assignment).
  let path: string;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(parts.url)) {
      path = new URL(parts.url).pathname;
    } else {
      const target = parts.url.startsWith('/') ? parts.url : `/${parts.url}`;
      path = new URL(`http://${host || 'localhost'}${target}`).pathname;
    }
  } catch {
    const q = parts.url.indexOf('?');
    path = q === -1 ? parts.url : parts.url.slice(0, q);
  }
  return {
    method: parts.method,
    authority: host,
    path,
    agentIdentityHeaders,
    signatureInput: readNodeHeader(parts.headers, 'signature-input') ?? null,
    signature: readNodeHeader(parts.headers, 'signature') ?? null,
  };
};
