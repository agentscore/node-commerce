# @agent-score/commerce

Agent commerce SDK for Node.js. The full merchant-side toolkit: identity gating + payment helpers + 402 builders + discovery + Stripe multichain. One install, subpath imports per concern.

Every helper is extracted from a real consumer, not speculated.

## Subpaths

| Subpath | What it is |
|---|---|
| `@agent-score/commerce` (top-level) | `Checkout` orchestrator (the 2.0 high-level surface) for fixed-price one-shot endpoints: one config object + hooks (preValidate, computePricing, mintRecipients, composeMppx, onSettled, gate), auto-derived x402+mppx servers, per-framework adapters `handleHono`/`handleExpress`/`handleFastify`/`handleNextjs`/`handleWeb`, signed UCP routes via `mountUcpRoutes{Hono,Express,Fastify}`, optional `discoveryProbe` config for x402-crawler auto-routing. Plus `computeFirstCheckout` — variable-cost pay-per-result helper (compute-first + exact-x402). Scope is exact-mode rails only (x402-exact Base, tempo/charge, solana/charge, Stripe SPT); does NOT use x402-upto (Permit2) or Settlement-Overrides — variable cost is captured by running the work pre-settle and emitting a 402 at the exact computed price. `createQuoteCache` — content-hash quote cache used by the compute-first helper (in-memory by default; pass `redisUrl` for distributed deployments). `createDefaultOnDenied` — canonical `onDenied(reason)` factory matching `Checkout`'s gate hook (handles `wallet_signer_mismatch`, `wallet_not_trusted` unfixable fallback, `payment_required`, `token_expired`/`invalid_credential`/`api_error`); merchants pass `merchantName` + `supportEmail` and override `walletNotTrustedMessage` / `paymentRequiredMessage` / `supportContext` for vendor-specific copy. `hasPaymentHeader` — discriminator that splits discovery legs (no payment credential → 402) from settle legs (`payment-signature` / `x-payment` / `Authorization: Payment <jwt>`); `hasX402Header` / `hasMppxHeader` — granular dispatch helpers (x402 vs MPP credential present) for routes that branch on rail. `defaultReadOnlyOnDenied(reason)` — canonical `onDenied` for read-only resource gates (`GET /orders/:id`): collapses every denial to 401 `unauthorized` + `Cache-Control: no-store` while still spreading `denialReasonToBody` so `agent_instructions` / `verify_url` ride through. `extractOwnerScope(headers) → { walletAddress?, operatorTokenHash? }` — pull canonical owner identity from `X-Wallet-Address` / `X-Operator-Token` with safe token hashing; pair with a wallet-or-token-scoped resource query so plaintext tokens never leave the request. Plus factories: `pricingResult` (cents → typed PricingResult with optional `decimals` for sub-cent precision), `validationResponse{Hono,Express,Fastify,Nextjs,Web}` (4xx envelope per framework) |
| `@agent-score/commerce/identity/{hono,express,fastify,nextjs,web}` | Trust gate middleware (KYC, age, sanctions, jurisdiction). Each adapter exports a `conditionalAgentscoreGate(options)` variant (Next.js / Web Fetch use the wrapper form `withConditionalAgentScoreGate(opts, handler)` / `createConditionalAgentScoreGate(opts) => guard(req)`) that fires only on settle legs — discovery legs (no payment credential) flow through and the handler emits a 402 with all rails. Adapters export ONLY framework-specific surface (gate fns, accessors, `captureWallet`); shared helpers like `hasPaymentHeader` / `denialReasonToBody` import from their canonical home (`@agent-score/commerce/payment` and `@agent-score/commerce` respectively). |
| `@agent-score/commerce/identity/policy` | Framework-agnostic per-product / per-tier compliance policy helpers: `PolicyBlock`, `buildGateFromPolicy`, `runGateWithEnforcement`, `shippingCountryAllowed`, `shippingStateAllowed`, `validateShippingAgainstPolicy` (one-call country+state validator that raises `CheckoutValidationError` with the canonical envelope on miss) |
| `@agent-score/commerce/payment` | Networks/USDC/rails registries, paymentauth.org directive builders, `createX402Server` (peer-dep `@x402/core` + `@coinbase/x402` for the Coinbase facilitator), `buildX402AcceptsFor402` (one-call helper for the 402-emit path: builds the requirements via the registered scheme so `extra.name` matches the on-chain USDC contract per network), `buildDefaultCheckoutRails({tempo?, x402Base?, solanaMpp?, stripe?})` (canonical 4-rail `rails` dict factory: merchants pass per-rail overrides instead of redeclaring the recipient sentinel + network/chainId/token boilerplate. When a caller overrides `network` without pinning `token` / `chainId`, the helper derives them from the network: Base Sepolia → Sepolia USDC + chainId 84532, Solana devnet → devnet USDC mint. Explicit overrides always win. Solana's `network` field accepts both CAIP-2 (`solana:5eykt4UsFv8…` / `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`) AND the raw `@solana/mpp` form (`mainnet-beta` / `devnet` / `localnet`)), `buildMppxComposeRails({amountUsd, tempoRecipient?, solanaRecipient?, ...})` (per-call intent factory replacing the hand-rolled `[['tempo/charge',{...}],['solana/charge',{...}],['stripe/charge',{...}]]` array; auto-handles USD→atomic conversion for Solana; auto-drops the `stripe/charge` rail with a one-time `console.warn` when `amountUsd < 0.50` since Stripe's fixed ~$0.30 fee makes sub-50-cent charges unprofitable — many Stripe accounts also reject PI creation below the floor with `amount_too_small`; sub-50-cent APIs pass `includeStripe: false` explicitly to silence the warning), `createMppxServer` (peer-dep `mppx`; the solana rail's `ataCreationRequired` defaults to `true` so Solana settles work zero-config on `@solana/mpp >= 0.6.0` — the SDK propagates it as a self-referential split so the validator's `allowedAtaOwners` accepts the configured recipient; opt out only when every recipient's ATA pre-exists out-of-band), `composeMppxRequest` (typed wrapper around `mppx.compose(...intents)(request)`; replaces the `(mppx as any).compose(...)` cast in custom `composeMppx` hooks), `mppxChallengeHeaders` (one-call extractor for the 402 path's `Object.fromEntries(challenge.headers)`), `processX402Settle` (verify+settle in one call), `isEvmNetwork`/`isSolanaNetwork` (CAIP-2 discriminators that hide the `startsWith('eip155:')` / `startsWith('solana:')` prefix matching), dispatch-by-network, signer extraction, WWW-Authenticate header, Settlement-Overrides header |
| `@agent-score/commerce/discovery` | Discovery probe middleware (`isDiscoveryProbeRequest`, `buildDiscoveryProbeResponse`), Bazaar wrapper, `/.well-known/mpp.json` builder, `llms.txt` builder, `skill.md` builder (Claude-Skill-compatible agent-discovery manifest), `buildRedemptionSkillMd` (delivery-neutral; printed/emailed/API-trial codes all covered via `deliveryIntro`/`bodyShape`/`bodyRules`/`extraRecoveryRows` overrides), `buildMerchantIndexJson` + `standardEndpointDescriptions({kind})` (canonical `/` discovery body for goods or API merchants), `buildSuccessNextSteps` (universal Passport-active success block), `buildAgentscoreOnboardingSteps`, OpenAPI snippets, `noindexNonDiscoveryPaths` Hono middleware. Plus the UCP/JWKS publish surface: `buildSignedUcpResponse`, `buildSignedJwksResponse`, `wellKnownPreflightResponse`, `defaultA2aServices`, `bootstrapUcpSigningKey`, framework-neutral `SignedDiscoveryResponse` + per-framework wrappers `signedResponse{Hono,Express,Fastify,Nextjs,Web}` |
| `@agent-score/commerce/challenge` | 402-body builders: accepted_methods, identity metadata (auto-attached by `Checkout` when wallet header present), how_to_pay, agent_instructions, build402Body, pricing, agent_memory, `buildValidationError` (4xx body builder), `Receipt` (canonical 200-receipt shape) |
| `@agent-score/commerce/stripe-multichain` | Multichain PaymentIntent helper (`createMultichainPaymentIntent` returns `{ paymentIntentId, depositAddresses }`; read `depositAddresses[network]` directly), `createPayToAddressFromStripePI({request, amountCents, stripe, piCache, networks?, staticRecipients?, metadata?, orderId?, preferredNetwork?})` — one-call per-order payTo resolver matching `Checkout.mintRecipients`: on the settle leg, reuses the buyer's signed-against payTo from the MPP credential (after `piCache.hasAddress` check OR a `staticRecipients` match — the static address is always-accepted because the merchant owns it); on the discovery leg, mints a fresh PI for the rails NOT covered by `staticRecipients`, caches the merged map, registers static addresses with `piCache.cacheAddress`. `mintMultichainRecipients({...same opts}) => { recipients, paymentIntentId?, reusedFromCredential }` — structured variant that returns the full per-rail map; prefer this when the merchant's `mintRecipients` hook needs all rail addresses (typical multi-rail merchant), and to avoid the "returned-string-is-ambiguous" trap on the settle leg when `staticRecipients` is configured (the bound recipient might be the solana static, not the tempo per-PI). Use `staticRecipients: { solana: '<wallet>' }` for low-margin endpoints where rotating per-PI Solana addresses can't absorb MPP spec §13.6's ~$0.50 ATA rent per call — the SDK skips Stripe minting on that network and reuses the static recipient forever; pair with a one-time external USDC pre-funding of the recipient's ATA and every settle pays only the per-tx fee. Testnet simulator (`simulateCryptoDeposit`, `simulateDepositIfTestMode`), `simulateDepositForOutcome({outcome, depositAddress, getPaymentIntentId, stripeSecretKey, stripeVersion?})` (dispatches the simulator based on a Checkout / computeFirstCheckout settle outcome; replaces the per-merchant rail-switch + thin `simulateDepositIfTestnet(addr, network)` wrapper), `networkForOutcome` (outcome → simulator network arg, handles both Checkout-shaped `railKey` and computeFirstCheckout-shaped `mppMethod`, accepts bare scheme names AND `<scheme>/charge` forms), `createPiCache`, `createMppxStripe` |
| `@agent-score/commerce/api` | Re-exports `AgentScore` + `AgentScoreError` from `@agent-score/sdk` |
| `@agent-score/commerce/middleware/{hono,express,fastify,nextjs,web}` | Framework-specific rate-limit middleware. Hono / Express / Fastify expose middleware factories (`rateLimitHono`, `rateLimitExpress`, `rateLimitFastify`); Next.js exposes `withRateLimit(opts, handler)`; Web Fetch exposes `createRateLimit(opts) => guard(req)`. Shared core: `windowSeconds` (default 60), `maxRequests` (default 60), `keyResolver` (default first hop of `x-forwarded-for`), `redisUrl` (optional; lazy-imports `ioredis` when set, falls back to in-memory `Map` otherwise). Mount globally with `app.use('*', rateLimitHono())` before any payment route. `ioredis` is an optional peer dep — merchants without Redis don't install it and get in-memory state per process. |

