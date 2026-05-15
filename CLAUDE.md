# @agent-score/commerce

Agent commerce SDK for Node.js. The full merchant-side toolkit: identity gating + payment helpers + 402 builders + discovery + Stripe multichain. One install, subpath imports per concern.

Every helper is extracted from a real consumer, not speculated.

## Subpaths

| Subpath | What it is |
|---|---|
| `@agent-score/commerce` (top-level) | `Checkout` orchestrator (the 2.0 high-level surface): one config object + hooks (preValidate, computePricing, mintRecipients, composeMppx, onSettled, gate), auto-derived x402+mppx servers, per-framework adapters `handleHono`/`handleExpress`/`handleFastify`/`handleNextjs`/`handleWeb`, signed UCP routes via `mountUcpRoutes{Hono,Express,Fastify}`, optional `discoveryProbe` config for x402-crawler auto-routing. Plus factories: `pricingResult` (cents → typed PricingResult), `validationResponse{Hono,Express,Fastify,Nextjs,Web}` (4xx envelope per framework), `Receipt`/`ReceiptNextSteps`/`ProductInfo`/`ShippingAddress` (canonical 200-receipt shape — universal across goods + API merchants) |
| `@agent-score/commerce/identity/{hono,express,fastify,nextjs,web}` | Trust gate middleware (KYC, age, sanctions, jurisdiction) |
| `@agent-score/commerce/identity/policy` | Framework-agnostic per-product / per-tier compliance policy helpers: `PolicyBlock`, `buildGateOptionsFromPolicy`, `runGateWithEnforcement`, `shippingCountryAllowed`, `shippingStateAllowed`, `validateShippingAgainstPolicy` (one-call country+state validator that raises `CheckoutValidationError` with the canonical envelope on miss) |
| `@agent-score/commerce/payment` | Networks/USDC/rails registries, paymentauth.org directive builders, `createX402Server` (peer-dep `@x402/core` + `@coinbase/x402` for the Coinbase facilitator), `buildX402AcceptsFor402` (one-call helper for the 402-emit path: builds the requirements via the registered scheme so `extra.name` matches the on-chain USDC contract per network), `createMppxServer` (peer-dep `mppx`), `processX402Settle` (verify+settle in one call), dispatch-by-network, signer extraction, WWW-Authenticate header, Settlement-Overrides header |
| `@agent-score/commerce/discovery` | Discovery probe middleware (`isDiscoveryProbeRequest`, `buildDiscoveryProbeResponse`), Bazaar wrapper, `/.well-known/mpp.json` builder, `llms.txt` builder, `skill.md` builder (Claude-Skill-compatible agent-discovery manifest), `buildRedemptionSkillMd` (delivery-neutral; printed/emailed/API-trial codes all covered via `deliveryIntro`/`bodyShape`/`bodyRules`/`extraRecoveryRows` overrides), `buildMerchantIndexJson` + `standardEndpointDescriptions({kind})` (canonical `/` discovery body for goods or API merchants), `buildSuccessNextSteps` (universal Passport-active success block), `buildAgentscoreOnboardingSteps`, OpenAPI snippets, `noindexNonDiscoveryPaths` Hono middleware. Plus the UCP/JWKS publish surface: `buildSignedUcpResponse`, `buildSignedJwksResponse`, `wellKnownPreflightResponse`, `defaultA2aServices`, `bootstrapUcpSigningKey`, framework-neutral `SignedDiscoveryResponse` + per-framework wrappers `signedResponse{Hono,Express,Fastify,Nextjs,Web}` |
| `@agent-score/commerce/challenge` | 402-body builders: accepted_methods, identity metadata (auto-attached by `Checkout` when wallet header present), how_to_pay, agent_instructions, build402Body, pricing, agent_memory, `buildValidationError` (4xx body builder), `Receipt`/`ReceiptNextSteps`/`ProductInfo`/`ShippingAddress` (canonical 200-receipt shape) |
| `@agent-score/commerce/stripe-multichain` | Multichain PaymentIntent helper (`createMultichainPaymentIntent` returns `{ paymentIntentId, depositAddresses }`; read `depositAddresses[network]` directly), testnet simulator (`simulateCryptoDeposit`, `simulateDepositIfTestMode`), `createPiCache`, `createMppxStripe` |
| `@agent-score/commerce/api` | Re-exports `AgentScore` + `AgentScoreError` from `@agent-score/sdk` |

