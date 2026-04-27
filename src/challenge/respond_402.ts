/**
 * `respond402` — single-call 402 emit for merchants who use both `mppx` (for tempo + stripe
 * MPP rails) AND x402 (for Base + Solana).
 *
 * The seam is fiddly enough to get wrong by hand:
 *   - mppx's `compose()(req)` returns a 402 Response with WWW-Authenticate directives
 *     whose ids mppx's server-side validator REMEMBERS — they round-trip in client
 *     credentials. Overwriting that header (e.g. with `buildPaymentHeaders` output)
 *     breaks the round-trip.
 *   - x402 needs the binary-friendly `PAYMENT-REQUIRED` header (base64-encoded JSON
 *     of `{x402Version, accepts, resource}`) — mppx doesn't emit it.
 *   - Merchants want a richer JSON body (pricing, identity metadata, agent_instructions,
 *     agent_memory, retry_body, accepted_methods cross-reference) than the bare mppx body.
 *
 * `respond402` composes all three in one call:
 *   - PRESERVES mppx's WWW-Authenticate verbatim
 *   - ADDS PAYMENT-REQUIRED when x402 entries are present
 *   - REPLACES the body with the rich body via `build402Body`
 *
 * Usage:
 * ```ts
 * const result = await m.compose(['tempo/charge', {...}], ['stripe/charge', {...}])(c.req.raw);
 * if (result.status === 402) {
 *   return commerce.respond402({
 *     mppxChallenge: result.challenge,
 *     x402: { version: 2, accepts: x402Accepts, resource: { url: c.req.url, mimeType: 'application/json' } },
 *     body: { acceptedMethods, agentInstructions, identityMetadata, pricing, agentMemory, retryBody, ... },
 *   });
 * }
 * ```
 */

import { paymentRequiredHeader, type PaymentRequiredHeaderInput } from '../payment/wwwauthenticate';
import { build402Body, type Build402BodyInput } from './body';

export interface Respond402Input {
  /** The 402 Response returned by `mppx.compose()(req)`. Its WWW-Authenticate header
   *  is preserved verbatim — mppx's server-side validator matches credentials to the
   *  directive ids it generated, so overwriting breaks the round-trip. */
  mppxChallenge: Response;
  /** Inputs to `build402Body` — the rich JSON body sent to the agent. */
  body: Build402BodyInput;
  /** When set, layers on the x402 PAYMENT-REQUIRED header (base64-encoded JSON).
   *  Omit for merchants that don't accept x402 (Base/Solana) — mppx-only setups. */
  x402?: PaymentRequiredHeaderInput;
}

export function respond402(input: Respond402Input): Response {
  const body = build402Body(input.body);
  const headers = new Headers(input.mppxChallenge.headers);
  headers.set('content-type', 'application/json');
  if (input.x402) {
    headers.set('PAYMENT-REQUIRED', paymentRequiredHeader(input.x402));
  }
  return new Response(JSON.stringify(body), { headers, status: 402 });
}
