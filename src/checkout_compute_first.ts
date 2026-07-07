/**
 * `computeFirstCheckout` — variable-cost pay-per-result merchant helper using
 * compute-first + exact-x402 (no upto, no Permit2, no Settlement-Overrides).
 *
 * Flow (per request):
 *
 *   1. PROBE leg (no payment header)
 *      - Validate input
 *      - Look up cache by content-hash of the request body
 *      - On cache miss: run `runWork(body)`
 *        - 0 results → return 200 immediately with `no_charge` envelope (no 402)
 *        - Else → cache `{body, priceCents}` keyed by body hash → emit 402 with
 *          EXACT price (`actual_results × unitPriceCents`) on every advertised rail
 *      - On cache hit: emit 402 with cached price
 *
 *   2. SETTLE leg (X-Payment / Authorization: Payment header attached)
 *      - Look up cache by re-hashing the same body
 *      - Cache miss → 400 `stale_quote` with `next_steps.action: 're_probe'`
 *      - x402 path → `verifyX402Request` + `processX402Settle({scheme:'exact'})`
 *      - MPP path → `composeMppxRequest`
 *      - Return cached result body in the canonical 200 envelope
 *
 * Works on every exact-mode rail today (x402-exact Base, tempo/charge,
 * solana/charge, Stripe SPT). The tradeoff vs. upto is that the work runs on
 * the unpaid probe leg — so rate-limiting is load-bearing (use
 * `@agent-score/commerce/middleware/hono` `rateLimitHono` or the per-framework
 * equivalent).
 */

import { randomUUID } from 'crypto';
import { deriveMppxReceiptMethod } from './_mppx_receipt';
import { denialReasonToBody } from './_response';
import { warnMissingApiKeyOnce } from './_warnings';
import {
  build402Body,
  buildAcceptedMethods,
  buildAgentInstructions,
  buildHowToPay,
  buildPricingBlock,
  firstEncounterAgentMemory,
} from './challenge';
import { createAgentScoreCore } from './core';
import { buildSuccessNextSteps } from './discovery';
import { CheckoutValidationError } from './errors';
import {
  buildX402AcceptsFor402,
  paymentRequiredHeader,
  processX402Settle,
  verifyX402Request,
} from './payment';
import { formatUsdCents } from './payment/amounts';
import { STRIPE_MIN_CHARGE_USD } from './payment/constants';
import { hasMppxHeader, hasX402Header } from './payment/payment_header';
import {
  resolveRecipient,
  type SolanaMppRailSpec,
  type StripeRailSpec,
  type TempoRailSpec,
  type X402BaseRailSpec,
} from './payment/rail_spec';
import { createQuoteCache, type QuoteCache } from './quote_cache';
import { extractPaymentSigner, readX402PaymentHeader } from './signer';
import type { Context } from 'hono';

const DEFAULT_TTL_MS = 5 * 60_000;

export interface WorkOutcome {
  /** Number of billable units returned by `runWork` (results, tokens, bytes, …).
   *  Used to compute the exact price `unitPriceCents × resultCount` advertised
   *  in the 402. Zero short-circuits the probe to 200 no-charge. */
  resultCount: number;
  /** Body returned to the buyer on the settle leg. Cached verbatim and served
   *  from cache on retry; the merchant does NOT re-run `runWork`. */
  body: Record<string, unknown>;
}

export interface ComputeFirstWorkContext {
  /** Raw Web Fetch `Request` for the probe leg — useful when the work hook
   *  needs to dispatch by header (e.g. agent identity) or read query params. */
  request: Request;
}

export interface ComputeFirstMintContext {
  request: Request;
  body: Record<string, unknown>;
  /** Final price in cents (`unitPriceCents × resultCount`). Useful when minting
   *  payment-provider sessions (Stripe Multichain PaymentIntent) that need the
   *  exact charge amount up front. */
  priceCents: number;
}

