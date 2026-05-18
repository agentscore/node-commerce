/**
 * Per-order Stripe-multichain `pay_to` resolver.
 *
 * Stripe-multichain merchants need ONE function for their `mintRecipients`
 * (or per-request payTo) hook that does the right thing on both legs:
 *
 *   - **Discovery leg** (no payment header): mint a fresh PaymentIntent so
 *     the 402 advertises a stable per-order deposit address.
 *   - **Settle leg** (MPP credential attached): reuse the buyer's
 *     signed-against payTo from the credential (after verifying it's in the
 *     local cache) — otherwise the verify leg would compare against a
 *     freshly-rotated address and reject the credential.
 *
 * Stripe SPT and card methods don't carry an on-chain recipient, so the
 * settle leg still mints a fresh PaymentIntent for them.
 *
 * Mirrors the hand-rolled `createPayToAddress` block consumers wrote in
 * `lib/payment.ts`. Lifts the structural branching; merchants keep
 * env-driven config (network list, default network, metadata) at the call site.
 */

import { createMultichainPaymentIntent, type StripeClientLike } from './payment_intent';
import type { PiCache } from './pi-cache';

export interface CreatePayToAddressFromStripePIOptions {
  /** Inbound HTTP request — header is read for an Authorization Payment credential. */
  request: Request;
  /** Order amount in cents. */
  amountCents: number;
  /** Configured Stripe client (peer dep). */
  stripe: StripeClientLike;
  /** Cache backing the merchant's minted addresses + PI lookups. */
  piCache: PiCache;
  /** Networks to advertise to Stripe `deposit_options`. Default ['tempo', 'base', 'solana']. */
  networks?: string[];
  /** Optional Stripe metadata. */
  metadata?: Record<string, string>;
  /** Pending-order id; used as the Stripe idempotency key seed so retries
   *  of the same order don't mint duplicate PaymentIntents. */
  orderId?: string;
  /** Preferred network for the returned address when minting fresh. Default
   *  picks `tempo`, falls back to `base`. */
  preferredNetwork?: string;
}

/** Returns the on-chain `pay_to` address the agent should be told to pay
 *  (in the 402 challenge or the bound MPP credential).
 *
 *  On the settle leg, when the inbound `Authorization: Payment` credential
 *  binds a `tempo` or `solana` recipient, the helper returns THAT address
 *  (after verifying it's still in `piCache`). Otherwise it mints a fresh
 *  `createMultichainPaymentIntent` and caches the addresses + PI mapping. */
export async function createPayToAddressFromStripePI(
  opts: CreatePayToAddressFromStripePIOptions,
): Promise<string> {
  const authHeader = opts.request.headers.get('authorization');
  if (authHeader) {
    const { Credential } = await import('mppx');
    if (Credential.extractPaymentScheme(authHeader)) {
      const credential = Credential.fromRequest(opts.request);
      const method = credential.challenge.method;
      if (method === 'tempo' || method === 'solana') {
        const toAddress = credential.challenge.request.recipient as string;
        if (!(await opts.piCache.hasAddress(toAddress))) {
          throw new Error('Invalid payTo address: not found in cache or expired');
        }
        return toAddress;
      }
    }
  }

  const idempotencyKey = opts.orderId ? `pi-${opts.orderId}-${opts.amountCents}` : undefined;
  const { paymentIntentId, depositAddresses } = await createMultichainPaymentIntent({
    stripe: opts.stripe,
    amount: opts.amountCents,
    networks: opts.networks ?? ['tempo', 'base', 'solana'],
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });

  for (const address of Object.values(depositAddresses)) {
    await opts.piCache.cacheAddress(address);
    opts.piCache.cachePaymentIntent(address, paymentIntentId);
  }
  opts.piCache.cacheNetworkAddresses(paymentIntentId, depositAddresses);

  const preferred = opts.preferredNetwork ?? 'tempo';
  const payTo = depositAddresses[preferred] ?? depositAddresses.base ?? depositAddresses.tempo;
  if (!payTo) {
    throw new Error('Failed to resolve pay_to address from Stripe PaymentIntent');
  }
  return payTo;
}
