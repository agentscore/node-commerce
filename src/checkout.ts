/**
 * High-level Checkout orchestrator — composes 402-emit + verify+settle.
 *
 * The Checkout primitive collapses the agent-commerce dance (emit 402 →
 * verify+settle on retry → respond) into a single `await checkout.handle(request)`
 * call. It services every merchant shape:
 *
 * - **Goods sellers** wire inventory hooks (`onSettled` persists the order;
 *   `mintRecipients` mints per-order Stripe-multichain addresses).
 * - **API sellers** wire per-call billing (`computePricing` returns a fixed
 *   amount; `onSettled` returns the inline API response body).
 * - **Self-custody-only merchants** configure chain rails (Tempo / Base / Solana)
 *   via `X402BaseRailSpec` / `TempoRailSpec` / `SolanaMppRailSpec`.
 * - **Custodial-only merchants** configure `StripeRailSpec` and skip the chain
 *   rails — Stripe SPT settles via the same `composeMppx` hook.
 * - **Multi-rail merchants** configure all of the above; the agent picks the rail.
 *
 * Three flexibility axes — every combination is supported:
 *
 * - **x402 only / MPP only / both** — Checkout works with `x402Server` alone,
 *   `composeMppx` alone, or both. Whichever payment header arrives is dispatched
 *   to the configured handler; the other path is simply absent.
 * - **Self-custody / Stripe / mixed** — rails dict is the single source of truth.
 *   Listing `StripeRailSpec` makes Stripe SPT an acceptable rail; omitting it
 *   makes the merchant chain-only. Mixing freely is the default.
 * - **Gated / ungated identity** — `CheckoutRequest.assess` is optional. Merchants
 *   who run AgentScoreGate upstream pass its result through; merchants running
 *   anonymous leave it `null`.
 *
 * Domain-neutral by design: every per-request value is keyed by `referenceId`
 * (a UUID minted on first contact). Goods merchants persist this as their order
 * id; API merchants treat it as a per-call request id.
 */

import { randomUUID } from 'node:crypto';
import { normalizeHeadersToLowercase } from './_headers';
import { extractMppxReceiptHeaderFromRaw, extractMppxReceiptMethod } from './_mppx_receipt';
import { denialReasonToBody } from './_response';
import { warnMissingApiKeyOnce } from './_warnings';
import { buildAipErrorBody, buildAipPolicyDenyBody, buildAipWeakAuthBody, checkTrustRequirements, verifyAitParts } from './aip/gate';
import { AGENTSCORE_CANONICAL_ISSUER, canonicalizeIssuer, JwksCache } from './aip/jwks';
import { hasAgentIdentityHeaderNode } from './aip/request';
import { buildAcceptedMethods } from './challenge/accepted_methods';
import { type RailKey, buildAgentInstructions } from './challenge/agent_instructions';
import { firstEncounterAgentMemory } from './challenge/agent_memory';
import { build402Body, type X402ResourceInfo } from './challenge/body';
import { buildHowToPay } from './challenge/how_to_pay';
import { type IdentityMetadataBlock, buildIdentityMetadata } from './challenge/identity';
import { buildPricingBlock, type PricingBlock } from './challenge/pricing';
import { respond402 } from './challenge/respond_402';
import { buildValidationError } from './challenge/validation_error';
import {
  type AgentIdentity,
  type AgentScoreCoreOptions,
  type CreateSessionOnMissing,
  type DenialReason,
  type EvaluateOutcome,
  createAgentScoreCore,
} from './core';
import { enrichBazaarDiscoveryExtensions } from './discovery/bazaar';
import { CheckoutValidationError } from './errors';
import { applyForwardedProto, readForwardedProto } from './forwarded_proto';
import { STRIPE_MIN_CHARGE_USD } from './payment/constants';
import { lazyMppxServer, lazyX402Server } from './payment/lazy';
import { classifyMppxFailure } from './payment/mppx_failures';
import { runWithMppxFailureCapture, type MppxRailSpec } from './payment/mppx_server';
import { isEvmNetwork, isSolanaNetwork } from './payment/network_kind';
import { hasMppxHeader, hasX402Header } from './payment/payment_header';
import {
  resolveRecipient,
  type RecipientLike,
  type SolanaMppRailSpec,
  type StripeRailSpec,
  type TempoRailSpec,
  type TempoSessionRailSpec,
  type X402BaseRailSpec,
} from './payment/rail_spec';
import { buildX402AcceptsFor402, type X402Server } from './payment/x402_server';
import { classifyX402SettleResult, processX402Settle } from './payment/x402_settle';
import { verifyX402Request } from './payment/x402_validation';
import { zeroAmountCarveOut, type ZeroSettleRail } from './payment/zero-settle';
import { extractPaymentSignerFromAuth } from './signer';
import type { TrustLevel } from './aip/types';
import type { SignedDiscoveryResponse } from './discovery/well_known';


export type CheckoutRailSpec =
  | TempoRailSpec
  | X402BaseRailSpec
  | SolanaMppRailSpec
  | StripeRailSpec
  | TempoSessionRailSpec;

/**
 * Framework-neutral HTTP request input to `Checkout.handle`.
 *
 * Merchants build this from their framework's request object once; the
 * Checkout layer then runs the same flow regardless of Hono / Express / Next /
 * Fastify / raw Web Fetch.
 */
export interface CheckoutRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Parsed JSON body. For non-JSON endpoints, pass `{}` and stash the raw bytes elsewhere. */
  body: Record<string, unknown>;
  /** Optional assess block from the gate (operator/wallet identity, signer verdicts).
   *
   *  When present, hooks can branch on identity (e.g. KYC-only pricing). When absent,
   *  the merchant is either running pre-gate (anonymous discovery) or chose to skip
   *  the gate for this endpoint. */
  assess?: Record<string, unknown> | null;
  /** Optional escape hatch for the framework's native request object. Pass when
   *  your `composeMppx` hook needs to call `mppx.compose(...)(rawRequest)` — mppx's
   *  compose binds to the raw HTTP request, so the orchestrator forwards this
   *  through unchanged. */
  raw?: unknown;
}

/** Output of `Checkout.computePricing` — per-request pricing. */
export interface PricingResult {
  /** Total to charge in USD (or the upper bound, for `mode: 'upto'` rails). */
  amountUsd: number;
  currency?: string;
  /** Optional pre-built `PricingBlock`. When omitted, Checkout builds a minimal
   *  block from `amountUsd` so the 402 body always carries pricing metadata. */
  block?: PricingBlock;
  /** Dollar-precision used to format `amountUsd` and the derived `PricingBlock`
   *  fields. Default `2` (canonical USD cents). Raise for sub-cent unit pricing
   *  (per-token LLM, per-byte storage, etc.) so the 402 body advertises the
   *  real amount instead of rounding to two decimals. */
  decimals?: number;
  /** Optional product block surfaced in the 402 body's `product` field. Goods
   *  merchants populate `{id, name, slug, list_price_usd, ...}`; API sellers leave
   *  this absent since per-call billing has no product concept. */
  product?: Record<string, string>;
  /** Optional merchant-specific fields merged into the 402 body alongside the
   *  standard `accepted_methods` / `agent_instructions` / `pricing` blocks.
   *  Useful for `redemption_code_applied`, coupon hints, or any other field the
   *  merchant wants the agent to see in the challenge body. */
  bodyExtras?: Record<string, unknown>;
}

/**
 * Build a {@link PricingResult} from cents-denominated inputs.
 *
 * Saves the `{ amountUsd: ..., block: buildPricingBlock({...}) }` dance every
 * US-commerce merchant repeats. When `subtotalCents` is set:
 *
 * - `subtotalCents` is the list price (pre-discount). `discountCents` is the
 *   deduction applied (redemption code / coupon / promo).
 * - `amountUsd` is derived from `(subtotal + tax + shipping - discount) / 100`
 *   (floored at 0) unless explicitly provided.
 * - A {@link PricingBlock} is built via {@link buildPricingBlock} and attached
 *   to the result's `block` field. `discount` is surfaced as a dollar-string
 *   when `discountCents` is supplied.
 *
 * When `subtotalCents` is omitted, the function passes through to the raw
 * `PricingResult` shape; `amountUsd` is then required.
 *
 * Use this in `computePricing` hooks instead of hand-rolling:
 *
 * @example
 * computePricing: async (ctx) => pricingResult({
 *   subtotalCents: 25000,
 *   taxCents: 2000,
 *   taxRate: 0.08,
 *   taxState: 'CA',
 * }),
 *
 * @example
 * // Redemption-code applied (free order, agent sees the savings line):
 * computePricing: async (ctx) => pricingResult({
 *   subtotalCents: 7500,
 *   discountCents: 7500,
 * }),
 */
export function pricingResult(opts: {
  subtotalCents?: number;
  taxCents?: number;
  shippingCents?: number;
  discountCents?: number;
  taxRate?: number;
  taxState?: string;
  currency?: string;
  amountUsd?: number;
  /** Dollar-precision for `amountUsd` derivation and the embedded `PricingBlock`.
   *  Default `2` (canonical USD cents). Raise for sub-cent pricing. */
  decimals?: number;
  product?: Record<string, string>;
  bodyExtras?: Record<string, unknown>;
}): PricingResult {
  const currency = opts.currency ?? 'USD';
  if (opts.subtotalCents !== undefined) {
    const totalCents = Math.max(
      0,
      opts.subtotalCents + (opts.taxCents ?? 0) + (opts.shippingCents ?? 0) - (opts.discountCents ?? 0),
    );
    const derivedAmount = opts.amountUsd ?? totalCents / 100;
    const block = buildPricingBlock({
      subtotalCents: opts.subtotalCents,
      taxCents: opts.taxCents ?? 0,
      ...(opts.shippingCents !== undefined && { shippingCents: opts.shippingCents }),
      ...(opts.discountCents !== undefined && { discountCents: opts.discountCents }),
      ...(opts.taxRate !== undefined && { taxRate: opts.taxRate }),
      ...(opts.taxState !== undefined && { taxState: opts.taxState }),
      currency,
      ...(opts.decimals !== undefined && { decimals: opts.decimals }),
    });
    return {
      amountUsd: derivedAmount,
      currency,
      block,
      ...(opts.decimals !== undefined && { decimals: opts.decimals }),
      ...(opts.product !== undefined && { product: opts.product }),
      ...(opts.bodyExtras !== undefined && { bodyExtras: opts.bodyExtras }),
    };
  }
  if (opts.amountUsd === undefined) {
    throw new Error('pricingResult requires either `subtotalCents` or `amountUsd`.');
  }
  return {
    amountUsd: opts.amountUsd,
    currency,
    ...(opts.decimals !== undefined && { decimals: opts.decimals }),
    ...(opts.product !== undefined && { product: opts.product }),
    ...(opts.bodyExtras !== undefined && { bodyExtras: opts.bodyExtras }),
  };
}

/**
 * Per-route discovery-probe config. When passed to {@link Checkout}, any
 * empty-body POST without a payment credential short-circuits with a sample
 * 402 advertising the merchant's payment shape — the canonical pattern x402
 * crawlers rely on.
 */
export interface DiscoveryProbeConfig {
  realm: string;
  sampleRail: string;
  sampleAmountUsd: number;
  sampleRecipient: string;
  intent?: 'charge' | 'authorize' | 'session.open';
  ttlSeconds?: number;
  docsUrl?: string;
  message?: string;
  x402Sample?: {
    version?: 1 | 2;
    networks?: string[];
    accepts?: unknown[];
    amountAtomic?: string;
    resourceUrl?: string;
  };
}

/** In-flight state passed to every hook in the Checkout flow. */
export interface CheckoutContext {
  request: CheckoutRequest;
  /** UUID minted on first contact. Goods merchants persist as order id; API
   *  merchants treat as request id. */
  referenceId: string;
  /** Set after `computePricing` runs. */
  pricing: PricingResult | null;
  /** rail-key → recipient address, after `mintRecipients` runs (if provided).
   *  Static rails inherit recipients from the RailSpec. */
  recipients: Record<string, string>;
  /** Merchant-supplied per-request state, populated by `preValidate`. Other
   *  hooks read from here (e.g. `ctx.state.product` after preValidate
   *  resolved it). Stays empty when no `preValidate` is configured. */
  state: Record<string, unknown>;
  /** Capture the signer wallet under the operator credential the gate resolved
   *  for this request. Set by Checkout's internal gate after a successful allow
   *  when an operator_token is present; `undefined` for wallet-authenticated
   *  requests (no operator_token to associate) or anonymous discovery legs.
   *  Fire-and-forget — invoke from `onSettled` with the recovered signer. */
  captureWallet?: (opts: {
    walletAddress: string;
    network: 'evm' | 'solana';
    idempotencyKey?: string;
  }) => Promise<void>;
}

/**
 * Derive a coarse identity status (`'verified' | 'unverified' | 'anonymous'`)
 * from the assess block on a CheckoutContext. Goods merchants persist this on
 * the order row so audit logs distinguish gated buyers from anonymous ones.
 */
export function getIdentityStatus(
  ctx: CheckoutContext,
): 'verified' | 'unverified' | 'anonymous' {
  const assess = ctx.request.assess;
  if (assess === null || assess === undefined) return 'anonymous';
  const decision = (assess as { decision?: string }).decision;
  if (decision === 'allow') return 'verified';
  return 'unverified';
}

/**
 * Hook that runs once per request before pricing/settle. Returns a state dict
 * that Checkout merges into `ctx.state` so downstream hooks (`computePricing`,
 * `onSettled`) can read merchant-resolved values like the product row,
 * redemption code, post-discount cents, etc.
 *
 * Throw {@link CheckoutValidationError} to short-circuit with a 4xx envelope.
 */