export interface ComputeFirstMppContext {
  request: Request;
  /** Cached body that will be returned to the buyer on settle success. The
   *  merchant doesn't need to re-run the work; it's already done. */
  cachedBody: Record<string, unknown>;
  /** Exact price in cents (`unitPriceCents × resultCount`). Build mppx
   *  intents at this amount. */
  priceCents: number;
  /** Dollar-string of the price at the helper's configured precision (e.g.
   *  `"0.03"`, `"0.001234"`). Useful for `tempo/charge` / `stripe/charge`
   *  intents which take a USD string. */
  priceUsd: string;
  /** Minted (or static) recipients per rail. The merchant uses these to build
   *  the per-rail intents. */
  recipients: MintedRecipients;
}

export interface ComputeFirstSettledContext {
  request: Request;
  /** Which rail family captured the payment. `'x402'` = x402-exact on Base.
   *  `'mpp'` = one of Tempo / Solana / Stripe SPT via mppx — disambiguate with
   *  `mppMethod` when you need per-MPP-rail dispatch (e.g. firing the Stripe
   *  testnet deposit simulator with the right `network`). */
  rail: 'x402' | 'mpp';
  /** When `rail === 'mpp'`, the specific intent that mppx settled
   *  (`'tempo/charge'`, `'solana/charge'`, `'stripe/charge'`). Undefined when
   *  the receipt method couldn't be extracted or for non-MPP rails. */
  mppMethod?: string;
  /** Cached body that will be returned to the buyer. */
  cachedBody: Record<string, unknown>;
  priceCents: number;
  priceUsd: string;
  recipients: MintedRecipients;
  signer?: { address: string; network: 'evm' | 'solana' };
  paymentIntentId?: string;
}

export interface MintedRecipients {
  tempo?: string;
  x402_base?: string;
  solana_mpp?: string;
}

export interface ComputeFirstRails {
  tempo?: TempoRailSpec;
  x402_base?: X402BaseRailSpec;
  solana_mpp?: SolanaMppRailSpec;
  stripe?: StripeRailSpec;
}

export interface ComputeFirstOptions {
  /** Merchant-facing name (used in cache prefix, response envelope, product id). */
  name: string;
  /** Public URL of the endpoint, including scheme + host. */
  url: string;
  /** Price per billable unit, in cents. Fractional values supported (per-token
   *  / per-byte unit pricing); precision is auto-derived from the fractional
   *  digits unless `decimals` is set explicitly. */
  unitPriceCents: number;
  /** Override the auto-derived dollar-precision. Default: `2` for integer
   *  cents, else `2 + decimal digits of unitPriceCents`. */
  decimals?: number;
  /** Per-rail config. Pass only the rails you support. At least one rail required. */
  rails: ComputeFirstRails;
  /** Required: registered x402 server (from `createX402Server`). The helper
   *  uses it to build x402 `accepts[]` entries (correct USDC contract +
   *  EIP-712 domain name per network) and to call `processX402Settle` on the
   *  settle leg. */
  x402Server: unknown;
  /** MPP compose hook for the Tempo / Solana / Stripe SPT rails. Called on
   *  BOTH legs of the round-trip:
   *
   *  - **Probe leg** (no payment header): the merchant builds per-rail intents
   *    at the exact cached price and calls `composeMppxRequest(mppx, intents,
   *    request)` — mppx returns a 402 challenge whose `WWW-Authenticate`
   *    header carries the proper per-rail `request=<base64-intent>` values
   *    the agent needs to sign. Return `{status: 402, headers}` where
   *    `headers` is `mppxChallengeHeaders(result)` — the helper merges them
   *    into the 402 response so pay / mppx-clients can settle on any
   *    advertised MPP rail.
   *  - **Settle leg** (`Authorization: Payment` header attached): mppx
   *    verifies + composes. Return `{status: 200, ...}` with `txHash` and
   *    signer info for the success envelope.
   *
   *  Omit to skip MPP entirely — the helper then advertises only x402-exact
   *  in the 402 and rejects MPP-header settles with 503 `mpp_unavailable`. */
  composeMppx?: (ctx: ComputeFirstMppContext) => Promise<{ status: number; raw?: unknown; headers?: Record<string, string>; txHash?: string; signerAddress?: string; signerNetwork?: 'evm' | 'solana' }>;
  /** Optional side-effect hook fired after a successful settle on either rail
   *  (x402 or MPP), before the response is sent. Use this for Stripe testnet
   *  deposit simulation, audit logging, captureWallet writeback, or any other
   *  post-settle work that shouldn't block the response. Errors are caught
   *  and logged but don't fail the request — the buyer still gets their data. */
  onSettled?: (ctx: ComputeFirstSettledContext) => Promise<void> | void;
  /** Optional input validator. Throw a `CheckoutValidationError` for typed
   *  4xx envelopes; any other error becomes a 500. */
  validateInput?: (body: Record<string, unknown>) => void;
  /** The per-request work. Probe leg calls this once; settle leg replays the
   *  cached output. */
  runWork: (body: Record<string, unknown>, ctx: ComputeFirstWorkContext) => Promise<WorkOutcome>;
  /** Optional per-call recipient mint hook. Stripe-multichain merchants mint
   *  per-PI deposit addresses; static-recipient merchants leave this unset
   *  and the rail recipient configured in `rails` is used verbatim. */
  mintRecipients?: (ctx: ComputeFirstMintContext) => Promise<MintedRecipients>;
  /** Quote cache instance. Default: in-memory cache with 5-min TTL. Pass a
   *  Redis-backed cache (via `createQuoteCache({redisUrl})`) for multi-task
   *  deployments. */
  cache?: QuoteCache;
  /** Override default cache TTL (only used when `cache` is not provided). */
  cacheTtlMs?: number;
  /** App URL used in success `next_steps.order_status_url`. Defaults to the
   *  origin of `url` + `/health`. */
  appUrl?: string;
  /** Override the on-success body. Default returns a canonical
   *  `{id, endpoint, payment_status, charged_usd, rail, signer?, result, ...}`
   *  envelope matching the fixed-price `Checkout` shape. */
  buildSuccessBody?: (args: SuccessBodyArgs) => Record<string, unknown>;
}