## Architecture

Single TypeScript package, tsup-built CJS + ESM with subpath exports. Per-framework identity adapters split by mounting style: hono/express/fastify expose the context-getter surface (`agentscoreGate(opts)` middleware + `getAgentScoreData(ctx)` / `getGateDegradedState(ctx)` / `getGateQuotaInfo(ctx)` / `getSignerVerdict(ctx)` accessors); nextjs/web expose the wrapper surface (`withAgentScoreGate(opts, handler)` / `createAgentScoreGate(opts) => guard(req)` which pass `data` + `degraded` + `infraReason` + `getSignerVerdict` directly on the handler arg / guard result). All five share `captureWallet` and network-aware address normalization (EVM lowercased, Solana base58 preserved verbatim). The gate middleware extracts the inbound payment signer pre-evaluate (`extractPaymentSigner`) and passes it to `/v1/assess` via the SDK's `signer` arg, so the API composes both wallet-binding (`signer_match`) and OFAC SDN wallet-address (`signer_sanctions`) verdicts on one round trip; merchants read both back synchronously via `getSignerVerdict(ctx)` off the gate's cache.

| Directory | Contents |
|---|---|
| `src/identity/` | Per-framework gate adapters (hono, express, fastify, nextjs, web) |
| `src/core.ts` | Shared assess/session/cache/captureWallet (framework-agnostic) |
| `src/payment/` | Payment-protocol helpers (`networks.ts`, `usdc.ts`, `rails.ts`, `directive.ts`, `dispatch.ts`, `signer.ts`, `wwwauthenticate.ts`, `settlement_override.ts`, `x402.ts`, `x402_server.ts`, `mppx_server.ts`) |
| `src/discovery/` | Probe + Bazaar + `/.well-known/mpp.json` + `llms.txt` + `skill.md` + OpenAPI |
| `src/challenge/` | 402-body builders |
| `src/stripe-multichain/` | Stripe multichain PaymentIntent helpers |
| `src/api/` | `AgentScore` re-export from sdk |
| `examples/` | Runnable single-file Hono apps for each common scenario |
| `tests/` | Vitest, one file per surface |

Peer-dep pattern: payment/x402/mppx/stripe modules `dynamic import` at runtime, so vendors install only what they use (`@x402/core`, `@x402/evm`, `@coinbase/x402`, `mppx`, `@solana/mpp`, `@solana/kit`, `stripe`). Missing peer dep throws a guiding error with the install command. x402 in this SDK is EVM-only; Solana SPL payments go through MPP `solana/charge` (`@solana/mpp/server`).

## Examples

`examples/` contains full single-file Hono apps for the most common merchant scenarios; copy-paste templates, not frameworks:

| Example | Scenario |
|---|---|
| `api-provider.ts` | Per-call API billing on multiple rails: Tempo MPP + x402 Base + Solana MPP; no compliance gate |
| `identity-only.ts` | Compliance gate without payment (vendor handles their own) |
| `multi-rail-merchant.ts` | Full agent-commerce: identity + Tempo MPP + x402 + Stripe SPT |
| `stripe-multichain-merchant.ts` | Stripe-anchored multichain (PaymentIntent → tempo/base/solana deposit addresses) |
| `variable-cost-merchant.ts` | Pay-per-actual-usage on **two protocols**: x402 upto (Permit2 + Settlement-Overrides) AND MPP tempo session (channel + SSE + mid-stream vouchers) |
| `compliance-merchant.ts` | Regulated-goods merchant: full compliance gate + custom `onDenied` composing the denial helpers (`verificationAgentInstructions`, `isFixableDenial`, `buildSignerMismatchBody`, `buildContactSupportNextSteps`, `denialReasonToBody`/`denialReasonStatus`) |
| `per-product-policy-merchant.ts` | Multi-product merchant where each product carries its own compliance policy: wine has hard gate (KYC + 21 + state allowlist), tee has none (anonymous), limited print uses `enforcement: 'soft'` (request KYC, accept anonymous, stamp `identity_status: 'unverified'`). Demonstrates `PolicyBlock`, `buildGateOptionsFromPolicy`, `runGateWithEnforcement`, `shippingCountryAllowed`, `shippingStateAllowed`. |
| `signed-ucp-merchant.ts` | Signed UCP profile (`/.well-known/ucp`) + JWKS endpoint (`/.well-known/jwks.json`). AgentScore's `agentscore-profile+jws` is a vendor extension on top of UCP for trust-mode verifiers (regulated-commerce, AP2-aware) that opt into auditable cryptographic provenance — UCP §6 itself does NOT mandate signing; production UCP merchants commonly ship unsigned. Wires ephemeral-for-dev / env-JWK-for-prod signing, kid rotation, and `Cache-Control` posture. Uses `generateUCPSigningKey`, `signUCPProfile`, `buildJWKSResponse`, `UCPSigningKey.fromJWK`, `UCPVerificationError`. Demonstrates the payment-handler builders (`mppPaymentHandler`, `x402PaymentHandler`, `stripeSptPaymentHandler` — see "Payment-handler builders" below). |

