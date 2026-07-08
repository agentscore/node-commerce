/**
 * Zero-amount carve-out: skip upstream verify+settle for $0 orders on the
 * rails that cannot settle $0 upstream.
 *
 * Scope (which rail takes the carve-out is decided in `Checkout.handleZeroSettle`):
 *
 * - **x402 Base**: CDP rejects EIP-3009 `transferWithAuthorization` with
 *   `value=0` as `invalid_payload`, so $0 x402 orders take the carve-out. The
 *   credential is still run through `verifyX402Request` (signature shape +
 *   payTo binding) before the carve-out is honored.
 * - **Tempo (and other EVM MPP)**: NOT carved out. mppx >= 0.8 settles
 *   zero-amount challenges natively via the wallet-bound EIP-712 proof
 *   credential (full verification, access-key authorization, replay
 *   protection), so $0 Tempo orders flow through the normal MPP settle path.
 * - **Solana MPP**: `@solana/mpp` has no proof-credential contract, so there
 *   is nothing upstream to verify a $0 credential against. The carve-out
 *   parses the credential and lifts the signer for wallet-capture
 *   attribution; that signer block is UNAUTHENTICATED (parse-only) and must
 *   not be trusted for anything beyond attribution hints. Identity is still
 *   authenticated by the merchant's gate above; redemption codes are
 *   single-use; nothing settles on-chain.
 *
 * `zeroAmountCarveOut` parses the credential, lifts the signer, and returns
 * `{ signerAddress, signerNetwork, txHash: null }`. The MPP path uses inline
 * base64+JSON parsing (no `mppx` dependency at runtime) so this module stays
 * dependency-free; it is also how `handleZeroSettle` classifies the rail
 * (Solana vs EVM did:pkh source) to decide carve-out vs delegation.
 */

import type { SignerNetwork } from '../signer';

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type ZeroSettleRail = 'x402-base' | 'tempo' | 'solana';

export interface ZeroSettleResult {
  /** Recovered signer address, or `null` when the credential is malformed
   *  or shaped wrong for the requested rail. */
  signerAddress: string | null;
  /** `"evm"` or `"solana"`, matching the recovered signer's key family.
   *  `null` when no signer was recoverable. */
  signerNetwork: SignerNetwork | null;
  /** Always `null`. A zero-amount carve-out skips on-chain settlement, so
   *  no transaction hash exists. The field is present so callers can use
   *  `ZeroSettleResult` interchangeably with the success path of
   *  `processX402Settle` etc. without branching on shape. */
  txHash: null;
}

const NULL_RESULT: ZeroSettleResult = {
  signerAddress: null,
  signerNetwork: null,
  txHash: null,
};

/**
 * Skip verify+settle for a zero-amount order; recover the signer from the credential.
 *
 * Returns a `ZeroSettleResult`. `signerAddress` / `signerNetwork` are `null`
 * when the credential is malformed, missing required fields, or shaped wrong
 * for the requested rail. `txHash` is always `null` since no on-chain settle runs.
 */
export function zeroAmountCarveOut({
  rail,
  payload,
  authorizationHeader,
}: {
  rail: ZeroSettleRail;
  /** For `rail: 'x402-base'`: the verified x402 payload (decoded JSON
   *  from `verifyX402Request(...).payload`). Reads
   *  `payload.payload.authorization.from`. */
  payload?: Record<string, unknown> | null;
  /** For `rail: 'tempo'` / `'solana'`: the full `Authorization: Payment <base64>`
   *  header value. Reads the `did:pkh:*` source DID. */
  authorizationHeader?: string | null;
}): ZeroSettleResult {
  if (rail === 'x402-base') {
    return x402SignerFromPayload(payload);
  }
  if (rail === 'tempo' || rail === 'solana') {
    return mppSignerFromAuth(authorizationHeader);
  }
  return NULL_RESULT;
}

function x402SignerFromPayload(payload: Record<string, unknown> | null | undefined): ZeroSettleResult {
  if (!payload || typeof payload !== 'object') return NULL_RESULT;
  const inner = (payload as { payload?: unknown }).payload;
  if (!inner || typeof inner !== 'object') return NULL_RESULT;
  const authorization = (inner as { authorization?: unknown }).authorization;
  if (!authorization || typeof authorization !== 'object') return NULL_RESULT;
  const fromAddr = (authorization as { from?: unknown }).from;
  if (typeof fromAddr !== 'string' || !EVM_RE.test(fromAddr)) return NULL_RESULT;
  return {
    signerAddress: fromAddr.toLowerCase(),
    signerNetwork: 'evm',
    txHash: null,
  };
}

function mppSignerFromAuth(
  authorizationHeader: string | null | undefined,
): ZeroSettleResult {
  if (typeof authorizationHeader !== 'string') return NULL_RESULT;
  if (!authorizationHeader.toLowerCase().startsWith('payment ')) return NULL_RESULT;
  const token = authorizationHeader.slice('payment '.length).trim();
  if (!token) return NULL_RESULT;

  let credential: unknown;
  try {
    credential = JSON.parse(atob(token));
  } catch {
    return NULL_RESULT;
  }
  if (!credential || typeof credential !== 'object') return NULL_RESULT;

  let source = (credential as { source?: unknown }).source;
  if (typeof source !== 'string') {
    const challenge = (credential as { challenge?: unknown }).challenge;
    if (challenge && typeof challenge === 'object') {
      source = (challenge as { source?: unknown }).source;
    }
  }
  if (typeof source !== 'string') return NULL_RESULT;

  const parts = source.split(':');
  if (parts.length < 4 || parts[0] !== 'did' || parts[1] !== 'pkh') return NULL_RESULT;
  const family = parts[2];
  const addr = parts[parts.length - 1] ?? '';

  if (family === 'eip155' && EVM_RE.test(addr)) {
    return { signerAddress: addr.toLowerCase(), signerNetwork: 'evm', txHash: null };
  }
  if (family === 'solana' && SOLANA_BASE58_RE.test(addr)) {
    return { signerAddress: addr, signerNetwork: 'solana', txHash: null };
  }
  return NULL_RESULT;
}
