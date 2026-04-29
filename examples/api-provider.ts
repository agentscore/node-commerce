/**
 * Example: API provider with per-call billing — multi-rail (Tempo MPP + x402)
 *
 * Scenario: you sell access to an HTTP API (search, scraping, RPC, etc.). Each call
 * costs a fixed price; agents pick whichever rail their wallet supports. No identity
 * gate, no compliance — purely pay-or-fail. Think Exa, QuickNode, anyone in the x402
 * Bazaar (which now also indexes MPP-discoverable services).
 *
 * Rails advertised:
 *   - **Tempo MPP** (`tempo/charge` intent)
 *   - **x402 USDC on Base** (EIP-3009)
 *   - **x402 USDC on Solana** (SPL Token)
 *
 * The 402 lists all rails neutrally — the agent picks based on what their wallet supports.
 *
 * Peer deps to install:
 *   bun add @agent-score/commerce hono mppx @x402/core @x402/evm @x402/svm
 *   # @coinbase/x402 optional — only if you want the Coinbase CDP facilitator instead of HTTP
 *
 * Env vars:
 *   MPP_SECRET_KEY        — random base64 (mppx merchant secret)
 *   TEMPO_RECIPIENT       — your Tempo wallet for receiving USDC.e
 *   X402_BASE_RECIPIENT   — your Base wallet for receiving USDC
 *   X402_SOLANA_RECIPIENT — your Solana wallet for receiving USDC
 *
 * Run: bun run examples/api-provider.ts
 */
import {
  buildDiscoveryProbeResponse,
  isDiscoveryProbeRequest,
  noindexNonDiscoveryPaths,
} from '@agent-score/commerce/discovery';
import {
  createMppxServer,
  createX402Server,
  networks,
  paymentDirective,
  paymentRequiredHeader,
  wwwAuthenticateHeader,
} from '@agent-score/commerce/payment';
import { Hono } from 'hono';

const PRICE_USDC = 0.01; // per-call price in USD
const REALM = 'api.example.com';

// ── Boot both rails — Tempo MPP + x402 ──────────────────────────────────────
// One-call setup for each. Vendors who only support one rail can drop the other.
await createMppxServer({
  rails: { tempo: { recipient: process.env.TEMPO_RECIPIENT! } },
  secretKey: process.env.MPP_SECRET_KEY!,
});

await createX402Server({
  facilitator: 'http', // 'coinbase' if you have @coinbase/x402 installed
  rails: ['x402-base-mainnet', 'x402-solana-mainnet'],
});

const app = new Hono();

// noindex non-discovery paths so /search doesn't end up in human-shaped SERPs.
// Defaults cover /openapi.json, /llms.txt, /.well-known/{mpp.json,agent-card.json,ucp},
// /favicon.{png,ico} — pass `customPaths: ['/sitemap.xml']` to extend or
// `replacePaths: true` to swap the set entirely.
app.use('*', noindexNonDiscoveryPaths());

// ── Discovery (optional but recommended for crawler indexing) ────────────────
app.use('/search', async (c, next) => {
  if (await isDiscoveryProbeRequest(c.req.raw)) {
    const probe = buildDiscoveryProbeResponse({
      realm: REALM,
      sampleRail: 'tempo-mainnet',
      sampleAmountUsd: PRICE_USDC,
      sampleRecipient: process.env.TEMPO_RECIPIENT!,
      // Advertise x402 support so crawlers (`awal x402 details`, etc.) can find
      // it on an empty-body POST. Commerce synthesizes USDC sample accepts from
      // the registry per CAIP-2 network passed.
      x402Sample: {
        networks: [networks.base.mainnet.caip2, networks.solana.mainnet.caip2],
        resourceUrl: `${REALM}/search`,
      },
    });
    return new Response(probe.body, { status: probe.status, headers: probe.headers });
  }
  await next();
});

// ── The paid endpoint ───────────────────────────────────────────────────────
app.post('/search', async (c) => {
  const auth = c.req.header('authorization');
  const x402Header = c.req.header('payment-signature') || c.req.header('x-payment');

  // No payment? Return a 402 with directives for all accepted rails.
  if (!auth?.startsWith('Payment ') && !x402Header) {
    const challengeId = `chg_${Date.now()}`;
    const directives = [
      paymentDirective({
        rail: 'tempo-mainnet',
        id: `${challengeId}_tempo`,
        realm: REALM,
        request: '',
      }),
      paymentDirective({
        rail: 'x402-base-mainnet',
        id: `${challengeId}_base`,
        realm: REALM,
        request: '',
      }),
      paymentDirective({
        rail: 'x402-solana-mainnet',
        id: `${challengeId}_solana`,
        realm: REALM,
        request: '',
      }),
    ];
    const accepts = [
      {
        scheme: 'exact',
        network: networks.base.mainnet.caip2,
        amount: String(PRICE_USDC * 1_000_000),
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        payTo: process.env.X402_BASE_RECIPIENT,
        extra: { decimals: 6 },
      },
      {
        scheme: 'exact',
        network: networks.solana.mainnet.caip2,
        amount: String(PRICE_USDC * 1_000_000),
        asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        payTo: process.env.X402_SOLANA_RECIPIENT,
        extra: { decimals: 6 },
      },
    ];
    return new Response(
      JSON.stringify({ payment_required: true, x402Version: 2, accepts }),
      {
        status: 402,
        headers: {
          'content-type': 'application/json',
          'www-authenticate': wwwAuthenticateHeader(directives),
          'PAYMENT-REQUIRED': paymentRequiredHeader({ x402Version: 2, accepts, resource: { url: c.req.url } }),
        },
      },
    );
  }

  // Payment present — validate via the right server based on which header arrived:
  //   Authorization: Payment ... → MPP (tempo) — call mppx.compose() to verify + settle
  //   payment-signature / x-payment → x402 (base or solana) — call verifyX402Request
  //     then processX402Settle from `@agent-score/commerce/payment` for a single-call
  //     verify + settle (returns base64 paymentResponseHeader for the success response).
  // See multi-rail-merchant.ts for the full drop-in pattern.

  const body = await c.req.json();
  const results = await runYourSearch(body.query);
  return c.json({ results });
});

async function runYourSearch(_query: string): Promise<unknown[]> {
  // Vendor's own search implementation (Exa, custom embeddings, etc.)
  return [];
}

export default app;
