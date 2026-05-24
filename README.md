# @agent-score/commerce

[![npm version](https://img.shields.io/npm/v/@agent-score/commerce.svg)](https://www.npmjs.com/package/@agent-score/commerce)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

The full merchant-side SDK for [AgentScore](https://agentscore.sh): agent commerce in one install. Ships identity gating, payment rail helpers, 402 challenge builders, MPP discovery, and Stripe multichain support. Built and maintained by AgentScore; works with any 402/MPP merchant in the ecosystem, AgentScore-gated or not.

## Install

```bash
npm install @agent-score/commerce
# or
bun add @agent-score/commerce
```

Framework + protocol packages are optional peer deps; install only what you use:

```bash
npm install hono mppx @x402/core @x402/evm @solana/mpp @solana/kit stripe   # whatever your stack needs
```

## What's in the package

| Subpath | What it provides |
|---|---|
| `/identity/{hono,express,fastify}` | Trust gate middleware: KYC, sanctions (account name + signer wallet), age, jurisdiction. Context-getter pattern: `agentscoreGate(opts)` middleware + `getAgentScoreData(ctx)` / `getGateDegradedState(ctx)` / `getGateQuotaInfo(ctx)` / `getSignerVerdict(ctx)` accessors, `captureWallet(...)`. The denial helpers (`denialReasonStatus`, `denialReasonToBody`, `buildSignerMismatchBody`, `buildContactSupportNextSteps`, `verificationAgentInstructions`, `isFixableDenial`, `FIXABLE_DENIAL_REASONS`) are exported from the top-level `@agent-score/commerce`, not the adapters. |
| `/identity/policy` | Per-product compliance helpers for multi-product merchants (each product carries its own policy: hard gate vs soft vs none, per-product shipping allowlists): `PolicyBlock`, `GateResult`, `EnforcementMode`, `IdentityStatus`, `buildGateOptionsFromPolicy`, `runGateWithEnforcement`, `shippingCountryAllowed`, `shippingStateAllowed`, `validateShippingAgainstPolicy` (one-call country+state validator that raises `CheckoutValidationError` with the canonical envelope on miss). |
| `/identity/{nextjs,web}` | Same gate, wrapper pattern: `withAgentScoreGate(opts, handler)` / `createAgentScoreGate(opts) => guard(req)`. The `data` + `degraded` + `infraReason` + `getSignerVerdict` fields land directly on the handler arg / guard result (no separate getter). Plus shared `captureWallet`. |
| `/payment` | `networks`, `USDC`, `rails` registries; `paymentDirective`, `buildPaymentDirective`, `wwwAuthenticateHeader`, `paymentRequiredHeader`, `aliasAmountFields` (opt-in v1↔v2 amount-field shim: adds both `amount` and `maxAmountRequired` to an entry. The 402 builders do NOT apply it by default — strict x402 v2 settlement matches the agent's echoed requirement by exact comparison, so an extra field the server's rebuilt requirement lacks breaks settle; use only when you know a client is hardcoded to read `maxAmountRequired`), `settlementOverrideHeader`, `dispatchSettlementByNetwork`, `extractPaymentSigner` (Request-based; recovers signer from x402 EIP-3009 `payload.authorization.from` OR MPP `Authorization: Payment <base64>` `did:pkh:eip155:<chain>:<addr>` / `did:pkh:solana:<genesis>:<addr>` source DID, including Solana `TransferChecked` authority fallback when `@solana/kit` is installed), `extractPaymentSignerFromAuth` (header-string variant for callers that already have the `Authorization` value in hand), `detectRailFromHeaders` (returns `"x402"` / `"mpp"` / `null` from inbound headers); `createX402Server`, `createMppxServer` (the solana rail's `ataCreationRequired` defaults to `true` so Solana settles work on `@solana/mpp >= 0.6.0` out of the box — opt out only if every recipient's ATA is guaranteed to pre-exist; see `SolanaMppRailSpec.ataCreationRequired` for economics), `buildDefaultCheckoutRails({tempo?, x402Base?, solanaMpp?, stripe?})` (canonical 4-rail `rails` dict factory: flipping `network` alone derives the right `token` + `chainId` — Base Sepolia → Sepolia USDC + chainId 84532, Solana devnet → devnet USDC mint. Solana's `network` accepts both CAIP-2 and the raw `@solana/mpp` form `mainnet-beta` / `devnet` / `localnet`. Explicit overrides always win), `buildMppxComposeRails({amountUsd, tempoRecipient?, solanaRecipient?, ...})` (per-call intent factory replacing the hand-rolled `[['tempo/charge',{...}],['solana/charge',{...}],['stripe/charge',{...}]]` array; auto-handles USD→atomic conversion for Solana; auto-drops `stripe/charge` when `amountUsd < 0.50` since Stripe's fixed ~$0.30 fee makes sub-50-cent charges unprofitable — sub-50-cent APIs pass `includeStripe: false` explicitly to silence the warning); drop-in x402 helpers: `validateX402NetworkConfig` (boot-time guard), `verifyX402Request` (parse + validate inbound X-Payment), `processX402Settle` (verify-then-settle with one call), `classifyX402SettleResult` (maps the tagged settle result to a recommended HTTP status / code / nextSteps so merchants get a controlled envelope without coupling to facilitator-specific error text), `classifyOrchestrationError` (same `ClassifiedX402Error` shape but for uncaught exceptions thrown elsewhere in the orchestration; returns `null` for unknown errors so merchants rethrow instead of swallowing); `zeroAmountCarveOut` (skip CDP / mppx upstream verify+settle for $0 settles where the upstream rejects value=0 payloads; parses the credential, lifts signer + network, returns a `ZeroSettleResult` shaped identically to the success path so callers branch on rail, not on result shape); `usdToAtomic` (BigInt-based USD → atomic value, ROUND_HALF_UP — for Tempo / Solana / Base USDC amount construction). |
| `/discovery` | `isDiscoveryProbeRequest`, `buildDiscoveryProbeResponse` (with optional `x402Sample` for x402-aware crawlers, e.g. `awal x402 details`), `sampleX402AcceptForNetwork` (USDC sample-accept builder for known CAIP-2 networks), `buildWellKnownMpp`, `buildLlmsTxt` + `llmsTxtIdentitySection` + `llmsTxtPaymentSection` (compact + verbose modes), `buildSkillMd` (Claude-Skill-compatible `/skill.md` agent-discovery manifest; strictly agent-facing data only, no internal posture), `buildRedemptionSkillMd` (delivery-neutral redemption-code template — printed mailers, emailed codes, API trial credits all covered; `endpointPath`/`deliveryIntro`/`bodyShape`/`bodyRules`/`extraRecoveryRows` overrides for non-goods shapes), `agentscoreOpenApiSnippets`, `createBazaarDiscovery`, `noindexNonDiscoveryPaths` (Hono middleware emitting `X-Robots-Tag: noindex` on every path except the agent-discovery surfaces; pure helpers `isDiscoveryPath` + `defaultDiscoveryPaths` for non-Hono frameworks), `buildMerchantIndexJson` (canonical `/` discovery body), `standardEndpointDescriptions({kind})` (canonical method+path → description map for goods vs api merchants; optional `includeOrderStatusRoute` for goods), `buildSuccessNextSteps` (universal Passport-active success block), `buildAgentscoreOnboardingSteps` (canonical skill.md onboarding for goods or API merchants). Plus the UCP/JWKS publish surface: `buildSignedUcpResponse`, `buildSignedJwksResponse`, `wellKnownPreflightResponse`, `defaultA2aServices`, `bootstrapUcpSigningKey`, and the framework-neutral `SignedDiscoveryResponse` + per-framework wrappers `signedResponse{Hono,Express,Fastify,Nextjs,Web}`. |
| `/challenge` | `build402Body`, `buildAcceptedMethods`, `buildIdentityMetadata`, `buildHowToPay`, `buildAgentInstructions` (auto-emits per-rail `compatible_clients`: smoke-verified CLIs the agent should use; vendor override supported; pure helper `compatibleClientsByRails(rails)` returns the same map for vendors building custom 402s), `buildPricingBlock`, `firstEncounterAgentMemory`, `Receipt` (canonical 200-receipt shape returned post-settle — universal: goods merchants fill the shipping/fulfillment/product slots, API merchants populate only the universal fields); `respond402`, a drop-in 402 emit that preserves mppx's `WWW-Authenticate` and layers x402's `PAYMENT-REQUIRED`. `buildValidationError`: structured 4xx body builder (`{error: {code, message}, required_fields?, example_body?, next_steps?, ...extra}`) so vendors compose body shapes by name instead of inlining at every validation site. |
| `/stripe-multichain` | `createMultichainPaymentIntent` (returns `{ paymentIntentId, depositAddresses }` — read `depositAddresses[network]` directly), `createPayToAddressFromStripePI({request, amountCents, stripe, piCache, networks?, staticRecipients?, metadata?, orderId?, preferredNetwork?})` — per-order payTo resolver: on the settle leg, reuses the buyer's signed-against payTo from the MPP credential (after `piCache.hasAddress` check OR a `staticRecipients` match — the static address is always-accepted because the merchant owns it); on the discovery leg, mints a fresh PI for the rails NOT covered by `staticRecipients`, caches the merged map, registers static addresses with `piCache.cacheAddress` so verify-leg lookups pass. `mintMultichainRecipients({...same opts})` — structured variant that returns `{ recipients: Record<string,string>, paymentIntentId?, reusedFromCredential }`; prefer this when your `mintRecipients` hook needs the full per-rail map (typical multi-rail merchant). Use `staticRecipients: { solana: '<wallet>' }` for low-margin endpoints where the per-call ATA rent on Solana (~$0.50 against MPP spec §13.6) would dominate revenue — the SDK skips Stripe minting for that network, the static recipient is reused forever, and a one-time pre-funding of its USDC ATA from any external wallet makes every settle pay only the ~$0.001 per-tx fee. `simulateCryptoDeposit`, `createMppxStripe`; `createPiCache` (TTL'd PI / deposit-address cache, Redis-backed when `redisUrl` set, in-memory otherwise), `simulateDepositIfTestMode` (gates on `sk_test_` and looks up the PI for you), `STRIPE_TEST_TX_HASH_SUCCESS` / `STRIPE_TEST_TX_HASH_FAILED` constants. Peer dep on `stripe`. |
| `/api` | Everything from `@agent-score/sdk` re-exported in one place: `AgentScore` + `AgentScoreError`, `AGENTSCORE_TEST_ADDRESSES` + `isAgentScoreTestAddress`. **Don't add `@agent-score/sdk` as a separate dep**; the two can drift versions and cause subtle type mismatches. |
| `/middleware/{hono,express,fastify,nextjs,web}` | Framework-specific rate-limit middleware. Hono / Express / Fastify expose middleware factories (`rateLimitHono`, `rateLimitExpress`, `rateLimitFastify`); Next.js exposes `withRateLimit(opts, handler)`; Web Fetch exposes `createRateLimit(opts) => guard(req)`. Shared options: `windowSeconds` (default 60), `maxRequests` (default 60), `keyResolver` (default first hop of `x-forwarded-for`), `redisUrl` (lazy-imports `ioredis` when set, in-memory `Map` fallback otherwise), `keyPrefix`. `ioredis` is an optional peer dep — install it only if you want distributed limiting. |
| `@agent-score/commerce` (top-level) | `Checkout` orchestrator + `CheckoutContext` + `CheckoutGateConfig` + `CheckoutValidationError` + `DiscoveryProbeConfig` + `MountUcpRoutesOptions` + `SettleOutcome` + `MppxComposeOutcome` + `PricingResult` (the 2.0 high-level surface: one config object, hooks for preValidate/computePricing/onSettled/mintRecipients/composeMppx, auto-derived x402+mppx servers, per-framework adapters `handleHono`/`handleExpress`/`handleFastify`/`handleNextjs`/`handleWeb`, signed UCP routes via `mountUcpRoutes{Hono,Express,Fastify}`); `pricingResult` (factory: cents-denominated → typed `PricingResult` with embedded `PricingBlock`); `validationResponse{Hono,Express,Fastify,Nextjs,Web}` (per-framework 4xx envelope wrappers); `loadUCPSigningKeyFromEnv` (cached env-driven loader for the UCP signing key — reads `UCP_SIGNING_KEY_JWK_PRIVATE` JSON JWK, detects alg from shape, falls back to ephemeral when unset, sanitizes errors so key bytes never reach logs, concurrent-safe via Promise-pinned cache); `hashOperatorToken` (sha256 hex of plaintext `opc_...` — for merchants persisting `operator_token_id` to their own DB without ever storing the plaintext); `extractOwnerScope(headers) → { walletAddress?, operatorTokenHash? }` (canonical owner-identity extractor for caller-scoped resource queries — reads `X-Wallet-Address` / `X-Operator-Token`, hashes the token so plaintext never leaves the request); `hasPaymentHeader` / `hasX402Header` / `hasMppxHeader` (request discriminators — any-credential vs x402 vs MPP); `defaultReadOnlyOnDenied(reason)` (canonical `onDenied` for read-only resource gates: 401 + `Cache-Control: no-store` while still spreading `denialReasonToBody`); plus the cross-vendor publishers `buildA2AAgentCard` + `buildUCPProfile` (return unsigned payloads: vendor signs + publishes). |

## Quick start

### Rate limiting (Hono / Express / Fastify / Next.js / Web)

Mount globally before any payment route so probe and settle legs share the same bucket. Defaults: 60 req / 60s / IP. Redis when `REDIS_URL` is set, in-memory fallback otherwise.

```typescript
import { Hono } from "hono";
import { rateLimitHono } from "@agent-score/commerce/middleware/hono";

const app = new Hono();
app.use("*", rateLimitHono());
// ... your routes ...
```

Same factory shape per framework: `rateLimitExpress`, `rateLimitFastify` (preHandler hook), `withRateLimit(opts, handler)` for Next.js App Router, and `createRateLimit(opts) => guard(req)` for Web Fetch. Override `maxRequests` / `windowSeconds` / `keyResolver` / `redisUrl` / `keyPrefix` as needed.

### Identity gate (Hono)

```typescript
import { Hono } from "hono";
import {
  agentscoreGate,
  captureWallet,
  getAgentScoreData,
  getSignerVerdict,
} from "@agent-score/commerce/identity/hono";

const app = new Hono();

const _gate = agentscoreGate({
  apiKey: process.env.AGENTSCORE_API_KEY!,
  requireKyc: true,
  minAge: 21,
  allowedJurisdictions: ["US"],
  createSessionOnMissing: { apiKey: process.env.AGENTSCORE_API_KEY!, context: "wine-purchase" },
});

// Run the gate CONDITIONALLY: only when a payment credential is already attached.
// Anonymous discovery (no payment header) flows through to the handler so any spec-
// compliant x402 wallet can read the 402 challenge with rails + pricing without first
// proving identity. Identity is verified at settle time on the retry leg.
import { hasPaymentHeader } from "@agent-score/commerce/payment";

app.use("/purchase", async (c, next) => {
  if (!hasPaymentHeader(c.req.raw)) { await next(); return; }
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

### Checkout orchestrator (the 2.0 high-level surface)

`Checkout` is the canonical merchant surface for fixed-price one-shot endpoints: one config object, hooks for the merchant-specific pieces, and the SDK handles 402 emit, identity gating, x402 verify+settle, mppx compose, $0 carve-out, and the per-framework adapter. Most fixed-price merchants reach for `Checkout` first.

For **variable-cost pay-per-result** endpoints (per-result search, per-token LLM, per-byte transcoding), reach for `computeFirstCheckout` — same config shape, but the probe leg runs the work, caches by body content-hash, and emits a 402 with the EXACT computed price. The retry pays that exact amount and receives the cached body. Works on every exact-mode rail (x402-exact Base, tempo/charge, solana/charge, Stripe SPT) without upto / Permit2 / Settlement-Overrides. Tradeoff: the work runs on the unpaid probe leg, so mount `rateLimitHono` (from `@agent-score/commerce/middleware/hono`) globally — it's load-bearing. See `examples/compute-first-merchant.ts`.

```typescript
import { Checkout, pricingResult } from "@agent-score/commerce";
import { defaultA2aServices } from "@agent-score/commerce/discovery";
import { validateShippingAgainstPolicy } from "@agent-score/commerce/identity/policy";

const checkout = new Checkout({
  rails: {
    tempo:     { recipient: process.env.TEMPO_RECIPIENT! },
    x402_base: { recipient: process.env.X402_BASE_RECIPIENT!, network: "eip155:8453" },
    solana_mpp:{ recipient: process.env.SOLANA_RECIPIENT!,    network: "solana:mainnet" },
    stripe:    { profileId: process.env.STRIPE_PROFILE_ID! },
  },
  url: "https://merchant.example/purchase",
  preValidate: async (ctx) => {
    const body = (ctx.request.body ?? {}) as { product_slug?: string; shipping?: { country?: string; state?: string } };
    const product = await lookupProduct(body.product_slug);
    validateShippingAgainstPolicy({ country: body.shipping?.country ?? "", state: body.shipping?.state ?? "", policy: product, productName: product.name });
    return { product };
  },
  computePricing: async (ctx) => pricingResult({
    subtotalCents: ctx.state.product.priceCents,
    taxCents: ctx.state.product.taxCents,
    taxRate: ctx.state.product.taxRate,
    taxState: ctx.state.product.taxState,
  }),
  onSettled: async (ctx, outcome) => ({ ok: true, order_id: ctx.referenceId, tx_hash: outcome.txHash }),
  cdpApiKeyId:     process.env.CDP_API_KEY_ID,
  cdpApiKeySecret: process.env.CDP_API_KEY_SECRET,
  mppxSecretKey:   process.env.MPP_SECRET_KEY,
  gate: {
    apiKey: process.env.AGENTSCORE_API_KEY!,
    merchantName: "Merchant",
    requireKyc: true, requireSanctionsClear: true, minAge: 21, allowedJurisdictions: ["US"],
  },
  // Optional: empty-body POSTs without a payment header auto-route to a sample 402
  // so x402 crawlers (awal x402 details, x402-proxy, ...) can discover the surface.
  discoveryProbe: {
    realm: "merchant.example",
    sampleRail: "tempo-mainnet",
    sampleAmountUsd: 1.0,
    sampleRecipient: process.env.TEMPO_RECIPIENT!,
  },
});

// Mount the signed UCP profile + JWKS + OPTIONS preflights in one call.
// (For Express / Fastify use `mountUcpRoutesExpress` / `mountUcpRoutesFastify`.
// Next.js / Web Fetch use file-based routing — call buildSignedUcpResponse
// directly inside the route handler.)
checkout.mountUcpRoutesHono(app, {
  name: "Merchant",
  wellKnownUcpUrl: "https://merchant.example/.well-known/ucp",
  services: defaultA2aServices({ agentCardUrl: "https://merchant.example/.well-known/agent-card.json" }),
  signingKid: "merchant-2026-05",
});

app.post("/purchase", (c) => checkout.handleHono(c));
```

The 402 body Checkout emits auto-attaches `identity_mode` + `required_signer` + `signer_constraint` (and `linked_wallets` when the gate populated them) when an inbound `X-Wallet-Address` header is present — so agents self-correct at discovery instead of at the 403 retry.

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

// Recover the on-chain signer from the inbound credential; returns {address, network}.
// Covers x402 EIP-3009 (EVM `from` address), Tempo MPP (`did:pkh:eip155` source),
// and Solana MPP `solana/charge` (via `did:pkh:solana` source when set, else by
// decoding the credential's signed-tx payload; `@solana/kit` optional peer).
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
      // Optional fee sponsor: pass any `TransactionPartialSigner` from `@solana/kit`.
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

`buildPricingBlock` handles cents → dollar-string conversion (with optional shipping). Pass `discountCents` for redemption codes / coupons: `subtotal` stays the list price, the block surfaces `discount` as a dollar-string, and `total` becomes `subtotal + tax + shipping - discount` (floored at 0). `pricingResult` accepts the same `discountCents` and propagates it to `block.discount` so agents reading the 402 see the savings line. Pass `decimals: N` (default `2`) on either helper for sub-cent unit pricing — e.g. `decimals: 4` advertises `$0.0005`-precision instead of rounding to two decimals. Set `decimals` on `PricingResult` and the SDK threads it through `buildHowToPay`, `buildPricingBlock`, and the x402 settle `price` string automatically; the `cents` inputs accept fractional values under that mode (per-token / per-byte unit pricing). `firstEncounterAgentMemory` returns the canonical hint or `undefined` based on a per-merchant first-seen flag. `Receipt` is a universal TS interface for the post-settlement 200 response shape — goods merchants populate the shipping/fulfillment/tracking slots, API merchants fill only the universal fields (id, created_at, pricing, payment_status, next_steps).

### Idempotency-key + multi-rail header bundle

```typescript
import { buildIdempotencyKey, buildPaymentHeaders } from "@agent-score/commerce/payment";

// Stable per-payment key: Stripe PI id wins, falls back to pi-{orderId}-{amountCents}.
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
import { buildA2AAgentCard, buildUCPProfile, ucpA2AExtension } from "@agent-score/commerce";

// Google A2A v1.0 Signed Agent Card; publish at /.well-known/agent-card.json.
// Per UCP §A2A binding, the card MUST declare the canonical UCP extension URI in
// `capabilities.extensions[]`; pass `ucpA2AExtension()` with empty capabilities
// until you bind formal UCP capabilities (dev.ucp.shopping.checkout, etc.).
// Skills are top-level AgentSkill objects; identity claims live in a separate
// AgentCardSignature (RFC 7515 JWS) wrapping the serialized card.
const card = buildA2AAgentCard({
  name,
  description,
  url,
  version: "1.0.0",
  skills: [{ id: "purchase", name: "Purchase", description: "Buy products via agent payments.", tags: ["commerce", "payment"] }],
  extensions: [ucpA2AExtension()],
});

// Google Universal Commerce Protocol; publish at /.well-known/ucp
// Output shape: { ucp: { version, services, capabilities, payment_handlers,
// name?, supported_versions? }, signing_keys: [...], signature?: "..." }
// — services / capabilities / payment_handlers are MAPS keyed by reverse-DNS
// service / capability / handler name (UCP spec §3 + §6).
const profile = buildUCPProfile({
  name,
  services: {
    'dev.ucp.shopping': [
      { version: '2026-04-08', spec: 'https://ucp.dev/2026-04-08/specification/overview',
        transport: 'mcp', endpoint: 'https://merchant.example/api/ucp/mcp',
        schema: 'https://ucp.dev/services/shopping/mcp.openrpc.json' },
    ],
  },
  payment_handlers: {
    ...mppPaymentHandler({ networks: [{ network: 'tempo-mainnet', chain_id: 4217, recipient: TEMPO_ADDR }] }),
    ...x402PaymentHandler({ networks: [{ network: 'base-8453', recipient: BASE_ADDR }] }),
    ...stripeSptPaymentHandler({ spec: { profileId: 'profile_5xKvNqM9BaH' } }),
  },
  signing_keys,
  // Optional: declare the merchant's gate policy as an `sh.agentscore.identity` capability
  // binding inside the public profile. Static policy declaration only — no per-operator data.
  // Per-operator identity attestation lives on the AP2 risk-signal endpoint, not here.
  agentscore_gate: { require_kyc: true, min_age: 21, allowed_jurisdictions: ['US'] },
});
```

UCP §6 doesn't mandate profile-body JWS signing; production UCP merchants commonly ship unsigned. AgentScore's `agentscore-profile+jws` is a vendor extension for trust-mode verifiers (regulated-commerce, AP2-aware) that opt into auditable profiles. Sign + verify via the optional `jose` peer dep (tested against jose v6.x; pin `jose@^6`):

```typescript
import { buildJWKSResponse, generateUCPSigningKey, signUCPProfile, verifyUCPProfile, UCPVerificationError } from "@agent-score/commerce";

const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: "merchant-2026-05" });
const profile = buildUCPProfile({ name, services, payment_handlers, signing_keys: [publicJWK] });
const signed = await signUCPProfile(profile, { signingKey: privateKey, kid: publicJWK.kid, alg: "EdDSA" });
const jwks = buildJWKSResponse([publicJWK]);
```

`verifyUCPProfile` enforces the JWS protected header `typ: "agentscore-profile+jws"` (vendor-namespaced; UCP §6 does not define a profile-as-JWS typ), restricts `alg` to `EdDSA` / `ES256`, requires a `kid`, rejects duplicate kids in the JWKS, and compares the canonical body bytes against the JWS payload to catch swap-after-sign tampering. Failures throw `UCPVerificationError` with a discriminated `code` (`no_signature` / `missing_kid` / `kid_not_found` / `duplicate_kid` / `unsupported_alg` / `wrong_typ` / `signature_invalid` / `body_mismatch` / `malformed_jws` / `malformed_jwks` / `unusable_key` / `unrecognized_critical_header`). `malformed_jwks` covers a JWKS argument that isn't a `{ keys: [...] }` document. `unusable_key` covers a matched JWK whose `use` is not `sig` (e.g. `enc`). `unrecognized_critical_header` covers a JWS whose `crit` header lists an extension the verifier doesn't understand (RFC 7515 §4.1.11).

`signUCPProfile` rejects profiles containing non-integer `Number` values and integers outside `Number.MAX_SAFE_INTEGER` (cross-language float canonicalization is not stable; values past 2^53 lose precision when JS verifiers reparse the canonical body). Use decimal strings for monetary or fractional fields and for any integer that may exceed the safe range.

**Persisting the private JWK.** Mint once via `generateUCPSigningKey()`, export with `jose.exportJWK(privateKey)` to get the JSON-serializable form, store in your secret manager (AWS Secrets Manager, GCP Secret Manager, etc.). On each container start, read the secret, `jose.importJWK(jwk, alg)` to re-hydrate. Remote-signer flows (KMS-backed asymmetric keys) require an adapter layer that exposes a `KeyLike` jose can call; `jose` does not natively wrap KMS endpoints.

**Key rotation.** Mint a new key with a new `kid`, add the public JWK to your JWKS endpoint alongside the old one, then sign new profiles with the new key. Verifiers fetching the JWKS pick up both; any in-flight envelopes signed by the old key still verify until you remove that JWK from the JWKS. Set `Cache-Control: public, max-age=300` on `/.well-known/jwks.json` and wait at least that long after publishing the new key before removing the old JWK.

**Inline JWK in the profile vs separate JWKS endpoint.** UCP §6 mandates the separate `/.well-known/jwks.json` endpoint as the canonical trust source. The profile's `signing_keys[]` is informational; verifiers MUST resolve the kid against the JWKS (not the embedded copy), to prevent a swap-after-sign attack where a hostile actor replaces the inline key with their own.

ACP (Stripe + OpenAI Agentic Commerce Protocol) is a transactional checkout protocol with no identity-publishing surface; ACP merchants integrate via the existing `build402Body` + `buildPaymentHeaders` + Stripe SPT rail.

### Stripe multichain (peer dep on `stripe`)

```typescript
import {
  createMultichainPaymentIntent,
  createPiCache,
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
const baseAddress = result.depositAddresses.base;
const solanaAddress = result.depositAddresses.solana;

// PI / deposit-address cache. Redis-backed when REDIS_URL is set, in-memory otherwise.
// Multi-task deployments need Redis so a deposit lands on whichever task settles it.
const piCache = createPiCache({ redisUrl: process.env.REDIS_URL });
for (const addr of Object.values(result.depositAddresses)) {
  await piCache.cacheAddress(addr);
  piCache.cachePaymentIntent(addr, result.paymentIntentId);
}
piCache.cacheNetworkAddresses(result.paymentIntentId, result.depositAddresses);

// Testnet helper: gates on sk_test_ and looks up the PI for you. No-op on live keys.
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

// Boot-time guard: raises if a configured network isn't supported.
validateX402NetworkConfig({ baseNetwork: X402_BASE });

app.post("/purchase", async (c) => {
  // Path A: agent presented an x402 X-Payment header
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

  // Path B: cold call (or Authorization: Payment for mppx). After mppx.compose() returns 402,
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
    // Compliance was NOT enforced this request; log/alert/refund-async/etc.
    console.warn(`[gate] degraded: ${infraReason}`);
  }
  // ...rest of handler
});
```

When `failOpen: true` AND the failure is infra-shape, the gate carries `degraded: true` + `infraReason: 'quota_exceeded' | 'api_error' | 'network_timeout'` so merchants can log/alert without parsing console output. **Compliance denials (sanctions, age, jurisdiction, signer-mismatch) still deny regardless of `failOpen`**; `failOpen` only covers "AgentScore couldn't tell us," never "AgentScore said no."

For regulated commerce (alcohol, age-gated, sanctioned-jurisdiction-relevant) keep the default `failOpen: false`: outage is the correct posture, and bypassing compliance on infra failure is a compliance gap. For low-stakes commerce or high-uptime SLAs, opt in and use the `degraded` flag as the audit trail.

The `getGateDegradedState` helper is exported by the context-getter adapters (Hono, Express, Fastify). For the wrapper-pattern adapters (Next.js, Web Fetch via `withAgentScoreGate` / `createAgentScoreGate`), the `degraded` + `infraReason` fields land directly on the `gate` object passed to your handler — no separate getter.

## Examples

The [examples/](./examples) directory has 8 runnable single-file Hono apps covering common merchant scenarios; copy-paste templates, not frameworks. See [examples/README.md](./examples/README.md) for the full table.

## Vendor profile examples

| Vendor type | Subpaths used | Example install line |
|---|---|---|
| Wine merchant (full compliance + multi-rail) | `/identity/*`, `/payment`, `/discovery`, `/challenge`, `/stripe-multichain` | `npm install @agent-score/commerce stripe` |
| API provider (per-call billing, no compliance) | `/payment`, `/discovery` | `npm install @agent-score/commerce` |
| Tempo-only merchant | `/payment` | `npm install @agent-score/commerce mppx` |
| Crypto-native, no Stripe | `/identity/*`, `/payment`, `/challenge` | `npm install @agent-score/commerce @x402/core` |

The SDK is genuinely a toolkit; vendors compose only what they need. Helpers don't bundle assumptions about which rails or protocols you support, and don't recommend one rail over another.

## Stability

The full merchant SDK surface is stable. Helpers are protocol translations + configurable opinions; most evolution is additive (new optional params, new helpers, new networks/rails). Major bumps are reserved for genuine protocol-mapping bugs.

## Documentation

Full integration docs at [docs.agentscore.sh/integrations/node-commerce](https://docs.agentscore.sh/integrations/node-commerce).

## License

[MIT](LICENSE)
