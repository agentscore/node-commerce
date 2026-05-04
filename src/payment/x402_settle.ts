/**
 * `processX402Settle` — single-call x402 verify+settle for merchants.
 *
 * Wraps the four x402-server steps every x402-accepting merchant repeats:
 *   1. `buildPaymentRequirements(resourceConfig)` — builds the requirement entries the
 *      facilitator validates against
 *   2. `enrichExtensions(extension, transportContext)` — folds in Bazaar (or other)
 *      extensions for the verify step
 *   3. `processPaymentRequest(payload, resourceConfig, resourceMeta, extensions)` —
 *      runs verify against the facilitator
 *   4. `settlePayment(payload, matchedRequirement)` — settles on-chain
 *
 * Returns a tagged result so the caller can map errors to merchant-shaped responses
 * without owning the orchestration boilerplate.
 */

import type { X402Server } from './x402_server';

export interface ProcessX402SettleInput {
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
}

export type ProcessX402SettleResult =
  | {
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
  | { success: false; phase: 'no_requirements'; reason: string }
  | { success: false; phase: 'verify_failed'; verifyResult: unknown }
  | { success: false; phase: 'settle_failed'; error: unknown; matchedRequirement: unknown }
  | {
      success: false;
      /** Facilitator threw an unexpected error during one of the verify-stage calls
       *  (build requirements, extension enrich, or processPaymentRequest). Most common
       *  cause: the facilitator client rejects the configured network — for example,
       *  Coinbase's CDP facilitator throws on Solana devnet because it only supports
       *  mainnet networks. The merchant should emit a 503 with diagnostic info so the
       *  agent can pick a different rail or the operator can fix the deploy config. */
      phase: 'facilitator_error';
      /** Which verify-stage step threw. */
      step: 'build_requirements' | 'enrich_extensions' | 'process_payment_request';
      error: unknown;
    };

export async function processX402Settle(input: ProcessX402SettleInput): Promise<ProcessX402SettleResult> {
  const server = input.x402Server as unknown as {
    buildPaymentRequirements: (cfg: unknown) => Promise<unknown[]>;
    enrichExtensions: (ext: unknown, ctx: unknown) => unknown;
    processPaymentRequest: (
      payload: unknown,
      cfg: unknown,
      meta: unknown,
      ext: unknown,
    ) => Promise<{ success: boolean; [key: string]: unknown }>;
    settlePayment: (payload: unknown, requirement: unknown) => Promise<unknown>;
  };

  let builtRequirements: unknown[];
  try {
    builtRequirements = await server.buildPaymentRequirements(input.resourceConfig);
  } catch (err) {
    return { success: false, phase: 'facilitator_error', step: 'build_requirements', error: err };
  }
  const matchedRequirement = builtRequirements[0];
  if (!matchedRequirement) {
    return { success: false, phase: 'no_requirements', reason: 'x402Server.buildPaymentRequirements returned empty' };
  }

  const transportContext = input.transportContext ?? (() => {
    const path = new URL(input.resourceMeta.url).pathname;
    return { method: 'POST', adapter: { getPath: () => path }, routePattern: path };
  })();

  let enrichedExt: unknown;
  try {
    enrichedExt = input.extension !== undefined
      ? server.enrichExtensions(input.extension, transportContext)
      : undefined;
  } catch (err) {
    return { success: false, phase: 'facilitator_error', step: 'enrich_extensions', error: err };
  }

  let verifyResult: { success: boolean; [key: string]: unknown };
  try {
    verifyResult = await server.processPaymentRequest(
      input.payload,
      input.resourceConfig,
      input.resourceMeta,
      enrichedExt,
    );
  } catch (err) {
    return { success: false, phase: 'facilitator_error', step: 'process_payment_request', error: err };
  }

  if (!verifyResult.success) {
    return { success: false, phase: 'verify_failed', verifyResult };
  }

  try {
    const settleResult = await server.settlePayment(input.payload, matchedRequirement);
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