## Architecture

Single TypeScript package, tsup-built CJS + ESM with subpath exports. Per-framework identity adapters split by mounting style: hono/express/fastify expose the context-getter surface (`agentscoreGate(opts)` middleware + `getAgentScoreData(ctx)` / `getGateDegradedState(ctx)` / `getGateQuotaInfo(ctx)` / `getSignerVerdict(ctx)` accessors); nextjs/web expose the wrapper surface (`withAgentScoreGate(opts, handler)` / `createAgentScoreGate(opts) => guard(req)` which pass `data` + `degraded` + `infraReason` + `getSignerVerdict` directly on the handler arg / guard result). All five share `captureWallet` and network-aware address normalization (EVM lowercased, Solana base58 preserved verbatim). The gate middleware extracts the inbound payment signer pre-evaluate (`extractPaymentSigner`) and passes it to `/v1/assess` via the SDK's `signer` arg, so the API composes both wallet-binding (`signer_match`) and OFAC SDN wallet-address (`signer_sanctions`) verdicts on one round trip; merchants read both back synchronously via `getSignerVerdict(ctx)` off the gate's cache.

| Directory | Contents |
|---|---|
| `src/identity/` | Per-framework gate adapters (hono, express, fastify, nextjs, web). Each also exports the opt-in AIP gate (`aipGate` / `conditionalAipGate` / `getVerifiedAit`; nextjs/web use `createAipGate` / `withAipGate` / `withConditionalAipGate`) |
| `src/aip/` | AIP verifier: `verify.ts` (claim pipeline), `http-signature.ts` (RFC 9421 verify + sign), `jwks.ts` (issuer JWKS cache), `gate.ts` (problem+json errors), `request.ts`, `types.ts` (AIT claim contract) |
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
| `compute-first-merchant.ts` | Pay-per-result variable-cost merchant via the compute-first + exact-x402 helper (`computeFirstCheckout`). Exact-mode rails only (x402-exact Base, tempo/charge, solana/charge, Stripe SPT); deliberately scoped out of x402-upto (Permit2) and Settlement-Overrides. Probe runs the work + caches by body content-hash; settle replays the cached result at the computed exact price. Pairs with `rateLimitHono` since the probe leg runs work pre-payment. |
| `compliance-merchant.ts` | Regulated-goods merchant: full compliance gate + custom `onDenied` composing the denial helpers (`verificationAgentInstructions`, `isFixableDenial`, `buildContactSupportNextSteps`, `denialReasonToBody`/`denialReasonStatus`) |
| `per-product-policy-merchant.ts` | Multi-product merchant where each product carries its own compliance policy: wine has hard gate (KYC + 21 + state allowlist), tee has none (anonymous), limited print uses `enforcement: 'soft'` (request KYC, accept anonymous, stamp `identity_status: 'unverified'`). Demonstrates `PolicyBlock`, `buildGateFromPolicy`, `runGateWithEnforcement`, `shippingCountryAllowed`, `shippingStateAllowed`. |
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
    ...stripeSptPaymentHandler({ spec: { profileId: 'profile_...' } }),
  },
});
```

Each helper returns `{ [reverse-DNS-key]: [binding] }` so spreading composes the parent map. The handler `version`, spec URL, and schema URL are owned by the helpers (`src/identity/ucp.ts`) — bumping a handler spec version is a one-line change there. mpp + x402 share the same `networks: [{ network, recipient?, ...extras }]` config shape so consumers parse both identically. Recipient is optional — omit when the merchant uses per-order recipients (e.g. Stripe-derived deposit addresses); the authoritative recipient still ships in the 402 body.

## Identity model

Two header-based identity types: wallet (`X-Wallet-Address`) and operator-token (`X-Operator-Token`). Default checks operator-token first, then wallet. Address normalization is network-aware via `src/address.ts`: EVM lowercased, Solana base58 preserved verbatim. Used for cache keys, wallet→operator resolves, and signer-match comparisons.

A third, **opt-in** identity type is the Agent Identity Token (AIP): a JWT issued by a trusted issuer, bound to the agent's key via `cnf` (RFC 7800) and presented in an `Agent-Identity` header alongside an RFC 9421 HTTP Message Signature (proof-of-possession over `@method @authority @path agent-identity`). AIP engages only when the merchant opts in — `Checkout({ gate: { aip: { trustedIssuers } } })`, or the per-framework `aipGate` / `conditionalAipGate` adapters. With no `aip` config the `Agent-Identity` header is ignored and wallet/operator behavior is unchanged. When opted in, the gate verifies the token at the edge (issuer-JWKS signature + PoP) BEFORE `/v1/assess`, then sends the raw token as `aip_token` so the same policy evaluates against its attested claims; a verified AIT becomes the sole identity (wins over wallet/operator). A present-but-invalid AIT is a hard deny (no fall-through). **AgentScore's canonical issuer (`https://agentscore.sh`, exported as `AGENTSCORE_CANONICAL_ISSUER`) is always trusted** — `JwksCache` merges it itself, so every gate/adapter inherits it and `trustedIssuers` is optional + externals-only (a merchant can't fail to trust AgentScore AITs). `gate.aip` also accepts `issuerPolicies?: Record<issuer, AipIssuerPolicy>` — a per-issuer whole-policy REPLACEMENT (keyed by canonicalized `iss`): a verified AIT from a listed issuer is evaluated against that block instead of the gate defaults (e.g. relax a partner issuer to `{requireKyc, minAge:21}` while AgentScore AITs face the full policy). Plus `maxSkewSeconds` / `authority`. Per-adapter accessor: `getVerifiedAit(ctx)` (hono/express/fastify) returns the verified claims. See `src/aip/` and `examples/aip-merchant.ts`.

