/**
 * Minimal Stripe client surface — only the methods we use. Vendors pass their actual
 * `Stripe` instance (peer dep on the `stripe` package); this interface keeps the SDK
 * decoupled from any specific Stripe version.
 */
export interface StripeClientLike {
  paymentIntents: {
    create(
      params: Record<string, unknown>,
      opts?: { idempotencyKey?: string },
    ): Promise<StripePaymentIntent>;
  };
}

export interface StripePaymentIntent {
  id: string;
  next_action?: {
    crypto_display_details?: {
      deposit_addresses?: Record<string, { address?: string } | undefined>;
    };
  } | null;
  [key: string]: unknown;
}

export interface MultichainPaymentIntentResult {
  /** Stripe PaymentIntent ID. */
  paymentIntentId: string;
  /** Map of network name → on-chain deposit address. e.g., { tempo: '0x...', base: '0x...', solana: '...' }. */
  depositAddresses: Record<string, string>;
}

/**
 * Create a Stripe PaymentIntent with `deposit_options.networks` set to multiple chains,
 * returning the PI id + deposit addresses per network. The agent sends funds to the
 * address on whichever chain they prefer (via x402 or MPP), and Stripe auto-captures
 * the PI when funds land.
 *
 * This is the canonical path for the multi-chain x402 + Tempo flow.
 * Distinct from the Stripe SPT (Shared Payment Token) flow, which is handled via
 * `createMppxStripe` + the agent's own Stripe account or `link-cli`.
 */
export async function createMultichainPaymentIntent({
  stripe,
  amount,
  currency = 'usd',
  networks,
  metadata,
  idempotencyKey,
}: {
  /** A configured Stripe SDK instance. */
  stripe: StripeClientLike;
  /** Amount in cents (Stripe convention — $1.00 = 100). */
  amount: number;
  /** Currency code. Default 'usd'. */
  currency?: string;
  /** Networks to advertise to Stripe deposit_options. Default ['tempo', 'base', 'solana']. */
  networks?: string[];
  /** Metadata to attach to the PI (visible in Stripe dashboard). */
  metadata?: Record<string, string>;
  /** Idempotency key — agent retries of the same purchase won't create duplicate PIs. */
  idempotencyKey?: string;
}): Promise<MultichainPaymentIntentResult> {
  const pi = await stripe.paymentIntents.create(
    {
      amount,
      currency,
      payment_method_types: ['crypto'],
      payment_method_data: { type: 'crypto' },
      payment_method_options: {
        crypto: {
          mode: 'deposit',
          deposit_options: { networks: networks ?? ['tempo', 'base', 'solana'] },
        },
      },
      confirm: true,
      ...(metadata ? { metadata } : {}),
    },
    idempotencyKey ? { idempotencyKey } : undefined,
  );

  const depositAddresses: Record<string, string> = {};
  const addrs = pi.next_action?.crypto_display_details?.deposit_addresses ?? {};
  for (const [network, info] of Object.entries(addrs)) {
    if (info?.address) depositAddresses[network] = info.address;
  }

  if (Object.keys(depositAddresses).length === 0) {
    throw new Error('No deposit addresses returned from Stripe PaymentIntent');
  }

  return { paymentIntentId: pi.id, depositAddresses };
}
