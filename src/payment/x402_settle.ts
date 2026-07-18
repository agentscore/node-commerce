/**
 * `processX402Settle`: single-call x402 verify+settle for merchants.
 *
 * Wraps the four x402-server steps every x402-accepting merchant repeats:
 *   1. `buildPaymentRequirements(resourceConfig)`: builds the requirement entries the
 *      facilitator validates against
 *   2. `enrichExtensions(extension, transportContext)`: folds in Bazaar (or other)
 *      extensions for the verify step
 *   3. `processPaymentRequest(payload, resourceConfig, resourceMeta, extensions)`:
 *      runs verify against the facilitator
 *   4. `settlePayment(payload, matchedRequirement)`: settles on-chain
 *
 * Returns a tagged result so the caller can map errors to merchant-shaped responses
 * without owning the orchestration boilerplate. Use `classifyX402SettleResult` to
 * map the tagged result to a recommended HTTP response.
 */

import type { X402Server } from './x402_server';

/** Success result of `processX402Settle`: both verify and settle passed. */
export interface ProcessX402SettleSuccess {
  success: true;
  /** The matched requirement passed to `settlePayment`. */
  matchedRequirement: unknown;
  /** The settlement response from the facilitator. */
  settleResult: unknown;
  /** Base64-encoded JSON of `settleResult`, ready to set as the `payment-response`
   *  HTTP header on the merchant's success response. x402 clients (`@x402/fetch`,
   *  `agentscore-pay`) read this to confirm settlement landed. `undefined` when
   *  there's no settle result (shouldn't happen on success path but typed defensively). */
  paymentResponseHeader: string | undefined;
  /** The x402 server's `processPaymentRequest` verify result. */
  verifyResult: { success: true; [key: string]: unknown };
}

/** Failure result of `processX402Settle`, discriminated by `phase`. Map to a controlled HTTP
 *  response via `classifyX402SettleResult`; keep raw `error` / `verifyResult` / `reason`
 *  server-side rather than serializing them to the consumer. */
export type ProcessX402SettleFailure =
  /** No-requirements branch: `buildPaymentRequirements` returned an empty array, so
   *  there is nothing to verify against. Indicates a merchant-side misconfiguration
   *  (resource config doesn't match any registered scheme/network).
   *  Recommended response: log `reason` server-side; map to a controlled 500 to the
   *  consumer via `classifyX402SettleResult`. */
  | { success: false; phase: 'no_requirements'; reason: string }
  /** Verify-failed branch: the facilitator's verify step ran and returned
   *  `{ success: false, ... }`. Payload is structurally invalid, expired, signed by
   *  the wrong wallet, or otherwise rejected by facilitator policy.
   *  Recommended response: log `verifyResult` server-side; map to a controlled 400
   *  with `payment_proof_invalid` to the consumer via `classifyX402SettleResult`. */
  | { success: false; phase: 'verify_failed'; verifyResult: unknown }
  /** Settle-failed branch: verify succeeded but `settlePayment` threw (on-chain
   *  rejection, RPC outage, facilitator broadcast failure, etc.). The agent's
   *  credential was valid; funds did not move.
   *  Recommended response: log raw `error` server-side; map to a controlled 503 with
   *  `payment_provider_unavailable` to the consumer via `classifyX402SettleResult`. */
  | { success: false; phase: 'settle_failed'; error: unknown; matchedRequirement: unknown }
  | {
      success: false;
      /** Facilitator threw an unexpected error during one of the verify-stage calls
       *  (build requirements, extension enrich, or processPaymentRequest). Most common
       *  cause: the facilitator client rejects the configured network. Coinbase's CDP
       *  facilitator throws on Solana devnet because it only supports mainnet networks;
       *  Stripe's SPT facilitator throws on EVM networks; etc.
       *  Recommended response: log raw `error` server-side; map to a controlled 503
       *  with `payment_provider_unavailable` to the consumer via `classifyX402SettleResult`
       *  so the agent can pick a different rail. */
      phase: 'facilitator_error';
      /** Which verify-stage step threw. */
      step: 'build_requirements' | 'enrich_extensions' | 'verify_payment';
      error: unknown;
    };

