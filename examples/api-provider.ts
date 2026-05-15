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

import { Checkout, type SettleOutcome } from '@agent-score/commerce';
import {
  buildDiscoveryProbeResponse,
  isDiscoveryProbeRequest,
  noindexNonDiscoveryPaths,
} from '@agent-score/commerce/discovery';
import {
  type SolanaMppRailSpec,
  type TempoRailSpec,
  type X402BaseRailSpec,
  networks,
} from '@agent-score/commerce/payment';
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
  rails: {
    // Static treasury recipients; relies on env-set values. Empty recipients
    // would be advertised in 402s as broken rails.
    tempo: {
      recipient: TEMPO_RECIPIENT,
      network: X402_BASE_NETWORK === networks.base.sepolia.caip2 ? 'tempo-testnet' : 'tempo-mainnet',
    } as TempoRailSpec,
    x402_base: { recipient: X402_BASE_RECIPIENT, network: X402_BASE_NETWORK } as X402BaseRailSpec,
    solana: { recipient: SOLANA_RECIPIENT, network: SOLANA_NETWORK_CAIP2 } as SolanaMppRailSpec,
  },
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
});

const app = new Hono();

// noindex non-discovery paths so /search doesn't end up in human-shaped SERPs.
app.use('*', noindexNonDiscoveryPaths());

app.post('/search', async (c: Context) => {
  // Discovery probe: empty-body POST without any payment header. Return sample
  // 402 so crawlers (`awal x402 details`, x402-proxy, ...) can find this surface
  // without committing to a real charge. Handle inline because the probe
  // advertises SAMPLE accepts (not the merchant's real settle rails).
  if (await isDiscoveryProbeRequest(c.req.raw)) {
    const probe = buildDiscoveryProbeResponse({
      realm: REALM,
      sampleRail: _TEMPO_RAIL_NAME,
      sampleAmountUsd: PRICE_USDC,
      sampleRecipient: TEMPO_RECIPIENT,
      x402Sample: {
        networks: [X402_BASE_NETWORK, SOLANA_NETWORK_CAIP2],
        resourceUrl: `https://${REALM}/search`,
      },
    });
    return new Response(probe.body, { status: probe.status, headers: probe.headers });
  }

  return checkout.handleHono(c);
});

export default app;
