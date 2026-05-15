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
import { denialReasonToBody } from './_response';
import { buildAcceptedMethods } from './challenge/accepted_methods';
import { type RailKey, buildAgentInstructions } from './challenge/agent_instructions';
import { firstEncounterAgentMemory } from './challenge/agent_memory';
import { build402Body } from './challenge/body';
import { buildHowToPay } from './challenge/how_to_pay';
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
import { lazyMppxServer, lazyX402Server } from './payment/lazy';
import { type MppxRailSpec } from './payment/mppx_server';
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
 * Raised from a `preValidate` hook to short-circuit Checkout with a canonical
 * 4xx envelope.
 *
 * Checkout catches this and emits the canonical `{ error, next_steps }` envelope
 * via `buildValidationError` so merchants don't construct response bodies
 * themselves in the pre-validate path.
 */
export class CheckoutValidationError extends Error {
  readonly code: string;
  readonly action: string;
  readonly status: number;
  readonly extra: Record<string, unknown> | undefined;
  constructor(opts: {
    code: string;
    message: string;
    action?: string;
    status?: number;
    extra?: Record<string, unknown>;
  }) {
    super(opts.message);
    this.name = 'CheckoutValidationError';
    this.code = opts.code;
    this.action = opts.action ?? 'fix_request';
    this.status = opts.status ?? 400;
    this.extra = opts.extra;
  }
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
  /** Override the default `https://api.agentscore.sh` base URL. */
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
  /** Full escape hatch — replaces the SDK gate flow. */
  runGate?: RunGateFn;
}