export type PreValidateFn = (
  ctx: CheckoutContext,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

/** Denial returned by a `CheckoutGateConfig.runGate` function. */
export interface GateDenial {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

/**
 * Function the merchant supplies (or builds via a Checkout-gate helper) to run
 * the per-request AgentScore gate. Returns `null` on accept, a `GateDenial`
 * on deny.
 */
export type RunGateFn = (ctx: CheckoutContext) => Promise<GateDenial | null>;

/**
 * Wires the AgentScore gate into Checkout.
 *
 * The SDK constructs an `AgentScoreCore` from the policy fields (KYC, age,
 * sanctions, jurisdiction allowlist) and evaluates it after `preValidate`
 * populates state. Supports the full `createSessionOnMissing` hook surface so
 * merchants can pre-create pending orders before the verification session is
 * minted (set `onBeforeSession` to upsert state keyed by `ctx.referenceId` or
 * `ctx.state.*`, returning extras that the SDK folds into `reason.extra`).
 *
 * Three customization layers, in order of precedence:
 *
 * 1. ``runGate`` — full escape hatch. Replaces the SDK's gate flow entirely.
 *    Merchants implement assess + denial body construction themselves. Useful
 *    only for non-standard auth (e.g. shared signing keys, non-AgentScore IdP).
 * 2. ``perRequestPolicy`` — reads `ctx.state` (populated by preValidate) and
 *    returns a partial policy override applied per request (e.g. product-level
 *    KYC requirement). When omitted, the static fields below apply uniformly.
 * 3. ``onDenied`` — invoked AFTER the SDK builds the canonical DenialReason.
 *    Return a `GateDenial` to override the response body shape, or null to
 *    fall back to the canonical body from `denialReasonToBody`.
 *
 * Static policy fields mirror `AgentScoreCoreOptions` — see that interface
 * for field semantics.
 */
export interface CheckoutGateConfig {
  /** AgentScore API key. Required when `runGate` is omitted. */
  apiKey?: string;
  /** Override the default `https://api.agentscore.com` base URL. */
  baseUrl?: string;
  /** Prepended to the default User-Agent on API calls. */
  userAgent?: string;
  /** Require KYC verification. */
  requireKyc?: boolean;
  /** Require operator clear of sanctions. */
  requireSanctionsClear?: boolean;
  /** Minimum operator age bracket (18 or 21). */
  minAge?: number;
  /** Blocked jurisdiction list. */
  blockedJurisdictions?: string[];
  /** Allowed jurisdiction allowlist; only these pass. */
  allowedJurisdictions?: string[];
  /** Fail-open posture for AgentScore-side infra failures. Default false. */
  failOpen?: boolean;
  /** How long to cache results in seconds. Default 300. */
  cacheSeconds?: number;
  /** Optional chain filter for scoring. */
  chain?: string;
  /** Session-mint config for missing-identity bootstrap. Hooks receive the
   *  CheckoutContext so `getSessionOptions` and `onBeforeSession` can read
   *  state populated by `preValidate`. */
  createSessionOnMissing?: CreateSessionOnMissing<CheckoutContext>;
  /** Surfaced in `agent_memory` hints and audit logs. */
  merchantName?: string;
  /** Free-form context label (e.g. `"purchase"`, `"orders"`). */
  context?: string;
  /** Per-request policy override. Returns the partial fields to merge over
   *  the static config above. Return `null` to skip the gate. */
  perRequestPolicy?: (ctx: CheckoutContext) => Partial<AgentScoreCoreOptions> | null | Promise<Partial<AgentScoreCoreOptions> | null>;
  /** Customize the denial response body. Called after the SDK resolves a
   *  DenialReason. Return a `GateDenial` to override the canonical body, or
   *  null to use `denialReasonToBody`. */
  onDenied?: (ctx: CheckoutContext, reason: DenialReason) => GateDenial | null | Promise<GateDenial | null>;
  /** Accept AIP Agent Identity Tokens (AITs) on this route. When set and a request carries
   *  an `Agent-Identity` header, the gate verifies the token offline (issuer signature via the
   *  trusted-issuer JWKS + RFC 9421 proof-of-possession) BEFORE the assess call, then sends the
   *  raw token to `/v1/assess` as `aip_token` so the same wine/age/sanctions policy evaluates
   *  against the token's attested identity. A present-but-invalid AIT is a hard deny (the gate
   *  does NOT fall through to wallet / operator-token). Requests with no `Agent-Identity` header
   *  use the existing wallet / operator-token path unchanged.
   *
   *  Ignored when `runGate` is also set (a custom gate fully owns the flow). Without an `apiKey`,
   *  a verified AIT is honored offline for identity-only gates, but a gate that declares policy
   *  fields (KYC / age / sanctions / jurisdiction) without an `apiKey` fails closed
   *  (`aip_policy_requires_api_key`) since policy can only be evaluated via `/v1/assess`. */
  aip?: AipGateConfig;
  /** Full escape hatch — replaces the SDK gate flow. */
  runGate?: RunGateFn;
}

/** AIP acceptance config for {@link CheckoutGateConfig.aip}. */
export interface AipGateConfig {
  /** ADDITIONAL external issuers to trust beyond AgentScore's own (e.g. `['https://issuer.example']`),
   *  matched after canonicalization. AgentScore's canonical issuer
   *  ({@link AGENTSCORE_CANONICAL_ISSUER}) is ALWAYS trusted and never needs listing — this SDK
   *  is the AgentScore verifier, so a merchant can't accidentally fail to trust AgentScore AITs.
   *  Omit/empty to accept only AgentScore-issued AITs. */
  trustedIssuers?: string[];
  /** Clock-skew tolerance in seconds for the RFC 9421 signature window (and, as an override,
   *  the AIT JWT `exp`/`iat`). Defaults to 60s for both. */
  maxSkewSeconds?: number;
  /** Expected `@authority` (public hostname) the RFC 9421 signature must cover. When set, the
   *  verifier binds the signature to this value instead of trusting the inbound `Host` header —
   *  pin it to your real public host (e.g. `'wine.example.com'`) when behind a proxy that does
   *  not normalize `Host`, to prevent a captured AIT+signature from being replayed to a
   *  different virtual host on the same origin. */
  authority?: string;
  /** Minimum `trust_level` an AIT must assert to pass this gate (autonomous < human_present <
   *  human_confirmed) — the spec's human-presence gate (e.g. require `human_confirmed` for
   *  checkout). Enforced at the edge from the verified token; insufficient → 403 weak_auth with
   *  `required_trust_level`. Unset = any trust level accepted. */
  requireTrustLevel?: TrustLevel;
  /** Acceptable `auth.amr` methods (RFC 8176); the AIT must carry at least one (e.g.
   *  `['face','fpt','hwk']` to require strong human auth). Insufficient → 403 weak_auth with
   *  `required_amr`. Unset = not enforced. */
  requireAmr?: string[];
  /** Per-issuer compliance policy override, keyed by issuer URL (canonicalized before lookup).
   *  When a request's AIT is verified and its `iss` matches a key here, that block REPLACES the
   *  gate's default policy fields (`requireKyc` / `requireSanctionsClear` / `minAge` /
   *  `allowed/blockedJurisdictions`) for that request — letting a merchant apply different rules
   *  by issuer (e.g. full compliance for its own AITs, a relaxed set for a partner issuer whose
   *  tokens carry fewer attested claims). The replacement is whole-policy, not a merge: an issuer
   *  block of `{ requireKyc: true, minAge: 21 }` evaluates ONLY those two rules for that issuer
   *  (sanctions / jurisdiction omitted → not enforced for that issuer). Issuers NOT listed here
   *  use the gate's default policy unchanged. Only the AIT path consults this — wallet /
   *  operator-token requests are unaffected.
   *
   *  This is a deliberate compliance posture per issuer, not a default; an empty/absent map keeps
   *  every issuer on the gate's default policy. */
  issuerPolicies?: Record<string, AipIssuerPolicy>;
}

/** A per-issuer compliance policy block for {@link AipGateConfig.issuerPolicies}. The same
 *  compliance fields as the gate, applied (as a whole-policy replacement) only to AITs from the
 *  matching issuer. */
interface AipIssuerPolicy {
  requireKyc?: boolean;
  requireSanctionsClear?: boolean;
  minAge?: number;
  blockedJurisdictions?: string[];
  allowedJurisdictions?: string[];
}

/** Surface passed to `Checkout.onSettled` after a payment lands. */
export interface SettleOutcome {
  /** Protocol family that handled the settle. */
  rail: 'x402' | 'mpp';
  /** The `PAYMENT-RESPONSE` header to echo (x402 success path). `null` for MPP. */
  paymentResponseHeader: string | null;
  /** The `Payment-Receipt` header to echo (MPP success path, paymentauth.org §5).
   *  `null` for x402 and for the MPP zero-settle carve-out (no receipt minted). */
  paymentReceiptHeader: string | null;
  /** The underlying settle result for merchants that need to inspect tx hash / etc. */
  raw: unknown;
  /** On-chain transaction hash where applicable; `null` for the zero-settle carve-out
   *  (no on-chain settle) and for Stripe SPT. */
  txHash?: string | null;
  /** Verified signer address (EVM lowercased; Solana base58 verbatim). */
  signerAddress?: string | null;
  /** Network family of the signer; `'evm'` or `'solana'`. */
  signerNetwork?: string | null;
  /** The merchant's `rails`-dict key that handled this settle (e.g. `'tempo'`,
   *  `'x402_base'`). Use to label rails in audit logs and persisted orders. */
  railKey?: string;
}

/** Result a `composeMppx` hook returns when handling an MPP credential.
 *
 *  `status: 200` means mppx validated the `Authorization: Payment` credential
 *  and the settlement landed; Checkout runs `onSettled` and returns success.
 *
 *  `status: 402` means mppx emitted a 402 (no credential / invalid credential).
 *  Checkout layers its rich body on top of mppx's WWW-Authenticate header and
 *  optional x402 PAYMENT-REQUIRED, returning the composed 402.
 */
export interface MppxComposeOutcome {
  status: 200 | 402;
  /** For `status: 402`: the WWW-Authenticate (+ any other) headers mppx's compose
   *  emitted. Checkout merges these into the final 402 response. */
  headers?: Record<string, string>;
  /** For `status: 200`: optional PAYMENT-RESPONSE header echoed to the agent. */
  paymentResponseHeader?: string | null;
  /** For `status: 200`: serialized `Payment-Receipt` header (base64url-encoded
   *  receipt struct per mppx's `Receipt.serialize`). Echoed to the agent so
   *  spec-strict MPP clients (tempo CLI, etc.) can lift tx_hash + source from
   *  headers without parsing the JSON body. */
  paymentReceiptHeader?: string | null;
  /** The underlying mppx compose result for `onSettled` introspection. */
  raw?: unknown;
  /** On-chain tx hash from the mppx Receipt (when status=200 and on-chain). */
  txHash?: string | null;
  /** Verified signer recovered from the credential (when status=200). */
  signerAddress?: string | null;
  /** Network family of the signer; `'evm'` or `'solana'`. */
  signerNetwork?: string | null;
  /** The merchant's `rails`-dict key that handled this settle. Defaults to
   *  `"tempo"` when unset by the hook. */
  railKey?: string;
}

/** Framework-neutral output of `Checkout.handle`. */
export interface CheckoutResult {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  referenceId: string;
  settled: boolean;
  /** `null` on settlement success; otherwise the failure phase
   *  (`'verify_failed'`, `'settle_failed'`, ...) for diagnostics. */
  settlePhase?: string | null;
}

export type PricingFn = (ctx: CheckoutContext) => PricingResult | Promise<PricingResult>;
export type RecipientsFn = (
  ctx: CheckoutContext,
) => Record<string, string> | Promise<Record<string, string>>;
export type ReferenceIdFn = (ctx: CheckoutContext) => string | Promise<string>;
export type OnSettledFn = (
  ctx: CheckoutContext,
  outcome: SettleOutcome,
) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
export type ComposeMppxFn = (ctx: CheckoutContext) => MppxComposeOutcome | Promise<MppxComposeOutcome>;
export type IsCachedAddressFn = (address: string) => boolean | Promise<boolean>;


function resolveIdentityMetadata(
  ctx: CheckoutContext,
): IdentityMetadataBlock | undefined {
  const h = normalizeHeadersToLowercase(ctx.request.headers);
  const wallet = h['x-wallet-address'];
  if (!wallet) return undefined;
  let linkedWallets: string[] | undefined;
  const assess = ctx.request.assess;
  if (assess && typeof assess === 'object') {
    const identity = (assess as Record<string, unknown>)['identity'];
    if (identity && typeof identity === 'object') {
      const lw = (identity as Record<string, unknown>)['linked_wallets'];
      if (Array.isArray(lw) && lw.every((x): x is string => typeof x === 'string')) {
        linkedWallets = lw;
      }
    }
  }
  return buildIdentityMetadata({
    mode: 'wallet',
    wallet,
    ...(linkedWallets !== undefined ? { linkedWallets } : {}),
  });
}

function isStripeRailSpec(s: CheckoutRailSpec): s is StripeRailSpec {
  return !('recipient' in s);
}

function isTempoSessionRailSpec(s: CheckoutRailSpec): s is TempoSessionRailSpec {
  return 'escrowContract' in s && 'store' in s;
}

/** A recipient is STATIC when it's a non-empty string literal (not a factory callable, not an
 *  empty-string per-order sentinel). Factory/empty recipients signal that the authoritative
 *  `payTo` is minted per request and shipped in the 402 body, so they can't be bound at
 *  construction time. Mirrors the reference `_static_recipient`. */
function staticRecipient(r: RecipientLike): string | null {
  return typeof r === 'string' && r.length > 0 ? r : null;
}

/**
 * Collect the lowercased static recipient address(es) for the EVM/x402-base rail(s) in `rails`.
 *
 * Used to bind the agent-supplied x402 `payTo` to the merchant's CONFIGURED recipient: the
 * x402 `payTo` is read from the agent's signed payload, and the only sanity check is
 * `isCachedAddress`. For a static-recipient merchant (one address, no per-order minting and no
 * custom `isCachedAddress`), the gate must reject any `payTo` that isn't the configured address —
 * otherwise a hostile agent points `payTo` at their own wallet and drains the settle. This set is
 * the allow-list the auto-supplied `isCachedAddress` checks against.
 *
 * Empty when every x402-base recipient is a factory/empty sentinel (pure per-order minting) — in
 * that case there's nothing static to bind, and the merchant is expected to supply `isCachedAddress`
 * (e.g. `piCache.hasAddress`) themselves.
 */
function collectStaticX402Recipients(rails: Record<string, CheckoutRailSpec>): Set<string> {
  const out = new Set<string>();
  for (const spec of Object.values(rails)) {
    if (isStripeRailSpec(spec) || isTempoSessionRailSpec(spec)) continue;
    if (!isEvmNetwork(spec)) continue;
    const recipient = staticRecipient((spec as X402BaseRailSpec).recipient);
    if (recipient !== null) out.add(recipient.toLowerCase());
  }
  return out;
}

/** Map a `*RailSpec` instance to its canonical `RailKey` slug. Tempo charge
 *  and Tempo session both speak MPP on Tempo, so they fold to `"tempo_mpp"`. */
function specRailKey(spec: CheckoutRailSpec): RailKey {
  if (isStripeRailSpec(spec)) return 'stripe';
  if (isTempoSessionRailSpec(spec)) return 'tempo_mpp';
  if (isEvmNetwork(spec)) return 'x402_base';
  if (isSolanaNetwork(spec) || 'rpcUrl' in spec) return 'solana_mpp';
  return 'tempo_mpp';
}

/** Protocol-shaped method name for the `methods: [...]` discovery array. */
function specMethodName(spec: CheckoutRailSpec): string {
  if (isStripeRailSpec(spec)) return 'stripe/spt';
  if (isTempoSessionRailSpec(spec)) return 'tempo/charge';
  if (isEvmNetwork(spec)) return 'x402/exact (base)';
  if (isSolanaNetwork(spec) || 'rpcUrl' in spec) return 'solana/charge';
  return 'tempo/charge';
}

/**
 * Build the canonical `composeMppx` hook for pympp/mppx-backed MPP rails.
 *
 * Lazily resolves the server via the supplied `serverGetter` (typically the
 * output of `lazyMppxServer`). Forwards the request's `Authorization: Payment`
 * header and the current pricing amount to `mpp.charge`. Maps the three pympp
 * outcomes to `MppxComposeOutcome`:
 *
 * - `Challenge` (no/invalid credential) → `status: 402` with the
 *   `www-authenticate` header pympp issued.
 * - `(Credential, Receipt)` tuple → `status: 200` with the tx hash lifted from
 *   `receipt.reference` / `receipt.transaction` and the signer lifted from the
 *   credential's `did:pkh:...` source.
 * - Any unexpected exception → `status: 402` (no headers; Checkout falls back
 *   to its standard 402 emit).
 */
export function makeMppxComposeHook(opts: {
  serverGetter: () => Promise<unknown>;
}): ComposeMppxFn {
  return async (ctx: CheckoutContext): Promise<MppxComposeOutcome> => {
    if (ctx.pricing === null) return { status: 402 };
    const mpp = (await opts.serverGetter()) as {
      realm?: string;
      charge: (args: { authorization?: string; amount: string }) => Promise<unknown>;
    };
    const lower = normalizeHeadersToLowercase(ctx.request.headers);
    const authorization = lower['authorization'];
    const amountStr = ctx.pricing.amountUsd.toFixed(ctx.pricing.decimals ?? 2);
    let result: unknown;
    try {
      result = await mpp.charge({ authorization, amount: amountStr });
    } catch {
      return { status: 402 };
    }
    if (!Array.isArray(result)) {
      const challenge = result as { toWwwAuthenticate?: (realm: string) => string };
      const realm = mpp.realm ?? '';
      const headers: Record<string, string> =
        typeof challenge.toWwwAuthenticate === 'function'
          ? { 'www-authenticate': challenge.toWwwAuthenticate(realm) }
          : {};
      return { status: 402, headers };
    }
    const [credential, receipt] = result as [
      { source?: string },
      { reference?: string; transaction?: string },
    ];
    const txHash = receipt.reference ?? receipt.transaction ?? null;
    let signerAddress: string | null = null;
    let signerNetwork: string | null = null;
    const source = credential.source;
    if (typeof source === 'string') {
      const parts = source.split(':');
      if (parts.length >= 4 && parts[0] === 'did' && parts[1] === 'pkh') {
        const family = parts[2];
        const addr = parts[parts.length - 1] ?? null;
        if (family === 'eip155' && addr !== null) {
          signerAddress = addr.toLowerCase();
          signerNetwork = 'evm';
        } else if (family === 'solana' && addr !== null) {
          signerAddress = addr;
          signerNetwork = 'solana';
        }
      }
    }
    const { Receipt } = (await import('mppx')) as {
      Receipt: { serialize: (r: unknown) => string };
    };
    const paymentReceiptHeader = Receipt.serialize(receipt);
    return {
      status: 200,
      txHash,
      signerAddress,
      signerNetwork,
      paymentReceiptHeader,
      raw: { credential, receipt },
    };
  };
}

/**
 * Apply per-call recipient overrides (from `mintRecipients`) to rail specs.
 * Returns a new dict; original rails dict is not mutated. Stripe rails are
 * passed through unchanged (no on-chain recipient — they use `profileId`).
 *
 * When the merchant declares rails with sentinel empty-string recipients
 * (per-order minting pattern) and `mintRecipients` only returns addresses
 * for some rails, drop the rails that resolve to an empty recipient — those
 * weren't actually minted for this request and shouldn't be advertised in
 * the 402.
 */
function applyRecipientOverrides(
  rails: Record<string, CheckoutRailSpec>,
  overrides: Record<string, string>,
): Record<string, CheckoutRailSpec> {
  const out: Record<string, CheckoutRailSpec> = {};
  for (const [key, spec] of Object.entries(rails)) {
    if (isStripeRailSpec(spec)) {
      out[key] = spec;
      continue;
    }
    const override = overrides[key];
    const finalRecipient = override ?? (spec as { recipient?: unknown }).recipient;
    if (finalRecipient === '' || finalRecipient === undefined) continue;
    out[key] = override !== undefined
      ? ({ ...spec, recipient: override } as CheckoutRailSpec)
      : spec;
  }
  return out;
}

/** Cast helper: trust the rail-dict key for downcasting to the expected spec type.
 *  Returns undefined when the key is absent. */
function pickRail<T>(rails: Record<string, CheckoutRailSpec>, key: string): T | undefined {
  const spec = rails[key];
  return spec === undefined ? undefined : (spec as unknown as T);
}

/** Resolve a per-issuer compliance-policy override for a verified AIT's issuer. Both the verified
 *  `iss` and the map keys are canonicalized (lowercase scheme+host, no default port / trailing
 *  slash) before comparison so `https://issuer.example` and `https://issuer.example/` resolve the same.
 *  Returns the matching policy block, or undefined when the issuer is not overridden (→ caller
 *  falls back to the gate's default policy). */
/** The effective AIP trusted-issuer list: AgentScore's canonical issuer (ALWAYS trusted) plus any
 *  external issuers. De-duped after canonicalization. Use this for the `agent_memory` hint and any
 *  presentation surface (llms.txt / mpp.json / skill.md) that advertises AIP acceptance, so a
 *  merchant relying solely on AgentScore AITs (no external issuers) still advertises the
 *  `agent_identity` path. Trust enforcement itself lives in {@link JwksCache}, which merges the
 *  canonical issuer independently. */
export function buildAipTrustedIssuers(externalIssuers?: string[]): string[] {
  const out = [AGENTSCORE_CANONICAL_ISSUER, ...(externalIssuers ?? [])];
  // De-dupe on canonical form so an explicit `https://www.agentscore.com` (or trailing-slash variant)
  // doesn't double up; keep the first-seen original string for each canonical key.
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const iss of out) {
    const key = canonicalizeIssuer(iss) ?? iss;
    if (!seen.has(key)) { seen.add(key); deduped.push(iss); }
  }
  return deduped;
}

function aipTrustedIssuerSet(cfg: AipGateConfig): string[] {
  return buildAipTrustedIssuers(cfg.trustedIssuers);
}

/** Project the gate's effective compliance policy onto the AIT identity claims it requires, for
 *  the `required_claims` escalation hint on an `insufficient_claims` AIP denial. Mirrors the
 *  claim names the API checks an AIT against (`id_verified` / `sanctions_clear` / `age_over_<N>` /
 *  `jurisdiction`). Empty when the policy is identity-only. */
function aipRequiredClaims(policy: AipIssuerPolicy): string[] {
  const claims: string[] = [];
  if (policy.requireKyc) claims.push('id_verified');
  if (policy.requireSanctionsClear) claims.push('sanctions_clear');
  if (policy.minAge != null) claims.push(`age_over_${policy.minAge}`);
  if (policy.blockedJurisdictions !== undefined || policy.allowedJurisdictions !== undefined) {
    claims.push('jurisdiction');
  }
  return claims;
}

function resolveIssuerPolicy(
  issuerPolicies: Record<string, AipIssuerPolicy>,
  iss: string,
): AipIssuerPolicy | undefined {
  const target = canonicalizeIssuer(iss);
  if (target === null) return undefined;
  for (const [key, policy] of Object.entries(issuerPolicies)) {
    if (canonicalizeIssuer(key) === target) return policy;
  }
  return undefined;
}

/**
 * High-level agent-commerce orchestrator.
 *
 * @example
 * ```ts
 * const checkout = new Checkout({
 *   rails: { tempo: ..., x402_base: ..., stripe: ... },
 *   url: APP_URL,
 *   computePricing: (ctx) => ({ amountUsd: cartTotal(ctx.request.body) }),
 *   mintRecipients: (ctx) => stripeMultichainAddressesFor(ctx),
 *   onSettled: (ctx, outcome) => persistOrder(ctx.referenceId, ctx.request.body, outcome),
 *   composeMppx: (ctx) => mppxCompose(mppx, ctx.request),
 *   x402Server: x402,
 * });
 * const result = await checkout.handle(buildCheckoutRequest(request));
 * return new Response(JSON.stringify(result.body), { status: result.status, headers: result.headers });
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class Checkout {
  readonly rails: Record<string, CheckoutRailSpec>;
  readonly url: string;
  readonly merchantName: string | undefined;
  readonly computePricing: PricingFn;
  readonly preValidate: PreValidateFn | undefined;
  x402Server: X402Server | undefined;
  composeMppx: ComposeMppxFn | undefined;
  readonly mintRecipients: RecipientsFn | undefined;
  readonly mintReferenceId: ReferenceIdFn | undefined;
  readonly onSettled: OnSettledFn | undefined;
  readonly isCachedAddress: IsCachedAddressFn | undefined;
  /** Lowercased static recipient addresses for the x402-base rail(s). When the merchant
   *  configured a static recipient and supplied no `isCachedAddress`, the gate binds the
   *  agent-supplied `payTo` to this set (anti funds-drain). Empty for pure per-order minting. */
  private readonly x402StaticRecipients: Set<string>;
  readonly zeroSettleCarveOut: boolean;
  readonly gate: CheckoutGateConfig | undefined;
  readonly discoveryExtensions: Record<string, unknown> | undefined;
  readonly resourceInfo: { serviceName?: string; tags?: string[]; iconUrl?: string; description?: string } | undefined;
  readonly discoveryProbe: DiscoveryProbeConfig | undefined;
  private _x402ServerGetter: (() => Promise<X402Server>) | undefined;

  /** Lazily-built JWKS cache for AIP verification, shared across requests so issuer keys
   *  are fetched once and cached (per the verifier's hard 24h cap). Built on first AIT. */
  private aipJwks: JwksCache | undefined;

  private getAipJwks(cfg: AipGateConfig): JwksCache {
    if (this.aipJwks === undefined) {
      // JwksCache merges AgentScore's canonical issuer itself, so pass only the merchant's
      // external issuers (if any).
      this.aipJwks = new JwksCache(cfg.trustedIssuers !== undefined ? { trustedIssuers: cfg.trustedIssuers } : {});
    }
    return this.aipJwks;
  }

  /**
   * True when the merchant has configured an identity-bearing policy flag —
   * `require_kyc`, `require_sanctions_clear` (name screening on the KYC
   * identity), `min_age`, or jurisdiction lists. Wallet OFAC SDN enforcement
   * (the always-on default) does NOT count as an identity gate; agents don't
   * need an AgentScore credential to satisfy it.
   *
   * Used to conditionally emit AgentScore identity boilerplate in 402 bodies
   * (`agent_memory`, `X-Operator-Token` references in per-rail commands).
   */
  hasIdentityGate(): boolean {
    const g = this.gate;
    if (!g) return false;
    return Boolean(
      g.requireKyc ||
      g.requireSanctionsClear ||
      g.minAge !== undefined ||
      (g.allowedJurisdictions && g.allowedJurisdictions.length > 0) ||
      (g.blockedJurisdictions && g.blockedJurisdictions.length > 0),
    );
  }

  constructor(opts: {
    rails: Record<string, CheckoutRailSpec>;
    url: string;
    computePricing: PricingFn;
    /** Per-request validation hook. Runs before pricing/gate/settle. Throw
     *  `CheckoutValidationError` to short-circuit with a 4xx envelope. Returns
     *  a state dict merged into `ctx.state` for downstream hooks. */
    preValidate?: PreValidateFn;
    /** Built via `createX402Server`. Pair it with an `X402BaseRailSpec` in
     *  `rails['x402_base']`; the CAIP-2 network is read from `rail.network`.
     *  When omitted, Checkout auto-derives via `lazyX402Server` from the flat
     *  `cdpApiKeyId` / `cdpApiKeySecret` kwargs. */
    x402Server?: X402Server;
    /** Required when the merchant accepts `Authorization: Payment` credentials.
     *  When omitted and `mppxSecretKey` is supplied, Checkout auto-derives via
     *  `lazyMppxServer` + the canonical compose hook (see `makeMppxComposeHook`). */
    composeMppx?: ComposeMppxFn;
    /** Flat-config: when `x402Server` is omitted and any X402BaseRailSpec is in
     *  `rails`, Checkout lazy-builds the x402 server. Pair `cdpApiKeyId` +
     *  `cdpApiKeySecret` to use Coinbase's facilitator; omit both for the
     *  public HTTP facilitator. */
    cdpApiKeyId?: string;
    cdpApiKeySecret?: string;
    /** Flat-config: when `composeMppx` is omitted and an MPP rail is in `rails`,
     *  Checkout lazy-builds the mppx server. */
    mppxSecretKey?: string;
    /** Per-order deposit address minting (e.g. Stripe-multichain). */
    mintRecipients?: RecipientsFn;
    /** Default is `randomUUID()`. */
    mintReferenceId?: ReferenceIdFn;
    /** Runs after a settle lands; can return an inline response body for API sellers. */
    onSettled?: OnSettledFn;
    /** Pass when the merchant mints per-order addresses so `verifyX402Request` can
     *  confirm the `payTo` was minted by this merchant (e.g. `piCache.hasAddress`).
     *  When omitted, Checkout auto-binds the agent-supplied `payTo` to the rail's
     *  configured STATIC recipient(s) — the permissive default applies ONLY when no
     *  static recipient exists (pure per-order minting). */
    isCachedAddress?: IsCachedAddressFn;
    /** Engage the EIP-3009 value=0 + pympp `proof` carve-out when pricing
     *  resolves to $0. Goods merchants offering free redemption codes set this
     *  to `true` so the credential parses without an on-chain settle. */
    zeroSettleCarveOut?: boolean;
    /** Per-request gate config. When set, the gate runs after `preValidate`
     *  populates `ctx.state` and before pricing/settle. Denials short-circuit
     *  with the gate's body verbatim. */
    gate?: CheckoutGateConfig;
    /** Per-endpoint x402 `extensions` block emitted on the 402 body. Merge
     *  outputs of `createBazaarDiscovery({...})` (or other extension declarers)
     *  here — Checkout forwards verbatim into the 402 response body's
     *  `extensions` field so Bazaar crawlers and other spec-compliant clients
     *  read the route's declared input/output schema. */
    discoveryExtensions?: Record<string, unknown>;
    /** Optional x402 v2 ResourceInfo metadata advertised on the 402 (both the
     *  body and the PAYMENT-REQUIRED header): `serviceName` / `tags` (max 5) /
     *  `iconUrl` / `description`, used by Bazaar search + filtering. `url` and
     *  `mimeType` are filled automatically from the request. */
    resourceInfo?: { serviceName?: string; tags?: string[]; iconUrl?: string; description?: string };
    /** Optional discovery-probe config: auto-route empty-body POSTs without a
     *  payment header to a sample 402 advertising the merchant's shape for
     *  crawlers (`awal x402 details`, x402-proxy, x402scan, ...). */
    discoveryProbe?: DiscoveryProbeConfig;
  }) {
    const x402Server = opts.x402Server;
    let x402ServerGetter: (() => Promise<X402Server>) | undefined;
    if (x402Server === undefined) {
      const baseSpec = Object.values(opts.rails).find(
        (s): s is X402BaseRailSpec =>
          !isTempoSessionRailSpec(s) && !isStripeRailSpec(s) && 'recipient' in s &&
          isEvmNetwork(s),
      );
      if (baseSpec !== undefined) {
        x402ServerGetter = lazyX402Server({
          spec: baseSpec,
          cdpApiKeyId: opts.cdpApiKeyId,
          cdpApiKeySecret: opts.cdpApiKeySecret,
        });
      }
    } else {
      const baseSpec = opts.rails['x402_base'];
      if (baseSpec === undefined || !('recipient' in baseSpec)) {
        throw new Error(
          "Checkout: x402Server requires an X402BaseRailSpec in rails['x402_base'] " +
            "(the rail's `network` field supplies the CAIP-2).",
        );
      }
    }

    let composeMppx = opts.composeMppx;
    if (composeMppx === undefined && opts.mppxSecretKey !== undefined) {
      const mppRails: Record<string, MppxRailSpec> = {};
      for (const [k, v] of Object.entries(opts.rails)) {
        if (isStripeRailSpec(v) || isTempoSessionRailSpec(v) || 'recipient' in v) {
          mppRails[k] = v as MppxRailSpec;
        }
      }
      const getter = lazyMppxServer({
        rails: mppRails,
        secretKey: opts.mppxSecretKey,
      });
      composeMppx = makeMppxComposeHook({ serverGetter: getter });
    }

    this.rails = opts.rails;
    this.url = opts.url;
    this.merchantName = opts.gate?.merchantName;
    this.computePricing = opts.computePricing;
    this.preValidate = opts.preValidate;
    this.x402Server = x402Server;
    this._x402ServerGetter = x402ServerGetter;
    this.composeMppx = composeMppx;
    this.mintRecipients = opts.mintRecipients;
    this.mintReferenceId = opts.mintReferenceId;
    this.onSettled = opts.onSettled;
    this.isCachedAddress = opts.isCachedAddress;
    this.x402StaticRecipients = collectStaticX402Recipients(opts.rails);
    this.zeroSettleCarveOut = opts.zeroSettleCarveOut ?? false;
    this.gate = opts.gate;
    this.discoveryExtensions = opts.discoveryExtensions;
    this.resourceInfo = opts.resourceInfo;
    this.discoveryProbe = opts.discoveryProbe;
  }

  /** Canonical `RailKey` list derived from the configured rails dict. Each
   *  `*RailSpec` type maps to one `RailKey` (Tempo and TempoSession both fold
   *  to `"tempo_mpp"`). Dedupes so listing is per protocol, not per recipient.
   *  Use in `.well-known/mpp.json`, skill.md / llms.txt discovery responses. */
  get acceptedRails(): RailKey[] {
    const out: RailKey[] = [];
    const seen = new Set<string>();
    for (const spec of Object.values(this.rails)) {
      const key = specRailKey(spec);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
    return out;
  }

  /** Protocol-shaped method-name list (`"tempo/charge"`, `"x402/exact (base)"`).
   *  Suitable for the `methods: [...]` array of `.well-known/mpp.json`. */
  get acceptedMethodNames(): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const spec of Object.values(this.rails)) {
      const name = specMethodName(spec);
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
    return out;
  }

  /** Resolve the x402 server, awaiting the lazy getter on first use. */
  private async getX402Server(): Promise<X402Server | undefined> {
    if (this.x402Server !== undefined) return this.x402Server;
    if (this._x402ServerGetter === undefined) return undefined;
    this.x402Server = await this._x402ServerGetter();
    return this.x402Server;
  }

  private x402ServerAvailable(): boolean {
    return this.x402Server !== undefined || this._x402ServerGetter !== undefined;
  }

  /** Return the rails-dict key for the X402BaseRailSpec entry. Defaults to
   *  `"x402_base"` when no match found. */
  private x402RailKey(): string {
    for (const [k, v] of Object.entries(this.rails)) {
      if (!isStripeRailSpec(v) && !isTempoSessionRailSpec(v) && isEvmNetwork(v)) {
        return k;
      }
    }
    return 'x402_base';
  }

  /** Return the rails-dict key for the primary MPP rail. */
  private mppRailKey(): string {
    for (const [k, v] of Object.entries(this.rails)) {
      if (!isStripeRailSpec(v) && !isEvmNetwork(v)) return k;
    }
    return 'tempo';
  }

  /** Map an mppx credential `method` (`tempo` | `solana` | `stripe`) to the
   *  merchant's rails-dict key. Used in handleMppx so onSettled outcomes
   *  distinguish Solana from Tempo (both settle under `rail: 'mpp'`) and from
   *  Stripe SPT. Returns the first matching key or `undefined` when no rail in
   *  the merchant's config corresponds to that method. */
  private railsKeyForMppxMethod(method: string): string | undefined {
    if (method === 'stripe') {
      for (const [k, v] of Object.entries(this.rails)) {
        if (isStripeRailSpec(v)) return k;
      }
      return undefined;
    }
    if (method === 'solana') {
      for (const [k, v] of Object.entries(this.rails)) {
        if (isStripeRailSpec(v) || isTempoSessionRailSpec(v)) continue;
        if (isSolanaNetwork(v) || 'rpcUrl' in v || 'tokenProgram' in v) return k;
      }
      return undefined;
    }
    if (method === 'tempo') {
      for (const [k, v] of Object.entries(this.rails)) {
        if (isStripeRailSpec(v)) continue;
        if (isSolanaNetwork(v) || 'rpcUrl' in v || 'tokenProgram' in v) continue;
        if (isEvmNetwork(v)) continue;
        return k;
      }
      return undefined;
    }
    return undefined;
  }

  /** CAIP-2 read from `rails['x402_base'].network` (or its default).
   *  Defined only when an `X402BaseRailSpec` is present in rails AND a server
   *  is configured (explicit or auto-derived); otherwise `null`. */
  get x402BaseNetwork(): string | null {
    if (!this.x402ServerAvailable()) return null;
    for (const spec of Object.values(this.rails)) {
      if (!isStripeRailSpec(spec) && !isTempoSessionRailSpec(spec) && isEvmNetwork(spec)) {
        return (spec as { network?: string }).network ?? 'eip155:8453';
      }
    }
    return null;
  }

  async handle(request: CheckoutRequest): Promise<CheckoutResult> {
    const referenceId = await this.mintRefId(request);
    const ctx: CheckoutContext = {
      request,
      referenceId,
      pricing: null,
      recipients: {},
      state: {},
    };

    if (this.discoveryProbe !== undefined && request.method === 'POST') {
      const auth = request.headers['authorization'] ?? request.headers['Authorization'];
      const isProbe =
        !(auth?.startsWith('Payment ')) &&
        !hasX402Header(request.headers) &&
        !hasMppxHeader(request.headers) &&
        (request.body === undefined || request.body === null ||
         (typeof request.body === 'object' && Object.keys(request.body as object).length === 0));
      if (isProbe) {
        const { buildDiscoveryProbeResponse } = await import('./discovery/probe.js');
        const cfg = this.discoveryProbe;
        const probe = buildDiscoveryProbeResponse({
          realm: cfg.realm,
          sampleRail: cfg.sampleRail,
          sampleAmountUsd: cfg.sampleAmountUsd,
          sampleRecipient: cfg.sampleRecipient,
          ...(cfg.intent !== undefined && { intent: cfg.intent }),
          ...(cfg.ttlSeconds !== undefined && { ttlSeconds: cfg.ttlSeconds }),
          ...(cfg.docsUrl !== undefined && { docsUrl: cfg.docsUrl }),
          ...(cfg.message !== undefined && { message: cfg.message }),
          ...(cfg.x402Sample !== undefined && { x402Sample: cfg.x402Sample }),
        });
        return {
          status: probe.status,
          body: JSON.parse(probe.body),
          headers: probe.headers,
          referenceId: ctx.referenceId,
          settled: false,
        };
      }
    }

    // 1. Pre-validate (merchant-supplied per-request validation).
    if (this.preValidate !== undefined) {
      try {
        const state = await this.preValidate(ctx);
        if (state && typeof state === 'object') Object.assign(ctx.state, state);
      } catch (err) {
        if (err instanceof CheckoutValidationError) {
          return this.validationErrorResult(ctx, err);
        }
        throw err;
      }
    }

    // 2. Per-request compliance. Only fires when a payment header is present
    //    (so the discovery leg stays anonymous-friendly).
    //
    //    Two paths converge here:
    //    - Merchants with an explicit `gate` config run the full identity
    //      policy (KYC / age / sanctions / jurisdiction) via `runGate`.
    //    - Merchants WITHOUT a `gate` config still get wallet OFAC SDN
    //      enforcement via `runWalletSanctionsOnly` — this is the always-on
    //      strict-liability default. Falls back to `process.env.AGENTSCORE_API_KEY`
    //      for the API call; logs a warning and skips when no key is set
    //      (dev/testnet pattern).
    const hasPaymentHeader =
      hasX402Header(request.headers) || hasMppxHeader(request.headers);
    if (hasPaymentHeader) {
      const denial = this.gate !== undefined
        ? await this.runGate(ctx)
        : await this.runWalletSanctionsOnly(ctx);
      if (denial !== null) {
        return {
          status: denial.status,
          body: denial.body,
          headers: { ...(denial.headers ?? {}) },
          referenceId: ctx.referenceId,
          settled: false,
        };
      }
    }

    // 3. Pricing.
    ctx.pricing = await this.computePricing(ctx);

    // Recipients are read by every downstream dispatch (x402 verify+settle,
    // mppx compose, 402 emit). Resolve once here so hooks see ctx.recipients
    // populated. The resolver is idempotent — subsequent calls no-op.
    //
    // mintRecipients can throw CheckoutValidationError from cross-bundle
    // helpers like createPayToAddressFromStripePI (e.g. malformed
    // Authorization: Payment). Match by error name since tsup's per-entry
    // bundles produce separate class identities under `splitting: false`.
    try {
      await this.resolveRecipientsForCtx(ctx);
    } catch (err) {
      if (err instanceof Error && err.name === 'CheckoutValidationError') {
        return this.validationErrorResult(ctx, err as CheckoutValidationError);
      }
      throw err;
    }

    const x402ServerOk = this.x402ServerAvailable() && this.x402BaseNetwork !== null;
    if (hasX402Header(request.headers) && x402ServerOk) {
      const zero = await this.handleZeroSettle(ctx, 'x402-base');
      if (zero !== null) return zero;
      return await this.handleX402(ctx);
    }

    if (hasMppxHeader(request.headers) && this.composeMppx !== undefined) {
      const zero = await this.handleZeroSettle(ctx, 'tempo');
      if (zero !== null) return zero;
      return await this.handleMppx(ctx);
    }

    // Discovery leg: mint per-order recipients BEFORE composeMppx so the
    // hook sees ctx.recipients populated. composeMppx mints a fresh
    // WWW-Authenticate challenge that the agent needs to sign on the retry;
    // the hook returns status=402 with mppx-issued headers, which we
    // propagate into the rich 402 emit. (Resolver is idempotent — the
    // earlier resolve in this flow already succeeded; this call is a no-op
    // unless we got here without going through it.)
    await this.resolveRecipientsForCtx(ctx);
    let mppxHeaders: Record<string, string> = {};
    if (this.composeMppx !== undefined) {
      try {
        const preComposed = await this.composeMppx(ctx);
        if (preComposed.status === 402) {
          mppxHeaders = { ...(preComposed.headers ?? {}) };
        }
      } catch {
        // Hook errors here only affect the optional MPP challenge; the 402
        // still goes out with whatever rails resolved.
      }
    }
    return await this.emit402(ctx, mppxHeaders);
  }

  private validationErrorResult(
    ctx: CheckoutContext,
    err: CheckoutValidationError,
  ): CheckoutResult {
    const body = buildValidationError({
      code: err.code,
      message: err.message,
      nextSteps: { action: err.action, user_message: err.message },
      extra: err.extra,
    });
    return {
      status: err.status,
      body,
      headers: {},
      referenceId: ctx.referenceId,
      settled: false,
    };
  }

  private async runGate(ctx: CheckoutContext): Promise<GateDenial | null> {
    const gate = this.gate;
    if (gate === undefined) return null;
    if (gate.runGate !== undefined) {
      // Escape hatch — fully owns the gate. The wallet-OFAC fallback below
      // (apiKey === undefined → runWalletSanctionsOnly) does NOT fire here;
      // merchants who supply runGate are taking explicit ownership of
      // compliance enforcement and should call /v1/assess themselves (or
      // accept that they're not getting SDN protection). NOTE: `runGate` also
      // bypasses the `gate.aip` AIP pre-step below — a custom gate owns AIT
      // verification too. `runGate` and `gate.aip` are mutually exclusive.
      const result = await gate.runGate(ctx);
      // Allow merchants to return undefined as an alias for `null` (allow).
      if (result === undefined || result === null) return null;
      if (typeof result !== 'object' || typeof (result as { status?: unknown }).status !== 'number') {
        throw new TypeError(
          'gate.runGate must return null/undefined (allow) or an object { status, body, headers? } (deny)',
        );
      }
      return result;
    }
    // AIP pre-step — runs BEFORE the no-apiKey fallback so a present-but-invalid AIT is always
    // a hard deny, and a cryptographically verified AIT is honored even on an offline-only gate.
    // The RFC 9421 proof-of-possession can only be checked here at the edge, where the signed
    // HTTP message lives. A valid AIT becomes the sole identity (wins over wallet / operator-token).
    const headers = normalizeHeadersToLowercase(ctx.request.headers);
    const walletAddress = headers['x-wallet-address'];
    const operatorToken = headers['x-operator-token'];
    let aipToken: string | undefined;
    let aipIssuer: string | undefined;
    let aipSignature: AgentIdentity['aipSignature'];
    if (gate.aip !== undefined && hasAgentIdentityHeaderNode(headers)) {
      const aipResult = await verifyAitParts(
        {
          method: ctx.request.method,
          url: ctx.request.url,
          headers,
          ...(gate.aip.authority !== undefined && { authority: gate.aip.authority }),
        },
        {
          jwks: this.getAipJwks(gate.aip),
          ...(gate.aip.maxSkewSeconds !== undefined && { maxSkewSeconds: gate.aip.maxSkewSeconds }),
        },
      );
      if (!aipResult.ok) {
        const body = buildAipErrorBody(aipResult.failure, {
          trustedIssuers: aipTrustedIssuerSet(gate.aip),
          ...(gate.aip.requireTrustLevel !== undefined && { requiredTrustLevel: gate.aip.requireTrustLevel }),
          ...(gate.aip.requireAmr !== undefined && { requiredAmr: gate.aip.requireAmr }),
        });
        return {
          status: body.status,
          body: body as unknown as Record<string, unknown>,
          headers: {
            'content-type': 'application/problem+json',
            // 503 = the IdP's JWKS was unreachable (transient infra, not a bad token). Hint a
            // short backoff so agents retry rather than uselessly re-signing.
            ...(body.status === 503 && { 'retry-after': '5' }),
          },
        };
      }
      aipToken = aipResult.ait.token;
      aipIssuer = aipResult.ait.iss;
      aipSignature = aipResult.ait.signatureMaterial;

      // Enforce the merchant's trust_level / auth.amr requirement (the spec's human-presence gate).
      // Verification-derived (carried in the verified token), so enforced here at the edge —
      // insufficient → weak_auth (403) with required_* so the agent can step up (re-mint a
      // higher-trust AIT) rather than guess.
      const weakAuthDetail = checkTrustRequirements(aipResult.ait.payload, gate.aip.requireTrustLevel, gate.aip.requireAmr);
      if (weakAuthDetail) {
        const body = buildAipWeakAuthBody({
          detail: weakAuthDetail,
          ...(gate.aip.requireTrustLevel !== undefined && { requiredTrustLevel: gate.aip.requireTrustLevel }),
          ...(gate.aip.requireAmr !== undefined && { requiredAmr: gate.aip.requireAmr }),
          trustedIssuers: aipTrustedIssuerSet(gate.aip),
        });
        return { status: 403, body: body as unknown as Record<string, unknown>, headers: { 'content-type': 'application/problem+json' } };
      }
    }

    // Resolve the per-issuer policy override (if any) for the verified AIT's issuer. Matched on
    // the canonicalized issuer so keys line up with the trust list's canonicalization. When set,
    // it REPLACES the gate's default compliance policy for this request.
    const issuerPolicy: AipIssuerPolicy | undefined =
      aipIssuer !== undefined && gate.aip?.issuerPolicies !== undefined
        ? resolveIssuerPolicy(gate.aip.issuerPolicies, aipIssuer)
        : undefined;
    // The effective compliance fields for this request: the issuer override when present, else
    // the gate defaults. Used by both the no-apiKey policy-presence check and the coreOpts build.
    const effPolicy: AipIssuerPolicy = issuerPolicy ?? {
      ...(gate.requireKyc !== undefined && { requireKyc: gate.requireKyc }),
      ...(gate.requireSanctionsClear !== undefined && { requireSanctionsClear: gate.requireSanctionsClear }),
      ...(gate.minAge !== undefined && { minAge: gate.minAge }),
      ...(gate.blockedJurisdictions !== undefined && { blockedJurisdictions: gate.blockedJurisdictions }),
      ...(gate.allowedJurisdictions !== undefined && { allowedJurisdictions: gate.allowedJurisdictions }),
    };

    if (gate.apiKey === undefined) {
      if (aipToken !== undefined) {
        // A cryptographically verified AIT is a complete offline *identity* check (issuer
        // signature + RFC 9421 PoP). But compliance *policy* (KYC / age / sanctions /
        // jurisdiction) is evaluated against the token's claims by `/v1/assess`, which needs an
        // apiKey. If the merchant declared policy fields without an apiKey we cannot enforce
        // them — fail closed rather than silently allow a verified-but-non-compliant identity
        // (e.g. an under-21 AIT through a `minAge: 21` gate). Identity-only gates (no policy
        // fields) are satisfied by the verified AIT alone.
        const hasPolicy = effPolicy.requireKyc || effPolicy.requireSanctionsClear || effPolicy.minAge != null
          || effPolicy.blockedJurisdictions !== undefined || effPolicy.allowedJurisdictions !== undefined;
        if (hasPolicy) {
          return {
            status: 403,
            body: {
              error: {
                code: 'aip_policy_requires_api_key',
                message: 'This gate declares compliance policy (KYC / age / sanctions / jurisdiction) but has no AgentScore apiKey, so the Agent Identity Token’s claims cannot be evaluated. Configure gate.apiKey to enable policy enforcement on AITs.',
              },
            },
          };
        }
        return null;
      }
      // No AIT, no apiKey → fall through to wallet OFAC SDN enforcement (the strict-liability
      // default) so the merchant still gets the basic protection layer instead of allowing.
      return this.runWalletSanctionsOnly(ctx);
    }

    // Merge per-request policy overrides over the static config.
    let policyOverride: Partial<AgentScoreCoreOptions> | null | undefined;
    if (gate.perRequestPolicy !== undefined) {
      policyOverride = await gate.perRequestPolicy(ctx);
      // A null override means "no per-request *identity* policy for this product"
      // — but it must NOT skip the always-on wallet OFAC SDN floor. Route to
      // runWalletSanctionsOnly so a NULL-enforcement product still screens its
      // payment signer (identical to the no-gate dispatch above). The floor is a
      // no-op for non-wallet flows (no apiKey, or no extractable signer on Stripe
      // SPT / card), so this never forces a wallet onto a free/card/no-signer settle.
      if (policyOverride === null) return this.runWalletSanctionsOnly(ctx);
    }
    const coreOpts: AgentScoreCoreOptions = {
      apiKey: gate.apiKey,
      ...(gate.baseUrl !== undefined && { baseUrl: gate.baseUrl }),
      ...(gate.userAgent !== undefined && { userAgent: gate.userAgent }),
      // Compliance fields come from effPolicy — the per-issuer override for the verified AIT's
      // issuer when one is configured, else the gate defaults (see effPolicy above). A whole-
      // policy replacement: an issuer override of `{ requireKyc, minAge }` sends ONLY those,
      // so sanctions / jurisdiction are not enforced for that issuer.
      ...(effPolicy.requireKyc !== undefined && { requireKyc: effPolicy.requireKyc }),
      ...(effPolicy.requireSanctionsClear !== undefined && { requireSanctionsClear: effPolicy.requireSanctionsClear }),
      ...(effPolicy.minAge !== undefined && { minAge: effPolicy.minAge }),
      ...(effPolicy.blockedJurisdictions !== undefined && { blockedJurisdictions: effPolicy.blockedJurisdictions }),
      ...(effPolicy.allowedJurisdictions !== undefined && { allowedJurisdictions: effPolicy.allowedJurisdictions }),
      ...(gate.failOpen !== undefined && { failOpen: gate.failOpen }),
      ...(gate.cacheSeconds !== undefined && { cacheSeconds: gate.cacheSeconds }),
      ...(gate.chain !== undefined && { chain: gate.chain }),
      // Surface AIP acceptance in the missing-identity recovery instructions + agent_memory
      // hint so agents holding an AIT learn they can present it instead of bootstrapping.
      ...(gate.aip !== undefined && { aipTrustedIssuers: aipTrustedIssuerSet(gate.aip) }),
      // Auto-default `createSessionOnMissing` from gate config when the merchant
      // didn't supply one, so every gated route gets the bootstrap session-mint UX
      // out of the box. Merchants who need custom session context or onBeforeSession
      // side effects (goods merchants pre-minting an order_id) supply their own config.
      createSessionOnMissing: (gate.createSessionOnMissing as unknown as CreateSessionOnMissing | undefined) ?? {
        apiKey: gate.apiKey,
        ...(gate.baseUrl !== undefined && { baseUrl: gate.baseUrl }),
        ...(gate.context !== undefined && { context: gate.context }),
        ...(gate.merchantName !== undefined && { productName: gate.merchantName }),
      },
      ...(policyOverride ?? {}),
    };

    const core = createAgentScoreCore(coreOpts);

    // headers / walletAddress / operatorToken / aipToken were resolved in the AIP pre-step
    // above (which runs before the no-apiKey fallback). AIT wins when present; else wallet/operator.
    const identity: AgentIdentity | undefined =
      aipToken !== undefined
        ? { aipToken, ...(aipSignature !== undefined && { aipSignature }) }
        : walletAddress !== undefined || operatorToken !== undefined
          ? {
              ...(walletAddress !== undefined && { address: walletAddress }),
              ...(operatorToken !== undefined && { operatorToken }),
            }
          : undefined;
    const x402Header = headers['payment-signature'] ?? headers['x-payment'];
    const signer = await extractPaymentSignerFromAuth(headers['authorization'], x402Header);
    const outcome: EvaluateOutcome = await core.evaluate(identity, ctx, signer);

    if (outcome.kind === 'allow') {
      // Stash captureWallet on ctx so onSettled can link the signer wallet to
      // the operator credential without needing a framework-specific Context.
      // No-op for wallet-authenticated requests (no operator_token to bind).
      if (operatorToken !== undefined) {
        const opToken = operatorToken;
        ctx.captureWallet = async (opts) => {
          await core.captureWallet({
            operatorToken: opToken,
            walletAddress: opts.walletAddress,
            network: opts.network,
            ...(opts.idempotencyKey !== undefined && { idempotencyKey: opts.idempotencyKey }),
          });
        };
      }
      // Post-allow signer-match enforcement: the API composed signer_match on
      // the assess call when a signer was extracted; convert non-pass verdicts
      // into wallet_signer_mismatch / wallet_auth_requires_wallet_signing
      // denials so the gate enforces wallet binding inline (no separate hook).
      // Signer-match enforcement applies only to the wallet identity path. On the AIT path the
      // identity is the token (PoP-bound via cnf) and assess was keyed by aip_token, so there is
      // no address-keyed signer verdict to read — the wallet binding for AITs is the IdP's
      // `payment.signer` claim, enforced server-side. Guarding on aipToken===undefined keeps
      // this from being dead code that silently no-ops on a cache miss.
      if (aipToken === undefined && walletAddress !== undefined) {
        const sm = outcome.signerVerdict?.signer_match;
        if (sm && sm.kind !== 'pass') {
          const reason: DenialReason = sm.kind === 'wallet_auth_requires_wallet_signing'
            ? {
                code: 'wallet_auth_requires_wallet_signing',
                expected_signer: sm.claimedWallet,
                agent_instructions: sm.agentInstructions,
              }
            : {
                code: 'wallet_signer_mismatch',
                ...(sm.claimedOperator !== null && { claimed_operator: sm.claimedOperator }),
                actual_signer_operator: sm.actualSignerOperator,
                expected_signer: sm.expectedSigner,
                actual_signer: sm.actualSigner,
                ...(sm.linkedWallets.length > 0 && { linked_wallets: sm.linkedWallets }),
                agent_instructions: sm.agentInstructions,
              };
          if (gate.onDenied !== undefined) {
            const custom = await gate.onDenied(ctx, reason);
            if (custom !== null) return custom;
          }
          const body = denialReasonToBody(reason);
          return { status: 403, body: body as Record<string, unknown> };
        }
      }
      return null;
    }

    const reason = outcome.reason;
    if (gate.onDenied !== undefined) {
      const custom = await gate.onDenied(ctx, reason);
      if (custom !== null) return custom;
    }
    const body = denialReasonToBody(reason);
    // AIT-input denial (a verified AIT that /v1/assess then denied): emit the AgentScore body as
    // an RFC 9457 + AIP-spec SUPERSET so the response is both schemes at once — the rich
    // AgentScore `{ error, agent_instructions, ... }` AND the spec's `type`/`title`/`status`/
    // `detail` (+ escalation). `application/problem+json` so spec consumers content-negotiate it.
    // The wallet / operator-token paths (aipToken undefined) keep the bare AgentScore body +
    // application/json (the renderers' default), untouched.
    if (aipToken !== undefined) {
      const superset = buildAipPolicyDenyBody(reason.code, reason.reasons, body, {
        trustedIssuers: gate.aip !== undefined ? aipTrustedIssuerSet(gate.aip) : undefined,
        requiredClaims: aipRequiredClaims(effPolicy),
        ...(gate.aip?.requireTrustLevel !== undefined && { requiredTrustLevel: gate.aip.requireTrustLevel }),
        ...(gate.aip?.requireAmr !== undefined && { requiredAmr: gate.aip.requireAmr }),
      });
      return {
        status: superset.status as number,
        body: superset,
        headers: { 'content-type': 'application/problem+json' },
      };
    }
    const status =
      reason.code === 'token_expired' || reason.code === 'invalid_credential'
        ? 401
        : reason.code === 'api_error'
          ? 503
          : 403;
    return { status, body: body as Record<string, unknown> };
  }

  /**
   * Wallet OFAC SDN enforcement.
   *
   * Runs on settle (payment header present) when either `this.gate` is
   * undefined OR a gate is configured but has no `apiKey` to reach
   * `/v1/assess` for full policy enforcement (fallback to the
   * strict-liability default).
   *
   * Env knobs:
   *   - `AGENTSCORE_API_KEY` — required. No key → one-time warning + skip
   *     (dev/testnet pattern; production should always configure a key).
   *   - `AGENTSCORE_BASE_URL` — optional override for staging/dev API
   *     (e.g. `https://api.staging.example` or `http://localhost:3002`).
   *
   * Stripe SPT (no extractable wallet signer) → skip silently; Stripe runs
   * its own OFAC screen on the buyer's Stripe account at customer creation.
   *
   * Calls `/v1/assess` with the signer wallet as both the primary address
   * and the signer block. The API enforces signer-sanctions unconditionally
   * when a signer is present (no policy flag needed). Denies on OFAC SDN
   * hit; fail-closed on unavailable lookup (strict liability — falsely
   * allowing a sanctioned settle is an OFAC violation, falsely denying a
   * clean buyer is just bad UX).
   */
  private async runWalletSanctionsOnly(ctx: CheckoutContext): Promise<GateDenial | null> {
    // Prefer the gate's own apiKey when present, else the env var — symmetric with
    // python's `_run_wallet_sanctions_only` (gate.api_key or env). In practice this is
    // reached only when the gate has no apiKey, so both resolve to the env var.
    const apiKey = this.gate?.apiKey ?? process.env.AGENTSCORE_API_KEY;
    if (!apiKey) {
      warnMissingApiKeyOnce('checkout');
      return null;
    }

    const headers = normalizeHeadersToLowercase(ctx.request.headers);
    const x402Header = headers['payment-signature'] ?? headers['x-payment'];
    const signer = await extractPaymentSignerFromAuth(headers['authorization'], x402Header);
    if (!signer) {
      // Stripe SPT path — no wallet signer, no OFAC check possible. Stripe
      // screens its own customer accounts; we have nothing to add here.
      return null;
    }

    const baseUrl = process.env.AGENTSCORE_BASE_URL;
    const core = createAgentScoreCore({
      apiKey,
      ...(baseUrl !== undefined && { baseUrl }),
    });
    // Pass the signer wallet as both the claimed address AND the signer block.
    // The API resolves the operator (likely null for unclaimed wallets), skips
    // identity policy (we set none), and enforces signer-sanctions (OFAC SDN)
    // on the signer block.
    const outcome = await core.evaluate(
      { address: signer.address },
      ctx,
      signer,
    );
    if (outcome.kind === 'allow') return null;

    const reason = outcome.reason;
    const body = denialReasonToBody(reason);
    const status =
      reason.code === 'token_expired' || reason.code === 'invalid_credential'
        ? 401
        : reason.code === 'api_error'
          ? 503
          : 403;
    return { status, body: body as Record<string, unknown> };
  }


  private async handleZeroSettle(
    ctx: CheckoutContext,
    rail: ZeroSettleRail,
  ): Promise<CheckoutResult | null> {
    if (!this.zeroSettleCarveOut || ctx.pricing === null) return null;
    // Gate on the REAL amount, not cents. `Math.round(amountUsd * 100)` rounds a sub-cent
    // NON-zero price (e.g. $0.002 → 0 cents) to zero and would skip the on-chain settle while
    // still delivering the goods — a free-goods bypass. Only a genuine $0 price takes the
    // carve-out. Matches python `checkout.py` (`amount_usd == 0`).
    if (ctx.pricing.amountUsd !== 0) return null;
    const headers = normalizeHeadersToLowercase(ctx.request.headers);
    let zero;
    let railKey: string;
    if (rail === 'x402-base') {
      // Verify the signature + payTo binding before honoring the carve-out (parity
      // with python's _handle_zero_settle): the recovered signer feeds wallet-capture
      // attribution and onSettled, so it must come from a verified payload.
      const fakeRequest = new Request(ctx.request.url, {
        method: ctx.request.method,
        headers: ctx.request.headers,
      });
      const verified = await verifyX402Request({
        request: fakeRequest,
        isCachedAddress: (addr) => this.asyncIsCachedAddress(addr, ctx),
        acceptedNetwork: this.x402BaseNetwork ?? '',
      });
      if (!verified.ok) {
        return {
          status: verified.status,
          body: verified.body,
          headers: {},
          referenceId: ctx.referenceId,
          settled: false,
          settlePhase: 'verify_failed',
        };
      }
      zero = zeroAmountCarveOut({ rail, payload: verified.payload });
      railKey = this.x402RailKey();
    } else {
      zero = zeroAmountCarveOut({ rail, authorizationHeader: headers['authorization'] });
      // No receipt is minted on the $0 path, so the receipt-method derivation in
      // handleMppx can't run. Resolve the rails key from the bound credential's
      // signer network instead of the primary-MPP default, so Solana zero-settles
      // don't report under the Tempo key (and vice versa).
      railKey =
        (zero.signerNetwork !== null
          ? this.railsKeyForMppxMethod(zero.signerNetwork === 'solana' ? 'solana' : 'tempo')
          : undefined) ?? this.mppRailKey();
    }
    const outcome: SettleOutcome = {
      rail: rail === 'x402-base' ? 'x402' : 'mpp',
      paymentResponseHeader: null,
      paymentReceiptHeader: null,
      raw: zero,
      txHash: null,
      signerAddress: zero.signerAddress,
      signerNetwork: zero.signerNetwork,
      railKey,
    };
    return await this.buildSuccess(ctx, outcome);
  }

  private async mintRefId(request: CheckoutRequest): Promise<string> {
    if (this.mintReferenceId === undefined) return randomUUID();
    const seedCtx: CheckoutContext = { request, referenceId: '', pricing: null, recipients: {}, state: {} };
    return await this.mintReferenceId(seedCtx);
  }

  private async resolveRecipientsForCtx(ctx: CheckoutContext): Promise<Record<string, string>> {
    if (this.mintRecipients === undefined) return ctx.recipients;
    // Idempotent: if a prior call (e.g. pre-compose) already minted, skip.
    if (Object.keys(ctx.recipients).length > 0) return ctx.recipients;
    ctx.recipients = { ...(await this.mintRecipients(ctx)) };
    return ctx.recipients;
  }

  private async asyncIsCachedAddress(address: string, ctx?: CheckoutContext): Promise<boolean> {
    // Merchant-supplied lookup wins (e.g. `piCache.hasAddress` for per-order minting).
    if (this.isCachedAddress !== undefined) return Promise.resolve(this.isCachedAddress(address));
    // Per-request minted recipient (`ctx.recipients['x402_base']` from `mintRecipients`) wins over
    // the construction-time static set. A rail can carry BOTH a static recipient AND `mintRecipients`
    // (static = discovery/sentinel default; per-request mint = the real payTo). Binding to the static
    // set here would reject the legit minted payTo, so the per-request recipient takes precedence —
    // exactly as the compute-first path already does (`expectedPayTo = recipients.x402_base`).
    const minted = ctx?.recipients['x402_base'];
    if (minted !== undefined && minted.length > 0) {
      return address.toLowerCase() === minted.toLowerCase();
    }
    // No custom lookup: bind to the CONFIGURED static recipient(s). The agent controls `payTo`
    // in the x402 payload, so a permissive `true` would let a hostile agent redirect the USDC to
    // their own wallet while still receiving the goods (funds drain). Reject unless the signed
    // `payTo` is exactly a configured static recipient.
    if (this.x402StaticRecipients.size > 0) {
      return this.x402StaticRecipients.has(address.toLowerCase());
    }
    // Pure per-order minting with no `isCachedAddress` supplied: nothing static to bind against.
    // Stays permissive (unchanged behavior) — such merchants are expected to pass `isCachedAddress`.
    return true;
  }

  private async handleX402(ctx: CheckoutContext): Promise<CheckoutResult> {
    const x402Server = await this.getX402Server();
    if (ctx.pricing === null || this.x402BaseNetwork === null || x402Server === undefined) {
      throw new Error('Checkout.handleX402: missing pricing or x402 rail config');
    }
    const fakeRequest = new Request(ctx.request.url, {
      method: ctx.request.method,
      headers: ctx.request.headers,
    });
    const verified = await verifyX402Request({
      request: fakeRequest,
      isCachedAddress: (addr) => this.asyncIsCachedAddress(addr, ctx),
      acceptedNetwork: this.x402BaseNetwork,
    });
    if (!verified.ok) {
      return {
        status: verified.status,
        body: verified.body,
        headers: {},
        referenceId: ctx.referenceId,
        settled: false,
        settlePhase: 'verify_failed',
      };
    }
    const settle = await processX402Settle({
      x402Server,
      payload: verified.payload,
      resourceConfig: {
        scheme: 'exact',
        network: verified.signedNetwork,
        price: `$${ctx.pricing.amountUsd.toFixed(ctx.pricing.decimals ?? 2)}`,
        payTo: verified.signedPayTo,
        maxTimeoutSeconds: 300,
      },
      resourceMeta: {
        url: resolveResourceUrl(ctx.request),
        description: 'Agent purchase via x402',
        mimeType: 'application/json',
      },
    });
    if (!settle.success) {
      // Map each failure phase to its canonical merchant-facing response:
      // verify_failed → 400 payment_proof_invalid, facilitator_error /
      // settle_failed → 503 payment_provider_unavailable, etc.
      const classified = classifyX402SettleResult(settle);
      const responseHeaders: Record<string, string> =
        classified !== null && classified.status >= 500 ? { 'Cache-Control': 'no-store' } : {};
      if (classified !== null) {
        return {
          status: classified.status,
          body: {
            error: { code: classified.code, message: classified.message },
            next_steps: classified.nextSteps,
          },
          headers: responseHeaders,
          referenceId: ctx.referenceId,
          settled: false,
          settlePhase: settle.phase ?? 'settle_failed',
        };
      }
      return {
        status: 400,
        body: buildValidationError({
          code: 'payment_proof_invalid',
          message: `Payment failed during settlement (phase: ${settle.phase ?? 'unknown'}).`,
          nextSteps: { action: 'regenerate_payment_credential' },
          extra: { phase: settle.phase },
        }),
        headers: {},
        referenceId: ctx.referenceId,
        settled: false,
        settlePhase: settle.phase ?? 'settle_failed',
      };
    }
    // Lift the verified signer + tx hash off the settle result so on_settled
    // hooks can persist them without re-parsing the credential.
    const settleRes = (settle as { settleResult?: { transaction?: string; payer?: string } })
      .settleResult ?? {};
    const verifiedFrom = (
      (verified.payload as { payload?: { authorization?: { from?: string } } }).payload
        ?.authorization?.from ?? null
    );
    const signerAddress = verifiedFrom !== null ? verifiedFrom.toLowerCase() : (settleRes.payer ?? null);
    const outcome: SettleOutcome = {
      rail: 'x402',
      paymentResponseHeader: settle.paymentResponseHeader ?? null,
      paymentReceiptHeader: null,
      raw: settle,
      txHash: settleRes.transaction ?? null,
      signerAddress,
      signerNetwork: signerAddress !== null ? 'evm' : null,
      railKey: this.x402RailKey(),
    };
    return await this.buildSuccess(ctx, outcome);
  }

  private async handleMppx(ctx: CheckoutContext): Promise<CheckoutResult> {
    if (this.composeMppx === undefined) {
      throw new Error('Checkout.handleMppx: composeMppx hook not configured');
    }
    // Wrap the compose call so we capture any inner verification error mppx
    // swallows on the 402 path (e.g., Tempo's `KeyNotFound` keychain rejection).
    // See `runWithMppxFailureCapture` for the why.
    const { result: composed, failureReason } = await runWithMppxFailureCapture(async () =>
      this.composeMppx!(ctx),
    );
    if (composed.status === 200) {
      const paymentReceiptHeader =
        composed.paymentReceiptHeader ?? extractMppxReceiptHeaderFromRaw(composed.raw);
      const directMethod = (composed.raw as { receipt?: { method?: string } } | undefined)
        ?.receipt?.method;
      const headerMethod = paymentReceiptHeader
        ? await extractMppxReceiptMethod(paymentReceiptHeader)
        : undefined;
      const receiptMethod = directMethod ?? headerMethod;
      const derivedKey =
        typeof receiptMethod === 'string'
          ? this.railsKeyForMppxMethod(receiptMethod)
          : undefined;
      const outcome: SettleOutcome = {
        rail: 'mpp',
        paymentResponseHeader: composed.paymentResponseHeader ?? null,
        paymentReceiptHeader,
        raw: composed.raw,
        txHash: composed.txHash ?? null,
        signerAddress: composed.signerAddress ?? null,
        signerNetwork: composed.signerNetwork ?? null,
        railKey: derivedKey ?? composed.railKey ?? this.mppRailKey(),
      };
      return await this.buildSuccess(ctx, outcome);
    }
    // handleMppx is only invoked when an `Authorization: Payment` header was
    // present, so a 402 here means mppx REJECTED the credential. Try to
    // classify the swallowed inner error (e.g. Tempo `KeyNotFound`) into a
    // typed envelope agents can route on; fall back to the generic
    // `payment_proof_invalid` regenerate hint otherwise.
    const classified = classifyMppxFailure(failureReason);
    if (classified !== null) {
      return {
        status: classified.status,
        body: buildValidationError({
          code: classified.code,
          message: classified.message,
          nextSteps: classified.nextSteps,
          ...(classified.extra && { extra: classified.extra }),
        }),
        headers: { ...(composed.headers ?? {}) },
        referenceId: ctx.referenceId,
        settled: false,
        settlePhase: 'verify_failed',
      };
    }
    return {
      status: 400,
      body: buildValidationError({
        code: 'payment_proof_invalid',
        message: 'MPP credential rejected; regenerate from a fresh 402 challenge.',
        nextSteps: { action: 'regenerate_payment_credential' },
      }),
      headers: { ...(composed.headers ?? {}) },
      referenceId: ctx.referenceId,
      settled: false,
      settlePhase: 'verify_failed',
    };
  }

  private async emit402(
    ctx: CheckoutContext,
    mppxHeaders: Record<string, string> = {},
  ): Promise<CheckoutResult> {
    if (ctx.pricing === null) {
      throw new Error('Checkout.emit402: pricing not computed');
    }
    await this.resolveRecipientsForCtx(ctx);
    let emitRails = applyRecipientOverrides(this.rails, ctx.recipients);

    // Auto-drop stripe when priced below Stripe's $0.50 USD minimum so the
    // emitted accepted_methods + how_to_pay stay consistent with what mppx's
    // compose layer will actually accept (see buildMppxComposeRails). Without
    // this, the 402 body advertises a stripe rail that has no matching
    // WWW-Authenticate challenge — agents see it offered but any SPT pay
    // attempt fails. The compose-time auto-drop emits the user-facing warn;
    // here we just strip the slot from the discovery body.
    if (ctx.pricing.amountUsd < STRIPE_MIN_CHARGE_USD && emitRails.stripe !== undefined) {
      const { stripe: _stripe, ...rest } = emitRails;
      emitRails = rest;
    }

    const accepted = await buildAcceptedMethods({
      tempo: pickRail<TempoRailSpec>(emitRails, 'tempo'),
      x402_base: pickRail<X402BaseRailSpec>(emitRails, 'x402_base'),
      solana_mpp: pickRail<SolanaMppRailSpec>(emitRails, 'solana_mpp'),
      stripe: pickRail<StripeRailSpec>(emitRails, 'stripe'),
    });
    const howToPayRails: Record<
      string,
      TempoRailSpec | X402BaseRailSpec | SolanaMppRailSpec | StripeRailSpec
    > = {};
    for (const [k, v] of Object.entries(emitRails)) {
      if (!isTempoSessionRailSpec(v)) {
        howToPayRails[k] = v as
          | TempoRailSpec
          | X402BaseRailSpec
          | SolanaMppRailSpec
          | StripeRailSpec;
      }
    }
    const pricingDecimals = ctx.pricing.decimals ?? 2;
    const howToPay = buildHowToPay({
      url: this.url,
      retryBodyJson: JSON.stringify(ctx.request.body),
      totalUsd: ctx.pricing.amountUsd.toFixed(pricingDecimals),
      rails: howToPayRails,
      // Merchants without an identity-bearing policy flag get clean commands
      // without an X-Operator-Token header — agents don't need one to satisfy
      // wallet OFAC enforcement (the always-on default).
      ...(this.hasIdentityGate() ? {} : { opTokenPlaceholder: null }),
      ...(ctx.pricing.decimals !== undefined && { decimals: ctx.pricing.decimals }),
    });
    const pricingBlock =
      ctx.pricing.block ??
      buildPricingBlock({
        subtotalCents: ctx.pricing.amountUsd * 100,
        currency: ctx.pricing.currency ?? 'USD',
        ...(ctx.pricing.decimals !== undefined && { decimals: ctx.pricing.decimals }),
      });
    // Build x402 accepts BEFORE the body so they appear both in the rich body
    // (agents read JSON) AND in the PAYMENT-REQUIRED header (x402-spec clients).
    let x402Accepts: unknown[] = [];
    let x402Resource: X402ResourceInfo | undefined;
    const baseNetwork = this.x402BaseNetwork;
    const x402Server = await this.getX402Server();
    if (x402Server !== undefined && baseNetwork !== null) {
      const baseSpec = emitRails['x402_base'] as X402BaseRailSpec | undefined;
      if (baseSpec !== undefined) {
        const recipient = await resolveRecipientValue(baseSpec.recipient);
        try {
          x402Accepts = await buildX402AcceptsFor402(x402Server, {
            network: baseNetwork,
            price: `$${ctx.pricing.amountUsd.toFixed(pricingDecimals)}`,
            payTo: recipient,
            maxTimeoutSeconds: 300,
          });
          x402Resource = {
            url: resolveResourceUrl(ctx.request),
            mimeType: 'application/json',
            ...(this.resourceInfo?.description !== undefined && { description: this.resourceInfo.description }),
            ...(this.resourceInfo?.serviceName !== undefined && { serviceName: this.resourceInfo.serviceName }),
            ...(this.resourceInfo?.tags !== undefined && { tags: this.resourceInfo.tags }),
            ...(this.resourceInfo?.iconUrl !== undefined && { iconUrl: this.resourceInfo.iconUrl }),
          };
        } catch {
          // Facilitator/scheme build failure: drop x402 from accepts but keep
          // other rails in the body. Merchant logs internally.
          x402Accepts = [];
        }
      }
    }

    // Pre-advertise wallet-mode signer constraint when the request shows
    // wallet intent. Saves agents a round trip: they learn required_signer +
    // linked_wallets at discovery instead of at the 403 on retry.
    const identityMetadata = resolveIdentityMetadata(ctx);

    // Enrich the declared Bazaar discovery extension with the request method +
    // route so info.input.method (required by the v2 discovery schema) and
    // routeTemplate get populated, matching the reference x402 server flow.
    let requestPath = ctx.request.url;
    try {
      requestPath = new URL(resolveResourceUrl(ctx.request)).pathname;
    } catch {
      /* malformed url: fall back to the raw url */
    }
    const enrichedExtensions = await enrichBazaarDiscoveryExtensions(this.discoveryExtensions, {
      method: ctx.request.method,
      path: requestPath,
    });

    const body = build402Body({
      acceptedMethods: accepted,
      agentInstructions: buildAgentInstructions({ howToPay }),
      ...(identityMetadata !== undefined ? { identityMetadata } : {}),
      pricing: pricingBlock,
      amountUsd: ctx.pricing.amountUsd.toFixed(pricingDecimals),
      retryBody: ctx.request.body,
      // Merchants without an identity-bearing gate get a clean 402: no
      // AgentScore-identity bootstrap describing a verification flow they
      // don't run. Wallet OFAC (the always-on default) doesn't need it. When the
      // merchant accepts AIP, advertise the agent_identity path too (AgentScore's
      // own issuer is always trusted, so this fires even with no external issuers).
      agentMemory: firstEncounterAgentMemory({
        firstEncounter: this.hasIdentityGate(),
        ...(this.gate?.aip !== undefined && { aipTrustedIssuers: aipTrustedIssuerSet(this.gate.aip) }),
      }),
      ...(ctx.pricing.product ? { product: ctx.pricing.product as { id: string; name: string } } : {}),
      ...(ctx.pricing.bodyExtras ? { extra: ctx.pricing.bodyExtras } : {}),
      ...(x402Accepts.length > 0 ? {
        x402: {
          accepts: x402Accepts,
          ...(x402Resource ? { resource: x402Resource } : {}),
          ...(enrichedExtensions !== undefined && Object.keys(enrichedExtensions).length > 0
            ? { extensions: enrichedExtensions }
            : {}),
        },
      } : {}),
    });

    let x402Block: Parameters<typeof respond402>[0]['x402'];
    if (x402Accepts.length > 0) {
      x402Block = {
        x402Version: 2,
        accepts: x402Accepts,
        ...(x402Resource ? { resource: x402Resource } : {}),
        ...(enrichedExtensions !== undefined && Object.keys(enrichedExtensions).length > 0
          ? { extensions: enrichedExtensions }
          : {}),
      };
    }

    const respond = respond402({
      mppxChallengeHeaders: mppxHeaders,
      body,
      x402: x402Block,
    });
    return {
      status: respond.status,
      body: respond.body,
      headers: respond.headers,
      referenceId: ctx.referenceId,
      settled: false,
    };
  }

  private async buildSuccess(
    ctx: CheckoutContext,
    outcome: SettleOutcome,
  ): Promise<CheckoutResult> {
    let customBody: Record<string, unknown> | null = null;
    if (this.onSettled !== undefined) {
      const result = await this.onSettled(ctx, outcome);
      if (result !== null && typeof result === 'object') customBody = result;
    }
    const body: Record<string, unknown> = customBody ?? { ok: true };
    if (!('reference_id' in body)) body.reference_id = ctx.referenceId;
    const headers: Record<string, string> = {};
    if (outcome.paymentResponseHeader) {
      headers['payment-response'] = outcome.paymentResponseHeader;
    }
    if (outcome.paymentReceiptHeader) {
      headers['payment-receipt'] = outcome.paymentReceiptHeader;
    }
    return {
      status: 200,
      body,
      headers,
      referenceId: ctx.referenceId,
      settled: true,
    };
  }
}