## Payment-handler builders

The SDK ships protocol-rooted builders for the AgentScore-published payment handlers — vendors compose UCP `payment_handlers` blocks by spreading these helpers instead of hand-writing the verbose binding wrapper:

```ts
import { buildUCPProfile, mppPaymentHandler, x402PaymentHandler, stripeSptPaymentHandler } from '@agent-score/commerce';

buildUCPProfile({
  ...,
  payment_handlers: {
    ...mppPaymentHandler({ networks: [{ network: 'tempo-mainnet', chain_id: 4217, recipient: '0x...' }] }),
    ...x402PaymentHandler({ networks: [{ network: 'base-8453', recipient: '0x...' }] }),
    ...stripeSptPaymentHandler({ profile_id: 'profile_...' }),
  },
});
```

Each helper returns `{ [reverse-DNS-key]: [binding] }` so spreading composes the parent map. The handler `version`, spec URL, and schema URL are owned by the helpers (`src/identity/ucp.ts`) — bumping a handler spec version is a one-line change there. mpp + x402 share the same `networks: [{ network, recipient?, ...extras }]` config shape so consumers parse both identically. Recipient is optional — omit when the merchant uses per-order recipients (e.g. Stripe-derived deposit addresses); the authoritative recipient still ships in the 402 body.

## Identity model

Two identity types: wallet (`X-Wallet-Address`) and operator-token (`X-Operator-Token`). Default checks operator-token first, then wallet. Address normalization is network-aware via `src/identity/address.ts`: EVM lowercased, Solana base58 preserved verbatim. Used for cache keys, wallet→operator resolves, and signer-match comparisons.

Denial reason codes: `missing_identity`, `identity_verification_required`, `token_expired`, `invalid_credential`, `wallet_signer_mismatch`, `wallet_auth_requires_wallet_signing`, `wallet_not_trusted`, `api_error`, `payment_required`. Each carries a structured `agent_instructions` JSON block describing concrete recovery actions. See `src/identity/_response.ts` and `src/core.ts` for the canned action copy.

`createSessionOnMissing` auto-mints a verification session when no identity is present and returns 403 with `verify_url` + poll instructions instead of a bare denial. `getSignerVerdict(ctx)` (per-adapter) returns the cached `signer_match` + `signer_sanctions` verdicts the gate composed on its primary `/v1/assess` call (single round trip; merchants build a 403 with `buildSignerMismatchBody({ result: verdict.signer_match })` when `kind !== 'pass'`).

Captured wallets: `captureWallet(ctx, { walletAddress, network, idempotencyKey })` is fire-and-forget; reads `operator_token` stashed during gating and POSTs to `/v1/credentials/wallets`. No-ops for wallet-authenticated requests.

