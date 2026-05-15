/**
 * Example: variable-cost merchant supporting BOTH x402 upto AND MPP tempo session.
 *
 * Scenario: you sell something where the cost depends on output (LLM
 * completions, transcription, video transcode, etc.). You don't know the
 * final price until the work is done. Two protocols solve this; both are
 * advertised on the 402 so agents can pick whichever they support.
 *
 *   x402 upto (one-shot)
 *     - Agent signs Permit2 authorizing up to a max amount.
 *     - Vendor does the work, knows actual cost after.
 *     - Response sets Settlement-Overrides: {"amount":"<actual>"}.
 *     - Facilitator settles for actual; difference auto-refunds.
 *
 *   MPP tempo session (streaming)
 *     - Agent opens a channel with on-chain deposit.
 *     - Vendor streams output as SSE.
 *     - Cumulative cost grows; vendor emits voucher requests.
 *     - Agent signs each voucher mid-stream.
 *     - Final settle on close reclaims unspent deposit.
 *
 * These flows are too custom to fit the one-shot `Checkout(...)` model:
 * `computePricing` returns a single amount, but variable-cost discovers the
 * amount AFTER the request runs (upto) or grows it cumulatively (session).
 * The example keeps the 402-emit path custom (using `build402Body` +
 * `buildAcceptedMethods` + `buildHowToPay`) and the settle path manual;
 * vendors compose `createX402Server` + Permit2 extensions or
 * `createMppxServer` (tempo_session rail) at the vendor layer.
 *
 * Peer deps:
 *   bun add @agent-score/commerce hono mppx @x402/core @x402/evm
 *
 * Env vars:
 *   APP_URL               public URL of your service
 *   MPP_SECRET_KEY        random base64
 *   TEMPO_RECIPIENT       your Tempo wallet
 *   TEMPO_ESCROW_CONTRACT your deployed escrow contract for channel deposits
 *   X402_BASE_RECIPIENT   your Base wallet (USDC payouts for upto rail)
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
  paymentRequiredHeader,
  settlementOverrideHeader,
  wwwAuthenticateHeader,
} from '@agent-score/commerce/payment';
import { Hono, type Context } from 'hono';
import { Store } from 'mppx';
import { Session } from 'mppx/tempo';

const APP_URL = process.env.APP_URL!;
const TEMPO_RECIPIENT = process.env.TEMPO_RECIPIENT!;
const TEMPO_ESCROW_CONTRACT = process.env.TEMPO_ESCROW_CONTRACT!;
const X402_BASE_RECIPIENT = process.env.X402_BASE_RECIPIENT!;
const MPP_SECRET_KEY = process.env.MPP_SECRET_KEY!;

const REALM = new URL(APP_URL).host;
const MAX_USDC = 0.5; // upper bound vendor advertises; actual bill <= this
const MAX_USDC_CENTS = Math.round(MAX_USDC * 100);

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
  secretKey: MPP_SECRET_KEY,
});

async function buildChallenge(url: string): Promise<Response> {
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

  // For variable-cost work, advertise the upper bound as `subtotal` and let
  // the vendor charge <= that. The actual amount lands via
  // Settlement-Overrides (x402 upto) or the highest voucher signed mid-stream
  // (tempo session).
  const body = build402Body({
    product: { id: 'llm-completion', name: 'LLM completion' },
    acceptedMethods,
    pricing: buildPricingBlock({ subtotalCents: MAX_USDC_CENTS, currency: 'USD' }),
    agentInstructions: buildAgentInstructions({
      howToPay,
      warnings: [
        'Cost is variable; final amount depends on output length.',
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
      // x402 wire requires the body to also appear as base64 in this header;
      // spec-strict clients (Coinbase awal, purl) parse it before falling
      // back to the JSON body.
      'PAYMENT-REQUIRED': paymentRequiredHeader({
        x402Version: 2,
        accepts: [],
        resource: { url },
      }),
    },
  });
}

const app = new Hono();

async function _runYourLlm(_prompt: string): Promise<{ text: string; tokensUsed: number }> {
  return { text: 'completion text here', tokensUsed: 1234 };
}

async function* _yourLlmTokenStream(): AsyncGenerator<string> {
  for (let i = 0; i < 100; i += 1) {
    yield `token_${i} `;
    await new Promise<void>((r) => setTimeout(r, 50));
  }
}

app.post('/llm/complete', async (c: Context) => {
  // x402 carries the credential in either `x-payment` or `payment-signature`
  // depending on client (purl uses payment-signature; awal uses x-payment).
  if (!(c.req.header('x-payment') ?? c.req.header('payment-signature'))) {
    return buildChallenge(c.req.url);
  }

  // Validate the x402 payment via `processX402Settle` from
  // `@agent-score/commerce/payment` (single-call verify + settle). Omitted
  // for brevity; see multi-rail-merchant.ts for the full drop-in pattern.

  const body = (await c.req.json()) as { prompt?: string };
  const { text, tokensUsed } = await _runYourLlm(body.prompt ?? '');

  const actualUsd = tokensUsed * 0.000_002; // $2 per 1M tokens
  const actualAtomic = String(Math.ceil(actualUsd * 1_000_000)); // USDC atomic units

  const { name, value } = settlementOverrideHeader({ amount: actualAtomic });
  c.header(name, value);

  return c.json({ text, tokens_used: tokensUsed, charged_usd: actualUsd });
});

app.post('/llm/stream', (c: Context) => {
  const ctx = Session.Sse.fromRequest(c.req.raw);
  if (!ctx) return buildChallenge(c.req.url);

  const stream = Session.Sse.serve({
    store: channelStore,
    channelId: ctx.channelId,
    challengeId: ctx.challengeId,
    tickCost: ctx.tickCost,
    generate: _yourLlmTokenStream(),
  });
  return Session.Sse.toResponse(stream);
});

void mppx;
export default app;
