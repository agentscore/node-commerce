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
 *     local cache OR matches a configured `staticRecipients` entry) —
 *     otherwise the verify leg would compare against a freshly-rotated
 *     address and reject the credential.
 *
 * Stripe SPT and card methods don't carry an on-chain recipient, so the
 * settle leg still mints a fresh PaymentIntent for them.
 *
 * Two public entrypoints share the same options and internal helpers:
 *   - `createPayToAddressFromStripePI` returns a single string (the
 *     `preferredNetwork`'s address). Convenient when the merchant only needs
 *     one rail's payTo back.
 *   - `mintMultichainRecipients` returns the full per-rail map plus the PI
 *     id. Preferred for multi-rail merchants — avoids the second pi-cache
 *     lookup to stitch sibling addresses back together.
 *
 * Mirrors the python `pay_to_address.py` factoring.
 */

import { CheckoutValidationError } from '../errors';
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
  /** Networks to advertise to Stripe `deposit_options`. Default ['tempo', 'base', 'solana'].
   *  Networks present as a key in `staticRecipients` are removed from this list
   *  automatically — Stripe is not asked to mint a per-PI address for them. */
  networks?: string[];
  /** Merchant-owned static deposit addresses, keyed by network. Use this to bypass
   *  Stripe per-PI rotation on chains where a rotating recipient is expensive
   *  (Solana: each new recipient address costs ~0.002 SOL of ATA rent locked on
   *  an account the merchant can't close — see MPP spec §13.6 "ATA Rent Drain").
   *
   *  The SDK handles everything: (a) excludes these networks from the Stripe mint,
   *  (b) registers them with `piCache.cacheAddress` on every call (so settle-leg
   *  `hasAddress` checks pass during the TTL window), (c) merges them into the
   *  per-PI network map (so `getNetworkDepositAddress(piId, network)` returns the
   *  static address transparently), and (d) accepts the credential's signed-against
   *  recipient on the settle leg when it matches a configured static address
   *  (bypassing the `hasAddress` TTL window since merchant-owned addresses are
   *  always valid).
   *
   *  Example: `{ solana: 'FR96wd96urHJdMnYayFrPYmDeAjKvwi3rQ2wkgXXTSP8' }` */
  staticRecipients?: Record<string, string>;
  /** Optional Stripe metadata. */
  metadata?: Record<string, string>;
  /** Pending-order id; used as the Stripe idempotency key seed so retries
   *  of the same order don't mint duplicate PaymentIntents. */
  orderId?: string;
  /** Preferred network for the returned address when minting fresh. Default
   *  picks `tempo`, falls back to `base`. */
  preferredNetwork?: string;
}

/** Structured result for `mintMultichainRecipients` — exposes the full per-network
 *  deposit map plus the PI id, so merchants can stop guessing "is the returned
 *  string the tempo address or the solana static". */
export interface MintMultichainRecipientsResult {
  /** Per-network deposit address map (e.g. `{ tempo: '0x...', base: '0x...', solana: 'FR96...' }`).
   *  Merges Stripe-minted addresses with any `staticRecipients` overrides. */
  recipients: Record<string, string>;
  /** Stripe PaymentIntent id (when a PI was minted on this call) or undefined
   *  if all networks were covered by staticRecipients. */
  paymentIntentId?: string;
  /** True when the settle leg short-circuited to the credential-bound recipient
   *  instead of minting a new PI. The merchant's downstream sibling-address
   *  lookups (e.g. for the 402 retry body) should fall back to the PI cache. */
  reusedFromCredential: boolean;
}

const DEFAULT_NETWORKS = ['tempo', 'base', 'solana'] as const;

/** Returns the on-chain `pay_to` address the agent should be told to pay.
 *
 *  On the settle leg, when the inbound `Authorization: Payment` credential
 *  binds a `tempo` or `solana` recipient, the helper returns THAT address
 *  (after verifying it's still in `piCache` OR matches a configured
 *  `staticRecipients` entry). Otherwise it mints a fresh
 *  `createMultichainPaymentIntent` and caches the addresses + PI mapping.
 *
 *  When `staticRecipients` is configured, prefer `mintMultichainRecipients`
 *  instead — its structured return avoids the "is this string the tempo or
 *  the solana static" ambiguity on the settle leg. */
export async function createPayToAddressFromStripePI(
  opts: CreatePayToAddressFromStripePIOptions,
): Promise<string> {
  const fromCredential = await tryResolveFromCredential(opts);
  if (fromCredential !== null) return fromCredential;

  const { preferred } = await mintAndCache(opts);
  return preferred;
}

/** Structured variant of `createPayToAddressFromStripePI`: returns the full
 *  per-rail map plus the PI id. Preferred when the merchant's `mintRecipients`
 *  hook needs all rail addresses (typical multi-rail merchant) — saves the
 *  pi-cache lookups + sidesteps the "returned-string-is-ambiguous" trap on
 *  the settle leg when `staticRecipients` is configured. */
