/**
 * Example: API provider with per-call billing; multi-rail (Tempo MPP + x402 base + Solana MPP).
 *
 * Scenario: you sell access to an HTTP API (search, scraping, RPC, etc.). Each
 * call costs a fixed price; agents pick whichever rail their wallet supports.
 * No identity gate, no compliance: purely pay-or-fail.
 *
 * Rails advertised:
 *   - **Tempo MPP** (`tempo/charge` intent, carried in `Authorization: Payment`)
 *   - **x402 USDC on Base** (EIP-3009, carried in `x-payment` / `payment-signature`)
 *   - **MPP USDC on Solana** (`solana/charge` intent, carried in `Authorization: Payment`)
 *
 * `Checkout(...)` collapses the ~150 lines of hand-rolled 402 envelope + header
 * parsing + rail dispatch in pre-2.0 examples to a single `computePricing` +
 * `onSettled` configuration. Discovery probes are still handled inline because
 * they advertise SAMPLE rails for crawlers (not the merchant's real rails).
 *
 * Peer deps:
 *   bun add @agent-score/commerce hono mppx @x402/core @x402/evm @solana/mpp @solana/kit
 *   # @coinbase/x402 optional — only if you want the Coinbase CDP facilitator
 *
 * Env vars:
 *   TEMPO_RECIPIENT       your Tempo wallet for receiving USDC.e
 *   X402_BASE_RECIPIENT   your Base wallet for receiving USDC
 *   SOLANA_RECIPIENT      your Solana wallet for receiving USDC
 *   X402_BASE_NETWORK     CAIP-2 (default eip155:8453 = Base mainnet)
 *   SOLANA_NETWORK_CAIP2  CAIP-2 (default solana mainnet)
 *   MPP_SECRET_KEY        secret key for the auto-derived mppx server
 *   CDP_API_KEY_ID        Coinbase CDP key id (auto-promotes x402 facilitator)
 *   CDP_API_KEY_SECRET    Coinbase CDP key secret
 *
 * Run: bun run examples/api-provider.ts
 */

import {
  Checkout,
  type DiscoveryProbeConfig,
  type SettleOutcome,
} from '@agent-score/commerce';
import {
  buildMerchantIndexJson,
  buildRedemptionSkillMd,
  noindexNonDiscoveryPaths,
  standardEndpointDescriptions,
} from '@agent-score/commerce/discovery';
import { rateLimitHono } from '@agent-score/commerce/middleware/hono';
import { buildDefaultCheckoutRails, networks } from '@agent-score/commerce/payment';
import { Hono, type Context } from 'hono';

const PRICE_USDC = 0.01; // per-call price in USD
const REALM = 'api.example.com';

const X402_BASE_NETWORK = process.env.X402_BASE_NETWORK ?? networks.base.mainnet.caip2;
const SOLANA_NETWORK_CAIP2 = process.env.SOLANA_NETWORK_CAIP2 ?? networks.solana.mainnet.caip2;
const TEMPO_RECIPIENT = process.env.TEMPO_RECIPIENT!;
const X402_BASE_RECIPIENT = process.env.X402_BASE_RECIPIENT!;
const SOLANA_RECIPIENT = process.env.SOLANA_RECIPIENT!;
const _TEMPO_RAIL_NAME =
  X402_BASE_NETWORK === networks.base.sepolia.caip2 ? 'tempo-testnet' : 'tempo-mainnet';

async function runYourSearch(_query: string): Promise<unknown[]> {
  // Vendor's actual search implementation.
  return [];
}

