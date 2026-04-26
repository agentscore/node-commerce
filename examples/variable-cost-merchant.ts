/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck — TODO(commerce@1.1): rewrite for current builder API. The pattern shown
// (x402 upto + tempo session) is still valid; the call shapes drifted across:
//   - PricingBlock no longer takes `max_usd` / `billing` (use buildPricingBlock with cents)
//   - buildAgentInstructions now takes `howToPay` (built first), not `rails: []`
//   - buildHowToPay rails is an object `{ tempo, x402_base, x402_solana, stripe }`, not an array
//   - mppx/server/tempo/session import path changed; current is `mppx/tempo/session`
// Other examples in this folder are typechecked and current; refer to api-provider.ts
// for the rail-helper conventions and multi-rail-merchant.ts for the full 402 builder flow.
/**
 * Example: variable-cost merchant supporting BOTH x402 upto AND MPP tempo session
 *
 * Scenario: you sell something where the cost depends on output — LLM completions,
 * transcription, video transcode, etc. You don't know the final price until the work
 * is done. Two protocols solve this; both are advertised on the 402 so agents can
 * pick whichever they support.
 *
 *   ┌─ x402 upto (one-shot) ──────────────────────────────────────────┐
 *   │ - Agent signs Permit2 authorizing up to a max amount            │
 *   │ - Vendor does the work, knows actual cost after                 │
 *   │ - Response sets Settlement-Overrides: {"amount":"<actual>"}     │
 *   │ - Facilitator settles for actual; difference auto-refunds       │
 *   │ - Best for: short-ish jobs returning a single response          │
 *   │ - Rails: x402-base-mainnet-upto, x402-base-sepolia-upto         │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 *   ┌─ MPP tempo session (streaming) ─────────────────────────────────┐
 *   │ - Agent opens a channel with on-chain deposit                   │
 *   │ - Vendor streams output as SSE                                  │
 *   │ - As cumulative cost grows, vendor emits voucher requests       │
 *   │ - Agent signs each voucher mid-stream; channel keeps flowing    │
 *   │ - Final settle on close reclaims unspent deposit                │
 *   │ - Best for: long-running streams (live LLM tokens, audio, etc.) │
 *   │ - Rails: tempo session intent (separate from one-shot tempo)    │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * Most agents pick one or the other based on what their wallet supports. Vendors
 * who care about reach offer both.
 *
 * Peer deps:
 *   bun add @agent-score/commerce hono mppx @x402/core @x402/evm
 *
 * Env vars:
 *   MPP_SECRET_KEY        — random base64
 *   TEMPO_RECIPIENT       — your Tempo wallet
 *   TEMPO_ESCROW_CONTRACT — your deployed escrow contract for channel deposits
 *   X402_BASE_RECIPIENT   — your Base wallet (USDC payouts for upto rail)
 *
 * Run: bun run examples/variable-cost-merchant.ts
 */
import {
  buildAcceptedMethods,
  buildAgentInstructions,
  buildHowToPay,
  build402Body,
} from '@agent-score/commerce/challenge';
import {
  createMppxServer,
  createX402Server,
  paymentDirective,
  settlementOverrideHeader,
  wwwAuthenticateHeader,
} from '@agent-score/commerce/payment';
import { Hono } from 'hono';
import { ChannelStore, Sse } from 'mppx/server/tempo/session';

// ── Boot both rails ─────────────────────────────────────────────────────────
const channelStore: ChannelStore.ChannelStore = ChannelStore.memory();

await createX402Server({
  facilitator: 'http',
  rails: ['x402-base-mainnet-upto'], // Permit2 authorize-max → settle-actual
});

const mppx = await createMppxServer({
  rails: {
    tempo_session: {
      recipient: process.env.TEMPO_RECIPIENT!,
      escrowContract: process.env.TEMPO_ESCROW_CONTRACT!,
      store: channelStore,
    },
  },
  secretKey: process.env.MPP_SECRET_KEY!,
});