async function resolveRecipientValue(r: RecipientLike): Promise<string> {
  return await resolveRecipient(r);
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation-envelope helpers + per-framework wrappers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Framework-neutral 4xx envelope (`{ error, next_steps, agent_instructions }`).
 *
 * Returns the body dict; merchants wrap in their framework's JSON response.
 * The per-framework `validationResponse*` helpers do this for you.
 */
export function validationEnvelope(opts: {
  code: string;
  message: string;
  action?: string;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const action = opts.action ?? 'fix_request';
  return buildValidationError({
    code: opts.code,
    message: opts.message,
    nextSteps: { action, user_message: opts.message },
    extra: opts.extra,
  });
}

interface ValidationResponseInput {
  code: string;
  message: string;
  action?: string;
  status?: number;
  extra?: Record<string, unknown>;
}

/** Hono one-liner; returns a `Response` via `c.json`-equivalent semantics. */
export function validationResponseHono(input: ValidationResponseInput): Response {
  const status = input.status ?? 400;
  const body = validationEnvelope(input);
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Express helper; writes the response on the supplied `res`. Returns `void`
 * to match Express convention.
 */
export function validationResponseExpress(
  res: { status: (code: number) => unknown; json: (body: unknown) => unknown },
  input: ValidationResponseInput,
): void {
  const status = input.status ?? 400;
  const body = validationEnvelope(input);
  res.status(status);
  res.json(body);
}

/** Fastify helper; writes on the supplied `reply` and returns it for chaining. */
export function validationResponseFastify(
  reply: { code: (code: number) => unknown; send: (body: unknown) => unknown },
  input: ValidationResponseInput,
): unknown {
  const status = input.status ?? 400;
  const body = validationEnvelope(input);
  reply.code(status);
  return reply.send(body);
}

/** Next.js helper; returns a `Response` (interchangeable with NextResponse.json). */
export function validationResponseNextjs(input: ValidationResponseInput): Response {
  return validationResponseHono(input);
}

/** Web Fetch helper; returns a standard `Response`. */
export function validationResponseWeb(input: ValidationResponseInput): Response {
  return validationResponseHono(input);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-framework adapters on Checkout
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resource URL for the x402 402, scheme-corrected for TLS-terminating edge proxies.
 * Behind ALB / CloudFront the inbound `request.url` is `http://`; x402 discovery
 * requires `https://`, so honor `X-Forwarded-Proto` (the proxy's original scheme).
 */
function resolveResourceUrl(request: CheckoutRequest): string {
  return applyForwardedProto(request.url, readForwardedProto(request.headers));
}

function stripContentType(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== 'content-type') out[k] = v;
  }
  return out;
}

/**
 * The explicitly-set `content-type` from a result's headers, or `undefined` when none was set.
 * Only the AIP deny paths set one (`application/problem+json`, for both the edge-deny and the
 * policy-deny superset, so they content-negotiate as RFC 9457). Every other response leaves it
 * unset — callers fall back to `application/json` WITHOUT mutating the response otherwise, so the
 * non-AIP paths are byte-for-byte unchanged.
 */
function explicitContentType(headers: Record<string, string>): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'content-type') return v;
  }
  return undefined;
}