export type ProcessX402SettleResult = ProcessX402SettleSuccess | ProcessX402SettleFailure;

/**
 * The merchant-shaped response for a non-success `ProcessX402SettleResult`.
 *
 * `status` / `code` / `message` are safe to send back to the consumer. `nextSteps`
 * is the agent-instructions block describing what the agent should do next. Raw
 * facilitator errors stay server-side: do NOT serialize the original `error` /
 * `verifyResult` / `reason` to the consumer; log them yourself.
 */
export interface ClassifiedX402Error {
  status: 400 | 500 | 503;
  code:
    | 'payment_proof_invalid'
    | 'payment_provider_unavailable'
    | 'payment_internal_error';
  message: string;
  nextSteps: {
    action: string;
    user_message: string;
    retry_after_seconds?: number;
  };
}

/**
 * Map a `ProcessX402SettleResult` to the recommended merchant response.
 *
 * Returns `null` for `success: true`. For each error phase, returns a controlled
 * status / code / message / nextSteps tuple. Replaces error-message string-sniffing
 * with a phase-based dispatch so merchants stop coupling to facilitator-specific
 * error text.
 *
 * Phase mapping:
 * - `verify_failed` → 400 `payment_proof_invalid` / `regenerate_payment_credential`
 * - `facilitator_error` → 503 `payment_provider_unavailable` / `try_different_rail`
 * - `settle_failed` → 503 `payment_provider_unavailable` / `retry_or_swap_method`
 * - `no_requirements` → 500 `payment_internal_error` / `contact_support`
 *
 * Always log the raw `result` server-side before responding; the returned object
 * is intentionally facilitator-agnostic and never carries raw error detail.
 */
export function classifyX402SettleResult(
  result: ProcessX402SettleResult,
): ClassifiedX402Error | null {
  if (result.success) return null;
  switch (result.phase) {
    case 'no_requirements':
      return {
        status: 500,
        code: 'payment_internal_error',
        message: 'Failed to build x402 payment requirements for this configuration',
        nextSteps: {
          action: 'contact_support',
          user_message:
            'The merchant could not produce a payment challenge for this request. Try again later or contact support.',
        },
      };
    case 'verify_failed':
      return {
        status: 400,
        code: 'payment_proof_invalid',
        message: 'Payment credential failed verification; regenerate from a fresh 402 challenge',
        nextSteps: {
          action: 'regenerate_payment_credential',
          user_message:
            'The payment credential was rejected at verify time. Discard it, fetch a fresh 402 challenge, and re-sign.',
        },
      };
    case 'facilitator_error':
      return {
        status: 503,
        code: 'payment_provider_unavailable',
        message: 'Payment provider could not process this network configuration',
        nextSteps: {
          action: 'try_different_rail',
          user_message:
            'This rail is currently unavailable. Pick a different rail from the 402 challenge and retry.',
        },
      };
    case 'settle_failed':
      return {
        status: 503,
        code: 'payment_provider_unavailable',
        message: 'Payment credential verified but on-chain settlement failed',
        nextSteps: {
          action: 'retry_or_swap_method',
          retry_after_seconds: 10,
          user_message:
            'Transient settlement error. Retry in a few seconds, or pick a different rail from the 402 challenge.',
        },
      };
  }
}

/**
 * Classify a thrown error during the 402 orchestration.
 *
 * Catches errors that escape `processX402Settle` (e.g. raised by `mppx.compose`,
 * a Stripe SDK call, or any other payment-side library code wrapped in a single
 * `try/catch` around the full settle flow). Returns a `ClassifiedX402Error`
 * when the error message matches a known pattern; `null` otherwise.
 *
 * Callers should rethrow on `null` — this helper never swallows unknown errors.
 *
 * Pattern matching is case-insensitive substring on the error message:
 * - `"x402version"` / `"invalid payment"` / `"unsupported x402"` →
 *   400 `payment_proof_invalid` / `regenerate_payment_credential`
 * - `"stripe"` / `"facilitator"` / `"cdp"` →
 *   503 `payment_provider_unavailable` / `retry_or_swap_method`
 * - Anything else → `null` (caller rethrows)
 *
 * Substring matching is intentionally narrow. New error families should land
 * here explicitly rather than have the helper grow opaque heuristics. For
 * tagged failure results that already classify themselves, use
 * `classifyX402SettleResult`.
 */