const checkout = new Checkout({
  // Static treasury recipients; relies on env-set values. Empty recipients
  // would be advertised in 402s as broken rails.
  rails: buildDefaultCheckoutRails({
    tempo: {
      recipient: TEMPO_RECIPIENT,
      network: X402_BASE_NETWORK === networks.base.sepolia.caip2 ? 'tempo-testnet' : 'tempo-mainnet',
    },
    x402Base: { recipient: X402_BASE_RECIPIENT, network: X402_BASE_NETWORK },
    solanaMpp: { recipient: SOLANA_RECIPIENT, network: SOLANA_NETWORK_CAIP2 },
  }),
  url: `https://${REALM}/search`,
  computePricing: async () => ({ amountUsd: PRICE_USDC }),
  onSettled: async (ctx, _outcome: SettleOutcome) => {
    const body = (ctx.request.body ?? {}) as { query?: string };
    const results = await runYourSearch(body.query ?? '');
    return { results };
  },
  ...(process.env.CDP_API_KEY_ID !== undefined && { cdpApiKeyId: process.env.CDP_API_KEY_ID }),
  ...(process.env.CDP_API_KEY_SECRET !== undefined && { cdpApiKeySecret: process.env.CDP_API_KEY_SECRET }),
  ...(process.env.MPP_SECRET_KEY !== undefined && { mppxSecretKey: process.env.MPP_SECRET_KEY }),
  // Auto-route empty-body POSTs without a payment header to a sample 402 so
  // crawlers (`awal x402 details`, x402-proxy, ...) can find this surface
  // without committing to a real charge. The probe advertises SAMPLE accepts;
  // real rails fire only when the agent retries with a credential.
  discoveryProbe: {
    realm: REALM,
    sampleRail: _TEMPO_RAIL_NAME,
    sampleAmountUsd: PRICE_USDC,
    sampleRecipient: TEMPO_RECIPIENT,
    x402Sample: {
      networks: [X402_BASE_NETWORK, SOLANA_NETWORK_CAIP2],
      resourceUrl: `https://${REALM}/search`,
    },
  } satisfies DiscoveryProbeConfig,
});

const app = new Hono();

// noindex non-discovery paths so /search doesn't end up in human-shaped SERPs.
app.use('*', rateLimitHono());
app.use('*', noindexNonDiscoveryPaths());

app.post('/search', (c: Context) => checkout.handleHono(c));

// Discovery root for API merchants. Mirror of the goods-merchant `/` pattern.
// Lists endpoints, supported rails, docs, and per-call pricing so agents can
// discover this merchant from a Bazaar listing or a llms.txt cross-link.
app.get('/', (c: Context) =>
  c.json(
    buildMerchantIndexJson({
      name: 'Example Search API',
      description:
        'Agent-native search API. Per-call billing on Tempo, x402 Base, and Solana. ' +
        'Trial credit codes (single-use) settle a fixed number of free calls before ' +
        'the wallet starts paying.',
      docs: { redemption: `https://${REALM}/redemption.md` },
      endpoints: standardEndpointDescriptions({ kind: 'api' }),
      supportedRails: ['tempo', 'x402-base', 'solana-mpp'],
      extra: {
        pricing: {
          per_call_usd: PRICE_USDC.toFixed(2),
          trial_credit_codes: 'single-use; settle one paid call for free',
        },
      },
    }),
  ),
);

// Agent-facing skill.md for trial-credit codes. The pattern is delivery-neutral;
// whether codes are emailed in a developer onboarding email, surfaced in a
// dashboard, or distributed via partner promotions, the redemption flow is the
// same: submit the code in the body next to the regular call shape, the server
// burns it single-use, and the 402 either skips entirely ($0 settle) or charges
// the discounted amount.
app.get('/redemption.md', (c: Context) =>
  c.text(
    buildRedemptionSkillMd({
      merchantName: 'Example Search API',
      appUrl: `https://${REALM}`,
      endpointPath: '/search',
      skuIntro:
        'The code unlocks one free `POST /search` call. After that, the endpoint ' +
        'reverts to standard per-call billing.',
      deliveryIntro:
        "You're reading this because the developer you're working for received a " +
        'single-use trial credit code from Example Search API (typically via the ' +
        'developer onboarding email or dashboard). This page tells you, the agent, ' +
        'exactly how to turn that code into a successful call.',
      bodyShape: `{
     "query": "<search query>",
     "redemption_code": "<code>"
   }`,
      bodyRules: '',
    }),
  ),
);

export default app;
