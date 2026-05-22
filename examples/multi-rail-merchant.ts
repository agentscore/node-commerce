/**
 * Example: full regulated-commerce merchant.
 *
 * Scenario: you sell a regulated good. Identity gate (KYC + age + jurisdiction
 * + sanctions), plus a 402 payment challenge advertising multiple rails so
 * agents pay with whatever they have: Tempo USDC (MPP `tempo/charge`), x402
 * USDC on Base, Solana USDC (MPP `solana/charge`), Stripe SPT.
 *
 * `Checkout(...)` orchestrates the flow:
 *
 * 1. Identity gate runs only on the settle leg (a payment header is attached);
 *    the discovery leg flows through anonymously and gets a 402 with all rails.
 * 2. `mintRecipients` hook calls Stripe to mint per-PI deposit addresses for
 *    tempo/base/solana before the 402 emits, so the body advertises the right
 *    addresses.
 * 3. `computePricing` returns the subtotal + tax block for the current cart.
 * 4. x402-base header → Checkout dispatches to `processX402Settle` internally.
 * 5. `Authorization: Payment` header → Checkout dispatches to the auto-derived
 *    `composeMppx` hook (built from `mppxSecretKey`).
 * 6. `onSettled` persists the order + fires `simulateDepositForOutcome` for
 *    Stripe testnet round-trip on any chain (rail dispatched automatically).
 *
 * Peer deps:
 *   bun add @agent-score/commerce hono mppx stripe \
 *           @x402/core @x402/evm @x402/extensions @solana/mpp @solana/kit
 *
 * Env vars:
 *   AGENTSCORE_API_KEY    your AgentScore API key
 *   APP_URL               public URL of your service
 *   STRIPE_SECRET_KEY     sk_test_... or sk_live_...
 *   STRIPE_PROFILE_ID     your Stripe Connect profile id (for SPT)
 *   X402_BASE_NETWORK     CAIP-2 (default eip155:8453)
 *   SOLANA_NETWORK_CAIP2  CAIP-2 (default solana mainnet)
 *   MPP_SECRET_KEY        secret_key for the auto-derived mppx server
 *   CDP_API_KEY_ID        Coinbase CDP key id (auto-promotes x402 facilitator)
 *   CDP_API_KEY_SECRET    Coinbase CDP key secret
 *   REDIS_URL             optional; in-memory PI cache otherwise
 *
 * Run: bun run examples/multi-rail-merchant.ts
 */
import {
  Checkout,
  CheckoutGateConfig,
  CheckoutValidationError,
  pricingResult,
  type CheckoutContext,
  type PricingResult,
  type Receipt,
  type SettleOutcome,
} from '@agent-score/commerce';
import { buildSuccessNextSteps } from '@agent-score/commerce/discovery';
import { rateLimitHono } from '@agent-score/commerce/middleware/hono';
import { buildDefaultCheckoutRails, networks, validateX402NetworkConfig } from '@agent-score/commerce/payment';
import {
  createPiCache,
  mintMultichainRecipients,
  simulateDepositForOutcome,
} from '@agent-score/commerce/stripe-multichain';
import { Hono, type Context } from 'hono';
// @ts-expect-error stripe is an optional peer dep installed by the example user
import Stripe from 'stripe';

const APP_URL = process.env.APP_URL!;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY!;
const STRIPE_PROFILE_ID = process.env.STRIPE_PROFILE_ID!;
const AGENTSCORE_API_KEY = process.env.AGENTSCORE_API_KEY!;
const X402_BASE_NETWORK = process.env.X402_BASE_NETWORK ?? networks.base.mainnet.caip2;
const SOLANA_NETWORK_CAIP2 = process.env.SOLANA_NETWORK_CAIP2 ?? networks.solana.mainnet.caip2;

// Boot-time guard: fails the deploy on a misconfigured x402 base network.
validateX402NetworkConfig({ baseNetwork: X402_BASE_NETWORK });

const stripeClient = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-11-20.acacia' as never });

// Singleton Stripe PI / deposit-address cache. Backed by Redis when REDIS_URL is set
// (multi-task deployments need this so a deposit lands on whichever task settles it).
const piCache = createPiCache({ redisUrl: process.env.REDIS_URL });

async function _validatePurchase(ctx: CheckoutContext): Promise<Record<string, unknown>> {
  const body = (ctx.request.body ?? {}) as Record<string, unknown>;
  const shipping = body.shipping as { state?: string } | undefined;
  if (!shipping) {
    throw new CheckoutValidationError({ code: 'missing_shipping', message: '`shipping` is required.' });
  }
  return { shippingState: shipping.state ?? 'CA' };
}

async function _computePricing(ctx: CheckoutContext): Promise<PricingResult> {
  return pricingResult({
    subtotalCents: 25000,
    taxCents: 2000,
    taxRate: 0.08,
    taxState: (ctx.state.shippingState as string | undefined) ?? 'CA',
  });
}

