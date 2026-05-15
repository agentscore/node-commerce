/**
 * Spec-rooted helpers for `/.well-known/{ucp,jwks.json}` discovery surfaces.
 *
 * What this module collapses for every UCP-publishing merchant:
 *
 * - Loading + caching the signing key via `loadUCPSigningKeyFromEnv`.
 * - Composing the `payment_handlers` map from the merchant's `Checkout` rails
 *   (TempoRailSpec → mppPaymentHandler; X402BaseRailSpec → x402PaymentHandler;
 *   StripeRailSpec → stripeSptPaymentHandler).
 * - Building the unsigned profile + signing it.
 * - Cache-Control + CORS + X-Request-ID echo per UCP section 6.
 * - RFC 7517 section 8.5 `application/jwk-set+json` media type on JWKS.
 * - The 503 `ucp_misconfigured` fallback envelope when no handlers can be
 *   derived (empty rails dict OR all rails have empty recipients).
 *
 * Each helper returns a framework-neutral `SignedDiscoveryResponse` that
 * merchants wrap in their framework's Response builder (Hono `c.body`, Express
 * `res.set/.status/.send`, Fastify `reply.headers/.code/.send`, Next.js
 * `NextResponse`, Web Fetch `new Response`, etc.).
 */

import {
  type AgentScoreGatePolicy,
  buildUCPProfile,
  mppPaymentHandler,
  stripeSptPaymentHandler,
  type UCPPaymentHandlerBinding,
  type UCPServiceBinding,
  UCPSigningKey,
  x402PaymentHandler,
} from '../identity/ucp';
import {
  buildJWKSResponse,
  loadUCPSigningKeyFromEnv,
  signUCPProfile,
} from '../identity/ucp-jwks';
import type { Checkout, CheckoutRailSpec } from '../checkout';
import type {
  SolanaMppRailSpec,
  StripeRailSpec,
  TempoRailSpec,
  TempoSessionRailSpec,
  X402BaseRailSpec,
} from '../payment/rail_spec';

const UCP_CACHE_SECONDS = 60;
const JWKS_CACHE_SECONDS = 300;
const UCP_SHOPPING_SPEC_2026_04_08 = 'https://ucp.dev/2026-04-08/specification/overview';

/**
 * Framework-neutral response shape for discovery endpoints.
 *
 * Wrap in your framework's response builder. `body` is already JSON-encoded
 * bytes (as a string); do not re-serialize.
 */
export interface SignedDiscoveryResponse {
  body: string;
  mediaType: string;
  headers: Record<string, string>;
  status: number;
}

function requestId(headers: Headers | Record<string, string> | undefined): string | undefined {
  if (headers === undefined) return undefined;
  if (headers instanceof Headers) return headers.get('x-request-id') ?? undefined;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'x-request-id') return v;
  }
  return undefined;
}

function attachRequestId(
  headers: Record<string, string>,
  requestHeaders: Headers | Record<string, string> | undefined,
): void {
  const rid = requestId(requestHeaders);
  if (rid !== undefined) headers['X-Request-ID'] = rid;
}

function isTempoSession(s: CheckoutRailSpec): s is TempoSessionRailSpec {
  return 'escrowContract' in s && 'store' in s;
}
function isStripe(s: CheckoutRailSpec): s is StripeRailSpec {
  return !('recipient' in s);
}
/** A rail spec qualifies for UCP publication when `recipient` is defined —
 *  whether concrete (`'0xabc'`), empty-string sentinel (per-order minted by
 *  the consumer), or a factory callable (per-order minted on demand). The
 *  `tempoToNetworkEntry` / `x402ToNetworkEntry` builders drop the recipient
 *  field from the emitted UCP entry when it's not a static address, so per-
 *  order-mint merchants advertise the rail without leaking a sentinel. */
function railHasRecipientField(spec: { recipient?: unknown }): boolean {
  return Object.hasOwn(spec, 'recipient');
}

