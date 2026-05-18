/** Settle-outcome → simulator dispatch. Replaces the 3-branch rail/railKey
 *  switch + thin `simulateDepositIfTestnet(addr, network)` wrapper that
 *  consumer codebases (sayer, martin, sandbox) hand-rolled in their own
 *  `lib/payment.ts` files.
 *
 *  Folding the dispatch into the SDK removes the consumer-wrap anti-pattern
 *  (`feedback_no_consumer_sdk_rewrapping`): merchants call this directly from
 *  `onSettled`, no per-merchant payment.ts wrapper needed.
 */

import { simulateDepositIfTestMode } from './simulate_deposit';

export type SimulateNetwork = 'tempo' | 'base' | 'solana';

/** Map a settle outcome (from `Checkout.onSettled` or
 *  `computeFirstCheckout.onSettled`) to the `network` arg consumed by
 *  `simulateDepositIfTestMode`. Returns null for:
 *   - Stripe SPT (no on-chain deposit)
 *   - rails we don't recognize
 *
 *  Accepts both Checkout-shaped outcomes (`rail` + `railKey`) and
 *  computeFirstCheckout-shaped outcomes (`rail` + `mppMethod`). The settle
 *  outcomes diverged historically; this helper canonicalizes them. */
export function networkForOutcome(outcome: {
  rail?: string;
  railKey?: string;
  mppMethod?: string;
}): SimulateNetwork | null {
  if (outcome.rail === 'x402') return 'base';
  // mppx's Receipt.method can be either the bare scheme name (`'tempo'`) or
  // the full directive (`'tempo/charge'`) depending on the version + path.
  // Accept both.
  const method = outcome.mppMethod?.split('/')[0];
  if (method === 'tempo') return 'tempo';
  if (method === 'solana') return 'solana';
  if (method === 'stripe') return null;
  if (outcome.railKey === 'tempo' || outcome.railKey === 'tempo_mpp') return 'tempo';
  if (outcome.railKey === 'solana_mpp') return 'solana';
  if (outcome.railKey === 'x402_base') return 'base';
  if (outcome.railKey === 'stripe') return null;
  return null;
}

export interface SimulateDepositForOutcomeOptions {
  /** The settle outcome handed to `onSettled`. Reads `rail` / `railKey` /
   *  `mppMethod` to pick the network arg. */
  outcome: { rail?: string; railKey?: string; mppMethod?: string };
  /** On-chain deposit address that was paid to. For Stripe-multichain
   *  merchants this is the per-order minted address; for static-recipient
   *  merchants it's the merchant treasury. */
  depositAddress: string;
  /** PI-id resolver. Typically `piCache.getPaymentIntentId` from
   *  `createPiCache(...)`. */
  getPaymentIntentId: (depositAddress: string) => string | undefined;
  /** Stripe secret key. The wrapper checks `sk_test_` and no-ops on live. */
  stripeSecretKey: string;
  /** Stripe API version (defaults to the deposit-mode preview). */
  stripeVersion?: string;
  /** Optional simulated buyer wallet. */
  buyerWallet?: string;
}

/** Dispatch `simulateDepositIfTestMode` based on the outcome's rail. Calls
 *  through to the SDK simulator; no-op for Stripe SPT or unknown rails.
 *
 *  Use this in `onSettled` to replace the hand-rolled rail switch +
 *  `simulateDepositIfTestnet` wrapper pattern. */
export async function simulateDepositForOutcome(opts: SimulateDepositForOutcomeOptions): Promise<void> {
  const network = networkForOutcome(opts.outcome);
  if (!network) return;
  return simulateDepositIfTestMode({
    getPaymentIntentId: opts.getPaymentIntentId,
    depositAddress: opts.depositAddress,
    network,
    ...(opts.buyerWallet !== undefined && { buyerWallet: opts.buyerWallet }),
    stripeSecretKey: opts.stripeSecretKey,
    ...(opts.stripeVersion !== undefined && { stripeVersion: opts.stripeVersion }),
  });
}
