export interface SimulateCryptoDepositInput {
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
}

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
export async function simulateCryptoDeposit(input: SimulateCryptoDepositInput): Promise<void> {
  const url = `${input.stripeApiBase ?? 'https://api.stripe.com'}/v1/test_helpers/payment_intents/${input.paymentIntentId}/simulate_crypto_deposit`;
  const params = new URLSearchParams({
    network: input.network,
    buyer_wallet: input.buyerWallet ?? DEFAULT_BUYER_WALLET[input.network] ?? '',
  });
  if (input.tokenCurrency) params.set('token_currency', input.tokenCurrency);
  if (input.transactionHash) params.set('transaction_hash', input.transactionHash);
  for (const [k, v] of Object.entries(input.extra ?? {})) {
    params.set(k, v);
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.stripeSecretKey}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (input.stripeVersion) headers['Stripe-Version'] = input.stripeVersion;
  const res = await fetch(url, { method: 'POST', headers, body: params.toString() });
  if (!res.ok) {
    throw new Error(`Stripe simulate_crypto_deposit failed: ${res.status} ${await res.text()}`);
  }
}