function composeHandlers(checkout: Checkout): Record<string, UCPPaymentHandlerBinding[]> {
  const handlers: Record<string, UCPPaymentHandlerBinding[]> = {};
  const mpp: (TempoRailSpec | SolanaMppRailSpec | TempoSessionRailSpec)[] = [];
  const x402: X402BaseRailSpec[] = [];
  const stripe: StripeRailSpec[] = [];

  for (const spec of Object.values(checkout.rails)) {
    if (isStripe(spec)) {
      stripe.push(spec);
      continue;
    }
    if (isTempoSession(spec)) {
      if (railHasRecipientField(spec)) mpp.push(spec);
      continue;
    }
    // Distinguish Tempo (`symbol: 'USDC.e'` or `network: 'tempo-*'`) from x402-Base
    // (CAIP-2 `eip155:*`) and Solana (`network: 'solana:*'`).
    const network = (spec as { network?: string }).network ?? '';
    if (network.startsWith('eip155:') || ('mode' in spec)) {
      if (railHasRecipientField(spec)) x402.push(spec as X402BaseRailSpec);
    } else if (network.startsWith('solana:') || 'rpcUrl' in spec) {
      if (railHasRecipientField(spec)) mpp.push(spec as SolanaMppRailSpec);
    } else {
      // Default to Tempo (network starts with `tempo-` or symbol is `USDC.e`).
      if (railHasRecipientField(spec)) mpp.push(spec as TempoRailSpec);
    }
  }

  if (mpp.length > 0) Object.assign(handlers, mppPaymentHandler({ networks: mpp }));
  if (x402.length > 0) Object.assign(handlers, x402PaymentHandler({ networks: x402 }));
  for (const spec of stripe) Object.assign(handlers, stripeSptPaymentHandler({ spec }));
  return handlers;
}

function misconfiguredResponse(
  requestHeaders: Headers | Record<string, string> | undefined,
): SignedDiscoveryResponse {
  const body = {
    error: {
      code: 'ucp_misconfigured',
      message: 'Merchant has no configured payment handlers.',
    },
    next_steps: {
      action: 'contact_merchant',
      user_message: 'This merchant is temporarily unable to accept agent payments.',
    },
    agent_instructions: {
      action: 'contact_merchant',
      steps: [
        'Surface a transient error to the user.',
        'Retry later; the merchant operator will repair the configuration.',
      ],
      user_message: 'Merchant temporarily offline for agent payments.',
    },
  };
  // UCP section 6 forbids `no-store` on profile responses; 60s is the minimum
  // cache age (short enough that recovery is fast once the merchant restores
  // config).
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': `public, max-age=${UCP_CACHE_SECONDS}`,
  };
  attachRequestId(headers, requestHeaders);
  return {
    body: JSON.stringify(body),
    mediaType: 'application/json',
    headers,
    status: 503,
  };
}

/**
 * Build the signed UCP profile response for `/.well-known/ucp`.
 *
 * Composes payment handlers from the Checkout's rails dict, builds the profile
 * via `buildUCPProfile`, signs via `signUCPProfile`, and attaches the UCP
 * section 6-prescribed Cache-Control + CORS + X-Request-ID headers.
 *
 * Returns a 503 `ucp_misconfigured` envelope (still with the section 6-compliant
 * Cache-Control) when no payment handlers can be derived from rails.
 *
 * `services` is the spec-compliant services map (keyed by reverse-DNS service
 * name). `wellKnownUcpUrl` is the canonical URL of this profile, surfaced as
 * the value in `supported_versions`.
 */