/** Surface passed to `Checkout.onSettled` after a payment lands. */
export interface SettleOutcome {
  /** Protocol family that handled the settle. */
  rail: 'x402' | 'mpp';
  /** The `PAYMENT-RESPONSE` header to echo (x402 success path). `null` for MPP. */
  paymentResponseHeader: string | null;
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

function lowerHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

function hasX402Header(headers: Record<string, string>): boolean {
  const h = lowerHeaders(headers);
  return Boolean(h['payment-signature'] ?? h['x-payment']);
}

function hasMppxHeader(headers: Record<string, string>): boolean {
  const h = lowerHeaders(headers);
  return (h['authorization'] ?? '').startsWith('Payment ');
}

function isStripeRailSpec(s: CheckoutRailSpec): s is StripeRailSpec {
  return !('recipient' in s);
}

function isTempoSessionRailSpec(s: CheckoutRailSpec): s is TempoSessionRailSpec {
  return 'escrowContract' in s && 'store' in s;
}

/** Map a `*RailSpec` instance to its canonical `RailKey` slug. Tempo charge
 *  and Tempo session both speak MPP on Tempo, so they fold to `"tempo_mpp"`. */
function specRailKey(spec: CheckoutRailSpec): RailKey {
  if (isStripeRailSpec(spec)) return 'stripe';
  if (isTempoSessionRailSpec(spec)) return 'tempo_mpp';
  const network = (spec as { network?: string }).network ?? '';
  if (network.startsWith('eip155:')) return 'x402_base';
  if (network.startsWith('solana:') || 'rpcUrl' in spec) return 'solana_mpp';
  return 'tempo_mpp';
}

/** Protocol-shaped method name for the `methods: [...]` discovery array. */
function specMethodName(spec: CheckoutRailSpec): string {
  if (isStripeRailSpec(spec)) return 'stripe/spt';
  if (isTempoSessionRailSpec(spec)) return 'tempo/charge';
  const network = (spec as { network?: string }).network ?? '';
  if (network.startsWith('eip155:')) return 'x402/exact (base)';
  if (network.startsWith('solana:') || 'rpcUrl' in spec) return 'solana/charge';
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
    const lower = lowerHeaders(ctx.request.headers);
    const authorization = lower['authorization'];
    const amountStr = ctx.pricing.amountUsd.toFixed(2);
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
    return {
      status: 200,
      txHash,
      signerAddress,
      signerNetwork,
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
  readonly zeroSettleCarveOut: boolean;
  readonly gate: CheckoutGateConfig | undefined;
  readonly discoveryExtensions: Record<string, unknown> | undefined;
  private _x402ServerGetter: (() => Promise<X402Server>) | undefined;

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
     *  confirm the `payTo` was minted by this merchant. Defaults to permissive. */
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
  }) {
    const x402Server = opts.x402Server;
    let x402ServerGetter: (() => Promise<X402Server>) | undefined;
    if (x402Server === undefined) {
      const baseSpec = Object.values(opts.rails).find(
        (s): s is X402BaseRailSpec =>
          !isTempoSessionRailSpec(s) && !isStripeRailSpec(s) && 'recipient' in s &&
          ((s as { network?: string }).network ?? '').startsWith('eip155:'),
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
    this.zeroSettleCarveOut = opts.zeroSettleCarveOut ?? false;
    this.gate = opts.gate;
    this.discoveryExtensions = opts.discoveryExtensions;
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
      if (!isStripeRailSpec(v) && !isTempoSessionRailSpec(v) &&
          ((v as { network?: string }).network ?? '').startsWith('eip155:')) {
        return k;
      }
    }
    return 'x402_base';
  }

  /** Return the rails-dict key for the primary MPP rail. */
  private mppRailKey(): string {
    for (const [k, v] of Object.entries(this.rails)) {
      const network = (v as { network?: string }).network ?? '';
      if (!isStripeRailSpec(v) && !network.startsWith('eip155:')) return k;
    }
    return 'tempo';
  }

  /** CAIP-2 read from `rails['x402_base'].network` (or its default).
   *  Defined only when an `X402BaseRailSpec` is present in rails AND a server
   *  is configured (explicit or auto-derived); otherwise `null`. */
  get x402BaseNetwork(): string | null {
    if (!this.x402ServerAvailable()) return null;
    for (const spec of Object.values(this.rails)) {
      if (!isStripeRailSpec(spec) && !isTempoSessionRailSpec(spec) &&
          ((spec as { network?: string }).network ?? '').startsWith('eip155:')) {
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

    // 2. Per-request gate. Only fires when a payment header is present (so the
    //    discovery leg stays anonymous-friendly). Merchants can wrap behavior
    //    via `gate.runGate` for full control.
    const hasPaymentHeader =
      hasX402Header(request.headers) || hasMppxHeader(request.headers);
    if (this.gate !== undefined && hasPaymentHeader) {
      const denial = await this.runGate(ctx);
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
    await this.resolveRecipientsForCtx(ctx);

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
    // propagate into the rich 402 emit.
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
    if (gate.apiKey === undefined) return null;

    // Merge per-request policy overrides over the static config.
    let policyOverride: Partial<AgentScoreCoreOptions> | null | undefined;
    if (gate.perRequestPolicy !== undefined) {
      policyOverride = await gate.perRequestPolicy(ctx);
      if (policyOverride === null) return null;
    }
    const coreOpts: AgentScoreCoreOptions = {
      apiKey: gate.apiKey,
      ...(gate.baseUrl !== undefined && { baseUrl: gate.baseUrl }),
      ...(gate.userAgent !== undefined && { userAgent: gate.userAgent }),
      ...(gate.requireKyc !== undefined && { requireKyc: gate.requireKyc }),
      ...(gate.requireSanctionsClear !== undefined && { requireSanctionsClear: gate.requireSanctionsClear }),
      ...(gate.minAge !== undefined && { minAge: gate.minAge }),
      ...(gate.blockedJurisdictions !== undefined && { blockedJurisdictions: gate.blockedJurisdictions }),
      ...(gate.allowedJurisdictions !== undefined && { allowedJurisdictions: gate.allowedJurisdictions }),
      ...(gate.failOpen !== undefined && { failOpen: gate.failOpen }),
      ...(gate.cacheSeconds !== undefined && { cacheSeconds: gate.cacheSeconds }),
      ...(gate.chain !== undefined && { chain: gate.chain }),
      ...(gate.createSessionOnMissing !== undefined && {
        createSessionOnMissing: gate.createSessionOnMissing as unknown as CreateSessionOnMissing,
      }),
      ...(policyOverride ?? {}),
    };

    const core = createAgentScoreCore(coreOpts);
    const headers = lowerHeaders(ctx.request.headers);
    const walletAddress = headers['x-wallet-address'];
    const operatorToken = headers['x-operator-token'];
    const identity: AgentIdentity | undefined =
      walletAddress !== undefined || operatorToken !== undefined
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
      if (walletAddress !== undefined) {
        const verdict = core.getSignerVerdict(walletAddress);
        const sm = verdict?.signer_match;
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
    const cents = Math.round(ctx.pricing.amountUsd * 100);
    if (cents !== 0) return null;
    const headers = lowerHeaders(ctx.request.headers);
    let zero;
    if (rail === 'x402-base') {
      const x402Header = headers['payment-signature'] ?? headers['x-payment'];
      let payload: Record<string, unknown> | null = null;
      if (typeof x402Header === 'string' && x402Header.length > 0) {
        try {
          payload = JSON.parse(atob(x402Header)) as Record<string, unknown>;
        } catch {
          payload = null;
        }
      }
      zero = zeroAmountCarveOut({ rail, payload });
    } else {
      zero = zeroAmountCarveOut({ rail, authorizationHeader: headers['authorization'] });
    }
    const railKey = rail === 'x402-base' ? this.x402RailKey() : this.mppRailKey();
    const outcome: SettleOutcome = {
      rail: rail === 'x402-base' ? 'x402' : 'mpp',
      paymentResponseHeader: null,
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

  private async asyncIsCachedAddress(address: string): Promise<boolean> {
    if (this.isCachedAddress === undefined) return true;
    return Promise.resolve(this.isCachedAddress(address));
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
      isCachedAddress: this.asyncIsCachedAddress.bind(this),
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
        price: `$${ctx.pricing.amountUsd.toFixed(2)}`,
        payTo: verified.signedPayTo,
        maxTimeoutSeconds: 300,
      },
      resourceMeta: {
        url: ctx.request.url,
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
    const composed = await this.composeMppx(ctx);
    if (composed.status === 200) {
      const outcome: SettleOutcome = {
        rail: 'mpp',
        paymentResponseHeader: composed.paymentResponseHeader ?? null,
        raw: composed.raw,
        txHash: composed.txHash ?? null,
        signerAddress: composed.signerAddress ?? null,
        signerNetwork: composed.signerNetwork ?? null,
        railKey: composed.railKey ?? this.mppRailKey(),
      };
      return await this.buildSuccess(ctx, outcome);
    }
    // handleMppx is only invoked when an `Authorization: Payment` header was
    // present, so a 402 here means mppx REJECTED the credential. Surface as
    // 400 payment_proof_invalid (the canonical "regenerate" denial), echoing
    // mppx's fresh WWW-Authenticate so the agent's retry signs against the new
    // directive id.
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
    const emitRails = applyRecipientOverrides(this.rails, ctx.recipients);

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
    const howToPay = buildHowToPay({
      url: this.url,
      retryBodyJson: JSON.stringify(ctx.request.body),
      totalUsd: ctx.pricing.amountUsd.toFixed(2),
      rails: howToPayRails,
    });
    const pricingBlock =
      ctx.pricing.block ??
      buildPricingBlock({
        subtotalCents: Math.round(ctx.pricing.amountUsd * 100),
        currency: ctx.pricing.currency ?? 'USD',
      });
    // Build x402 accepts BEFORE the body so they appear both in the rich body
    // (agents read JSON) AND in the PAYMENT-REQUIRED header (x402-spec clients).
    let x402Accepts: unknown[] = [];
    let x402Resource: { url: string; mimeType: string } | undefined;
    const baseNetwork = this.x402BaseNetwork;
    const x402Server = await this.getX402Server();
    if (x402Server !== undefined && baseNetwork !== null) {
      const baseSpec = emitRails['x402_base'] as X402BaseRailSpec | undefined;
      if (baseSpec !== undefined) {
        const recipient = await resolveRecipientValue(baseSpec.recipient);
        try {
          x402Accepts = await buildX402AcceptsFor402(x402Server, {
            network: baseNetwork,
            price: `$${ctx.pricing.amountUsd.toFixed(2)}`,
            payTo: recipient,
            maxTimeoutSeconds: 300,
          });
          x402Resource = { url: ctx.request.url, mimeType: 'application/json' };
        } catch {
          // Facilitator/scheme build failure: drop x402 from accepts but keep
          // other rails in the body. Merchant logs internally.
          x402Accepts = [];
        }
      }
    }

    const body = build402Body({
      acceptedMethods: accepted,
      agentInstructions: buildAgentInstructions({ howToPay }),
      pricing: pricingBlock,
      amountUsd: ctx.pricing.amountUsd.toFixed(2),
      retryBody: ctx.request.body,
      agentMemory: firstEncounterAgentMemory({ firstEncounter: true }),
      ...(ctx.pricing.product ? { product: ctx.pricing.product as { id: string; name: string } } : {}),
      ...(ctx.pricing.bodyExtras ? { extra: ctx.pricing.bodyExtras } : {}),
      ...(x402Accepts.length > 0 ? {
        x402: {
          accepts: x402Accepts,
          ...(this.discoveryExtensions !== undefined && Object.keys(this.discoveryExtensions).length > 0
            ? { extensions: this.discoveryExtensions }
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

function invalidBodyEnvelope(): Record<string, unknown> {
  return validationEnvelope({
    code: 'invalid_body',
    message: 'Request body must be valid JSON.',
  });
}

function stripContentType(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== 'content-type') out[k] = v;
  }
  return out;
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
      return new Response(JSON.stringify(invalidBodyEnvelope()), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
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
    headers: { 'Content-Type': 'application/json', ...stripContentType(result.headers) },
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
  const parsedBody =
    body ?? (typeof req.body === 'object' && req.body !== null ? (req.body as Record<string, unknown>) : null);
  if (parsedBody === null) {
    res.status(400);
    res.json(invalidBodyEnvelope());
    return;
  }
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
  const parsedBody =
    body ?? (typeof request.body === 'object' && request.body !== null
      ? (request.body as Record<string, unknown>)
      : null);
  if (parsedBody === null) {
    reply.code(400);
    return reply.send(invalidBodyEnvelope());
  }
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
      return new Response(JSON.stringify(invalidBodyEnvelope()), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
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
    headers: { 'Content-Type': 'application/json', ...stripContentType(result.headers) },
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
}
