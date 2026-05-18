/**
 * Example: Stripe-anchored multi-chain merchant
 *
 * Scenario: you want crypto payments but you're already a Stripe merchant. Use Stripe's
 * `deposit_options` to issue per-PI deposit addresses on multiple chains (Tempo, Base,
 * Solana). Agent picks a chain and sends USDC to the matching address; Stripe auto-captures
 * when funds land. Net: one Stripe PI per purchase, multi-chain optionality, settlement
 * tracked in Stripe.
 *
 * Distinct from Stripe SPT (Shared Payment Token), which is for user-approved cards via
 * the `link-cli` flow. This example is the "merchant funds via crypto rails" path.
 *
 * Peer deps to install:
 *   bun add @agent-score/commerce hono stripe
 *
 * Env vars:
 *   STRIPE_SECRET_KEY  — sk_live_... or sk_test_...
 *
 * Run: bun run examples/stripe-multichain-merchant.ts
 */
import { rateLimitHono } from '@agent-score/commerce/middleware/hono';
import {
  STRIPE_TEST_TX_HASH_SUCCESS,
  createMultichainPaymentIntent,
  simulateCryptoDeposit,
} from '@agent-score/commerce/stripe-multichain';
import { Hono } from 'hono';
// @ts-expect-error - stripe is an optional peer dep installed by the example user
import Stripe from 'stripe';

const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-11-20.acacia' as never });

const app = new Hono();
app.use('*', rateLimitHono());

app.post('/checkout', async (c) => {
  const body = await c.req.json();
  const amountCents = Math.round(Number(body.amount_usd) * 100);

  // 1. Create a Stripe PI with deposit addresses on tempo + base + solana
  const result = await createMultichainPaymentIntent({
    stripe: stripeClient as never,
    amount: amountCents,
    networks: ['tempo', 'base', 'solana'],
    metadata: { order_id: body.order_id, merchant: 'example-store' },
    idempotencyKey: body.order_id ? `pi-${body.order_id}-${amountCents}` : undefined,
  });

  // 2. Return per-network deposit addresses to the agent (or 402 with addresses
  // embedded — see multi-rail-merchant.ts for the full 402 builder pattern).
  return c.json({
    payment_intent_id: result.paymentIntentId,
    deposit_addresses: result.depositAddresses,
    instructions: {
      tempo: result.depositAddresses.tempo
        ? `Send ${body.amount_usd} USDC on Tempo to ${result.depositAddresses.tempo}`
        : 'Tempo not available for this PI',
      base: result.depositAddresses.base
        ? `Send ${body.amount_usd} USDC on Base to ${result.depositAddresses.base}`
        : 'Base not available for this PI',
      solana: result.depositAddresses.solana
        ? `Send ${body.amount_usd} USDC on Solana to ${result.depositAddresses.solana}`
        : 'Solana not available for this PI',
    },
  });
});

// ── Testnet helper: simulate a deposit landing on a PI ──────────────────────
// Useful for end-to-end testing without real on-chain transfers.
app.post('/testnet/simulate-deposit', async (c) => {
  const body = await c.req.json();
  await simulateCryptoDeposit({
    paymentIntentId: body.payment_intent_id,
    network: body.network,
    stripeSecretKey: process.env.STRIPE_SECRET_KEY!,
    stripeVersion: '2026-03-04.preview', // if you're on a preview API
    tokenCurrency: 'usdc',
    transactionHash: STRIPE_TEST_TX_HASH_SUCCESS,
  });
  return c.json({ ok: true, simulated: true });
});

export default app;
