/**
 * x402 boot-time + per-request validation helpers.
 *
 * Two layers of validation every x402-accepting merchant repeats:
 *
 *   - **Boot-time**: validate the configured `X402_BASE_NETWORK` env var is in the
 *     supported set. Failing loud at boot is much better than per-request "unsupported
 *     network" errors after a misconfigured deploy.
 *
 *   - **Per-request**: when an x402 X-Payment header arrives, parse the base64 payload,
 *     extract the signed network + payTo, validate against the merchant's accepted
 *     network, validate the payTo address shape, and check that the payTo was minted by
 *     THIS merchant (cache hit). Each step has its own denial code and `next_steps`
 *     shape — getting the message right by hand across 4 conditions is fiddly.
 */

import { networks } from './networks';

/** CAIP-2 networks the commerce SDK supports for x402 Base (EVM USDC). */
export const X402_SUPPORTED_BASE_NETWORKS = new Set<string>([
  networks.base.mainnet.caip2,
  networks.base.sepolia.caip2,
]);

export interface ValidateX402NetworkConfigInput {
  /** CAIP-2 base network string (e.g. `'eip155:8453'`). */
  baseNetwork: string;
}

/**
 * Boot-time guard: throws if the base network isn't supported. Call once at module
 * init / server boot.
 *
 * Throws `Error` with a message that names the unsupported value AND lists the valid
 * options — agents tracking down a misconfigured deploy don't need to grep for the
 * supported list.
 */
export function validateX402NetworkConfig(input: ValidateX402NetworkConfigInput): void {
  if (!X402_SUPPORTED_BASE_NETWORKS.has(input.baseNetwork)) {
    throw new Error(
      `X402_BASE_NETWORK=${input.baseNetwork} is not supported. Use one of: ${[...X402_SUPPORTED_BASE_NETWORKS].join(', ')}`,
    );
  }
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export interface VerifyX402RequestInput {
  /** The incoming Request — `verifyX402Request` reads the X-Payment / payment-signature header. */
  request: Request;
  /** Async lookup that returns true when the address was minted by this merchant
   *  (typically `piCache.hasAddress`). The cache check defends against agents replaying
   *  credentials against attacker-controlled deposit addresses. */
  isCachedAddress: (address: string) => Promise<boolean>;
  /** The merchant's accepted Base network. CAIP-2, e.g. `'eip155:8453'`. */
  acceptedNetwork: string;
}

export type VerifyX402RequestResult =
  | {
      ok: true;
      /** The base64-decoded JSON payload from the X-Payment header. */
      payload: { accepted?: { network?: string; payTo?: string }; [key: string]: unknown };
      /** The CAIP-2 network the agent signed for. */
      signedNetwork: string;
      /** The on-chain pay-to address the agent signed for (already validated). */
      signedPayTo: string;
    }
  | {
      ok: false;
      /** Suitable as a JSON body for the merchant's denial response. Includes
       *  `next_steps` with `regenerate_payment_credential` action + a per-condition
       *  `user_message` and a footgun `warning` so agents can recover deterministically
       *  from the response alone. */
      body: {
        error: { code: string; message: string };
        next_steps: {
          action: 'regenerate_payment_credential';
          user_message: string;
          warning: string;
        };
      };
      /** HTTP status to use for the denial response. */
      status: 400;
    };

const REGENERATE_WARNING =
  'Use `agentscore-pay pay --chain base` (or `tempo request` for Tempo USDC) so the credential is signed and submitted via the protocol handshake. Do NOT use `tempo wallet transfer` — that sends USDC on-chain but does not complete the handshake.';

function regenerateBody(message: string, userMessage: string) {
  return {
    error: { code: 'payment_proof_invalid' as const, message },
    next_steps: {
      action: 'regenerate_payment_credential' as const,
      user_message: userMessage,
      warning: REGENERATE_WARNING,
    },
  };
}

/**
 * Per-request: parse the x402 X-Payment header, validate the network + payTo, and
 * confirm the address was minted by this merchant. One call replaces ~45 lines of
 * inline header decode + regex validation + cache lookup.
 *
 * Returns `{ok: true, payload, signedNetwork, signedPayTo}` when valid; the caller
 * passes `payload` straight into `processX402Settle`.
 *
 * Returns `{ok: false, body, status}` when invalid — the merchant just does
 * `return c.json(body, status)` (or framework equivalent).
 *
 * Reads the header from `payment-signature` first, falling back to `x-payment` (both
 * are in the wild as the binary-friendly transport name evolved).
 */
export async function verifyX402Request(input: VerifyX402RequestInput): Promise<VerifyX402RequestResult> {
  const headerValue =
    input.request.headers.get('payment-signature')
    ?? input.request.headers.get('x-payment');
  if (!headerValue) {
    return {
      ok: false,
      status: 400,
      body: regenerateBody(
        'X-Payment header missing',
        'No X-Payment header was sent. Generate the credential from the 402 challenge and resubmit on the same endpoint.',
      ),
    };
  }

  let payload: { accepted?: { network?: string; payTo?: string }; [key: string]: unknown };
  try {
    payload = JSON.parse(Buffer.from(headerValue, 'base64').toString());
  } catch {
    return {
      ok: false,
      status: 400,
      body: regenerateBody(
        'X-Payment header is not valid base64 JSON',
        'The payment credential could not be decoded. Reconstruct the credential from the 402 challenge and retry.',
      ),
    };
  }

  const signedNetwork = payload.accepted?.network;
  const signedPayTo = payload.accepted?.payTo;

  if (!signedNetwork || signedNetwork !== input.acceptedNetwork) {
    return {
      ok: false,
      status: 400,
      body: regenerateBody(
        `Unsupported x402 network ${signedNetwork ?? '<missing>'}; this server accepts ${input.acceptedNetwork}.`,
        'The credential signed for an unsupported network. Pick the accepted network from the 402 challenge and re-sign.',
      ),
    };
  }

  const addressShapeOk = typeof signedPayTo === 'string' && EVM_ADDRESS_RE.test(signedPayTo);

  if (!signedPayTo || !addressShapeOk) {
    return {
      ok: false,
      status: 400,
      body: regenerateBody(
        `Payment payload missing or malformed accepted.payTo address for network ${signedNetwork}`,
        'The credential payload is missing or malformed payTo for the signed network. Reconstruct the credential from the 402 challenge.',
      ),
    };
  }

  if (!(await input.isCachedAddress(signedPayTo))) {
    return {
      ok: false,
      status: 400,
      body: regenerateBody(
        'payTo address not found in cache or expired. Request a fresh 402 challenge and retry.',
        'The deposit address is unknown or expired on this server. Request a fresh 402 challenge and re-sign against the new payTo.',
      ),
    };
  }

  return { ok: true, payload, signedNetwork, signedPayTo };
}