export interface SuccessBodyArgs {
  referenceId: string;
  endpoint: string;
  chargedUsd: string;
  rail: string;
  paymentIntentId?: string;
  signer?: { address: string; network: 'evm' | 'solana' };
  cachedBody: Record<string, unknown>;
}

export interface ComputeFirstHandler {
  /** Hono adapter — pass `(c) => handler.handleHono(c)` into your route. */
  handleHono(c: Context): Promise<Response>;
  /** Web Fetch adapter — pass `handler.handleWeb` directly as a route handler. */
  handleWeb(req: Request): Promise<Response>;
}

function decimalsForUnit(unitPriceCents: number): number {
  if (Number.isInteger(unitPriceCents)) return 2;
  const str = unitPriceCents.toString();
  const dotIdx = str.indexOf('.');
  const frac = dotIdx === -1 ? 0 : str.length - dotIdx - 1;
  return 2 + frac;
}

export function computeFirstCheckout(opts: ComputeFirstOptions): ComputeFirstHandler {
  const cache = opts.cache ?? createQuoteCache({ ttlMs: opts.cacheTtlMs ?? DEFAULT_TTL_MS });
  const decimals = opts.decimals ?? decimalsForUnit(opts.unitPriceCents);
  const appUrl = opts.appUrl ?? new URL(opts.url).origin;

  async function mintAndResolveRecipients(
    req: Request,
    body: Record<string, unknown>,
    priceCents: number,
  ): Promise<Record<string, string>> {
    const minted = opts.mintRecipients
      ? await opts.mintRecipients({ request: req, body, priceCents })
      : {};
    const out: Record<string, string> = {};
    const tempo = minted.tempo ?? (opts.rails.tempo ? await resolveRecipient(opts.rails.tempo.recipient) : undefined);
    const x402Base = minted.x402_base ?? (opts.rails.x402_base ? await resolveRecipient(opts.rails.x402_base.recipient) : undefined);
    const solana = minted.solana_mpp ?? (opts.rails.solana_mpp ? await resolveRecipient(opts.rails.solana_mpp.recipient) : undefined);
    if (tempo) out.tempo = tempo;
    if (x402Base) out.x402_base = x402Base;
    if (solana) out.solana_mpp = solana;
    return out;
  }

  async function emit402(
    req: Request,
    body: Record<string, unknown>,
    priceCents: number,
    recipients: Record<string, string>,
  ): Promise<Response> {
    const totalUsd = formatUsdCents(priceCents, decimals);
    const tempoRecipient = recipients.tempo;
    const x402BaseRecipient = recipients.x402_base;
    const solanaRecipient = recipients.solana_mpp;

    // Auto-drop stripe when the computed price is below Stripe's $0.50 USD
    // minimum so accepted_methods stays consistent with what buildMppxComposeRails
    // actually composes (see src/payment/constants.ts).
    const includeStripeInDiscovery =
      opts.rails.stripe !== undefined && Number(totalUsd) >= STRIPE_MIN_CHARGE_USD;

    const accepted = await buildAcceptedMethods({
      ...(tempoRecipient && opts.rails.tempo && { tempo: { ...opts.rails.tempo, recipient: tempoRecipient } }),
      ...(solanaRecipient && opts.rails.solana_mpp && { solana_mpp: { ...opts.rails.solana_mpp, recipient: solanaRecipient } }),
      ...(includeStripeInDiscovery && { stripe: opts.rails.stripe }),
    });

    // x402 entry is built via buildX402AcceptsFor402 so the registered scheme
    // resolves the correct on-chain USDC contract address + EIP-712 domain
    // `name` per network. Hand-rolling would default to mainnet USDC and break
    // pay's network/scheme registration check.
    if (x402BaseRecipient && opts.rails.x402_base) {
      try {
        const resolvedX402PayTo = await resolveRecipient(x402BaseRecipient);
        const x402Entries = await buildX402AcceptsFor402(opts.x402Server as never, {
          network: opts.rails.x402_base.network ?? 'eip155:8453',
          price: `$${totalUsd}`,
          payTo: resolvedX402PayTo,
          maxTimeoutSeconds: 300,
        });
        accepted.push(...(x402Entries as never[]));
      } catch (err) {
        console.warn(
          `[${opts.name}.computeFirst] buildX402AcceptsFor402 failed; dropping x402 from accepts:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    const howToPay = buildHowToPay({
      url: opts.url,
      retryBodyJson: JSON.stringify(body),
      totalUsd,
      decimals,
      rails: {
        ...(tempoRecipient && opts.rails.tempo && { tempo: { ...opts.rails.tempo, recipient: tempoRecipient } }),
        ...(x402BaseRecipient && opts.rails.x402_base && { x402_base: { ...opts.rails.x402_base, recipient: x402BaseRecipient } }),
        ...(solanaRecipient && opts.rails.solana_mpp && { solana_mpp: { ...opts.rails.solana_mpp, recipient: solanaRecipient } }),
        ...(opts.rails.stripe && { stripe: opts.rails.stripe }),
      },
    });

    const pricing = buildPricingBlock({ subtotalCents: priceCents, currency: 'USD', decimals });
    const agentInstructions = buildAgentInstructions({
      howToPay,
      warnings: [
        'The quoted price is exact: it was derived from the actual number of results returned by the work on the probe leg.',
        'The merchant cached the result against a hash of this request body. Retry with the same body within the quote TTL (default 5 min) to settle and receive the cached results; if the quote expires, re-probe.',
      ],
    });

    // MPP rails' `WWW-Authenticate` is generated by mppx during the
    // composeMppx callback's probe-leg pass (no payment header → mppx returns
    // a 402 challenge with per-rail `request=<base64 intent>` values). This
    // gives tempo/solana/stripe-spt the proper signing intent the agent needs
    // — hand-rolling `paymentDirective` here with `request=''` is what broke
    // the earlier smoke. x402-exact still uses PAYMENT-REQUIRED only (no
    // WWW-Authenticate directive needed).
    let mppChallengeHeaders: Record<string, string> = {};
    if (opts.composeMppx) {
      try {
        const mppResult = await opts.composeMppx({
          request: req,
          cachedBody: body,
          priceCents,
          priceUsd: totalUsd,
          recipients,
        });
        if (mppResult.status === 402 && mppResult.headers) {
          mppChallengeHeaders = mppResult.headers;
        }
      } catch (err) {
        console.warn(
          `[${opts.name}.computeFirst] composeMppx probe-leg failed; dropping MPP rails from 402 challenge:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    const body402 = build402Body({
      product: { id: opts.name, name: opts.name },
      acceptedMethods: accepted,
      pricing,
      agentInstructions,
      amountUsd: totalUsd,
      currency: 'USD',
      orderId: null,
      retryBody: body,
    });

    const headers = new Headers({ 'Content-Type': 'application/json' });
    for (const [k, v] of Object.entries(mppChallengeHeaders)) headers.set(k, v);
    headers.set(
      'PAYMENT-REQUIRED',
      paymentRequiredHeader({ x402Version: 2, accepts: accepted as never[], resource: { url: opts.url } }),
    );

    return new Response(JSON.stringify(body402), { status: 402, headers });
  }

  // Always-on wallet OFAC SDN enforcement for compute-first merchants.
  // Mirrors `Checkout.runWalletSanctionsOnly`: extract signer from the payment
  // header, call /v1/assess with the signer block (no policy), deny on SDN
  // hit or unavailable lookup. Skips silently for Stripe SPT (no wallet
  // signer to screen). Skips with a one-time warning when AGENTSCORE_API_KEY
  // is unset (dev/testnet pattern).
  async function enforceWalletSanctions(req: Request, referenceId: string): Promise<Response | null> {
    const apiKey = process.env.AGENTSCORE_API_KEY;
    if (!apiKey) {
      warnMissingApiKeyOnce(`${opts.name}.computeFirst`);
      return null;
    }
    const x402Header = readX402PaymentHeader(req);
    const signer = await extractPaymentSigner(req, x402Header);
    if (!signer) return null; // Stripe SPT — no wallet to screen
    const baseUrl = process.env.AGENTSCORE_BASE_URL;
    const core = createAgentScoreCore({
      apiKey,
      ...(baseUrl !== undefined && { baseUrl }),
    });
    const outcome = await core.evaluate({ address: signer.address }, undefined, signer);
    if (outcome.kind === 'allow') return null;
    const reason = outcome.reason;
    const body = denialReasonToBody(reason);
    const status =
      reason.code === 'token_expired' || reason.code === 'invalid_credential'
        ? 401
        : reason.code === 'api_error'
          ? 503
          : 403;
    return new Response(
      JSON.stringify({
        id: referenceId,
        endpoint: opts.name,
        created_at: new Date().toISOString(),
        payment_status: 'failed',
        ...body,
      }),
      { status, headers: { 'Content-Type': 'application/json' } },
    );
  }

  async function handleX402Settle(
    req: Request,
    referenceId: string,
    cachedBody: Record<string, unknown>,
    priceCents: number,
    recipients: MintedRecipients,
  ): Promise<Response> {
    // Bind the agent-supplied `payTo` to the recipient this request actually advertised in its
    // 402 (`recipients.x402_base` — static rail recipient OR per-order mint). The agent controls
    // `payTo` in the x402 payload, so accepting any address would let a hostile agent redirect the
    // USDC to their own wallet while still receiving the goods (funds drain). When no x402 recipient
    // was advertised (shouldn't happen on the x402 settle path), fall back to permissive so a
    // misconfig fails downstream at settle rather than here.
    const expectedPayTo = recipients.x402_base?.toLowerCase();
    const verified = await verifyX402Request({
      request: req,
      isCachedAddress: async (addr) => expectedPayTo === undefined || addr.toLowerCase() === expectedPayTo,
      acceptedNetwork: opts.rails.x402_base?.network ?? 'eip155:8453',
    });
    if (!verified.ok) {
      return new Response(JSON.stringify(verified.body), {
        status: verified.status as number,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const actualUsd = formatUsdCents(priceCents, decimals);
    const settle = await processX402Settle({
      x402Server: opts.x402Server as never,
      payload: verified.payload,
      resourceConfig: {
        scheme: 'exact',
        network: verified.signedNetwork,
        price: `$${actualUsd}`,
        payTo: verified.signedPayTo,
        maxTimeoutSeconds: 300,
      },
      resourceMeta: {
        url: req.url,
        description: `Agent purchase via x402-exact (${opts.name})`,
        mimeType: 'application/json',
      },
    });
    if (!settle.success) {
      const detail = (settle as { error?: { message?: string } }).error?.message ?? 'unknown';
      return new Response(
        JSON.stringify({
          id: referenceId,
          endpoint: opts.name,
          created_at: new Date().toISOString(),
          payment_status: 'failed',
          charged_usd: '0.00',
          rail: `x402-base (${verified.signedNetwork})`,
          error: {
            code: 'settle_failed',
            message: 'Facilitator rejected the exact settle; no on-chain capture occurred.',
            detail,
          },
        }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const signer = await extractPaymentSigner(req, readX402PaymentHeader(req));
    const signerInfo = signer ? { address: signer.address, network: signer.network } : undefined;
    const railLabel = `Base (${verified.signedNetwork})`;
    if (opts.onSettled) {
      try {
        await opts.onSettled({
          request: req,
          rail: 'x402',
          cachedBody,
          priceCents,
          priceUsd: actualUsd,
          recipients,
          ...(signerInfo ? { signer: signerInfo } : {}),
        });
      } catch (err) {
        console.warn(`[${opts.name}.computeFirst.onSettled] x402 side-effect failed:`, err instanceof Error ? err.message : err);
      }
    }
    const buildBody = opts.buildSuccessBody ?? defaultSuccessBody(appUrl);
    const body = buildBody({
      referenceId,
      endpoint: opts.name,
      chargedUsd: actualUsd,
      rail: railLabel,
      ...(signerInfo ? { signer: signerInfo } : {}),
      cachedBody,
    });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  function mppRailLabel(method: string | undefined): string {
    // Receipt.method ships as either the bare scheme (`'tempo'`) or the full
    // directive (`'tempo/charge'`). Strip the `/charge` suffix to match both.
    const scheme = method?.split('/')[0];
    if (scheme === 'tempo') {
      const networkName = opts.rails.tempo?.testnet ? 'tempo-testnet' : (opts.rails.tempo?.network ?? 'tempo-mainnet');
      return `Tempo (${networkName})`;
    }
    if (scheme === 'solana') {
      const networkName = opts.rails.solana_mpp?.network ?? 'solana';
      return `Solana (${networkName})`;
    }
    if (scheme === 'stripe') return 'Stripe (card+link)';
    return 'MPP';
  }

  async function handleMppSettle(
    req: Request,
    referenceId: string,
    cachedBody: Record<string, unknown>,
    priceCents: number,
    recipients: MintedRecipients,
  ): Promise<Response> {
    if (!opts.composeMppx) {
      return new Response(
        JSON.stringify({
          id: referenceId,
          endpoint: opts.name,
          created_at: new Date().toISOString(),
          payment_status: 'failed',
          charged_usd: '0.00',
          error: { code: 'mpp_unavailable', message: 'MPP settle hook not configured on this endpoint.' },
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const priceUsd = formatUsdCents(priceCents, decimals);
    const result = await opts.composeMppx({ request: req, cachedBody, priceCents, priceUsd, recipients });

    if (result.status !== 200) {
      const headers = result.headers ?? {};
      return new Response(
        JSON.stringify({
          id: referenceId,
          endpoint: opts.name,
          created_at: new Date().toISOString(),
          payment_status: 'failed',
          charged_usd: '0.00',
          error: { code: 'mpp_settle_failed', message: 'MPP compose did not return 200; credential rejected.' },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...headers } },
      );
    }

    const signer = result.signerAddress
      ? { address: result.signerAddress, network: result.signerNetwork ?? 'evm' as const }
      : await extractPaymentSigner(req, readX402PaymentHeader(req)).then((s) => s ? { address: s.address, network: s.network } : undefined);
    const method = await deriveMppxReceiptMethod(result.raw);
    const railLabel = mppRailLabel(method);
    if (opts.onSettled) {
      try {
        await opts.onSettled({
          request: req,
          rail: 'mpp',
          mppMethod: method,
          cachedBody,
          priceCents,
          priceUsd,
          recipients,
          ...(signer ? { signer } : {}),
          ...(result.txHash ? { paymentIntentId: result.txHash } : {}),
        });
      } catch (err) {
        console.warn(`[${opts.name}.computeFirst.onSettled] MPP side-effect failed:`, err instanceof Error ? err.message : err);
      }
    }
    const buildBody = opts.buildSuccessBody ?? defaultSuccessBody(appUrl);
    const body = buildBody({
      referenceId,
      endpoint: opts.name,
      chargedUsd: priceUsd,
      rail: railLabel,
      ...(result.txHash ? { paymentIntentId: result.txHash } : {}),
      ...(signer ? { signer } : {}),
      cachedBody,
    });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  async function handle(req: Request): Promise<Response> {
    const referenceId = `${opts.name}_${randomUUID()}`;
    let body: Record<string, unknown>;
    try {
      body = (await req.clone().json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    try {
      opts.validateInput?.(body);
    } catch (err) {
      if (err instanceof CheckoutValidationError) {
        return new Response(
          JSON.stringify({
            error: { code: err.code, message: err.message },
            ...(err.action ? { next_steps: { action: err.action, user_message: err.message } } : {}),
            ...err.extra,
          }),
          { status: err.status as number, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw err;
    }

    const cacheKey = cache.bodyHashKey(opts.name, body);

    if (hasX402Header(req.headers) || hasMppxHeader(req.headers)) {
      const quote = await cache.read(cacheKey);
      if (!quote) {
        return new Response(
          JSON.stringify({
            id: referenceId,
            endpoint: opts.name,
            created_at: new Date().toISOString(),
            payment_status: 'failed',
            charged_usd: '0.00',
            error: {
              code: 'stale_quote',
              message: 'No active quote for this request body. The quote may have expired or the body changed since the probe.',
            },
            next_steps: {
              action: 're_probe',
              suggestion: 'Send the same body without a payment header to get a fresh 402 quote, then retry with the payment credential.',
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
      // Wallet OFAC SDN enforcement (always-on default — matches Checkout's
      // `runWalletSanctionsOnly`). Strict-liability check before the rail-
      // specific settle so funds don't move (x402) or order doesn't fulfill
      // (MPP) for a sanctioned wallet.
      const ofacDenial = await enforceWalletSanctions(req, referenceId);
      if (ofacDenial !== null) return ofacDenial;
      if (hasX402Header(req.headers)) return handleX402Settle(req, referenceId, quote.body, quote.priceCents, quote.recipients as MintedRecipients);
      return handleMppSettle(req, referenceId, quote.body, quote.priceCents, quote.recipients as MintedRecipients);
    }

    let quote = await cache.read(cacheKey);
    if (!quote) {
      let outcome: WorkOutcome;
      try {
        outcome = await opts.runWork(body, { request: req });
      } catch {
        // Suppress the upstream exception detail in the wire response — merchant
        // errors may carry stack traces or internal state. The merchant's own
        // logger surface (passed via opts.onError if present) is the right
        // channel for the full exception.
        return new Response(
          JSON.stringify({
            id: referenceId,
            endpoint: opts.name,
            created_at: new Date().toISOString(),
            payment_status: 'no_charge',
            charged_usd: '0.00',
            result: { matches: [], total: 0 },
            error: {
              code: 'upstream_failed',
              message: 'The wrapped endpoint failed; no charge was applied.',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (outcome.resultCount === 0) {
        return new Response(
          JSON.stringify({
            id: referenceId,
            endpoint: opts.name,
            created_at: new Date().toISOString(),
            payment_status: 'no_charge',
            charged_usd: '0.00',
            result: outcome.body,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      const priceCents = opts.unitPriceCents * outcome.resultCount;
      const recipients = await mintAndResolveRecipients(req, body, priceCents);
      await cache.write(cacheKey, outcome.body, priceCents, recipients);
      quote = { body: outcome.body, priceCents, recipients };
    }

    return emit402(req, body, quote.priceCents, quote.recipients);
  }

  return {
    handleWeb: handle,
    async handleHono(c: Context): Promise<Response> {
      return handle(c.req.raw);
    },
  };
}

function defaultSuccessBody(appUrl: string): (args: SuccessBodyArgs) => Record<string, unknown> {
  return ({ referenceId, endpoint, chargedUsd, rail, paymentIntentId, signer, cachedBody }) => ({
    id: referenceId,
    endpoint,
    created_at: new Date().toISOString(),
    payment_status: 'completed',
    charged_usd: chargedUsd,
    rail,
    ...(paymentIntentId ? { payment_intent_id: paymentIntentId } : {}),
    ...(signer ? { signer } : {}),
    result: cachedBody,
    next_steps: buildSuccessNextSteps({ orderStatusUrl: `${appUrl}/health` }),
    agent_memory: firstEncounterAgentMemory({ firstEncounter: true }),
  });
}
