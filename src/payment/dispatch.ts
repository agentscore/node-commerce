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