const app = new Hono();
const REALM = 'llm.example.com';
const MAX_USDC = 0.5; // upper bound vendor advertises; actual bill ≤ this

// ── 402 challenge advertising both options ──────────────────────────────────
function buildChallenge(url: string) {
  const challengeId = `chg_${Date.now()}`;
  const directives = [
    paymentDirective({
      rail: 'x402-base-mainnet-upto',
      id: `${challengeId}_upto`,
      realm: REALM,
      request: '',
    }),
    paymentDirective({
      rail: 'tempo-mainnet',
      id: `${challengeId}_session`,
      realm: REALM,
      intent: 'session',
      request: '',
    }),
  ];
  const body = build402Body({
    productName: 'LLM completion',
    instructions: buildAgentInstructions({
      rails: ['x402-base-mainnet-upto', 'tempo-mainnet'],
      warnings: [
        'Cost is variable — final amount depends on output length.',
        'For one-shot completions use x402 upto. For long streams use tempo session.',
      ],
    }),
    pricing: { max_usd: MAX_USDC, billing: 'pay-per-token' },
    accepted_methods: buildAcceptedMethods({
      x402_base: { recipient: process.env.X402_BASE_RECIPIENT, scheme: 'upto' },
      tempo: {
        recipient: process.env.TEMPO_RECIPIENT,
        intent: 'session',
        escrowContract: process.env.TEMPO_ESCROW_CONTRACT,
      },
    }),
    how_to_pay: buildHowToPay({
      rails: ['x402-base-mainnet-upto', 'tempo-mainnet'],
      urlBase: url,
      retryBody: { prompt: '<your prompt>' },
      maxSpend: MAX_USDC,
    }),
  });
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': wwwAuthenticateHeader(directives),
    },
  });
}

// ── /llm/complete: x402 upto path (single JSON response) ────────────────────
app.post('/llm/complete', async (c) => {
  const auth = c.req.header('authorization');
  if (!auth?.startsWith('Payment ')) return buildChallenge(c.req.url);

  // Validate the x402 payment via your x402Server.processPaymentRequest here.
  // (Omitted for brevity — see api-provider.ts for the validate-then-settle pattern.)

  const body = await c.req.json();
  const { text, tokensUsed } = await runYourLlm(body.prompt);

  // Calculate actual cost based on tokens consumed
  const actualUsd = tokensUsed * 0.000_002; // $2 per 1M tokens
  const actualAtomic = String(Math.ceil(actualUsd * 1_000_000)); // USDC atomic units

  // Tell the facilitator to settle for actualAtomic instead of the authorized max.
  const { name, value } = settlementOverrideHeader({ amount: actualAtomic });
  c.header(name, value);

  return c.json({ text, tokens_used: tokensUsed, charged_usd: actualUsd });
});

// ── /llm/stream: MPP tempo session path (SSE with mid-stream vouchers) ──────
app.post('/llm/stream', async (c) => {
  const ctx = Sse.fromRequest(c.req.raw);
  if (!ctx) return buildChallenge(c.req.url);

  // Per-token price in atomic units (e.g., 0.000002 USDC = 2 with 6 decimals)
  const tickCost = 2n;

  const stream = Sse.serve({
    store: channelStore,
    channelId: ctx.channelId,
    challengeId: ctx.challengeId,
    tickCost,
    generate: yourLlmTokenStream(),
  });
  return Sse.toResponse(stream);
});

async function runYourLlm(_prompt: string): Promise<{ text: string; tokensUsed: number }> {
  return { text: 'completion text here', tokensUsed: 1234 };
}

async function* yourLlmTokenStream(): AsyncGenerator<string> {
  for (let i = 0; i < 100; i++) {
    yield `token_${i} `;
    await new Promise((r) => setTimeout(r, 50));
  }
}

void mppx;
export default app;
