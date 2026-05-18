/**
 * `respond402` — single-call 402 emit for merchants who use both `mppx` (for tempo + stripe
 * MPP rails) AND x402 (for Base + Solana).
 *
 * The seam is fiddly enough to get wrong by hand:
 *   - mppx's `compose()(req)` returns a 402 Response with WWW-Authenticate directives
 *     whose ids mppx's server-side validator REMEMBERS — they round-trip in client
 *     credentials. Overwriting that header breaks the round-trip.
 *   - x402 needs the binary-friendly `PAYMENT-REQUIRED` header (base64-encoded JSON
 *     of `{x402Version, accepts, resource}`) — mppx doesn't emit it.
 *   - Merchants want a richer JSON body (pricing, identity metadata, agent_instructions,
 *     agent_memory, retry_body, accepted_methods cross-reference) than the bare mppx body.
 *
 * `respond402` composes all three and returns a framework-neutral `Respond402Result`
 * (body + headers + status) that the merchant wraps in their framework's response shape.
 *
 * Usage:
 * ```ts
 * const challenge = await m.compose(['tempo/charge', {...}], ['stripe/charge', {...}])(c.req.raw);
 * if (challenge.status === 402) {
 *   const result = respond402({
 *     mppxChallengeHeaders: Object.fromEntries(challenge.headers),
 *     body: build402Body({ ... }),
 *     x402: { x402Version: 2, accepts: x402Accepts, resource: { url: c.req.url, mimeType: 'application/json' } },
 *   });
 *   return new Response(JSON.stringify(result.body), { status: result.status, headers: result.headers });
 * }
 * ```
 */

import { normalizeHeadersToLowercase } from '../_headers';
import { paymentRequiredHeader } from '../payment/wwwauthenticate';

/** Framework-neutral 402 response shape — body + headers + status. */
export interface Respond402Result {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  status: 402;
}

export function respond402({
  mppxChallengeHeaders,
  body,
  x402,
}: {
  /** Headers from mppx's 402 Response (`Object.fromEntries(challenge.headers)`). The
   *  `WWW-Authenticate` directives are preserved verbatim — mppx's server-side validator
   *  matches credentials to the ids it generated. */
  mppxChallengeHeaders: Record<string, string>;
  /** The already-built 402 body — call `build402Body({...})` to construct it. */
  body: Record<string, unknown>;
  /** When set, layers on the x402 PAYMENT-REQUIRED header (base64-encoded JSON).
   *  Omit for merchants that don't accept x402 (Base/Solana) — mppx-only setups. */
  x402?: Parameters<typeof paymentRequiredHeader>[0];
}): Respond402Result {
  const headers = normalizeHeadersToLowercase(mppxChallengeHeaders);
  headers['content-type'] = 'application/json';
  if (x402) {
    headers['payment-required'] = paymentRequiredHeader(x402);
  }
  return { body, headers, status: 402 };
}