function headersToRecord(h: Headers | Record<string, string> | undefined): Record<string, string> {
  if (h === undefined) return {};
  if (h instanceof Headers) {
    const out: Record<string, string> = {};
    h.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  return { ...h };
}

declare module './checkout' {
  // No-op; module-augmentation placeholder. The handler methods live on the
  // Checkout class via prototype extension below to keep the constructor block
  // readable in this large file.
}

// Hono adapter: takes a Hono `Context` (loose-typed to avoid hard-importing).
(Checkout.prototype as unknown as {
  handleHono: (
    this: Checkout,
    c: {
      req: {
        method: string;
        url: string;
        raw?: Request;
        header: (name?: string) => string | Record<string, string> | undefined;
        json: () => Promise<unknown>;
      };
      json: (body: unknown, status?: number, headers?: Record<string, string>) => Response;
      body: (body: string, status?: number, headers?: Record<string, string>) => Response;
    },
    body?: Record<string, unknown>,
  ) => Promise<Response>;
}).handleHono = async function (c, body) {
  let parsedBody: Record<string, unknown>;
  if (body !== undefined) {
    parsedBody = body;
  } else {
    try {
      parsedBody = (await c.req.json()) as Record<string, unknown>;
    } catch {
      // Empty / unparseable body must reach handle(), not 400 before it: x402
      // discovery validators probe with an empty body and no payment header and
      // require the 402 challenge. Treat it as {} and let handle() decide; body
      // validation runs on the paid leg (preValidate / gate).
      parsedBody = {};
    }
  }
  const rawHeaders = c.req.header() as Record<string, string> | undefined;
  const headers = headersToRecord(rawHeaders);
  const result = await this.handle({
    method: c.req.method,
    url: c.req.url,
    headers,
    body: parsedBody,
    assess: null,
    raw: c.req.raw ?? c,
  });
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'Content-Type': explicitContentType(result.headers) ?? 'application/json', ...stripContentType(result.headers) },
  });
};

