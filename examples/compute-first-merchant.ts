/**
 * Example: variable-cost merchant via compute-first + exact-x402.
 *
 * Scenario: you bill per unit of work (per result, per token, per byte). The
 * total can't be known until the work runs, but every payment rail in the
 * ecosystem signs an EXACT amount up front. The compute-first pattern flips
 * the order: probe runs the work server-side, caches the result, and emits a
 * 402 with the EXACT computed price. The retry pays that price; the merchant
 * serves the cached result.
 *
 * Why this exists (vs x402 upto / Permit2):
 *   - upto's facilitator support is still limited (Coinbase CDP testnet rejects
 *     upto-mode settles today; only mainnet claims support).
 *   - Permit2 is Ethereum-only — no Solana, no Tempo non-EIP-3009, no Stripe.
 *   - Compute-first works on every exact-mode rail in the ecosystem with no
 *     buyer setup and no facilitator extensions.
 *
 * The tradeoff: work runs on the unpaid probe leg, so rate-limiting is
 * load-bearing. Mount the SDK's rate-limit middleware globally and tune
 * `maxRequests` per your compute budget.
 *
 * This example wires the x402-exact rail on Base only. To add MPP rails
 * (Tempo, Solana, Stripe SPT), pass a `composeMppx` callback that builds
 * mppx intents at the exact cached price — see
 * `examples/multi-rail-merchant.ts` for the fixed-price MPP compose pattern;
 * the compute-first variant is structurally identical except the helper
 * passes the cached price + recipients into your callback. Stripe SPT
 * requires the computed price to be at least $0.50 USD — below that
 * Stripe's fixed ~$0.30 fee makes the charge unprofitable, so
 * `buildMppxComposeRails` auto-drops the stripe rail and sub-50-cent
 * pay-per-result APIs ship Tempo + x402 + Solana only.
 *
 * Peer deps:
 *   bun add @agent-score/commerce hono @x402/core @x402/evm @coinbase/x402
 *
 * Env vars:
 *   APP_URL              public URL of your service
 *   X402_BASE_RECIPIENT  Base wallet (USDC)
 *   X402_BASE_NETWORK    CAIP-2 (default eip155:8453)
 *
 * Run: bun run examples/compute-first-merchant.ts
 */

import { computeFirstCheckout, type WorkOutcome } from '@agent-score/commerce';
import { rateLimitHono } from '@agent-score/commerce/middleware/hono';
import { createX402Server } from '@agent-score/commerce/payment';
import { Hono, type Context } from 'hono';

const APP_URL = process.env.APP_URL ?? 'https://api.example.com';
const X402_BASE_NETWORK = (process.env.X402_BASE_NETWORK ?? 'eip155:8453') as `${string}:${string}`;
const X402_BASE_RECIPIENT = process.env.X402_BASE_RECIPIENT ?? '0xbase';

// Vendor's actual per-result work. Swap with a real search / enrichment / LLM
// call. The result_count drives pricing; the body is what the buyer receives.
async function runSearch(body: Record<string, unknown>): Promise<WorkOutcome> {
  const query = String(body.query ?? '');
  const limit = Number(body.limit ?? 5);
  const matches = Array.from({ length: Math.min(limit, 8) }, (_, i) => ({
    id: `result_${i}`,
    score: 0.9 - i * 0.05,
    snippet: `${query} hit ${i}`,
  }));
  return { resultCount: matches.length, body: { matches, total: 8492 } };
}

const x402Server = await createX402Server({
  facilitator: 'coinbase',
  rails: [X402_BASE_NETWORK === 'eip155:84532' ? 'x402-base-sepolia' : 'x402-base-mainnet'],
});

const searchHandler = computeFirstCheckout({
  name: 'search',
  url: `${APP_URL}/search`,
  // $0.01 per result. Use `0.0001` for sub-cent / per-token pricing — the
  // helper auto-derives decimal precision from the unit price.
  unitPriceCents: 1,
  rails: {
    x402_base: { recipient: X402_BASE_RECIPIENT, network: X402_BASE_NETWORK, mode: 'exact' },
  },
  x402Server,
  validateInput: (body) => {
    if (typeof body.query !== 'string' || body.query.length === 0) {
      throw new Error('`query` is required and must be a non-empty string.');
    }
  },
  runWork: async (body) => runSearch(body),
});

const app = new Hono();
// Rate-limit is load-bearing here: the probe leg runs the work without
// payment. Without it, an attacker can drain compute budget for free.
app.use('*', rateLimitHono({ maxRequests: 60, windowSeconds: 60 }));

app.post('/search', (c: Context) => searchHandler.handleHono(c));

export default app;
