/**
 * Example: full multi-rail agent commerce merchant
 *
 * Scenario: you want to accept agent payments via every rail — Tempo MPP, x402 on
 * Base + Solana, AND Stripe SPT. Identity-gated for compliance.
 *
 * The flow on each /purchase POST:
 *   1. Identity gate (agentscoreGate): KYC + age + jurisdiction + sanctions
 *   2. If `X-Payment` header present (x402 client paying) → verifyX402Request →
 *      processX402Settle → return 200 with payment-response header
 *   3. Else mint a Stripe multichain PI (deposit addresses for tempo/base/solana)
 *      and run mppx.compose() to validate any `Authorization: Payment` header
 *   4. If mppx returns 402 → respond402 (preserves mppx's WWW-Auth + adds x402's
 *      PAYMENT-REQUIRED) with the rich body
 *   5. If mppx returns 200 → also fire simulateDepositIfTestMode for testnet
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
 *   X402_BASE_NETWORK     — CAIP-2 (eip155:8453 mainnet, eip155:84532 sepolia)
 *   X402_SVM_NETWORK      — CAIP-2 (solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp mainnet, solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1 devnet)
 *   REDIS_URL             — optional; in-memory PI cache otherwise
 *
 * Run: bun run examples/multi-rail-merchant.ts
 */
import {
  buildAcceptedMethods,
  buildAgentInstructions,
  buildHowToPay,
  buildIdentityMetadata,
  buildPricingBlock,
  buildValidationError,
  firstEncounterAgentMemory,
  respond402,
} from '@agent-score/commerce/challenge';
import { agentscoreGate, getAgentScoreData } from '@agent-score/commerce/identity/hono';
import {
  createMppxServer,
  createX402Server,
  networks,
  processX402Settle,
  USDC,
  validateX402NetworkConfig,
  verifyX402Request,
} from '@agent-score/commerce/payment';
import {
  createMultichainPaymentIntent,
  createPiCache,
  simulateDepositIfTestMode,
} from '@agent-score/commerce/stripe-multichain';
import { Hono } from 'hono';
// @ts-expect-error - stripe is an optional peer dep installed by the example user
import Stripe from 'stripe';

const APP_URL = process.env.APP_URL!;
const X402_BASE_NETWORK = process.env.X402_BASE_NETWORK ?? networks.base.mainnet.caip2;
const X402_SVM_NETWORK = process.env.X402_SVM_NETWORK ?? networks.solana.mainnet.caip2;

// Boot-time guard: validate the configured x402 networks are in the supported set.
// Throws on misconfigured deploys before the first request.
validateX402NetworkConfig({ baseNetwork: X402_BASE_NETWORK, svmNetwork: X402_SVM_NETWORK });

const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-11-20.acacia' as never });

// Singleton Stripe PI / deposit-address cache. Backed by Redis when REDIS_URL is set
// (multi-task deployments need this so a deposit lands on whichever task settles it);
// falls back to in-process Map for single-instance dev.
const piCache = createPiCache({ redisUrl: process.env.REDIS_URL });

// ── Boot: x402 server with both EVM + SVM rails ─────────────────────────────
const x402Server = await createX402Server({
  facilitator: 'coinbase',
  rails: [X402_BASE_NETWORK.includes('84532') ? 'x402-base-sepolia' : 'x402-base-mainnet',
          X402_SVM_NETWORK.includes('EtWTRAB') ? 'x402-solana-devnet' : 'x402-solana-mainnet'],
  bazaar: true, // register the @x402/extensions bazaar discovery extension
});

const app = new Hono();

// ── Identity gate (conditional) ─────────────────────────────────────────────
// Gate fires only when a payment credential is already attached. Anonymous browsers
// (no payment header) fall through to the handler unauthenticated and receive a clean
// 402 with all rails advertised — so any spec-compliant x402 wallet (Coinbase awal,
// Phantom, Solflare, etc.) can discover prices before AgentScore identity exists.
// Identity is verified at settle time on the retry leg (when X-Payment / Authorization:
// Payment arrives), and `createSessionOnMissing` then auto-mints a verification session
// so agents can bootstrap KYC and replay the same payment authorization.
const _gate = agentscoreGate({
  apiKey: process.env.AGENTSCORE_API_KEY!,
  requireKyc: true,
  createSessionOnMissing: { apiKey: process.env.AGENTSCORE_API_KEY!, context: 'purchase' },
});
app.use('/purchase', async (c, next) => {
  const hasPaymentHeader = Boolean(
    c.req.header('payment-signature') ||
    c.req.header('x-payment') ||
    c.req.header('authorization')?.startsWith('Payment '),
  );
  if (!hasPaymentHeader) { await next(); return; }
  return _gate(c, next);
});

