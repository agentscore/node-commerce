# @agent-score/commerce

[![npm version](https://img.shields.io/npm/v/@agent-score/commerce.svg)](https://www.npmjs.com/package/@agent-score/commerce)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

The full merchant-side SDK for [AgentScore](https://agentscore.sh) — agent commerce in one install. Ships identity gating, payment rail helpers, 402 challenge builders, MPP discovery, and Stripe multichain support. Built and maintained by AgentScore; works with any 402/MPP merchant in the ecosystem, AgentScore-gated or not.

## Install

```bash
npm install @agent-score/commerce
# or
bun add @agent-score/commerce
```

Framework + protocol packages are optional peer deps — install only what you use:

```bash
npm install hono mppx @x402/core @x402/evm @solana/mpp @solana/kit stripe   # whatever your stack needs
```

## What's in the package

| Subpath | What it provides |
|---|---|
| `/identity/{hono,express,fastify,nextjs,web}` | Trust gate middleware: KYC, sanctions, age, jurisdiction. `agentscoreGate(...)`, `getAgentScoreData(c)`, `captureWallet(...)`, `verifyWalletSignerMatch(...)`. Plus shared denial helpers: `denialReasonStatus`, `denialReasonToBody`, `buildSignerMismatchBody`, `buildContactSupportNextSteps`, `verificationAgentInstructions`, `isFixableDenial`, `FIXABLE_DENIAL_REASONS`. |
| `/payment` | `networks`, `USDC`, `rails` registries; `paymentDirective`, `buildPaymentDirective`, `wwwAuthenticateHeader`, `paymentRequiredHeader`, `aliasAmountFields` (v1↔v2 amount field shim — emits both `amount` and `maxAmountRequired` so v1-only x402 parsers like Coinbase awal can read v2 bodies), `settlementOverrideHeader`, `dispatchSettlementByNetwork`, `extractPaymentSigner` (returns `{address, network}`); `createX402Server`, `createMppxServer`; drop-in x402 helpers: `validateX402NetworkConfig` (boot-time guard), `verifyX402Request` (parse + validate inbound X-Payment), `processX402Settle` (verify-then-settle with one call), `classifyX402SettleResult` (maps the tagged settle result to a recommended HTTP status / code / nextSteps so merchants get a controlled envelope without coupling to facilitator-specific error text). |
| `/discovery` | `isDiscoveryProbeRequest`, `buildDiscoveryProbeResponse` (with optional `x402Sample` for x402-aware crawlers — `awal x402 details` etc.), `sampleX402AcceptForNetwork` (USDC sample-accept builder for known CAIP-2 networks), `buildWellKnownMpp`, `buildLlmsTxt` + `llmsTxtIdentitySection` + `llmsTxtPaymentSection` (compact + verbose modes), `buildSkillMd` (Claude-Skill-compatible `/skill.md` agent-discovery manifest — strictly agent-facing data only, no internal posture), `agentscoreOpenApiSnippets`, `createBazaarDiscovery`, `noindexNonDiscoveryPaths` (Hono middleware that emits `X-Robots-Tag: noindex` on every path except the agent-discovery surfaces — defaults cover `/openapi.json`, `/llms.txt`, `/skill.md`, `/.well-known/{mpp.json,agent-card.json,ucp}`, `/favicon.{png,ico}`; pure helpers `isDiscoveryPath` + `defaultDiscoveryPaths` for non-Hono frameworks). |
| `/challenge` | `build402Body`, `buildAcceptedMethods`, `buildIdentityMetadata`, `buildHowToPay`, `buildAgentInstructions` (auto-emits per-rail `compatible_clients` — smoke-verified CLIs the agent should use; vendor override supported), `buildPricingBlock`, `firstEncounterAgentMemory`, `OrderReceipt`; `respond402` — drop-in 402 emit that preserves mppx's `WWW-Authenticate` and layers x402's `PAYMENT-REQUIRED`. `buildValidationError` — structured 4xx body builder (`{error: {code, message}, required_fields?, example_body?, next_steps?, ...extra}`) so vendors compose body shapes by name instead of inlining at every validation site. |
| `/stripe-multichain` | `createMultichainPaymentIntent`, `getDepositAddress`, `simulateCryptoDeposit`, `createMppxStripe`; `createPiCache` (TTL'd PI / deposit-address cache, Redis-backed when `redisUrl` set, in-memory otherwise), `simulateDepositIfTestMode` (gates on `sk_test_` and looks up the PI for you), `STRIPE_TEST_TX_HASH_SUCCESS` / `STRIPE_TEST_TX_HASH_FAILED` constants. Peer dep on `stripe`. |
| `/api` | Everything from `@agent-score/sdk` re-exported in one place: `AgentScore` + `AgentScoreError`, `AGENTSCORE_TEST_ADDRESSES` + `isAgentScoreTestAddress`. **Don't add `@agent-score/sdk` as a separate dep** — the two can drift versions and cause subtle type mismatches. |

## Quick start

### Identity gate (Hono)

```typescript
import { Hono } from "hono";
import {
  agentscoreGate,
  captureWallet,
  getAgentScoreData,
  verifyWalletSignerMatch,
} from "@agent-score/commerce/identity/hono";

const app = new Hono();

const _gate = agentscoreGate({
  apiKey: process.env.AGENTSCORE_API_KEY!,
  requireKyc: true,
  minAge: 21,
  allowedJurisdictions: ["US"],
  createSessionOnMissing: { apiKey: process.env.AGENTSCORE_API_KEY!, context: "wine-purchase" },
});

// Run the gate CONDITIONALLY — only when a payment credential is already attached.
// Anonymous discovery (no payment header) flows through to the handler so any spec-
// compliant x402 wallet can read the 402 challenge with rails + pricing without first
// proving identity. Identity is verified at settle time on the retry leg.
app.use("/purchase", async (c, next) => {
  const hasPaymentHeader = Boolean(
    c.req.header("payment-signature") ||
    c.req.header("x-payment") ||
    c.req.header("authorization")?.startsWith("Payment "),
  );
  if (!hasPaymentHeader) { await next(); return; }
  return _gate(c, next);
});

app.post("/purchase", async (c) => {
  const data = getAgentScoreData(c);
  // ... settle payment ...
  // After payment, capture the signer wallet for cross-merchant attribution
  await captureWallet(c, { walletAddress: signer, network: "evm", idempotencyKey: paymentIntentId });
  return c.json({ ok: true });
});
```

### Payment helpers

```typescript
import {
  buildPaymentDirective,
  extractPaymentSigner,
  networks,
  paymentRequiredHeader,
  wwwAuthenticateHeader,
} from "@agent-score/commerce/payment";

// Build paymentauth.org directives by symbolic rail name (decimals + currency from registry)
const directives = [
  buildPaymentDirective({ rail: "tempo-mainnet",     id: "chg_t", realm: "ex.com", recipient: TEMPO_ADDR, amountUsd: 0.01 }),
  buildPaymentDirective({ rail: "x402-base-mainnet", id: "chg_b", realm: "ex.com", recipient: BASE_ADDR,  amountUsd: 0.01 }),
  buildPaymentDirective({ rail: "mpp-solana-mainnet", id: "chg_s", realm: "ex.com", recipient: SOL_ADDR,  amountUsd: 0.01 }),
];
const wwwAuth = wwwAuthenticateHeader(directives);

// Recover the on-chain signer from the inbound credential — returns {address, network}.
// Covers x402 EIP-3009 (EVM `from` address), Tempo MPP (`did:pkh:eip155` source),
// and Solana MPP `solana/charge` (via `did:pkh:solana` source when set, else by
// decoding the credential's signed-tx payload — `@solana/kit` optional peer).
const signer = await extractPaymentSigner(req, req.headers.get("x-payment") ?? undefined);
```

### x402 + MPP server setup

```typescript
import { createX402Server, createMppxServer } from "@agent-score/commerce/payment";

const x402 = await createX402Server({
  facilitator: "coinbase",  // or "http", or pass a custom facilitator instance
  rails: ["x402-base-mainnet", "x402-base-mainnet-upto"],
});

const mppx = await createMppxServer({
  rails: {
    tempo: { recipient: process.env.TEMPO_RECIPIENT! },
    solana: {
      recipient: process.env.SOLANA_RECIPIENT!,
      // Optional fee sponsor — pass any `TransactionPartialSigner` from `@solana/kit`.
      // signer: solanaFeePayerSigner,
    },
    stripe: { profileId: process.env.STRIPE_PROFILE_ID!, secretKey: process.env.STRIPE_SECRET_KEY! },
  },
  secretKey: process.env.MPP_SECRET_KEY!,
});
```

### 402 builders

```typescript
import {
  build402Body,
  buildAcceptedMethods,
  buildAgentInstructions,
  buildHowToPay,
  buildIdentityMetadata,
} from "@agent-score/commerce/challenge";

const acceptedMethods = buildAcceptedMethods({
  tempo: { recipient: TEMPO_ADDR },
  x402_base: { recipient: BASE_ADDR },
  solana_mpp: { recipient: SOL_ADDR, feePayerKey: SOLANA_FEE_PAYER },
  stripe: { profileId: STRIPE_PROFILE_ID },
});

const howToPay = buildHowToPay({
  url: req.url,
  retryBodyJson: JSON.stringify(body),
  totalUsd: "10.00",
  rails: { tempo: { recipient: TEMPO_ADDR }, x402_base: { recipient: BASE_ADDR } },
});

const responseBody = build402Body({
  acceptedMethods,
  agentInstructions: buildAgentInstructions({ howToPay }),
  identityMetadata: buildIdentityMetadata({ mode: "wallet", wallet: claimedAddress }),
  pricing: buildPricingBlock({ subtotalCents: 1000, taxCents: 80, shippingCents: 999, taxRate: 0.08, taxState: "CA" }),
  amountUsd: "10.80",
  retryBody: body,
  // First-encounter merchants attach the cross-merchant agent_memory hint so agents persist the AgentScore pattern.
  agentMemory: firstEncounterAgentMemory({ firstEncounter: !merchant.hasSeenOperator(opToken) }),
});
```

`buildPricingBlock` handles cents → dollar-string conversion (with optional shipping). `firstEncounterAgentMemory` returns the canonical hint or `undefined` based on a per-merchant first-seen flag. `OrderReceipt` is a TS interface for the post-settlement 200 response shape.

### Idempotency-key + multi-rail header bundle

```typescript
import { buildIdempotencyKey, buildPaymentHeaders } from "@agent-score/commerce/payment";

// Stable per-payment key — Stripe PI id wins, falls back to pi-{orderId}-{amountCents}.
const idempotencyKey = buildIdempotencyKey({ paymentIntentId, orderId, amountCents });

// One-call WWW-Authenticate + PAYMENT-REQUIRED bundle from a single rails declaration.
const headers = buildPaymentHeaders({
  orderId,
  realm: "agents.merchant.example",
  rails: [
    { rail: "tempo-mainnet", amountUsd: "10.00", recipient: TEMPO_ADDR },
    { rail: "x402-base-mainnet", amountUsd: "10.00", recipient: BASE_ADDR },
    { rail: "stripe", amountUsd: "10.00", networkId: STRIPE_PROFILE_ID },
  ],
  x402: { accepts: x402Accepts, version: 2 },
});
return new Response(JSON.stringify(responseBody), { status: 402, headers });
```

### Identity publishing (cross-vendor standards)

```typescript
import { buildA2AAgentCard, buildUCPProfile } from "@agent-score/commerce";

// Google A2A v1.0 Signed Agent Card — publish at /.well-known/agent-card.json
const card = buildA2AAgentCard({ name, url, capabilities, data: assess });

// Google Universal Commerce Protocol — publish at /.well-known/ucp
const profile = buildUCPProfile({ name, services, payment_handlers, signing_keys, data: assess });
```

ACP (Stripe + OpenAI Agentic Commerce Protocol) is a transactional checkout protocol with no identity-publishing surface — ACP merchants integrate via the existing `build402Body` + `buildPaymentHeaders` + Stripe SPT rail.

### Stripe multichain (peer dep on `stripe`)

```typescript
import {
  createMultichainPaymentIntent,
  createPiCache,
  getDepositAddress,
  simulateCryptoDeposit,
  simulateDepositIfTestMode,
} from "@agent-score/commerce/stripe-multichain";

const result = await createMultichainPaymentIntent({
  stripe: stripeClient,
  amount: 1000,
  networks: ["tempo", "base", "solana"],
  metadata: { order_id: orderId },
  idempotencyKey: orderId,
});
const baseAddress = getDepositAddress(result, "base");
const solanaAddress = getDepositAddress(result, "solana");

// PI / deposit-address cache. Redis-backed when REDIS_URL is set, in-memory otherwise —
// multi-task deployments need Redis so a deposit lands on whichever task settles it.
const piCache = createPiCache({ redisUrl: process.env.REDIS_URL });
for (const addr of Object.values(result.depositAddresses)) {
  await piCache.cacheAddress(addr);
  piCache.cachePaymentIntent(addr, result.paymentIntentId);
}
piCache.cacheNetworkAddresses(result.paymentIntentId, result.depositAddresses);

// Testnet helper — gates on sk_test_ and looks up the PI for you. No-op on live keys.
await simulateDepositIfTestMode({
  getPaymentIntentId: piCache.getPaymentIntentId,
  depositAddress: baseAddress!,
  network: "base",
  stripeSecretKey: process.env.STRIPE_SECRET_KEY!,
});
```

### Build the x402 accepts entry for the 402 challenge

```typescript
import { buildX402AcceptsFor402 } from '@agent-score/commerce/payment';

const x402Accepts = await buildX402AcceptsFor402(x402Server, {
  network: X402_BASE,
  price: `$${totalUsd}`,
  payTo: process.env.TREASURY_BASE_RECIPIENT!,
  maxTimeoutSeconds: 300,
});
```

Returns a list of plain objects ready for the 402 body's `accepts[]`. `extra.name` is derived from the registered scheme metadata so the EIP-712 domain matches the on-chain USDC contract.

### Drop-in 402 + settle (x402)

```typescript
import {
  classifyX402SettleResult,
  processX402Settle,
  validateX402NetworkConfig,
  verifyX402Request,
} from "@agent-score/commerce/payment";
import { respond402 } from "@agent-score/commerce/challenge";

// Boot-time guard — raises if a configured network isn't supported.
validateX402NetworkConfig({ baseNetwork: X402_BASE });

app.post("/purchase", async (c) => {
  // Path A — agent presented an x402 X-Payment header
  if (c.req.header("payment-signature") || c.req.header("x-payment")) {
    const verified = await verifyX402Request({
      request: c.req.raw,
      isCachedAddress: piCache.hasAddress,
      acceptedNetwork: X402_BASE,
    });
    if (!verified.ok) return c.json(verified.body, verified.status);

    const settle = await processX402Settle({
      x402Server,
      payload: verified.payload,
      resourceConfig: { scheme: "exact", network: verified.signedNetwork, price: `$${total}`, payTo: verified.signedPayTo, maxTimeoutSeconds: 300 },
      resourceMeta: { url: c.req.url, mimeType: "application/json" },
    });
    const classified = classifyX402SettleResult(settle);
    if (classified) {
      // Log raw `settle` server-side; return controlled phase-based response to the agent.
      console.error("[x402-settle]", { phase: settle.success ? null : settle.phase, raw: settle });
      return c.json({ error: { code: classified.code, message: classified.message }, next_steps: classified.nextSteps }, classified.status);
    }
    if (!settle.success) throw new Error("unreachable: classified covers every non-success phase");

    const headers: Record<string, string> = {};
    if (settle.paymentResponseHeader) headers["payment-response"] = settle.paymentResponseHeader;
    return c.json({ ok: true }, { headers });
  }

  // Path B — cold call (or Authorization: Payment for mppx). After mppx.compose() returns 402,
  // respond402 PRESERVES mppx's WWW-Authenticate and ADDS x402's PAYMENT-REQUIRED.
  return respond402({
    mppxChallenge: mppxResult.challenge as Response,
    body: { acceptedMethods, agentInstructions, pricing, amountUsd: total, retryBody: body },
    x402: { x402Version: 2, accepts: x402Accepts, resource: { url: c.req.url, mimeType: "application/json" } },
  });
});
```

## Fail-open behavior

By default AgentScore Gate fails closed: any AgentScore-side infrastructure failure (HTTP 429, 5xx, network timeout) returns 503 to the buyer. Set `failOpen: true` on `agentscoreGate({...})` to opt in to graceful degradation:

```ts
import { agentscoreGate, getGateDegradedState } from '@agent-score/commerce/identity/hono';

const gate = agentscoreGate({ apiKey: process.env.AGENTSCORE_API_KEY!, failOpen: true });

app.use('/purchase', gate);

app.post('/purchase', async (c) => {
  const { degraded, infraReason } = getGateDegradedState(c);
  if (degraded) {
    // Compliance was NOT enforced this request — log/alert/refund-async/etc.
    console.warn(`[gate] degraded: ${infraReason}`);
  }
  // ...rest of handler
});
```

When `failOpen: true` AND the failure is infra-shape, the gate carries `degraded: true` + `infraReason: 'quota_exceeded' | 'api_error' | 'network_timeout'` so merchants can log/alert without parsing console output. **Compliance denials (sanctions, age, jurisdiction, signer-mismatch) still deny regardless of `failOpen`** — `failOpen` only covers "AgentScore couldn't tell us," never "AgentScore said no."

For regulated commerce (alcohol, age-gated, sanctioned-jurisdiction-relevant) keep the default `failOpen: false` — outage is the correct posture; bypassing compliance on infra failure is a compliance gap. For low-stakes commerce or high-uptime SLAs, opt in and use the `degraded` flag as the audit trail.

The `getGateDegradedState` helper is exported by every framework adapter (Hono, Express, Fastify, Next.js, Web Fetch). For `withAgentScoreGate` (Next.js / Web Fetch), the `degraded` + `infraReason` fields land directly on the `gate` object passed to your handler.

## Examples

The [examples/](./examples) directory has 7 runnable single-file Hono apps covering common merchant scenarios — copy-paste templates, not frameworks. See [examples/README.md](./examples/README.md) for the full table.

## Vendor profile examples

| Vendor type | Subpaths used | Example install line |
|---|---|---|
| Wine merchant (full compliance + multi-rail) | `/identity/*`, `/payment`, `/discovery`, `/challenge`, `/stripe-multichain` | `npm install @agent-score/commerce stripe` |
| API provider (per-call billing, no compliance) | `/payment`, `/discovery` | `npm install @agent-score/commerce` |
| Tempo-only merchant | `/payment` | `npm install @agent-score/commerce mppx` |
| Crypto-native, no Stripe | `/identity/*`, `/payment`, `/challenge` | `npm install @agent-score/commerce @x402/core` |

The SDK is genuinely a toolkit — vendors compose only what they need. Helpers don't bundle assumptions about which rails or protocols you support, and don't recommend one rail over another.

## Stability

`@agent-score/commerce@1.0.0` ships with the full merchant SDK surface stable. Helpers are protocol translations + configurable opinions — most evolution is additive (new optional params, new helpers, new networks/rails). Major bumps are reserved for genuine protocol-mapping bugs.

## Documentation

Full integration docs at [docs.agentscore.sh/integrations/node-commerce](https://docs.agentscore.sh/integrations/node-commerce).

## License

[MIT](LICENSE)
