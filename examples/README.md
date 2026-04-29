# `@agent-score/commerce` examples

Runnable, copy-pasteable example integrations covering the most common merchant scenarios. Each is a single-file Hono app you can adapt by swapping the relevant config.

| Example | Scenario | What it shows |
|---|---|---|
| [`api-provider.ts`](./api-provider.ts) | API provider (Exa-style) | Per-call billing on multiple rails: Tempo MPP + x402 (Base + Solana). No identity gate, no compliance — pay-or-fail. |
| [`identity-only.ts`](./identity-only.ts) | Compliance gate without payment | Wraps any endpoint with KYC + age + jurisdiction checks; vendor handles their own payment |
| [`multi-rail-merchant.ts`](./multi-rail-merchant.ts) | Full agent-commerce merchant | Identity gate + Tempo MPP + x402 Base + x402 Solana + Stripe SPT, all rails accepted, full 402 builder |
| [`stripe-multichain-merchant.ts`](./stripe-multichain-merchant.ts) | Stripe-anchored multi-chain | Stripe PaymentIntent with deposit_options for tempo/base/solana; crypto deposits flow through Stripe |
| [`variable-cost-merchant.ts`](./variable-cost-merchant.ts) | Pay-per-actual-usage (LLM, transcode, etc.) | Same use case on **two protocols**: x402 upto (Permit2 authorize-max → Settlement-Overrides settle-actual) AND MPP tempo session (channel + SSE + mid-stream vouchers). Vendor offers both so agents pick whichever their wallet supports. |
| [`compliance-merchant.ts`](./compliance-merchant.ts) | Regulated-goods merchant (wine, cannabis, etc.) | Full compliance gate (KYC + sanctions + age + jurisdiction) + custom `onDenied` composing commerce helpers: `verificationAgentInstructions`, `isFixableDenial`, `buildContactSupportNextSteps`, `denialReasonToBody`/`denialReasonStatus`, `buildSignerMismatchBody`. Shows how vendors write only the business-specific branches and let commerce handle the rest. |
| [`per-product-policy-merchant.ts`](./per-product-policy-merchant.ts) | Multi-product merchant with mixed compliance needs | One product hard-gates KYC + 21 + US-state allowlist (wine), one is anonymous (merch, ships anywhere), a third uses `enforcement: 'soft'` to request KYC as a fraud signal but accept anonymous sales — stamps `identity_status: 'unverified'` on the order. Uses `PolicyBlock`, `policyToGateOptions`, `runGateWithEnforcement`, `shippingCountryAllowed`, `shippingStateAllowed`. |

## How to use

1. Pick the scenario closest to yours
2. Copy the file into your project
3. Install peer deps mentioned at the top of the file (only what you actually need)
4. Set the env vars listed at the top of the file
5. Run with `bun run <file>` or `node` (after build)
6. Iterate — these are templates, not frameworks

## Patterns

All six examples follow the same rough shape:

1. **Boot:** instantiate framework, identity gate (if any), x402/mppx servers (if any) via commerce factories
2. **Discovery routes:** `/llms.txt` + `/.well-known/mpp.json` + `/openapi.json` (where applicable) using commerce/discovery helpers
3. **Per-request:** identity gate → validate body → 402 challenge (built via commerce/challenge helpers) → settle payment → return result

The commerce SDK keeps every step ~5-15 lines instead of ~50-150 lines. Vendors compose; commerce wraps the protocol-correctness boilerplate.

## What stays vendor-specific

These examples are intentionally thin on domain logic. Vendors plug in their own:

- Catalog / product / pricing data
- Order storage (DB, durable queue, etc.)
- Customer email / fulfillment notifications
- Tax / shipping calculators
- Frontend UI (none of these examples include one — they're agent-only APIs)

Commerce handles the agent commerce protocol layer; everything else is your business.
