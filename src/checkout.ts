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
import { buildAcceptedMethods } from './challenge/accepted_methods';
import { buildAgentInstructions } from './challenge/agent_instructions';
import { firstEncounterAgentMemory } from './challenge/agent_memory';
import { build402Body } from './challenge/body';
import { buildHowToPay } from './challenge/how_to_pay';
import { buildPricingBlock, type PricingBlock } from './challenge/pricing';
import { respond402 } from './challenge/respond_402';
import { buildValidationError } from './challenge/validation_error';
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
import { processX402Settle } from './payment/x402_settle';
import { verifyX402Request } from './payment/x402_validation';

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
}

/** Surface passed to `Checkout.onSettled` after a payment lands. */
export interface SettleOutcome {
  rail: 'x402' | 'mpp';
  /** The `PAYMENT-RESPONSE` header to echo (x402 success path). `null` for MPP. */
  paymentResponseHeader: string | null;
  /** The underlying settle result for merchants that need to inspect tx hash / etc. */
  raw: unknown;
}

/** Result a `composeMppx` hook returns when handling an MPP credential.
 *
 *  `status: 200` means mppx validated the `Authorization: Payment` credential
 *  and the settlement landed — Checkout runs `onSettled` and returns success.
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

/**
 * Apply per-call recipient overrides (from `mintRecipients`) to rail specs.
 * Returns a new dict; original rails dict is not mutated. Stripe rails are
 * passed through unchanged (no on-chain recipient — they use `profileId`).
 */
