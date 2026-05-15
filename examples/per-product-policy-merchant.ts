/**
 * Example: multi-product merchant with per-product compliance policy + soft mode.
 *
 * Scenario: you sell several products with different compliance needs.
 *
 * - Wine: hard gate, KYC + 21+ + US-only + state allowlist (regulated alcohol)
 * - Tee:  no gate at all; fully anonymous, ship anywhere
 * - Limited print: SOFT gate; request KYC for fraud signals, but don't block the
 *   sale if the buyer skips it; record `identity_status="unverified"` instead.
 *
 * Each product carries its own `PolicyBlock`. `Checkout(gate: { perRequestPolicy
 * })` resolves it per request:
 *
 * 1. `preValidate` looks up the product row by slug + checks shipping
 *    allowlists, stashing the policy onto `ctx.state`.
 * 2. `perRequestPolicy(ctx)` returns the matching PolicyBlock; the SDK gate
 *    runs hard/soft based on `enforcement`.
 * 3. Soft denials are swallowed by the SDK and stamp
 *    `identity_status="unverified"` onto the order; hard denials propagate the
 *    canonical 403 envelope.
 *
 * Peer deps:
 *   bun add @agent-score/commerce hono
 *
 * Env vars:
 *   AGENTSCORE_API_KEY — your AgentScore API key
 *
 * Run: bun run examples/per-product-policy-merchant.ts
 */
import {
  Checkout,
  CheckoutValidationError,
  type CheckoutContext,
  type CheckoutGateConfig,
  type PolicyBlock,
  type PricingResult,
  type SettleOutcome,
} from '@agent-score/commerce';
import { validateShippingAgainstPolicy } from '@agent-score/commerce/identity/policy';
import { type TempoRailSpec } from '@agent-score/commerce/payment';
import { Hono, type Context } from 'hono';

const API_KEY = process.env.AGENTSCORE_API_KEY ?? 'ask_test_dummy';

interface Product {
  name: string;
  priceUsd: number;
  policy: PolicyBlock | null;
}

// A merchant would normally read these from a `products` table.
const PRODUCTS: Record<string, Product> = {
  'wine-cabernet': {
    name: 'Reserve Cabernet',
    priceUsd: 75.0,
    policy: {
      enforcement: 'hard',
      requireKyc: true,
      requireSanctionsClear: true,
      minAge: 21,
      allowedJurisdictions: ['US'],
      allowedShippingCountries: ['US'],
      allowedShippingStates: ['CA', 'NY', 'TX', 'FL', 'WA'],
    },
  },
  tee: {
    name: 'Cotton Tee',
    priceUsd: 30.0,
    policy: null, // No gate; ship anywhere; identity_status="anonymous"
  },
  'limited-print': {
    name: 'Limited Edition Print (200/500)',
    priceUsd: 200.0,
    // Soft gate: request KYC as a fraud signal, but accept anonymous sales.
    policy: { enforcement: 'soft', requireKyc: true },
  },
};

async function _validatePurchase(ctx: CheckoutContext): Promise<Record<string, unknown>> {
  const body = (ctx.request.body ?? {}) as { product_slug?: string; shipping?: { country?: string; state?: string } };
  const slug = body.product_slug ?? '';
  const shipping = body.shipping ?? {};

  const product = PRODUCTS[slug];
  if (product === undefined) {
    throw new CheckoutValidationError({ code: 'product_not_found', message: `No product with slug ${slug}.` });
  }

  const policy = product.policy;
  validateShippingAgainstPolicy({
    country: shipping.country ?? '',
    state: shipping.state ?? '',
    policy,
    productName: product.name,
  });
  return { product, policy };
}

async function _computePricing(ctx: CheckoutContext): Promise<PricingResult> {
  const product = ctx.state.product as Product;
  return { amountUsd: product.priceUsd };
}

function _perRequestPolicy(ctx: CheckoutContext): PolicyBlock | null {
  const policy = ctx.state.policy as PolicyBlock | null | undefined;
  if (policy === undefined || policy === null) return null;
  return policy;
}

async function _onSettled(ctx: CheckoutContext, outcome: SettleOutcome): Promise<Record<string, unknown>> {
  const product = ctx.state.product as Product;
  return {
    order: { product: product.name, totalUsd: product.priceUsd },
    identity_status: ctx.identityStatus,
    tx_hash: outcome.txHash,
  };
}

const checkout = new Checkout({
  // Minimal rails so the 402 emit path has something to advertise; vendor
  // swaps in their real rails (multi-rail, Stripe-anchored, etc.).
  rails: {
    tempo: {
      recipient: process.env.TEMPO_RECIPIENT ?? '0xfeedface',
      network: 'tempo-mainnet',
    } as TempoRailSpec,
  },
  url: 'https://api.example.com/purchase',
  preValidate: _validatePurchase,
  computePricing: _computePricing,
  onSettled: _onSettled,
  gate: {
    apiKey: API_KEY,
    merchantName: 'Multi-Product Co.',
    perRequestPolicy: _perRequestPolicy,
  } satisfies CheckoutGateConfig,
});

const app = new Hono();

app.post('/purchase', (c: Context) => checkout.handleHono(c));

export { app };
