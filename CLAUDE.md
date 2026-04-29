# @agent-score/commerce

Agent commerce SDK for Node.js. The full merchant-side toolkit: identity gating + payment helpers + 402 builders + discovery + Stripe multichain. One install, subpath imports per concern.

Every helper lifts directly from working production code (`agentscore/martin-estate`) — extract from real consumers, not speculation.

## Subpaths

| Subpath | What it is |
|---|---|
| `@agent-score/commerce/identity/{hono,express,fastify,nextjs,web}` | Trust gate middleware (KYC, age, sanctions, jurisdiction) |
| `@agent-score/commerce/payment` | Networks/USDC/rails registries, paymentauth.org directive builders, x402 server factory + scheme dual-register, MPP server factory, dispatch-by-network, signer extraction, WWW-Authenticate header, Settlement-Overrides header |
| `@agent-score/commerce/discovery` | Discovery probe middleware, Bazaar wrapper, `/.well-known/mpp.json` builder, `llms.txt` builder, OpenAPI snippets |
| `@agent-score/commerce/challenge` | 402-body builders: accepted_methods, identity metadata, how_to_pay, agent_instructions, build402Body |
| `@agent-score/commerce/stripe-multichain` | Multichain PaymentIntent helper, deposit-address lookup, testnet simulator, mppx Stripe wrapper |
| `@agent-score/commerce/api` | Re-exports `AgentScore` + `AgentScoreError` from `@agent-score/sdk` |

## Architecture

Single TypeScript package, tsup-built CJS + ESM with subpath exports. Per-framework identity adapters expose the same surface — `agentscoreGate`, `captureWallet`, `getAgentScoreData`, `verifyWalletSignerMatch` — with network-aware address normalization (EVM lowercased, Solana base58 preserved verbatim).

| Directory | Contents |
|---|---|
| `src/identity/` | Per-framework gate adapters (hono, express, fastify, nextjs, web) |
| `src/core.ts` | Shared assess/session/cache/captureWallet (framework-agnostic) |
| `src/payment/` | Payment-protocol helpers (`networks.ts`, `usdc.ts`, `rails.ts`, `directive.ts`, `dispatch.ts`, `signer.ts`, `wwwauthenticate.ts`, `settlement_override.ts`, `x402.ts`, `x402_server.ts`, `mppx_server.ts`) |
| `src/discovery/` | Probe + Bazaar + `/.well-known/mpp.json` + `llms.txt` + OpenAPI |
| `src/challenge/` | 402-body builders |
| `src/stripe-multichain/` | Stripe multichain PaymentIntent helpers |
| `src/api/` | `AgentScore` re-export from sdk |
| `examples/` | Runnable single-file Hono apps for each common scenario |
| `tests/` | Vitest, one file per surface, ~360+ tests |

Peer-dep pattern: payment/x402/mppx/stripe modules `dynamic import` at runtime — vendors install only what they use (`@x402/core`, `@x402/evm`, `@x402/svm`, `@coinbase/x402`, `mppx`, `stripe`). Missing peer dep throws a guiding error with the install command.

## Examples

`examples/` contains full single-file Hono apps for the most common merchant scenarios — copy-paste templates, not frameworks:

| Example | Scenario |
|---|---|
| `api-provider.ts` | Per-call API billing on multiple rails: Tempo MPP + x402 (Base + Solana); no compliance gate |
| `identity-only.ts` | Compliance gate without payment (vendor handles their own) |
| `multi-rail-merchant.ts` | Full agent-commerce: identity + Tempo MPP + x402 + Stripe SPT |
| `stripe-multichain-merchant.ts` | Stripe-anchored multichain (PaymentIntent → tempo/base/solana deposit addresses) |
| `variable-cost-merchant.ts` | Pay-per-actual-usage on **two protocols**: x402 upto (Permit2 + Settlement-Overrides) AND MPP tempo session (channel + SSE + mid-stream vouchers) |
| `compliance-merchant.ts` | Regulated-goods merchant — full compliance gate + custom `onDenied` composing the denial helpers (`verificationAgentInstructions`, `isFixableDenial`, `buildSignerMismatchBody`, `buildContactSupportNextSteps`, `denialReasonToBody`/`denialReasonStatus`) |

## Identity model

Two identity types: wallet (`X-Wallet-Address`) and operator-token (`X-Operator-Token`). Default checks operator-token first, then wallet. Address normalization is network-aware via `src/identity/address.ts`: EVM lowercased, Solana base58 preserved verbatim — used for cache keys, wallet→operator resolves, and signer-match comparisons.

Denial reason codes: `missing_identity`, `identity_verification_required`, `token_expired`, `invalid_credential`, `wallet_signer_mismatch`, `wallet_auth_requires_wallet_signing`, `wallet_not_trusted`, `api_error`, `payment_required`. Each carries a structured `agent_instructions` JSON block describing concrete recovery actions. See `src/identity/_response.ts` and `src/core.ts` for the canned action copy.

`createSessionOnMissing` auto-mints a verification session when no identity is present and returns 403 with `verify_url` + poll instructions instead of a bare denial. `verifyWalletSignerMatch` (per-adapter) recovers the signer from MPP/x402 credentials and compares against `linked_wallets[]` for cross-chain wallet-stack matching.

Captured wallets: `captureWallet(ctx, { walletAddress, network, idempotencyKey })` is fire-and-forget — reads `operator_token` stashed during gating and POSTs to `/v1/credentials/wallets`. No-ops for wallet-authenticated requests.

### Mount posture: gate-first vs gate-conditional

`agentscoreGate(...)` returns a vanilla framework middleware. Mount it directly when the route is AgentScore-only (`app.use('/purchase', gate)` in Hono / Express, `dependencies=[Depends(gate)]` in FastAPI, etc.) — every request runs identity + policy. To support **anonymous discovery by any spec-compliant x402 wallet** (Coinbase awal, Phantom, Solflare, …), wrap the gate so it fires only when a payment credential is attached:

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

Anonymous POST flows through to the handler unauthenticated and gets a 402 with all rails + per-order pricing. Identity is verified at settle time on the retry leg (when the agent submits `X-Payment` / `Authorization: Payment`); `createSessionOnMissing` still auto-mints a verification session there. The same wrap pattern works identically across all 5 framework adapters (hono, express, fastify, nextjs, web). martin-estate runs this pattern in production. See `examples/multi-rail-merchant.ts` and `examples/compliance-merchant.ts`.

## Tooling

- **Bun** — package manager.
- **ESLint 9** — linting.
- **tsup** — CJS + ESM build with subpath exports.
- **Vitest** — tests.
- **Lefthook** — pre-commit lint, pre-push typecheck.

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
4. Open a PR — CI runs automatically
5. Merge (squash)

## Rules

- **No silent refactors**
- **Never commit .env files or secrets**
- **Use PRs** — never push directly to main
- **Helpers are protocol translations + configurable opinions, not opinionated frameworks** — vendor variation is config, not API redesign
- **Extract from real consumers** — every helper lifts from working production code

## Releasing

1. Update `version` in `package.json`
2. Commit: `git commit -am "chore: bump to vX.Y.Z"`
3. Tag: `git tag vX.Y.Z`
4. Push: `git push && git push origin vX.Y.Z`

The publish workflow runs on `ubuntu-latest` (required for npm trusted publishing), builds, publishes to npm with provenance, and creates a GitHub Release.

npm scope is `@agent-score`. User-Agent header uses `@agentscore` (brand name).