export function classifyOrchestrationError(err: unknown): ClassifiedX402Error | null {
  let msg: string;
  if (err instanceof Error) {
    msg = err.message;
  } else if (typeof err === 'string') {
    msg = err;
  } else {
    return null;
  }
  const msgLower = msg.toLowerCase();

  if (
    msgLower.includes('x402version') ||
    msgLower.includes('invalid payment') ||
    msgLower.includes('unsupported x402')
  ) {
    return {
      status: 400,
      code: 'payment_proof_invalid',
      message: 'Payment credential is malformed or uses an unsupported version',
      nextSteps: {
        action: 'regenerate_payment_credential',
        user_message:
          'The payment credential is malformed or uses an unsupported version. Regenerate from a fresh 402 challenge and re-sign.',
      },
    };
  }

  if (
    msgLower.includes('stripe') ||
    msgLower.includes('facilitator') ||
    msgLower.includes('cdp')
  ) {
    return {
      status: 503,
      code: 'payment_provider_unavailable',
      message: 'Payment provider returned an error',
      nextSteps: {
        action: 'retry_or_swap_method',
        retry_after_seconds: 10,
        user_message:
          'Transient payment-provider error. Retry in a few seconds, or pick a different rail from the 402 challenge.',
      },
    };
  }

  return null;
}

/**
 * Strip the non-signed `extensions` + `resource` blocks from a decoded X-Payment payload
 * before it is forwarded to the facilitator's verify/settle endpoints.
 *
 * agentscore-pay (and other x402 clients) echo the 402 challenge's `extensions` (Bazaar
 * input schema) and `resource` blocks into the payload alongside the signed `payload` +
 * `accepted`. Neither is part of the EIP-3009 signature (which covers only
 * `payload.authorization`). CDP's `/x402/verify` validates the paymentPayload against its
 * `x402V2PaymentPayload` schema, which is `{ x402Version, payload, accepted }` and admits
 * neither `extensions` nor `resource`: their presence makes the payload match no union
 * branch and CDP rejects it ("must match one of [x402V2PaymentPayload, x402V1PaymentPayload]").
 * Endpoints whose echoed Bazaar schema is large fail while small ones happen to slip through,
 * so it presents as "works on some routes, fails on others" but is one shape bug.
 *
 * Confirmed against the live CDP facilitator: accepted-nested WITHOUT extensions/resource
 * passes schema and reaches signature verify; a flat `{ x402Version, scheme, network, payload }`
 * is rejected with "x402V2PaymentPayload requires 'accepted'". So `accepted` (which
 * `verifyX402Request` reads for network/payTo) and every other field stay intact; only the
 * two echoed challenge blocks are dropped, and only here at the facilitator boundary.
 * Non-object payloads, and payloads carrying neither field, pass through untouched.
 */
export function stripUnsignedX402PayloadFields(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null) return payload;
  const p = payload as Record<string, unknown>;
  if (!('extensions' in p) && !('resource' in p)) return payload;
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === 'extensions' || k === 'resource') continue;
    rest[k] = v;
  }
  return rest;
}

