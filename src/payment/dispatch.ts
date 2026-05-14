/**
 * Detect which payment-protocol family the inbound request carries.
 *
 * Returns `"mpp"` when an `Authorization` header starts with the `Payment`
 * scheme (case-insensitive per RFC 7235). Returns `"x402"` when a non-empty
 * `payment-signature` or `x-payment` header is present. Returns `null` otherwise.
 *
 * In practice a client constructs a request with exactly one protocol's headers;
 * both arriving together is a client bug or misconfigured proxy. The helper checks
 * MPP first so the rare degenerate case resolves to MPP. Empty header values are
 * treated as absent. Header-name lookups are case-insensitive (RFC 7230 §3.2).
 * The narrower rail naming (`"tempo"` vs `"solana"` inside MPP) is merchant-side,
 * derived from the credential body, not this helper.
 *
 * Accepts either a Web Fetch `Headers` instance (case-insensitive lookup native)
 * or a plain object (case-insensitive lookup applied internally).
 */
export function detectRailFromHeaders(
  headers: Headers | Record<string, string | string[] | undefined>,
): 'x402' | 'mpp' | null {
  const get = (name: string): string => {
    if (headers instanceof Headers) {
      return headers.get(name) ?? '';
    }
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === lower) {
        // `null` is outside the TypeScript input type, but plain-JS callers can
        // still reach here with `{ 'x-payment': null }`; guard so `.toLowerCase()`
        // on the result doesn't throw downstream.
        if (v === undefined || v === null) return '';
        return Array.isArray(v) ? (v[0] ?? '') : v;
      }
    }
    return '';
  };

  const auth = get('authorization');
  if (auth.toLowerCase().startsWith('payment ')) {
    return 'mpp';
  }
  if (get('payment-signature') || get('x-payment')) {
    return 'x402';
  }
  return null;
}

export interface SettlementHandlers<TPayload, TResult> {
  evm?: (payload: TPayload) => TResult | Promise<TResult>;
  svm?: (payload: TPayload) => TResult | Promise<TResult>;
}

export interface SettlementPayloadLike {
  accepted: { network: string };
}

/**
 * Dispatches a settlement payload to the right network-family handler based on
 * the CAIP-2 network string in `payload.accepted.network`:
 *
 *   - eip155:* → handlers.evm
 *   - solana:* → handlers.svm
 *
 * Throws if the network is unrecognized or the matching handler is missing.
 * Most vendors will register handlers for both rail families they accept.
 */
export async function dispatchSettlementByNetwork<
  TPayload extends SettlementPayloadLike,
  TResult,
>(
  payload: TPayload,
  handlers: SettlementHandlers<TPayload, TResult>,
): Promise<TResult> {
  const network = payload.accepted.network;
  if (network.startsWith('eip155:')) {
    if (!handlers.evm) {
      throw new Error(`No EVM settlement handler registered (network: ${network})`);
    }
    return handlers.evm(payload);
  }
  if (network.startsWith('solana:')) {
    if (!handlers.svm) {
      throw new Error(`No Solana settlement handler registered (network: ${network})`);
    }
    return handlers.svm(payload);
  }
  throw new Error(`Unrecognized network in settlement payload: ${network}`);
}