// Express adapter: takes `req` + `res`. Writes to `res`; returns void.
(Checkout.prototype as unknown as {
  handleExpress: (
    this: Checkout,
    req: {
      method: string;
      originalUrl?: string;
      url?: string;
      headers: Record<string, string | string[] | undefined>;
      body?: unknown;
    },
    res: {
      status: (code: number) => unknown;
      setHeader: (name: string, value: string) => unknown;
      json: (body: unknown) => unknown;
    },
    body?: Record<string, unknown>,
  ) => Promise<void>;
}).handleExpress = async function (req, res, body) {
  // Empty / non-object body falls through to handle() as {} (see handleHono):
  // x402 discovery probes must reach the 402 paywall, not 400 at the adapter.
  const parsedBody =
    body ?? (typeof req.body === 'object' && req.body !== null ? (req.body as Record<string, unknown>) : {});
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers[k] = v;
    else if (Array.isArray(v) && v[0] !== undefined) headers[k] = v[0];
  }
  const url = req.originalUrl ?? req.url ?? '/';
  const result = await this.handle({
    method: req.method,
    url,
    headers,
    body: parsedBody,
    assess: null,
    raw: req,
  });
  for (const [k, v] of Object.entries(stripContentType(result.headers))) res.setHeader(k, v);
  // Honor an explicit content-type (AIP problem+json) — setting it before json() makes Express
  // respect it instead of forcing application/json. Only the AIP path sets one, so non-AIP
  // responses are untouched (res.json defaults to application/json as before).
  const ct = explicitContentType(result.headers);
  if (ct !== undefined) res.setHeader('Content-Type', ct);
  res.status(result.status);
  res.json(result.body);
};

