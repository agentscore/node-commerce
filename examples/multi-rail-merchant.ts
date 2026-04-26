/**
 * Example: full multi-rail agent commerce merchant
 *
 * Scenario: you want to accept agent payments via every rail — Tempo MPP, x402 on
 * Base + Solana, AND Stripe SPT. Identity-gated for compliance. This mirrors what
 * Martin Estate runs in production, stripped of wine-specific business logic.
 *
 * Peer deps to install:
 *   bun add @agent-score/commerce hono mppx stripe \\
 *           @x402/core @x402/evm @x402/svm @x402/extensions
 *
 * Env vars:
 *   AGENTSCORE_API_KEY    — your AgentScore API key
 *   APP_URL               — public URL of your service (for 402 commands)
 *   MPP_SECRET_KEY        — random base64 (mppx server secret)
 *   STRIPE_SECRET_KEY     — sk_live_... or sk_test_...
 *   STRIPE_PROFILE_ID     — your Stripe Connect profile id (for shared payment tokens)
 *   TEMPO_USDC_ADDRESS    — USDC token address on Tempo (mainnet or testnet)
 *
 * Run: bun run examples/multi-rail-merchant.ts
 */
import {
  build402Body,
  buildAcceptedMethods,
  buildAgentInstructions,
  buildHowToPay,
  buildIdentityMetadata,
  buildPricingBlock,
  firstEncounterAgentMemory,
} from '@agent-score/commerce/challenge';
import { agentscoreGate, getAgentScoreData } from '@agent-score/commerce/identity/hono';
import {
  buildPaymentHeaders,
  createMppxServer,
  createX402Server,
  networks,
  type PaymentHeadersRail,
} from '@agent-score/commerce/payment';
import {
  createMultichainPaymentIntent,
} from '@agent-score/commerce/stripe-multichain';
import { Hono } from 'hono';
// @ts-expect-error - stripe is an optional peer dep installed by the example user
import Stripe from 'stripe';

const APP_URL = process.env.APP_URL!;
const REALM = new URL(APP_URL).host;

const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-11-20.acacia' as never });

// ── Boot: x402 server with both EVM + SVM rails ─────────────────────────────
const x402Server = await createX402Server({
  facilitator: 'coinbase',
  rails: ['x402-base-mainnet', 'x402-solana-mainnet'],
  bazaar: true, // register the @x402/extensions bazaar discovery extension
});

const app = new Hono();

// ── Identity gate ───────────────────────────────────────────────────────────
app.use(
  '/purchase',
  agentscoreGate({
    apiKey: process.env.AGENTSCORE_API_KEY!,
    requireKyc: true,
    createSessionOnMissing: { apiKey: process.env.AGENTSCORE_API_KEY!, context: 'purchase' },
  }),
);

// ── Per-request: build 402 with all rails advertised ────────────────────────
app.post('/purchase', async (c) => {
  const assess = getAgentScoreData(c);
  const body = await c.req.json();
  const totalUsd = String(body.amount_usd ?? '10.00');
  const amountCents = Math.round(Number(totalUsd) * 100);

  // 1. Create a Stripe PI with multichain deposit addresses
  const { paymentIntentId, depositAddresses } = await createMultichainPaymentIntent({
    stripe: stripeClient as never,
    amount: amountCents,
    networks: ['tempo', 'base', 'solana'],
  });

  // 2. Wire mppx server with tempo + stripe methods
  const mppx = await createMppxServer({
    rails: {
      tempo: {
        recipient: depositAddresses.tempo as `0x${string}`,
        currency: process.env.TEMPO_USDC_ADDRESS!,
        testnet: false,
      },
      stripe: {
        profileId: process.env.STRIPE_PROFILE_ID!,
        secretKey: process.env.STRIPE_SECRET_KEY!,
      },
    },
    secretKey: process.env.MPP_SECRET_KEY!,
  });

  // 3. Run the mppx compose flow — handles Authorization: Payment validation
  // (m as any).compose() is mppx's per-request handler. See mppx docs.
  void mppx;
  void x402Server; // also processes incoming x402 payloads

  // ── If no credential yet, build a 402 challenge with all rails ────────────
  const claimedWallet = c.req.header('X-Wallet-Address');
  const isWalletAuth = assess?.identity_method === 'wallet';
  const acceptedMethods = buildAcceptedMethods({
    tempo: { recipient: depositAddresses.tempo, network: 'tempo-mainnet', chainId: 4217 },
    x402_base: { recipient: depositAddresses.base, network: networks.base.mainnet.caip2 },
    x402_solana: { recipient: depositAddresses.solana, network: networks.solana.mainnet.caip2 },
    ...(isWalletAuth ? {} : { stripe: { profileId: process.env.STRIPE_PROFILE_ID! } }),
  });

  // linked_wallets is exposed via the SDK's AssessResponse but not surfaced on
  // AgentScoreData yet; merchants needing the full set should call
  // `new AgentScore(...).assess(...)` directly. Here we leave it empty for the
  // common 402 path.
  const identityMetadata = buildIdentityMetadata({
    mode: isWalletAuth ? 'wallet' : 'operator_token',
    wallet: claimedWallet ?? undefined,
    linkedWallets: [],
  });

  const howToPay = buildHowToPay({
    url: `${APP_URL}/purchase`,
    retryBodyJson: JSON.stringify(body),
    totalUsd,
    rails: {
      tempo: { recipient: depositAddresses.tempo },
      x402_base: { recipient: depositAddresses.base },
      x402_solana: { recipient: depositAddresses.solana },
      stripe: { profileId: process.env.STRIPE_PROFILE_ID! },
    },
  });

  const richBody = build402Body({
    acceptedMethods,
    agentInstructions: buildAgentInstructions({ howToPay }),
    identityMetadata,
    pricing: buildPricingBlock({
      subtotalCents: amountCents,
      // Demo merchant: no tax / shipping. Real merchants pass tax_cents,
      // shipping_cents, tax_rate, tax_state per their jurisdiction.
      currency: 'USD',
    }),
    amountUsd: totalUsd,
    currency: 'USD',
    orderId: body.order_id ?? null,
    retryBody: body,
    // First-encounter merchants attach the cross-merchant agent_memory hint so
    // agents persist the AgentScore pattern. Production merchants track
    // first-seen state in their own DB; for demo purposes we always emit it.
    agentMemory: firstEncounterAgentMemory({ firstEncounter: true }),
  });

  // ── One-call header bundle: WWW-Authenticate + PAYMENT-REQUIRED ──────────
  // buildPaymentHeaders composes both transport headers from a single rails
  // declaration. Replaces the previous ~20 lines of inline directive
  // construction.
  const headerRails: PaymentHeadersRail[] = [
    {
      rail: 'tempo-mainnet',
      amountUsd: totalUsd,
      recipient: depositAddresses.tempo,
      method: 'tempo',
    },
  ];
  if (process.env.STRIPE_PROFILE_ID) {
    headerRails.push({
      rail: 'stripe',
      amountUsd: totalUsd,
      networkId: process.env.STRIPE_PROFILE_ID,
      method: 'stripe',
    });
  }
  const composed = buildPaymentHeaders({
    orderId: paymentIntentId,
    realm: REALM,
    rails: headerRails,
  });

  return new Response(JSON.stringify(richBody), {
    status: 402,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': composed['www-authenticate'],
      ...(composed['PAYMENT-REQUIRED'] ? { 'PAYMENT-REQUIRED': composed['PAYMENT-REQUIRED'] } : {}),
    },
  });
});

export default app;