Denial reason codes: `missing_identity`, `identity_verification_required`, `token_expired`, `invalid_credential`, `wallet_signer_mismatch`, `wallet_auth_requires_wallet_signing`, `wallet_not_trusted`, `api_error`, `payment_required`. Each carries a structured `agent_instructions` JSON block describing concrete recovery actions. See `src/_response.ts` and `src/core.ts` for the canned action copy.

`createSessionOnMissing` auto-mints a verification session when no identity is present AND when `wallet_not_trusted` carries fixable reasons (`kyc_required` / `kyc_pending` / `kyc_failed`) — both paths rewrite the denial to `identity_verification_required` before reaching `onDenied`, so merchants only need to handle one code. When the merchant omits `createSessionOnMissing` from the gate config, `Checkout` auto-defaults it from `gate.apiKey` + `gate.baseUrl` + `gate.context` + `gate.merchantName` — every gated route gets the bootstrap UX out of the box. Merchants that need per-request session context or `onBeforeSession` side effects (goods merchants pre-minting an order_id) supply their own config to override.

`buildVerificationRequiredBody(reason, opts?)` — canonical body builder for the `identity_verification_required` denial. Spreads `verify_url` / `session_id` / `poll_secret` / `poll_url` / `agent_instructions` from the gate-minted reason into a 4xx envelope with merchant-specific `error.message` and (optionally) `agentInstructions` + `extra` overrides. Saves ~10 LOC of duplicated mapping per merchant.

