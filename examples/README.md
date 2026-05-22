# `@agent-score/commerce` examples

Runnable, copy-pasteable example integrations covering the most common merchant scenarios. Each is a single-file Hono app you can adapt by swapping the relevant config.

| Example | Scenario | What it shows |
|---|---|---|
| [`api-provider.ts`](./api-provider.ts) | API provider (Exa-style) | Per-call billing on multiple rails: Tempo MPP + x402 Base + Solana MPP, all driven by `Checkout`. No identity gate, no compliance; pay-or-fail. Demos `Checkout(discoveryProbe: ...)` for x402-crawler auto-routing, `buildMerchantIndexJson` + `standardEndpointDescriptions({ kind: 'api' })` for `GET /` discovery, and `buildRedemptionSkillMd` with the trial-credit body shape on `GET /redemption.md`. |
| [`identity-only.ts`](./identity-only.ts) | Compliance gate without payment | Wraps any endpoint with KYC + age + jurisdiction checks; vendor handles their own payment |
| [`multi-rail-merchant.ts`](./multi-rail-merchant.ts) | Full agent-commerce merchant | Identity gate + Tempo MPP + x402 Base + Solana MPP + Stripe SPT, all rails accepted via `Checkout`. Demos `pricingResult` (cents → typed PricingResult), `Receipt` + `ReceiptNextSteps` + `buildSuccessNextSteps` in `onSettled`, per-order Stripe-multichain deposit minting via `mintRecipients`, and `simulateDepositIfTestMode` for Stripe testnet round-trips. |
| [`stripe-multichain-merchant.ts`](./stripe-multichain-merchant.ts) | Stripe-anchored multi-chain | Stripe PaymentIntent with deposit_options for tempo/base/solana; crypto deposits flow through Stripe. Read `result.depositAddresses[network]` directly. For low-margin endpoints (sub-dollar APIs), use `createPayToAddressFromStripePI` / `mintMultichainRecipients` with `staticRecipients: { solana }` — see the `/stripe-multichain` row in the main `README.md` for the full pattern and economics. |
| [`variable-cost-merchant.ts`](./variable-cost-merchant.ts) | Pay-per-actual-usage (LLM, transcode, etc.) | Same use case on **two protocols**: x402 upto (Permit2 authorize-max → Settlement-Overrides settle-actual) AND MPP tempo session (channel + SSE + mid-stream vouchers). Vendor offers both so agents pick whichever their wallet supports. Stays on lower-level helpers (`paymentDirective`, `wwwAuthenticateHeader`, `settlementOverrideHeader`) because variable-cost flows don't fit the one-shot `Checkout` model. |
| [`compliance-merchant.ts`](./compliance-merchant.ts) | Regulated-goods merchant (wine, cannabis, etc.) | Full compliance gate (KYC + sanctions + age + jurisdiction) + custom `onDenied` composing commerce helpers: `verificationAgentInstructions`, `isFixableDenial`, `buildContactSupportNextSteps`, `denialReasonToBody`/`denialReasonStatus`, `buildSignerMismatchBody`. Shows how vendors write only the business-specific branches and let commerce handle the rest. |
| [`per-product-policy-merchant.ts`](./per-product-policy-merchant.ts) | Multi-product merchant with mixed compliance needs | One product hard-gates KYC + 21 + US-state allowlist (wine), one is anonymous (merch, ships anywhere), a third uses `enforcement: 'soft'` to request KYC as a fraud signal but accept anonymous sales (stamps `identity_status: 'unverified'` on the order). Uses `PolicyBlock`, `buildGateOptionsFromPolicy`, `runGateWithEnforcement`, and the one-call `validateShippingAgainstPolicy`. |
| [`signed-ucp-merchant.ts`](./signed-ucp-merchant.ts) | Signed UCP profile + JWKS endpoint | One-call mount via `checkout.mountUcpRoutesHono(app, ...)` registers `/.well-known/ucp` + `/.well-known/jwks.json` + the OPTIONS preflights. AgentScore's `agentscore-profile+jws` is a vendor extension on top of UCP for trust-mode verifiers (regulated-commerce, AP2-aware) that opt into auditable profiles; UCP §6 itself does NOT mandate signing — production UCP merchants commonly ship unsigned. This example shows ephemeral-for-dev / env-JWK-for-prod and `bootstrapUcpSigningKey` lifespan-hook usage. |

## How to use

1. Pick the scenario closest to yours
2. Copy the file into your project
3. Install peer deps mentioned at the top of the file (only what you actually need)
4. Set the env vars listed at the top of the file
5. Run with `bun run <file>` or `node` (after build)
6. Iterate; these are templates, not frameworks

## Patterns

All examples follow the same rough shape:

1. **Boot:** instantiate framework, identity gate (if any), x402/mppx servers (if any) via commerce factories
2. **Discovery routes:** `/llms.txt` + `/.well-known/mpp.json` + `/openapi.json` (where applicable) using commerce/discovery helpers
3. **Per-request:** identity gate → validate body → 402 challenge (built via commerce/challenge helpers) → settle payment → return result

AgentScore Commerce keeps every step ~5–15 lines instead of ~50–150 lines. Vendors compose; the SDK wraps the protocol-correctness boilerplate.

## What stays vendor-specific

These examples are intentionally thin on domain logic. Vendors plug in their own:

- Catalog / product / pricing data
- Order storage (DB, durable queue, etc.)
- Customer email / fulfillment notifications
- Tax / shipping calculators
- Frontend UI (none of these examples include one; they're agent-only APIs)

AgentScore Commerce handles the agent commerce protocol layer; everything else is your business.