export async function buildSignedUcpResponse(opts: {
  checkout: Checkout;
  name: string;
  wellKnownUcpUrl: string;
  services: Record<string, UCPServiceBinding[]>;
  requestHeaders?: Headers | Record<string, string>;
  signingKid?: string;
  agentscoreGate?: AgentScoreGatePolicy;
}): Promise<SignedDiscoveryResponse> {
  const {
    checkout,
    name,
    wellKnownUcpUrl,
    services,
    requestHeaders,
    signingKid = 'merchant-default',
    agentscoreGate,
  } = opts;

  const handlers = composeHandlers(checkout);
  if (Object.keys(handlers).length === 0) {
    return misconfiguredResponse(requestHeaders);
  }

  const key = await loadUCPSigningKeyFromEnv({ defaultKid: signingKid });
  const signingKeyEntry = UCPSigningKey.fromJWK(key.publicJWK);

  const profile = buildUCPProfile({
    name,
    supported_versions: { '2026-04-08': wellKnownUcpUrl },
    agentscore_gate: agentscoreGate,
    services,
    payment_handlers: handlers,
    signing_keys: [signingKeyEntry],
  });
  const signed = await signUCPProfile(profile, {
    signingKey: key.privateKey,
    kid: key.publicJWK.kid as string,
    alg: (key.publicJWK.alg as 'EdDSA' | 'ES256' | undefined) ?? 'EdDSA',
  });
  const headers: Record<string, string> = {
    'Cache-Control': `public, max-age=${UCP_CACHE_SECONDS}`,
    'Access-Control-Allow-Origin': '*',
  };
  attachRequestId(headers, requestHeaders);
  return {
    body: JSON.stringify(signed),
    mediaType: 'application/json',
    headers,
    status: 200,
  };
}

/**
 * Build the JWKS response for `/.well-known/jwks.json`.
 *
 * RFC 7517 section 8.5 prescribes `application/jwk-set+json`. Five-minute
 * Cache-Control balances verifier-side cache hit rate against rotation
 * propagation latency.
 */
export async function buildSignedJwksResponse(opts?: {
  requestHeaders?: Headers | Record<string, string>;
  signingKid?: string;
}): Promise<SignedDiscoveryResponse> {
  const { requestHeaders, signingKid = 'merchant-default' } = opts ?? {};
  const key = await loadUCPSigningKeyFromEnv({ defaultKid: signingKid });
  const jwks = buildJWKSResponse([UCPSigningKey.fromJWK(key.publicJWK)]);
  const headers: Record<string, string> = {
    'Cache-Control': `public, max-age=${JWKS_CACHE_SECONDS}`,
    'Access-Control-Allow-Origin': '*',
  };
  attachRequestId(headers, requestHeaders);
  return {
    body: JSON.stringify(jwks),
    mediaType: 'application/jwk-set+json',
    headers,
    status: 200,
  };
}

/**
 * CORS preflight headers for `/.well-known/*` endpoints.
 *
 * Echoes `Access-Control-Request-Headers` verbatim when present rather than
 * advertising `*` (which browsers reject with credentials in scope). Returns
 * a 204 on the corresponding response via the merchant's framework.
 */
export function wellKnownCorsPreflightHeaders(
  requestHeaders?: Headers | Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Access-Control-Request-Headers',
  };
  if (requestHeaders === undefined) return headers;
  const acrh =
    requestHeaders instanceof Headers
      ? requestHeaders.get('access-control-request-headers')
      : Object.entries(requestHeaders).find(([k]) => k.toLowerCase() === 'access-control-request-headers')?.[1];
  if (acrh) headers['Access-Control-Allow-Headers'] = acrh;
  return headers;
}

/**
 * Build a 204 CORS preflight `Response` for `/.well-known/*` endpoints, wrapping
 * {@link wellKnownCorsPreflightHeaders}. Universal across every UCP-publishing
 * merchant; saves the 4-line `new Response(null, { status: 204, headers: ... })`
 * wrapper every consumer otherwise hand-rolls.
 */
export function wellKnownPreflightResponse(
  requestHeaders?: Headers | Record<string, string>,
): Response {
  return new Response(null, {
    status: 204,
    headers: wellKnownCorsPreflightHeaders(requestHeaders),
  });
}

