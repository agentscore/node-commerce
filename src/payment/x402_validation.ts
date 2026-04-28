/**
 * x402 boot-time + per-request validation helpers.
 *
 * Two layers of validation every x402-accepting merchant repeats:
 *
 *   - **Boot-time**: validate the configured `X402_BASE_NETWORK` + `X402_SVM_NETWORK`
 *     env vars are in the supported set, and aren't pointing at the same network
 *     family. Failing loud at boot is much better than per-request "unsupported
 *     network" errors after a misconfigured deploy.
 *
 *   - **Per-request**: when an x402 X-Payment header arrives, parse the base64
 *     payload, extract the signed network + payTo, validate against the merchant's
 *     accepted networks, validate the payTo address shape per network family, and
 *     check that the payTo was minted by THIS merchant (cache hit). Each step has
 *     its own denial code and `next_steps` shape — getting the message right by
 *     hand across 4 conditions is fiddly.
 */

import { networks, networkFamily } from './networks';

/** CAIP-2 networks the commerce SDK supports for x402 Base (EVM USDC). */
export const X402_SUPPORTED_BASE_NETWORKS = new Set<string>([
  networks.base.mainnet.caip2,
  networks.base.sepolia.caip2,
]);

/** CAIP-2 networks the commerce SDK supports for x402 Solana (SPL Token USDC). */
export const X402_SUPPORTED_SVM_NETWORKS = new Set<string>([
  networks.solana.mainnet.caip2,
  networks.solana.devnet.caip2,
]);

export interface ValidateX402NetworkConfigInput {
  /** CAIP-2 base network string (e.g. `'eip155:8453'`). */
  baseNetwork: string;
  /** CAIP-2 SVM network string (e.g. `'solana:5eykt…'`). */
  svmNetwork: string;
}

/**
 * Boot-time guard: throws if either network isn't supported, or if both point at the
 * same family (which would silently route Solana payments to the Base path or vice
 * versa). Call once at module init / server boot.
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
  if (!X402_SUPPORTED_SVM_NETWORKS.has(input.svmNetwork)) {
    throw new Error(
      `X402_SVM_NETWORK=${input.svmNetwork} is not supported. Use one of: ${[...X402_SUPPORTED_SVM_NETWORKS].join(', ')}`,
    );
  }
  if (input.baseNetwork === input.svmNetwork) {
    throw new Error(
      `X402_BASE_NETWORK and X402_SVM_NETWORK must be different (both set to ${input.baseNetwork}).`,
    );
  }
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface VerifyX402RequestInput {
  /** The incoming Request — `verifyX402Request` reads the X-Payment / payment-signature header. */
  request: Request;
  /** Async lookup that returns true when the address was minted by this merchant
   *  (typically `piCache.hasAddress`). The cache check defends against agents replaying
   *  credentials against attacker-controlled deposit addresses. */
  isCachedAddress: (address: string) => Promise<boolean>;
  /** The merchant's accepted networks per family. Both required — pass the same env
   *  values you fed to `validateX402NetworkConfig`. */
  acceptedNetworks: {
    /** CAIP-2 base network — e.g. `'eip155:8453'`. */
    base: string;
    /** CAIP-2 SVM network — e.g. `'solana:5eykt…'`. */
    svm: string;
  };
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
      /** True when the signed network is Solana — useful for routing settlement. */
      isSolana: boolean;
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
  "If you're trying to pay with Tempo USDC, use `tempo request` (sends Authorization: Payment), not a manual X-Payment header. Do NOT use `tempo wallet transfer` — that sends USDC on-chain but will not complete the MPP handshake. For x402 on Base/Solana, use `agentscore-pay pay` so the X-Payment credential is signed and submitted; bare wallet transfers do not complete the handshake.";

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
 * Returns `{ok: true, payload, signedNetwork, signedPayTo, isSolana}` when valid; the
 * caller passes `payload` straight into `processX402Settle`.
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

  if (!signedNetwork || (signedNetwork !== input.acceptedNetworks.base && signedNetwork !== input.acceptedNetworks.svm)) {
    return {
      ok: false,
      status: 400,
      body: regenerateBody(
        `Unsupported x402 network ${signedNetwork ?? '<missing>'}; this server accepts ${input.acceptedNetworks.base} (Base) and ${input.acceptedNetworks.svm} (Solana)`,
        'The credential signed for an unsupported network. Pick one of the accepted networks from the 402 challenge and re-sign.',
      ),
    };
  }

  const isSolana = networkFamily(signedNetwork) === 'solana';
  const addressShapeOk = isSolana
    ? typeof signedPayTo === 'string' && SOLANA_ADDRESS_RE.test(signedPayTo)
    : typeof signedPayTo === 'string' && EVM_ADDRESS_RE.test(signedPayTo);

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

  return { ok: true, payload, signedNetwork, signedPayTo, isSolana };
}