function applyRecipientOverrides(
  rails: Record<string, CheckoutRailSpec>,
  overrides: Record<string, string>,
): Record<string, CheckoutRailSpec> {
  if (Object.keys(overrides).length === 0) return rails;
  const out: Record<string, CheckoutRailSpec> = {};
  for (const [key, spec] of Object.entries(rails)) {
    const override = overrides[key];
    if (override === undefined || isStripeRailSpec(spec)) {
      out[key] = spec;
      continue;
    }
    out[key] = { ...spec, recipient: override } as CheckoutRailSpec;
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
export class Checkout {
  readonly rails: Record<string, CheckoutRailSpec>;
  readonly url: string;
  readonly computePricing: PricingFn;
  readonly x402Server: X402Server | undefined;
  readonly composeMppx: ComposeMppxFn | undefined;
  readonly mintRecipients: RecipientsFn | undefined;
  readonly mintReferenceId: ReferenceIdFn | undefined;
  readonly onSettled: OnSettledFn | undefined;
  readonly isCachedAddress: IsCachedAddressFn | undefined;

  constructor(opts: {
    rails: Record<string, CheckoutRailSpec>;
    url: string;
    computePricing: PricingFn;
    /** Built via `createX402Server`. Pair it with an `X402BaseRailSpec` in
     *  `rails['x402_base']`; the CAIP-2 network is read from `rail.network`. */
    x402Server?: X402Server;
    /** Required when the merchant accepts `Authorization: Payment` credentials. */
    composeMppx?: ComposeMppxFn;
    /** Per-order deposit address minting (e.g. Stripe-multichain). */
    mintRecipients?: RecipientsFn;
    /** Default is `randomUUID()`. */
    mintReferenceId?: ReferenceIdFn;
    /** Runs after a settle lands; can return an inline response body for API sellers. */
    onSettled?: OnSettledFn;
    /** Pass when the merchant mints per-order addresses so `verifyX402Request` can
     *  confirm the `payTo` was minted by this merchant. Defaults to permissive. */
    isCachedAddress?: IsCachedAddressFn;
  }) {
    if (opts.x402Server !== undefined) {
      const baseSpec = opts.rails['x402_base'];
      if (baseSpec === undefined || !('recipient' in baseSpec)) {
        throw new Error(
          "Checkout: x402Server requires an X402BaseRailSpec in rails['x402_base'] " +
            "(the rail's `network` field supplies the CAIP-2).",
        );
      }
    }
    this.rails = opts.rails;
    this.url = opts.url;
    this.computePricing = opts.computePricing;
    this.x402Server = opts.x402Server;
    this.composeMppx = opts.composeMppx;
    this.mintRecipients = opts.mintRecipients;
    this.mintReferenceId = opts.mintReferenceId;
    this.onSettled = opts.onSettled;
    this.isCachedAddress = opts.isCachedAddress;
  }

  /** CAIP-2 read from `rails['x402_base'].network` (or its default). */
  get x402BaseNetwork(): string | null {
    if (this.x402Server === undefined) return null;
    const spec = this.rails['x402_base'] as X402BaseRailSpec | undefined;
    if (spec === undefined) return null;
    return spec.network ?? 'eip155:8453';
  }

  async handle(request: CheckoutRequest): Promise<CheckoutResult> {
    const referenceId = await this.mintRefId(request);
    const ctx: CheckoutContext = {
      request,
      referenceId,
      pricing: null,
      recipients: {},
    };
    ctx.pricing = await this.computePricing(ctx);

    if (hasX402Header(request.headers) && this.x402Server !== undefined && this.x402BaseNetwork !== null) {
      return await this.handleX402(ctx);
    }

    if (hasMppxHeader(request.headers) && this.composeMppx !== undefined) {
      return await this.handleMppx(ctx);
    }

    return await this.emit402(ctx);
  }

  private async mintRefId(request: CheckoutRequest): Promise<string> {
    if (this.mintReferenceId === undefined) return randomUUID();
    const seedCtx: CheckoutContext = { request, referenceId: '', pricing: null, recipients: {} };
    return await this.mintReferenceId(seedCtx);
  }

  private async resolveRecipientsForCtx(ctx: CheckoutContext): Promise<Record<string, string>> {
    if (this.mintRecipients === undefined) return {};
    ctx.recipients = { ...(await this.mintRecipients(ctx)) };
    return ctx.recipients;
  }

  private async asyncIsCachedAddress(address: string): Promise<boolean> {
    if (this.isCachedAddress === undefined) return true;
    return Promise.resolve(this.isCachedAddress(address));
  }

  private async handleX402(ctx: CheckoutContext): Promise<CheckoutResult> {
    if (ctx.pricing === null || this.x402BaseNetwork === null || this.x402Server === undefined) {
      throw new Error('Checkout.handleX402: missing pricing or x402 rail config');
    }
    const x402Server = this.x402Server;
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
        price: `$${ctx.pricing.amountUsd}`,
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
    const outcome: SettleOutcome = {
      rail: 'x402',
      paymentResponseHeader: settle.paymentResponseHeader ?? null,
      raw: settle,
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
      };
      return await this.buildSuccess(ctx, outcome);
    }
    return await this.emit402(ctx, composed.headers ?? {});
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
      totalUsd: String(ctx.pricing.amountUsd),
      rails: howToPayRails,
    });
    const pricingBlock =
      ctx.pricing.block ??
      buildPricingBlock({
        subtotalCents: Math.round(ctx.pricing.amountUsd * 100),
        currency: ctx.pricing.currency ?? 'USD',
      });
    const body = build402Body({
      acceptedMethods: accepted,
      agentInstructions: buildAgentInstructions({ howToPay }),
      pricing: pricingBlock,
      amountUsd: String(ctx.pricing.amountUsd),
      retryBody: ctx.request.body,
      agentMemory: firstEncounterAgentMemory({ firstEncounter: true }),
    });

    let x402Block: Parameters<typeof respond402>[0]['x402'];
    const baseNetwork = this.x402BaseNetwork;
    const x402Server = this.x402Server;
    if (x402Server !== undefined && baseNetwork !== null) {
      const baseSpec = emitRails['x402_base'] as X402BaseRailSpec | undefined;
      if (baseSpec !== undefined) {
        const recipient = await resolveRecipientValue(baseSpec.recipient);
        x402Block = {
          x402Version: 2,
          accepts: await buildX402AcceptsFor402(x402Server, {
            network: baseNetwork,
            price: `$${ctx.pricing.amountUsd}`,
            payTo: recipient,
            maxTimeoutSeconds: 300,
          }),
          resource: { url: ctx.request.url, mimeType: 'application/json' },
        };
      }
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