/**
 * Canonical UCP services map for a merchant publishing an A2A agent card.
 *
 * Returns `{"dev.ucp.shopping": [UCPServiceBinding(version: '2026-04-08',
 * spec: <UCP shopping spec>, transport: 'a2a', endpoint: agentCardUrl)]}`;
 * the binding every UCP-publishing merchant declares when their primary agent
 * surface is the A2A v1.0 `/.well-known/agent-card.json` (versus a UCP MCP or
 * REST endpoint).
 *
 * Merchants who additionally expose a UCP MCP or REST transport append further
 * bindings to the same `dev.ucp.shopping` list.
 */
export function defaultA2aServices(opts: {
  agentCardUrl: string;
}): Record<string, UCPServiceBinding[]> {
  return {
    'dev.ucp.shopping': [
      {
        version: '2026-04-08',
        spec: UCP_SHOPPING_SPEC_2026_04_08,
        transport: 'a2a',
        endpoint: opts.agentCardUrl,
      },
    ],
  };
}

/**
 * Eager-load the UCP signing key at startup.
 *
 * A malformed `UCP_SIGNING_KEY_JWK_PRIVATE` env value otherwise surfaces on
 * the first `/.well-known/ucp` hit after deploy, masquerading as a runtime
 * 500. Calling this in the framework's startup hook fails the deploy fast.
 *
 * Wraps `loadUCPSigningKeyFromEnv`; throws (per that helper's contract) on a
 * malformed JWK so the orchestrator marks the task unhealthy.
 */
export async function bootstrapUcpSigningKey(opts?: {
  defaultKid?: string;
}): Promise<void> {
  const defaultKid = opts?.defaultKid ?? 'merchant-default';
  await loadUCPSigningKeyFromEnv({ defaultKid });
}

// ─────────────────────────────────────────────────────────────────────────────
// signedResponse<Framework> wrappers
//
// Convert the framework-neutral SignedDiscoveryResponse / Response (preflight)
// into a framework-specific response. Saves the 4-line per-framework wrapper
// every UCP-publishing merchant otherwise hand-rolls.
// ─────────────────────────────────────────────────────────────────────────────

/** Hono / Web Fetch wrapper. Returns a `Response`. */
export function signedResponseHono(resp: SignedDiscoveryResponse): Response {
  return new Response(resp.body, {
    status: resp.status,
    headers: { ...resp.headers, 'Content-Type': resp.mediaType },
  });
}

/** Next.js wrapper. Returns a `Response` (interchangeable with NextResponse). */
export function signedResponseNextjs(resp: SignedDiscoveryResponse): Response {
  return signedResponseHono(resp);
}

/** Web Fetch wrapper. Returns a standard `Response`. */
export function signedResponseWeb(resp: SignedDiscoveryResponse): Response {
  return signedResponseHono(resp);
}

/** Express wrapper. Writes onto `res`; returns `void` to match Express convention. */
export function signedResponseExpress(
  res: {
    status: (code: number) => unknown;
    set: (headers: Record<string, string>) => unknown;
    type: (mt: string) => unknown;
    send: (body: string) => unknown;
  },
  resp: SignedDiscoveryResponse,
): void {
  res.status(resp.status);
  res.set(resp.headers);
  res.type(resp.mediaType);
  res.send(resp.body);
}

/** Fastify wrapper. Writes onto `reply` and returns it. */
export function signedResponseFastify(
  reply: {
    code: (code: number) => unknown;
    header: (k: string, v: string) => unknown;
    type: (mt: string) => unknown;
    send: (body: string) => unknown;
  },
  resp: SignedDiscoveryResponse,
): unknown {
  reply.code(resp.status);
  for (const [k, v] of Object.entries(resp.headers)) reply.header(k, v);
  reply.type(resp.mediaType);
  return reply.send(resp.body);
}
