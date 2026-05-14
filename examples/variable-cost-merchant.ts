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
 *   APP_URL               — public URL of your service (for 402 commands)
 *   MPP_SECRET_KEY        — random base64
 *   TEMPO_RECIPIENT       — your Tempo wallet
 *   TEMPO_ESCROW_CONTRACT — your deployed escrow contract for channel deposits
 *   X402_BASE_RECIPIENT   — your Base wallet (USDC payouts for upto rail)
 *
 * Run: bun run examples/variable-cost-merchant.ts
 */
import {
  build402Body,
  buildAcceptedMethods,
  buildAgentInstructions,
  buildHowToPay,
  buildPricingBlock,
} from '@agent-score/commerce/challenge';
import {
  createMppxServer,
  createX402Server,
  paymentDirective,
  settlementOverrideHeader,
  wwwAuthenticateHeader,
} from '@agent-score/commerce/payment';
import { Hono } from 'hono';
import { Store } from 'mppx';
import { Session } from 'mppx/tempo';

const APP_URL = process.env.APP_URL!;
const TEMPO_RECIPIENT = process.env.TEMPO_RECIPIENT!;
const TEMPO_ESCROW_CONTRACT = process.env.TEMPO_ESCROW_CONTRACT!;
const X402_BASE_RECIPIENT = process.env.X402_BASE_RECIPIENT!;

// ── Boot both rails ─────────────────────────────────────────────────────────
// In production, swap Store.memory() for a durable backend (Postgres, D1,
// Durable Objects). The in-memory store is fine for examples and dev.
const channelStore = Session.ChannelStore.fromStore(Store.memory());

await createX402Server({
  facilitator: 'http',
  rails: ['x402-base-mainnet-upto'], // Permit2 authorize-max → settle-actual
});

const mppx = await createMppxServer({
  rails: {
    tempo_session: {
      recipient: TEMPO_RECIPIENT,
      escrowContract: TEMPO_ESCROW_CONTRACT,
      store: channelStore,
    },
  },
  secretKey: process.env.MPP_SECRET_KEY!,
});

const app = new Hono();
const REALM = new URL(APP_URL).host;
const MAX_USDC = 0.5; // upper bound vendor advertises; actual bill ≤ this
const MAX_USDC_CENTS = Math.round(MAX_USDC * 100);

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

  const acceptedMethods = await buildAcceptedMethods({
    x402_base: { recipient: X402_BASE_RECIPIENT },
    tempo: { recipient: TEMPO_RECIPIENT },
  });

  const howToPay = buildHowToPay({
    url,
    retryBodyJson: JSON.stringify({ prompt: '<your prompt>' }),
    totalUsd: MAX_USDC,
    rails: {
      x402_base: { recipient: X402_BASE_RECIPIENT },
      tempo: { recipient: TEMPO_RECIPIENT },
    },
    maxSpend: MAX_USDC,
  });

  // For variable-cost work, advertise the upper bound as `subtotal` and let the
  // vendor charge ≤ that. The actual amount lands via Settlement-Overrides
  // (x402 upto) or the highest voucher signed mid-stream (tempo session).
  const body = build402Body({
    product: { id: 'llm-completion', name: 'LLM completion' },
    acceptedMethods,
    pricing: buildPricingBlock({ subtotalCents: MAX_USDC_CENTS, currency: 'USD' }),
    agentInstructions: buildAgentInstructions({
      howToPay,
      warnings: [
        'Cost is variable — final amount depends on output length.',
        'For one-shot completions use x402 upto. For long streams use tempo session.',
      ],
    }),
    amountUsd: MAX_USDC.toFixed(2),
    currency: 'USD',
    orderId: null,
    retryBody: { prompt: '<your prompt>' },
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

  // Validate the x402 payment via processX402Settle from `@agent-score/commerce/payment`
  // (single-call verify + settle). Omitted for brevity — see multi-rail-merchant.ts for
  // the full drop-in pattern.

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
  const ctx = Session.Sse.fromRequest(c.req.raw);
  if (!ctx) return buildChallenge(c.req.url);

  const stream = Session.Sse.serve({
    store: channelStore,
    channelId: ctx.channelId,
    challengeId: ctx.challengeId,
    tickCost: ctx.tickCost,
    generate: yourLlmTokenStream(),
  });
  return Session.Sse.toResponse(stream);
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