export async function processX402Settle({
  x402Server,
  payload,
  resourceConfig,
  resourceMeta,
  extension,
  transportContext,
}: {
  /** The x402 server instance from `createX402Server`. */
  x402Server: X402Server;
  /** The verified x402 payload extracted from the X-Payment header. */
  payload: unknown;
  /** Resource configuration the facilitator validates against (network, price, payTo,
   *  asset, maxTimeoutSeconds, etc.). Shape is x402-server-specific. */
  resourceConfig: unknown;
  /** Resource metadata exposed to the facilitator (URL, description, mime type). */
  resourceMeta: { url: string; description: string; mimeType: string };
  /** Optional extension to enrich during verify (e.g. Bazaar). */
  extension?: unknown;
  /** Transport context for the extension enrich step. Defaults to `{ method: 'POST',
   *  adapter: { getPath: () => new URL(resourceMeta.url).pathname }, routePattern: <pathname> }`. */
  transportContext?: unknown;
}): Promise<ProcessX402SettleResult> {
  const server = x402Server as unknown as {
    buildPaymentRequirements: (cfg: unknown) => Promise<unknown[]>;
    enrichExtensions: (ext: unknown, ctx: unknown) => unknown;
    verifyPayment: (
      paymentPayload: unknown,
      requirements: unknown,
      declaredExtensions?: unknown,
      transportContext?: unknown,
    ) => Promise<{ success: boolean; [key: string]: unknown } | { isValid?: boolean; [key: string]: unknown }>;
    settlePayment: (
      paymentPayload: unknown,
      requirements: unknown,
      declaredExtensions?: unknown,
      transportContext?: unknown,
    ) => Promise<unknown>;
  };

  let builtRequirements: unknown[];
  try {
    builtRequirements = await server.buildPaymentRequirements(resourceConfig);
  } catch (err) {
    console.warn('[x402_settle] build_requirements failed:', err instanceof Error ? err.message : err);
    return { success: false, phase: 'facilitator_error', step: 'build_requirements', error: err };
  }
  const matchedRequirement = builtRequirements[0];
  if (!matchedRequirement) {
    return { success: false, phase: 'no_requirements', reason: 'x402Server.buildPaymentRequirements returned empty' };
  }

  // Strip the echoed `extensions`/`resource` blocks before the facilitator call: CDP's
  // verify schema admits neither, so their presence makes the payload match no union branch.
  const facilitatorPayload = stripUnsignedX402PayloadFields(payload);

  const resolvedTransportContext = transportContext ?? (() => {
    const path = new URL(resourceMeta.url).pathname;
    return { method: 'POST', adapter: { getPath: () => path }, routePattern: path };
  })();

  let enrichedExt: unknown;
  try {
    enrichedExt = extension !== undefined
      ? server.enrichExtensions(extension, resolvedTransportContext)
      : undefined;
  } catch (err) {
    console.warn('[x402_settle] enrich_extensions failed:', err instanceof Error ? err.message : err);
    return { success: false, phase: 'facilitator_error', step: 'enrich_extensions', error: err };
  }

  let verifyResult: { success?: boolean; isValid?: boolean; [key: string]: unknown };
  try {
    verifyResult = await server.verifyPayment(
      facilitatorPayload,
      matchedRequirement,
      enrichedExt as Record<string, unknown> | undefined,
      resolvedTransportContext,
    );
  } catch (err) {
    console.warn('[x402_settle] verify_payment failed:', err instanceof Error ? err.message : err);
    return { success: false, phase: 'facilitator_error', step: 'verify_payment', error: err };
  }

  // x402/core's ResourceVerifyResponse uses `isValid` (per spec). Accept the
  // legacy `success` field too for older facilitator builds.
  const verifyOk = verifyResult.isValid === true || verifyResult.success === true;
  if (!verifyOk) {
    return { success: false, phase: 'verify_failed', verifyResult };
  }

  try {
    const settleResult = await server.settlePayment(
      facilitatorPayload,
      matchedRequirement,
      enrichedExt as Record<string, unknown> | undefined,
      resolvedTransportContext,
    );
    const paymentResponseHeader = settleResult
      ? Buffer.from(JSON.stringify(settleResult)).toString('base64')
      : undefined;
    return {
      success: true,
      matchedRequirement,
      settleResult,
      paymentResponseHeader,
      verifyResult: verifyResult as { success: true; [key: string]: unknown },
    };
  } catch (err) {
    return { success: false, phase: 'settle_failed', error: err, matchedRequirement };
  }
}