// Fastify adapter: takes `request` + `reply`.
(Checkout.prototype as unknown as {
  handleFastify: (
    this: Checkout,
    request: {
      method: string;
      url: string;
      headers: Record<string, string | string[] | undefined>;
      body?: unknown;
    },
    reply: {
      code: (code: number) => unknown;
      header: (name: string, value: string) => unknown;
      send: (body: unknown) => unknown;
    },
    body?: Record<string, unknown>,
  ) => Promise<unknown>;
}).handleFastify = async function (request, reply, body) {
  // Empty / non-object body falls through to handle() as {} (see handleHono).
  const parsedBody =
    body ?? (typeof request.body === 'object' && request.body !== null
      ? (request.body as Record<string, unknown>)
      : {});
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(request.headers)) {
    if (typeof v === 'string') headers[k] = v;
    else if (Array.isArray(v) && v[0] !== undefined) headers[k] = v[0];
  }
  const result = await this.handle({
    method: request.method,
    url: request.url,
    headers,
    body: parsedBody,
    assess: null,
    raw: request,
  });
  for (const [k, v] of Object.entries(stripContentType(result.headers))) reply.header(k, v);
  reply.code(result.status);
  // Honor an explicit content-type (AIP problem+json): set it + send a pre-serialized string so
  // Fastify emits the body verbatim under the chosen content-type instead of forcing
  // application/json via its object serializer. The string is valid JSON, so parsers still read it
  // back. Non-AIP responses keep the object path (Fastify serializes + sets application/json).
  const ct = explicitContentType(result.headers);
  if (ct !== undefined) {
    reply.header('content-type', ct);
    return reply.send(JSON.stringify(result.body));
  }
  return reply.send(result.body);
};