async function _mintRecipients(ctx: CheckoutContext): Promise<Record<string, string>> {
  const totalCents = Math.round((ctx.pricing?.amountUsd ?? 0) * 100);
  // `mintMultichainRecipients` returns the full per-rail map in one call —
  // preferred over the single-string `createPayToAddressFromStripePI` for
  // multi-rail merchants because there's no second pi-cache lookup to glue
  // the other rails' addresses back together. On the settle leg it short-
  // circuits to the buyer's signed-against payTo from the MPP credential;
  // on the discovery leg it mints a fresh multichain PI + caches everything.
  //
  // For low-margin endpoints (sub-dollar per call), pass
  // `staticRecipients: { solana: process.env.MERCHANT_SOLANA_RECIPIENT! }` to
  // skip Stripe minting on Solana — at $0.01/call MPP spec §13.6's ~$0.50 per-PI
  // ATA rent dominates revenue. With a stable merchant-owned recipient + one-
  // time external pre-funding of its USDC ATA, every settle pays only the
  // per-tx fee.
  const { recipients } = await mintMultichainRecipients({
    request: ctx.request.raw as Request,
    amountCents: totalCents,
    stripe: stripeClient as never,
    piCache,
    networks: ['tempo', 'base', 'solana'],
  });
  const out: Record<string, string> = {};
  if (recipients.tempo) out.tempo = recipients.tempo;
  if (recipients.base) out.x402_base = recipients.base;
  if (recipients.solana) out.solana_mpp = recipients.solana;
  return out;
}

async function _onSettled(ctx: CheckoutContext, outcome: SettleOutcome): Promise<Record<string, unknown>> {
  // Stripe testnet deposit simulation (no-op on live keys). The dispatcher
  // picks the right network arg from the outcome's rail / railKey, no-ops on
  // Stripe SPT (no on-chain deposit), and gates on `txHash` so $0 zero-settle
  // carve-outs don't trigger a PI sim.
  const depositAddress = ctx.recipients.tempo ?? ctx.recipients.x402_base ?? ctx.recipients.solana_mpp;
  if (depositAddress && outcome.txHash !== null) {
    await simulateDepositForOutcome({
      outcome,
      depositAddress,
      getPaymentIntentId: piCache.getPaymentIntentId,
      stripeSecretKey: STRIPE_SECRET_KEY,
    });
  }
  // Compose the canonical Receipt shape returned on 200. Goods merchants
  // populate the goods-only slots (shipping, fulfillment_status, tracking)
  // at fulfillment time; this example wires the universal fields.
  const receipt: Receipt = {
    id: ctx.referenceId,
    created_at: new Date().toISOString(),
    ...(ctx.pricing?.block !== undefined ? { pricing: ctx.pricing.block } : {}),
    product: { name: 'Regulated Goods Cart' },
    payment_status: 'completed',
    next_steps: buildSuccessNextSteps({
      orderStatusUrl: `${APP_URL}/orders/${ctx.referenceId}`,
    }),
    extras: {
      tx_hash: outcome.txHash,
      identity_status: ctx.identityStatus,
    },
  };
  return receipt as unknown as Record<string, unknown>;
}

const checkout = new Checkout({
  // Per-order-mint pattern: defaults supply network/chainId/token + a `recipient: ''`
  // sentinel; `mintRecipients` resolves the real per-PI address at request time.
  rails: buildDefaultCheckoutRails({
    tempo: { network: 'tempo-mainnet' },
    x402Base: { network: X402_BASE_NETWORK },
    solanaMpp: { network: SOLANA_NETWORK_CAIP2 },
    stripe: { profileId: STRIPE_PROFILE_ID },
  }),
  url: `${APP_URL}/purchase`,
  preValidate: _validatePurchase,
  computePricing: _computePricing,
  mintRecipients: _mintRecipients,
  onSettled: _onSettled,
  isCachedAddress: piCache.hasAddress,
  ...(process.env.CDP_API_KEY_ID !== undefined && { cdpApiKeyId: process.env.CDP_API_KEY_ID }),
  ...(process.env.CDP_API_KEY_SECRET !== undefined && { cdpApiKeySecret: process.env.CDP_API_KEY_SECRET }),
  ...(process.env.MPP_SECRET_KEY !== undefined && { mppxSecretKey: process.env.MPP_SECRET_KEY }),
  gate: {
    apiKey: AGENTSCORE_API_KEY,
    merchantName: 'Regulated Goods Co.',
    requireKyc: true,
    requireSanctionsClear: true,
    minAge: 21,
    allowedJurisdictions: ['US'],
  } satisfies CheckoutGateConfig,
});

const app = new Hono();
app.use('*', rateLimitHono());

app.post('/purchase', (c: Context) => checkout.handleHono(c));

export default app;
