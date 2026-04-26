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
npm install hono mppx @x402/core @x402/evm @x402/svm stripe   # whatever your stack needs
```

## What's in the package

| Subpath | What it provides |
|---|---|
| `/identity/{hono,express,fastify,nextjs,web}` | Trust gate middleware: KYC, sanctions, age, jurisdiction. `agentscoreGate(...)`, `getAgentScoreData(c)`, `captureWallet(...)`, `verifyWalletSignerMatch(...)`. Plus shared denial helpers: `denialReasonStatus`, `denialReasonToBody`, `buildSignerMismatchBody`, `buildContactSupportNextSteps`, `verificationAgentInstructions`, `isFixableDenial`, `FIXABLE_DENIAL_REASONS`. |
| `/payment` | `networks`, `USDC`, `rails` registries; `paymentDirective`, `buildPaymentDirective`, `wwwAuthenticateHeader`, `paymentRequiredHeader`, `settlementOverrideHeader`, `dispatchSettlementByNetwork`, `extractPaymentSigner` (returns `{address, network}`); `createX402Server`, `createMppxServer`. |
| `/discovery` | `isDiscoveryProbeRequest`, `buildDiscoveryProbeResponse`, `buildWellKnownMpp`, `buildLlmsTxt` + `llmsTxtIdentitySection` + `llmsTxtPaymentSection` (compact + verbose modes), `agentscoreOpenApiSnippets`, `createBazaarDiscovery`. |
| `/challenge` | `build402Body`, `buildAcceptedMethods`, `buildIdentityMetadata`, `buildHowToPay`, `buildAgentInstructions`. |
| `/stripe-multichain` | `createMultichainPaymentIntent`, `getDepositAddress`, `simulateCryptoDeposit`, `createMppxStripe`. Peer dep on `stripe`. |
| `/api` | `AgentScore` + `AgentScoreError` re-exported from `@agent-score/sdk`. |

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

app.use("/purchase", agentscoreGate({
  apiKey: process.env.AGENTSCORE_API_KEY!,
  requireKyc: true,
  minAge: 21,
  allowedJurisdictions: ["US"],
  createSessionOnMissing: { apiKey: process.env.AGENTSCORE_API_KEY!, context: "wine-purchase" },
}));

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
  buildPaymentDirective({ rail: "tempo-mainnet",       id: "chg_t", realm: "ex.com", recipient: TEMPO_ADDR, amountUsd: 0.01 }),
  buildPaymentDirective({ rail: "x402-base-mainnet",   id: "chg_b", realm: "ex.com", recipient: BASE_ADDR,  amountUsd: 0.01 }),
  buildPaymentDirective({ rail: "x402-solana-mainnet", id: "chg_s", realm: "ex.com", recipient: SOL_ADDR,   amountUsd: 0.01 }),
];
const wwwAuth = wwwAuthenticateHeader(directives);

// Recover the on-chain signer from the inbound credential — returns {address, network}
const signer = await extractPaymentSigner(req, req.headers.get("x-payment") ?? undefined);
```

### x402 + MPP server setup

```typescript
import { createX402Server, createMppxServer } from "@agent-score/commerce/payment";

const x402 = await createX402Server({
  facilitator: "coinbase",  // or "http", or pass a custom facilitator instance
  rails: ["x402-base-mainnet", "x402-solana-mainnet", "x402-base-mainnet-upto"],
});

const mppx = await createMppxServer({
  rails: {
    tempo: { recipient: process.env.TEMPO_RECIPIENT! },
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
  x402_solana: { recipient: SOL_ADDR },
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
  pricing: { subtotal: "10.00", tax: "0.80", tax_rate: 0.08, tax_state: "CA", total: "10.80" },
  amountUsd: "10.80",
  retryBody: body,
});
```

### Stripe multichain (peer dep on `stripe`)

```typescript
import {
  createMultichainPaymentIntent,
  getDepositAddress,
  simulateCryptoDeposit,
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

// Testnet helper — simulates a deposit landing on the PI for end-to-end exercises
if (process.env.STRIPE_SECRET_KEY!.startsWith("sk_test_")) {
  await simulateCryptoDeposit({
    paymentIntentId: result.paymentIntentId,
    network: "base",
    stripeSecretKey: process.env.STRIPE_SECRET_KEY!,
  });
}
```

## Examples

The [examples/](./examples) directory has 6 runnable single-file Hono apps covering common merchant scenarios — copy-paste templates, not frameworks. See [examples/README.md](./examples/README.md) for the full table.

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