// Next.js / Web Fetch adapter: takes a standard `Request`, returns `Response`.
(Checkout.prototype as unknown as {
  handleNextjs: (this: Checkout, request: Request, body?: Record<string, unknown>) => Promise<Response>;
}).handleNextjs = async function (request, body) {
  let parsedBody: Record<string, unknown>;
  if (body !== undefined) {
    parsedBody = body;
  } else {
    try {
      parsedBody = (await request.json()) as Record<string, unknown>;
    } catch {
      // See handleHono: empty / unparseable body falls through to the paywall.
      parsedBody = {};
    }
  }
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const result = await this.handle({
    method: request.method,
    url: request.url,
    headers,
    body: parsedBody,
    assess: null,
    raw: request,
  });
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'Content-Type': explicitContentType(result.headers) ?? 'application/json', ...stripContentType(result.headers) },
  });
};

// `handleWeb` is an alias for `handleNextjs`; both consume Web Fetch Requests.
(Checkout.prototype as unknown as {
  handleWeb: (this: Checkout, request: Request, body?: Record<string, unknown>) => Promise<Response>;
}).handleWeb = (Checkout.prototype as unknown as {
  handleNextjs: (this: Checkout, request: Request, body?: Record<string, unknown>) => Promise<Response>;
}).handleNextjs;

