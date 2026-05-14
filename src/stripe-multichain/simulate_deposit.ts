/**
 * Stripe's documented magic test_helpers transaction hash that resolves the
 * PaymentIntent to `succeeded` within 15 seconds. Same value across all networks —
 * Stripe normalizes the format internally. Anything else (including network-shaped
 * placeholder bytes) is rejected with "not a valid testmode transaction hash".
 *
 * See: https://docs.stripe.com/payments/deposit-mode-stablecoin-payments
 */
export const STRIPE_TEST_TX_HASH_SUCCESS =
  '0x00000000000000000000000000000000000000000000000000000testsuccess';

/**
 * Stripe's documented magic test_helpers transaction hash that fails the charge
 * (PaymentIntent returns to `requires_payment_method` within 15 seconds).
 */
export const STRIPE_TEST_TX_HASH_FAILED =
  '0x000000000000000000000000000000000000000000000000000000testfailed';

const DEFAULT_BUYER_WALLET: Record<string, string> = {
  base: '0x0000000000000000000000000000000000000001',
  tempo: '0x0000000000000000000000000000000000000001',
  solana: '11111111111111111111111111111111',
};

/**
 * Call Stripe's `test_helpers/payment_intents/{id}/simulate_crypto_deposit` endpoint. Used
 * in testnet/dev to simulate a deposit landing on a PaymentIntent so the integration
 * end-to-end can be exercised without on-chain transfers.
 *
 * Throws on non-2xx responses (returns Stripe's error body in the message).
 */
export async function simulateCryptoDeposit({
  paymentIntentId,
  network,
  buyerWallet,
  tokenCurrency,
  transactionHash,
  stripeSecretKey,
  stripeVersion,
  stripeApiBase,
  extra,
}: {
  /** Stripe PaymentIntent id to simulate a deposit on. */
  paymentIntentId: string;
  /** Network the simulated deposit lands on. */
  network: 'tempo' | 'base' | 'solana';
  /** Optional simulated buyer wallet address. Defaults to a sensible placeholder per network. */
  buyerWallet?: string;
  /** Token currency (e.g., 'usdc'). Optional — passed as a form param if set. */
  tokenCurrency?: string;
  /** Simulated transaction hash. Optional — passed as a form param if set. */
  transactionHash?: string;
  /** Stripe secret key (for the test-helpers Authorization header). Must be a `sk_test_...` key. */
  stripeSecretKey: string;
  /** Stripe API version to request via the `Stripe-Version` header. Useful for preview APIs. */
  stripeVersion?: string;
  /** Override the Stripe API base URL. Default 'https://api.stripe.com'. */
  stripeApiBase?: string;
  /** Arbitrary additional form params to merge into the request body. */
  extra?: Record<string, string>;
}): Promise<void> {
  const url = `${stripeApiBase ?? 'https://api.stripe.com'}/v1/test_helpers/payment_intents/${paymentIntentId}/simulate_crypto_deposit`;
  const params = new URLSearchParams({
    network,
    buyer_wallet: buyerWallet ?? DEFAULT_BUYER_WALLET[network] ?? '',
  });
  if (tokenCurrency) params.set('token_currency', tokenCurrency);
  if (transactionHash) params.set('transaction_hash', transactionHash);
  for (const [k, v] of Object.entries(extra ?? {})) {
    params.set(k, v);
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${stripeSecretKey}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (stripeVersion) headers['Stripe-Version'] = stripeVersion;
  const res = await fetch(url, { method: 'POST', headers, body: params.toString() });
  if (!res.ok) {
    throw new Error(`Stripe simulate_crypto_deposit failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Higher-level wrapper around {@link simulateCryptoDeposit} for the testnet/dev path.
 * Bundles the three steps every Stripe-multichain merchant repeats:
 *
 *   1. Gate on `sk_test_` key prefix — production keys reject the test_helpers endpoint
 *      with 400; live deposits reach Stripe's real crypto-deposit watcher instead.
 *   2. Resolve the PaymentIntent id from the deposit address (cache lookup).
 *   3. Call `simulate_crypto_deposit` with Stripe's documented success magic hash.
 *
 * Logs `[stripe] ✓ Simulated <network> deposit for PI <id>` on success and
 * `[stripe] ✗ Failed to simulate <network> deposit for PI <id>: <err>` on failure.
 * Errors are caught + logged (never thrown) so a sim hiccup doesn't fail the order.
 *
 * Use case is exclusively dev/testnet end-to-end — production servers (sk_live_) no-op.
 */
export async function simulateDepositIfTestMode({
  getPaymentIntentId,
  depositAddress,
  network,
  buyerWallet,
  tokenCurrency,
  stripeSecretKey,
  stripeVersion,
}: {
  /** Stripe PaymentIntent id resolver — given a deposit address, return the PI id (or undefined
   *  if the cache TTL expired between 402 emit and settlement). Typically `cache.getPaymentIntentId`. */
  getPaymentIntentId: (depositAddress: string) => string | undefined;
  /** The deposit address that was paid to (recipient). */
  depositAddress: string;
  /** Network the simulated deposit lands on. */
  network: 'tempo' | 'base' | 'solana';
  /** Optional simulated buyer wallet (defaults per network in `simulateCryptoDeposit`). */
  buyerWallet?: string;
  /** Token currency to pass through to Stripe (typically `'usdc'`). */
  tokenCurrency?: string;
  /** Stripe secret key. The wrapper checks this starts with `sk_test_` and skips otherwise. */
  stripeSecretKey: string;
  /** Stripe API version (e.g. `'2026-03-04.preview'` for the deposit-mode preview). */
  stripeVersion?: string;
}): Promise<void> {
  if (!stripeSecretKey.startsWith('sk_test_')) return;
  const piId = getPaymentIntentId(depositAddress);
  if (!piId) {
    console.warn(
      `[stripe] Skipping deposit simulation — no PI cached for deposit address ${depositAddress.slice(0, 10)}… (network=${network}). The PI cache TTL may have expired between 402 emission and settlement.`,
    );
    return;
  }
  try {
    await simulateCryptoDeposit({
      paymentIntentId: piId,
      network,
      ...(buyerWallet !== undefined && { buyerWallet }),
      tokenCurrency: tokenCurrency ?? 'usdc',
      transactionHash: STRIPE_TEST_TX_HASH_SUCCESS,
      stripeSecretKey,
      ...(stripeVersion !== undefined && { stripeVersion }),
    });
    console.warn(`[stripe] ✓ Simulated ${network} deposit for PI ${piId}`);
  } catch (err) {
    console.error(
      `[stripe] ✗ Failed to simulate ${network} deposit for PI ${piId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