app.post('/purchase', async (c) => {
  const assess = getAgentScoreData(c);
  const body = await c.req.json();
  const totalUsd = String(body.amount_usd ?? '10.00');
  const amountCents = Math.round(Number(totalUsd) * 100);

  // ──────────────────────────────────────────────────────────────────────────
  // Path A: x402 X-Payment header present → verify + settle on chain
  // ──────────────────────────────────────────────────────────────────────────
  if (c.req.header('payment-signature') || c.req.header('x-payment')) {
    const verified = await verifyX402Request({
      request: c.req.raw,
      isCachedAddress: piCache.hasAddress,
      acceptedNetworks: { base: X402_BASE_NETWORK, svm: X402_SVM_NETWORK },
    });
    if (!verified.ok) return c.json(verified.body, verified.status);

    const settle = await processX402Settle({
      x402Server,
      payload: verified.payload,
      resourceConfig: {
        scheme: 'exact' as const,
        network: verified.signedNetwork,
        price: `$${totalUsd}`,
        payTo: verified.signedPayTo,
        maxTimeoutSeconds: 300,
      },
      resourceMeta: {
        url: c.req.url,
        description: 'Agent purchase via x402',
        mimeType: 'application/json',
      },
    });
    if (!settle.success) {
      return c.json(buildValidationError({
        code: 'payment_proof_invalid',
        message: `Payment failed during settlement (phase: ${settle.phase ?? 'unknown'}).`,
        nextSteps: { action: 'regenerate_payment_credential' },
        extra: { phase: settle.phase },
      }), 400);
    }

    // Fire Stripe testnet sim — no-ops on live keys.
    await simulateDepositIfTestMode({
      getPaymentIntentId: piCache.getPaymentIntentId,
      depositAddress: verified.signedPayTo,
      network: verified.isSolana ? 'solana' : 'base',
      stripeSecretKey: process.env.STRIPE_SECRET_KEY!,
    });

    const headers: Record<string, string> = {};
    if (settle.paymentResponseHeader) headers['payment-response'] = settle.paymentResponseHeader;
    return c.json({ ok: true, order_id: body.order_id ?? null }, { headers });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Path B: cold call OR Authorization: Payment (mppx) — mint PI + compose mppx
  // ──────────────────────────────────────────────────────────────────────────
  const { paymentIntentId, depositAddresses } = await createMultichainPaymentIntent({
    stripe: stripeClient as never,
    amount: amountCents,
    networks: ['tempo', 'base', 'solana'],
  });
  for (const addr of Object.values(depositAddresses)) {
    await piCache.cacheAddress(addr);
    piCache.cachePaymentIntent(addr, paymentIntentId);
  }
  piCache.cacheNetworkAddresses(paymentIntentId, depositAddresses);

  const mppx = await createMppxServer({
    rails: {
      tempo: {
        recipient: depositAddresses.tempo as `0x${string}`,
        currency: process.env.TEMPO_USDC_ADDRESS!,
        testnet: process.env.TEMPO_USDC_ADDRESS === '0x20c0000000000000000000000000000000000000',
      },
      stripe: {
        profileId: process.env.STRIPE_PROFILE_ID!,
        secretKey: process.env.STRIPE_SECRET_KEY!,
      },
    },
    secretKey: process.env.MPP_SECRET_KEY!,
  });

  // mppx.compose() validates any `Authorization: Payment` credential and either
  // returns {status: 200, ...} (settled) or {status: 402, challenge: Response}.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (mppx as any).compose(
    ['tempo/charge', { amount: totalUsd, currency: process.env.TEMPO_USDC_ADDRESS!, decimals: 6, recipient: depositAddresses.tempo }],
    ['stripe/charge', { amount: totalUsd, currency: 'usd', decimals: 2 }],
  )(c.req.raw);

  if (result.status === 402) {
    // ── Build the rich 402 with all 4 rails + identity metadata + agent_memory.
    // respond402 PRESERVES mppx's WWW-Authenticate (its server-side validator
    // matches credentials to its own directive ids) and ADDS x402's
    // PAYMENT-REQUIRED header (mppx doesn't emit it).
    const isWalletAuth = assess?.identity_method === 'wallet';
    const acceptedMethods = buildAcceptedMethods({
      tempo: { recipient: depositAddresses.tempo, network: 'tempo-mainnet', chainId: networks.tempo.mainnet.chainId },
      x402_base: { recipient: depositAddresses.base, network: X402_BASE_NETWORK },
      x402_solana: { recipient: depositAddresses.solana, network: X402_SVM_NETWORK },
      ...(isWalletAuth ? {} : { stripe: { profileId: process.env.STRIPE_PROFILE_ID! } }),
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

    return respond402({
      mppxChallenge: result.challenge as Response,
      body: {
        acceptedMethods,
        agentInstructions: buildAgentInstructions({ howToPay }),
        identityMetadata: buildIdentityMetadata({
          mode: isWalletAuth ? 'wallet' : 'operator_token',
          wallet: c.req.header('X-Wallet-Address') ?? undefined,
          linkedWallets: assess?.linked_wallets ?? [],
        }),
        pricing: buildPricingBlock({ subtotalCents: amountCents, currency: 'USD' }),
        amountUsd: totalUsd,
        currency: 'USD',
        orderId: body.order_id ?? null,
        retryBody: body,
        agentMemory: firstEncounterAgentMemory({ firstEncounter: true }),
      },
      x402: {
        x402Version: 2,
        accepts: [
          {
            scheme: 'exact',
            network: X402_BASE_NETWORK,
            amount: String(Math.round(Number(totalUsd) * 1_000_000)),
            asset: USDC.base.mainnet.address,
            payTo: depositAddresses.base,
            maxTimeoutSeconds: 300,
          },
          {
            scheme: 'exact',
            network: X402_SVM_NETWORK,
            amount: String(Math.round(Number(totalUsd) * 1_000_000)),
            asset: USDC.solana.mainnet.mint,
            payTo: depositAddresses.solana,
            maxTimeoutSeconds: 300,
          },
        ],
        resource: { url: c.req.url, mimeType: 'application/json' },
      },
    });
  }

  // mppx settled — fire Stripe testnet sim and return success.
  await simulateDepositIfTestMode({
    getPaymentIntentId: piCache.getPaymentIntentId,
    depositAddress: depositAddresses.tempo,
    network: 'tempo',
    stripeSecretKey: process.env.STRIPE_SECRET_KEY!,
  });
  return c.json({ ok: true, order_id: body.order_id ?? null });
});

export default app;