`getSignerVerdict(ctx)` (per-adapter) returns the cached `signer_match` + `signer_sanctions` verdicts the gate composed on its primary `/v1/assess` call (single round trip; merchants build a 403 with `buildSignerMismatchBody({ result: verdict.signer_match })` when `kind !== 'pass'`).

Captured wallets: `captureWallet(ctx, { walletAddress, network, idempotencyKey })` is fire-and-forget; reads `operator_token` stashed during gating and POSTs to `/v1/credentials/wallets`. No-ops for wallet-authenticated requests.

Wallet-signer-match + signer-sanctions: the gate adapter calls `extractPaymentSigner(request, x402PaymentHeader)` pre-evaluate (covers x402 EIP-3009 `from`, Tempo MPP `did:pkh:eip155` source, Solana MPP `did:pkh:solana` source, plus a Solana `TransferChecked` authority fallback decoded from the credential's signed-tx payload via the optional `@solana/kit` peer) and passes `signer: { address, network }` to the SDK's `assess`. The API returns both `signer_match` (wallet-binding) and `signer_sanctions` (OFAC SDN wallet-address) on the same response; commerce caches both projected verdicts so `getSignerVerdict` is a pure cache read. **Wallet-OFAC SDN enforcement on the `signer` block is unconditional** whenever a signer is present — no `policy.require_sanctions_clear` opt-in required. An SDN hit (or `sanctions_check_unavailable`) flips `decision -> deny` and the gate returns 403 before the handler runs.

### Always-on wallet OFAC default for gateless merchants

Merchants who do NOT configure a `gate` on `Checkout` (or `computeFirstCheckout`) still get wallet OFAC SDN enforcement on every settle leg. The SDK resolves the API key from `process.env.AGENTSCORE_API_KEY` (or `gate.apiKey` if a partial gate config is present), reads `process.env.AGENTSCORE_BASE_URL` for staging/dev overrides, extracts the payment signer, and calls `/v1/assess` with the signer block. SDN hit → 403 with `wallet_not_trusted` + `decision_reasons: ['sanctions_flagged']`. No key → one-time `[checkout]` / `[<name>.computeFirst]` warning + skip (dev/testnet pattern; see `src/_warnings.ts`). Stripe SPT (no extractable wallet signer) skips silently — Stripe runs its own OFAC screen at customer creation. `hasIdentityGate()` detects identity-bearing flags (`requireKyc`, `requireSanctionsClear`, `minAge`, `allowed/blockedJurisdictions`); when none are set, the 402 body omits `agent_memory` and per-rail commands strip the `-H 'X-Operator-Token: ...'` flag (gateless merchants have no operator to identify). Gate configured WITHOUT `apiKey` falls through to the wallet-OFAC-only path so the merchant gets the strict-liability floor instead of silently allowing.

### Fail-open (opt-in)

`failOpen: true` on `agentscoreGate({...})` flips infra-failure handling: 429 / 5xx / network-timeout return `{ kind: 'allow', degraded: true, infraReason: 'quota_exceeded' | 'api_error' | 'network_timeout' }` instead of throwing. Per-adapter `getGateDegradedState(c)` exposes the flag for merchant logging/alerting; `withAgentScoreGate` (Next.js / Web Fetch) propagates `degraded` + `infraReason` directly on the handler's `gate` arg. Default stays `failOpen: false`; regulated commerce should keep it. Compliance denials (sanctions, age, jurisdiction, signer-mismatch) still deny regardless of the flag.

### Mount posture: gate-first vs gate-conditional

`agentscoreGate(...)` returns a vanilla framework middleware. Mount it directly when the route is AgentScore-only (`app.use('/purchase', gate)` in Hono / Express, `dependencies=[Depends(gate)]` in FastAPI, etc.); every request runs identity + policy. To support **anonymous discovery by any spec-compliant x402 wallet** (Coinbase awal, Phantom, Solflare, ...), wrap the gate so it fires only when a payment credential is attached:

```ts
import { hasPaymentHeader } from '@agent-score/commerce/payment';

const _gate = agentscoreGate({ /* opts */ });
app.use('/purchase', async (c, next) => {
  if (!hasPaymentHeader(c.req.raw)) { await next(); return; }
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