// Type-declare the new methods so consumers see them through Checkout's interface.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface Checkout {
  handleHono(
    c: {
      req: {
        method: string;
        url: string;
        raw?: Request;
        header: (name?: string) => string | Record<string, string> | undefined;
        json: () => Promise<unknown>;
      };
      json: (body: unknown, status?: number, headers?: Record<string, string>) => Response;
      body: (body: string, status?: number, headers?: Record<string, string>) => Response;
    },
    body?: Record<string, unknown>,
  ): Promise<Response>;
  handleExpress(
    req: {
      method: string;
      originalUrl?: string;
      url?: string;
      headers: Record<string, string | string[] | undefined>;
      body?: unknown;
    },
    res: {
      status: (code: number) => unknown;
      setHeader: (name: string, value: string) => unknown;
      json: (body: unknown) => unknown;
    },
    body?: Record<string, unknown>,
  ): Promise<void>;
  handleFastify(
    request: {
      method: string;
      url: string;
      headers: Record<string, string | string[] | undefined>;
      body?: unknown;
    },
    reply: {
      code: (code: number) => unknown;
      header: (name: string, value: string) => unknown;
      send: (body: unknown) => unknown;
    },
    body?: Record<string, unknown>,
  ): Promise<unknown>;
  handleNextjs(request: Request, body?: Record<string, unknown>): Promise<Response>;
  handleWeb(request: Request, body?: Record<string, unknown>): Promise<Response>;
  mountUcpRoutesHono(
    app: {
      get: (path: string, handler: (c: { req: { raw: Request } }) => Promise<Response> | Response) => unknown;
      options: (path: string, handler: (c: { req: { raw: Request } }) => Promise<Response> | Response) => unknown;
    },
    opts: MountUcpRoutesOptions,
  ): void;
  mountUcpRoutesExpress(
    app: {
      get: (path: string, handler: (req: { headers: Record<string, string | string[] | undefined> }, res: ExpressLikeRes) => Promise<void> | void) => unknown;
      options: (path: string, handler: (req: { headers: Record<string, string | string[] | undefined> }, res: ExpressLikeRes) => Promise<void> | void) => unknown;
    },
    opts: MountUcpRoutesOptions,
  ): void;
  mountUcpRoutesFastify(
    app: {
      get: (path: string, handler: (request: { headers: Record<string, string | string[] | undefined> }, reply: FastifyLikeReply) => Promise<unknown> | unknown) => unknown;
      options: (path: string, handler: (request: { headers: Record<string, string | string[] | undefined> }, reply: FastifyLikeReply) => Promise<unknown> | unknown) => unknown;
    },
    opts: MountUcpRoutesOptions,
  ): void;
}

interface ExpressLikeRes {
  status: (code: number) => unknown;
  set: (headers: Record<string, string>) => unknown;
  type: (mt: string) => unknown;
  send: (body: string) => unknown;
}

interface FastifyLikeReply {
  code: (code: number) => unknown;
  header: (k: string, v: string) => unknown;
  type: (mt: string) => unknown;
  send: (body: string) => unknown;
}

/** Options for the `mountUcpRoutes<Framework>` helpers — one shape used by all
 *  three adapters. Saves merchants from copy-pasting the same 3-route block
 *  (GET ucp + GET jwks + OPTIONS preflights) every time. */
export interface MountUcpRoutesOptions {
  name: string;
  wellKnownUcpUrl: string;
  services: Record<string, unknown[]>;
  signingKid?: string;
  agentscoreGate?: unknown;
  ucpPath?: string;
  jwksPath?: string;
}

async function _ucpSignedResp(
  checkout: Checkout,
  reqHeaders: Headers,
  opts: MountUcpRoutesOptions,
): Promise<SignedDiscoveryResponse> {
  const { buildSignedUcpResponse } = await import('./discovery/well_known.js');
  return await buildSignedUcpResponse({
    checkout,
    name: opts.name,
    wellKnownUcpUrl: opts.wellKnownUcpUrl,
    services: opts.services as Parameters<typeof buildSignedUcpResponse>[0]['services'],
    requestHeaders: reqHeaders,
    ...(opts.signingKid !== undefined && { signingKid: opts.signingKid }),
    ...(opts.agentscoreGate !== undefined && {
      agentscoreGate: opts.agentscoreGate as Parameters<typeof buildSignedUcpResponse>[0]['agentscoreGate'],
    }),
  });
}

async function _jwksSignedResp(
  reqHeaders: Headers,
  opts: MountUcpRoutesOptions,
): Promise<SignedDiscoveryResponse> {
  const { buildSignedJwksResponse } = await import('./discovery/well_known.js');
  return await buildSignedJwksResponse({
    requestHeaders: reqHeaders,
    ...(opts.signingKid !== undefined && { signingKid: opts.signingKid }),
  });
}

function _preflightResp(reqHeaders: Headers): Response {
  // Use the existing wellKnownPreflightResponse helper (returns Response).
  // It's a sync function so dynamic import is unnecessary here; we already
  // import the module lazily inside the registered handlers.
  return new Response(null, {
    status: 204,
    headers: _preflightHeaders(reqHeaders),
  });
}

function _preflightHeaders(reqHeaders: Headers): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Access-Control-Request-Headers',
  };
  const acrh = reqHeaders.get('access-control-request-headers');
  if (acrh) headers['Access-Control-Allow-Headers'] = acrh;
  return headers;
}

(Checkout.prototype as unknown as {
  mountUcpRoutesHono: (this: Checkout, app: Parameters<Checkout['mountUcpRoutesHono']>[0], opts: MountUcpRoutesOptions) => void;
}).mountUcpRoutesHono = function (app, opts) {
  const ucpPath = opts.ucpPath ?? '/.well-known/ucp';
  const jwksPath = opts.jwksPath ?? '/.well-known/jwks.json';
  // eslint-disable-next-line @typescript-eslint/no-this-alias
  const checkout = this;
  app.get(ucpPath, async (c) => {
    const resp = await _ucpSignedResp(checkout, c.req.raw.headers, opts);
    return new Response(resp.body, {
      status: resp.status,
      headers: { ...resp.headers, 'Content-Type': resp.mediaType },
    });
  });
  app.get(jwksPath, async (c) => {
    const resp = await _jwksSignedResp(c.req.raw.headers, opts);
    return new Response(resp.body, {
      status: resp.status,
      headers: { ...resp.headers, 'Content-Type': resp.mediaType },
    });
  });
  app.options(ucpPath, (c) => _preflightResp(c.req.raw.headers));
  app.options(jwksPath, (c) => _preflightResp(c.req.raw.headers));
};

function _headersFromExpressLike(raw: Record<string, string | string[] | undefined>): Headers {
  const out = new Headers();
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    out.set(k, Array.isArray(v) ? v.join(',') : v);
  }
  return out;
}

(Checkout.prototype as unknown as {
  mountUcpRoutesExpress: (this: Checkout, app: Parameters<Checkout['mountUcpRoutesExpress']>[0], opts: MountUcpRoutesOptions) => void;
}).mountUcpRoutesExpress = function (app, opts) {
  const ucpPath = opts.ucpPath ?? '/.well-known/ucp';
  const jwksPath = opts.jwksPath ?? '/.well-known/jwks.json';
  // eslint-disable-next-line @typescript-eslint/no-this-alias
  const checkout = this;
  app.get(ucpPath, async (req, res) => {
    const resp = await _ucpSignedResp(checkout, _headersFromExpressLike(req.headers), opts);
    res.status(resp.status);
    res.set(resp.headers);
    res.type(resp.mediaType);
    res.send(resp.body);
  });
  app.get(jwksPath, async (req, res) => {
    const resp = await _jwksSignedResp(_headersFromExpressLike(req.headers), opts);
    res.status(resp.status);
    res.set(resp.headers);
    res.type(resp.mediaType);
    res.send(resp.body);
  });
  const preflight = (req: { headers: Record<string, string | string[] | undefined> }, res: ExpressLikeRes) => {
    const reqHeaders = _headersFromExpressLike(req.headers);
    res.status(204);
    res.set(_preflightHeaders(reqHeaders));
    res.send('');
  };
  app.options(ucpPath, preflight);
  app.options(jwksPath, preflight);
};

(Checkout.prototype as unknown as {
  mountUcpRoutesFastify: (this: Checkout, app: Parameters<Checkout['mountUcpRoutesFastify']>[0], opts: MountUcpRoutesOptions) => void;
}).mountUcpRoutesFastify = function (app, opts) {
  const ucpPath = opts.ucpPath ?? '/.well-known/ucp';
  const jwksPath = opts.jwksPath ?? '/.well-known/jwks.json';
  // eslint-disable-next-line @typescript-eslint/no-this-alias
  const checkout = this;
  app.get(ucpPath, async (request, reply) => {
    const resp = await _ucpSignedResp(checkout, _headersFromExpressLike(request.headers), opts);
    reply.code(resp.status);
    for (const [k, v] of Object.entries(resp.headers)) reply.header(k, v);
    reply.type(resp.mediaType);
    return reply.send(resp.body);
  });
  app.get(jwksPath, async (request, reply) => {
    const resp = await _jwksSignedResp(_headersFromExpressLike(request.headers), opts);
    reply.code(resp.status);
    for (const [k, v] of Object.entries(resp.headers)) reply.header(k, v);
    reply.type(resp.mediaType);
    return reply.send(resp.body);
  });
  const preflight = (request: { headers: Record<string, string | string[] | undefined> }, reply: FastifyLikeReply) => {
    const reqHeaders = _headersFromExpressLike(request.headers);
    reply.code(204);
    for (const [k, v] of Object.entries(_preflightHeaders(reqHeaders))) reply.header(k, v);
    return reply.send('');
  };
  app.options(ucpPath, preflight);
  app.options(jwksPath, preflight);
};