export async function mintMultichainRecipients(
  opts: CreatePayToAddressFromStripePIOptions,
): Promise<MintMultichainRecipientsResult> {
  const fromCredential = await tryResolveFromCredential(opts);
  if (fromCredential !== null) {
    const piId = opts.piCache.getPaymentIntentId(fromCredential);
    const networkMap = piId ? readNetworkMapFromCache(opts.piCache, piId) : {};
    const merged: Record<string, string> = { ...networkMap, ...(opts.staticRecipients ?? {}) };
    return {
      recipients: merged,
      ...(piId !== undefined && { paymentIntentId: piId }),
      reusedFromCredential: true,
    };
  }

  const { merged, paymentIntentId } = await mintAndCache(opts);
  return { recipients: merged, paymentIntentId, reusedFromCredential: false };
}

/** Parse the inbound credential and return the bound recipient when valid
 *  (cached OR a configured static), or `null` to fall through to the mint
 *  path. Throws `CheckoutValidationError` on malformed credentials or an
 *  unknown / TTL-expired recipient. */
async function tryResolveFromCredential(
  opts: CreatePayToAddressFromStripePIOptions,
): Promise<string | null> {
  const authHeader = opts.request.headers.get('authorization');
  if (!authHeader) return null;

  const { Credential } = await import('mppx');
  if (!Credential.extractPaymentScheme(authHeader)) return null;

  let credential;
  try {
    credential = Credential.fromRequest(opts.request);
  } catch {
    throw new CheckoutValidationError({
      code: 'invalid_credential',
      message: 'The Authorization: Payment header is not a valid MPP credential.',
      action: 'retry_without_credential',
      status: 401,
    });
  }
  const method = credential.challenge.method;
  if (method !== 'tempo' && method !== 'solana') return null;

  const toAddress = credential.challenge.request.recipient as unknown;
  if (typeof toAddress !== 'string' || !toAddress) {
    throw new CheckoutValidationError({
      code: 'invalid_credential',
      message: 'The MPP credential is missing its recipient field.',
      action: 'retry_without_credential',
      status: 401,
    });
  }

  // Merchant-owned static recipient is always valid — bypasses the piCache TTL
  // window since the merchant owns the address.
  const staticForMethod = opts.staticRecipients?.[method];
  if (staticForMethod && staticForMethod === toAddress) return toAddress;

  if (!(await opts.piCache.hasAddress(toAddress))) {
    throw new CheckoutValidationError({
      code: 'invalid_credential',
      message: 'The signed-against payTo recipient is not in this merchant\'s cache (unknown or expired). Retry without the Authorization: Payment header to receive a fresh 402 challenge.',
      action: 'retry_without_credential',
      status: 401,
    });
  }
  return toAddress;
}

/** Mint a fresh PI for rails not covered by `staticRecipients`, register
 *  everything in the cache, and return the per-network map + preferred
 *  address + PI id. */
async function mintAndCache(
  opts: CreatePayToAddressFromStripePIOptions,
): Promise<{ preferred: string; merged: Record<string, string>; paymentIntentId: string }> {
  const staticRecipients = opts.staticRecipients ?? {};
  const requestedNetworks = opts.networks ?? [...DEFAULT_NETWORKS];
  const stripeNetworks = requestedNetworks.filter((n) => !(n in staticRecipients));

  const idempotencyKey = opts.orderId ? `pi-${opts.orderId}-${opts.amountCents}` : undefined;
  const { paymentIntentId, depositAddresses } = await createMultichainPaymentIntent({
    stripe: opts.stripe,
    amount: opts.amountCents,
    networks: stripeNetworks,
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });

  for (const address of Object.values(depositAddresses)) {
    await opts.piCache.cacheAddress(address);
    opts.piCache.cachePaymentIntent(address, paymentIntentId);
  }
  for (const address of Object.values(staticRecipients)) {
    await opts.piCache.cacheAddress(address);
  }

  const merged: Record<string, string> = { ...depositAddresses, ...staticRecipients };
  opts.piCache.cacheNetworkAddresses(paymentIntentId, merged);

  const preferredKey = opts.preferredNetwork ?? 'tempo';
  const preferred = merged[preferredKey] ?? merged.base ?? merged.tempo;
  if (!preferred) {
    throw new CheckoutValidationError({
      code: 'payment_provider_unavailable',
      message:
        'Stripe returned deposit addresses but none matched the requested network (tempo / base / solana). The account may have only a subset of multichain networks enabled.',
      action: 'retry_later',
      status: 503,
    });
  }
  return { preferred, merged, paymentIntentId };
}

function readNetworkMapFromCache(
  piCache: PiCache,
  paymentIntentId: string,
): Record<string, string> {
  const entries: Array<[string, string]> = [];
  for (const n of DEFAULT_NETWORKS) {
    const addr = piCache.getNetworkDepositAddress(paymentIntentId, n);
    if (addr) entries.push([n, addr]);
  }
  return Object.fromEntries(entries);
}
