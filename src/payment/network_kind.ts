/** CAIP-2 prefix discriminators. Replaces the ad-hoc `startsWith('eip155:')` /
 *  `startsWith('solana:')` calls scattered across `checkout`, `checkout_compute_first`,
 *  `payment/lazy`, and `identity/ucp` so the prefix strings live in one place.
 *
 *  Accepts the bare network spec `'eip155:8453'` or a rail-spec object with a
 *  `network` field. Pure functions; no peer-dep imports.
 */

type NetworkLike = string | object | null | undefined;

function readNetwork(input: NetworkLike): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    const network = (input as { network?: unknown }).network;
    return typeof network === 'string' ? network : '';
  }
  return '';
}

/** True when the network is a CAIP-2 EVM chain (`eip155:<chainId>`). */
export function isEvmNetwork(input: NetworkLike): boolean {
  return readNetwork(input).startsWith('eip155:');
}

/** True when the network is a CAIP-2 Solana chain (`solana:<genesis-hash>`).
 *  Note: `'solana'` bare (no `:`) is the mppx-internal label, NOT a CAIP-2
 *  network spec — this helper treats it as false. */
export function isSolanaNetwork(input: NetworkLike): boolean {
  return readNetwork(input).startsWith('solana:');
}