Wallet-signer-match + signer-sanctions: the gate adapter calls `extractPaymentSigner(request, x402PaymentHeader)` pre-evaluate (covers x402 EIP-3009 `from`, Tempo MPP `did:pkh:eip155` source, Solana MPP `did:pkh:solana` source, plus a Solana `TransferChecked` authority fallback decoded from the credential's signed-tx payload via the optional `@solana/kit` peer) and passes `signer: { address, network }` to the SDK's `assess`. The API returns both `signer_match` (wallet-binding) and `signer_sanctions` (OFAC SDN wallet-address) on the same response; commerce caches both projected verdicts so `getSignerVerdict` is a pure cache read. Under `policy.require_sanctions_clear`, an OFAC SDN signer hit already flips `decision -> deny` before the handler runs.

### Fail-open (opt-in)

`failOpen: true` on `agentscoreGate({...})` flips infra-failure handling: 429 / 5xx / network-timeout return `{ kind: 'allow', degraded: true, infraReason: 'quota_exceeded' | 'api_error' | 'network_timeout' }` instead of throwing. Per-adapter `getGateDegradedState(c)` exposes the flag for merchant logging/alerting; `withAgentScoreGate` (Next.js / Web Fetch) propagates `degraded` + `infraReason` directly on the handler's `gate` arg. Default stays `failOpen: false`; regulated commerce should keep it. Compliance denials (sanctions, age, jurisdiction, signer-mismatch) still deny regardless of the flag.

### Mount posture: gate-first vs gate-conditional

`agentscoreGate(...)` returns a vanilla framework middleware. Mount it directly when the route is AgentScore-only (`app.use('/purchase', gate)` in Hono / Express, `dependencies=[Depends(gate)]` in FastAPI, etc.); every request runs identity + policy. To support **anonymous discovery by any spec-compliant x402 wallet** (Coinbase awal, Phantom, Solflare, ...), wrap the gate so it fires only when a payment credential is attached:

```ts
const _gate = agentscoreGate({ /* opts */ });
app.use('/purchase', async (c, next) => {
  const hasPaymentHeader = Boolean(
    c.req.header('payment-signature') ||
    c.req.header('x-payment') ||
    c.req.header('authorization')?.startsWith('Payment '),
  );
  if (!hasPaymentHeader) { await next(); return; }
  return _gate(c, next);
});
```

Anonymous POST flows through to the handler unauthenticated and gets a 402 with all rails + per-order pricing. Identity is verified at settle time on the retry leg (when the agent submits `X-Payment` / `Authorization: Payment`); `createSessionOnMissing` still auto-mints a verification session there. The same wrap pattern works identically across all 5 framework adapters (hono, express, fastify, nextjs, web). See `examples/multi-rail-merchant.ts` and `examples/compliance-merchant.ts`.

### `compatible_clients` field on emitted 402s

`buildAgentInstructions` emits a `compatible_clients` field in the 402 body, derived automatically from `howToPay`: per-rail list of CLIs the AgentScore team has smoke-verified end-to-end. Vendors override with `buildAgentInstructions({ howToPay, compatibleClients: {...} })` to add their own tested clients. Set to an empty object `{}` to suppress the default. Same data is published as `core/docs/integrations/x402-clients.mdx` for human-side rationale + per-rail commands.

## Tooling

- **Bun**: package manager.
- **ESLint 9**: linting.
- **tsup**: CJS + ESM build with subpath exports.
- **Vitest**: tests.
- **Lefthook**: pre-commit lint, pre-push typecheck.

```bash
bun install
bun run lint
bun run typecheck
bun run test
bun run build
```

## Dev: linked sdk

During local development the sdk dep is `link:@agent-score/sdk`. Run `bun link` in `agentscore/node-sdk` and `bun link @agent-score/sdk` here.

## Workflow

1. Create a branch
2. Make changes
3. Lefthook runs lint on commit, typecheck on push
4. Open a PR; CI runs automatically
5. Merge (squash)

## Rules

- **No silent refactors**
- **Never commit .env files or secrets**
- **Use PRs**: never push directly to main
- **Helpers are protocol translations + configurable opinions, not opinionated frameworks**: vendor variation is config, not API redesign
- **Extract from real consumers**: every helper lifts from working production code

## Releasing

1. Update `version` in `package.json`
2. Commit: `git commit -am "chore: bump to vX.Y.Z"`
3. Tag: `git tag vX.Y.Z`
4. Push: `git push && git push origin vX.Y.Z`

The publish workflow runs on `ubuntu-latest` (required for npm trusted publishing), builds, publishes to npm with provenance, and creates a GitHub Release.

npm scope is `@agent-score`. User-Agent header uses `@agentscore` (brand name).
