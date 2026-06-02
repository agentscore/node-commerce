import { denialReasonStatus } from '../_denial';
import { denialReasonToBody } from '../_response';
import { buildAipErrorBody, verifyAitRequest, type AipGateOptions } from '../aip/gate';
import { hasAgentIdentityHeader } from '../aip/request';
import { createAgentScoreCore } from '../core';
import { hasPaymentHeader } from '../payment/payment_header';
import { extractPaymentSigner, readX402PaymentHeader } from '../signer';
import type { VerifiedAit } from '../aip/verify';
import type {
  AgentIdentity,
  AgentScoreCoreOptions,
  AssessResult,
  CreateSessionOnMissing,
  DenialReason,
  FailOpenInfraReason,
  GateQuotaInfo,
  SignerVerdict,
} from '../core';

interface AgentScoreGateOptions extends Omit<AgentScoreCoreOptions, 'createSessionOnMissing'> {
  /** Custom function to extract agent identity from a Request. */
  extractIdentity?: (req: Request) => AgentIdentity | undefined;
  /** Custom handler invoked when a request is denied. Must return a Response. */
  onDenied?: (req: Request, reason: DenialReason) => Response | Promise<Response>;
  /** Auto-create a verification session on missing identity. Hooks receive the `Request`. */
  createSessionOnMissing?: CreateSessionOnMissing<Request>;
}

/**
 * Result of a gate check. `allowed: true` means the request passed; forward it to your
 * handler. `allowed: false` means it was denied; return `response` directly to the client.
 *
 * When the request was authenticated via `operator_token`, `captureWallet` is bound to the
 * identity and can be called after payment to report the signer wallet back to AgentScore.
 * When the request was wallet-authenticated (nothing to associate), `captureWallet` is
 * undefined. Always fire-and-forget.
 */
export type GuardResult =
  | {
      allowed: true;
      data?: AssessResult;
      captureWallet?: (opts: {
        walletAddress: string;
        network: 'evm' | 'solana';
        idempotencyKey?: string;
      }) => Promise<void>;
      /** Synchronous read of the cached signer verdicts (`signer_match` wallet-binding
       *  + `signer_sanctions` OFAC SDN wallet-address check). Both verdicts composed by
       *  the gate's primary `/v1/assess` call in one round trip. Bound only on strict
       *  wallet-auth requests; `undefined` otherwise (operator-token paths, discovery
       *  legs, or routes the gate didn't run on). */
      getSignerVerdict?: () => SignerVerdict | undefined;
      /** Set to `true` only when the gate fail-open'd due to AgentScore-side infra failure
       *  (429/5xx/network timeout). Compliance was NOT enforced this request — log/alert. */
      degraded?: boolean;
      /** Why the gate degraded — quota_exceeded / api_error / network_timeout. */
      infraReason?: FailOpenInfraReason;
      /** Per-account assess quota observability from X-Quota-* response headers. */
      quota?: GateQuotaInfo;
    }
  | { allowed: false; response: Response };

function defaultExtractIdentity(req: Request): AgentIdentity | undefined {
  const token = req.headers.get('x-operator-token');
  const addr = req.headers.get('x-wallet-address');
  const identity: AgentIdentity = {};
  if (token && token.length > 0) identity.operatorToken = token;
  if (addr && addr.length > 0) identity.address = addr;
  if (identity.operatorToken || identity.address) return identity;
  return undefined;
}

function defaultOnDenied(_req: Request, reason: DenialReason): Response {
  return new Response(JSON.stringify(denialReasonToBody(reason)), {
    status: denialReasonStatus(reason),
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Create a Web Fetch-compatible gate. Works with any runtime that speaks the standard
 * Request/Response API: Cloudflare Workers, Deno Deploy, Bun, Next.js App Router, etc.
 *
 * ```ts
 * const guard = createAgentScoreGate({ apiKey: 'as_live_...', requireKyc: true });
 *
 * export default {
 *   async fetch(req: Request) {
 *     const result = await guard(req);
 *     if (!result.allowed) return result.response;
 *     return handle(req, result.data);
 *   },
 * };
 * ```
 */
export function createAgentScoreGate(options: AgentScoreGateOptions): (req: Request) => Promise<GuardResult> {
  const { extractIdentity = defaultExtractIdentity, onDenied = defaultOnDenied, ...coreOptions } = options;
  const core = createAgentScoreCore(coreOptions as AgentScoreCoreOptions);

  return async (req: Request): Promise<GuardResult> => {
    const identity = extractIdentity(req);
    // Extract the payment signer pre-evaluate. When present, the API composes
    // signer_match + signer_sanctions verdicts on the primary assess response in one
    // round trip. Wallet-OFAC enforcement is unconditional — SDN wallet hits flip
    // decision -> deny inline before the handler runs, regardless of policy flags.
    const signer = await extractPaymentSigner(req, readX402PaymentHeader(req));
    const outcome = await core.evaluate(identity, req, signer);

    if (outcome.kind === 'allow') {
      const captureWallet = identity?.operatorToken
        ? (opts: { walletAddress: string; network: 'evm' | 'solana'; idempotencyKey?: string }) =>
            core.captureWallet({ operatorToken: identity.operatorToken!, ...opts })
        : undefined;
      // Synchronous getter — reads the cached verdicts (signer_match + signer_sanctions)
      // composed by the primary assess call above. Returns undefined for operator-token
      // paths or discovery legs where no signer was extractable.
      const getSignerVerdictBound = identity?.address && !identity?.operatorToken
        ? () => core.getSignerVerdict(identity.address!)
        : undefined;
      return {
        allowed: true,
        data: outcome.data,
        captureWallet,
        getSignerVerdict: getSignerVerdictBound,
        ...(outcome.degraded ? { degraded: true, infraReason: outcome.infraReason } : {}),
        ...(outcome.quota ? { quota: outcome.quota } : {}),
      };
    }

    const response = await onDenied(req, outcome.reason);
    return { allowed: false, response };
  };
}

/**
 * Wrap a Web Fetch request handler with the gate. Denied requests are returned directly;
 * allowed requests are passed to `handler` along with the assess data.
 *
 * ```ts
 * export const POST = withAgentScoreGate(
 *   { apiKey: 'as_live_...', requireKyc: true },
 *   async (req, { data }) => Response.json({ ok: true }),
 * );
 * ```
 */
export function withAgentScoreGate<TCtx = unknown>(
  options: AgentScoreGateOptions,
  handler: (
    req: Request,
    gate: {
      data?: AssessResult;
      captureWallet?: (opts: {
        walletAddress: string;
        network: 'evm' | 'solana';
        idempotencyKey?: string;
      }) => Promise<void>;
      /** Synchronous read of the cached signer verdicts. See {@link GuardResult}'s
       *  `getSignerVerdict` for the contract. */
      getSignerVerdict?: () => SignerVerdict | undefined;
      /** Set to `true` only when the gate fail-open'd due to AgentScore-side infra failure
       *  (429/5xx/network timeout). Compliance was NOT enforced this request — log/alert. */
      degraded?: boolean;
      /** Why the gate degraded — quota_exceeded / api_error / network_timeout. */
      infraReason?: FailOpenInfraReason;
      /** Per-account assess quota observability from X-Quota-* response headers. */
      quota?: GateQuotaInfo;
    },
    ctx?: TCtx,
  ) => Response | Promise<Response>,
): (req: Request, ctx?: TCtx) => Promise<Response> {
  const guard = createAgentScoreGate(options);
  return async (req, ctx) => {
    const result = await guard(req);
    if (!result.allowed) return result.response;
    return handler(
      req,
      {
        data: result.data,
        captureWallet: result.captureWallet,
        getSignerVerdict: result.getSignerVerdict,
        ...(result.degraded ? { degraded: true, infraReason: result.infraReason } : {}),
        ...(result.quota ? { quota: result.quota } : {}),
      },
      ctx,
    );
  };
}

/** Wrap `createAgentScoreGate(...)` so it only fires when a payment credential
 *  is attached. Discovery legs flow through allowed (with `data: undefined`)
 *  and the handler emits a 402 with all rails; settle legs run the full gate. */
export function createConditionalAgentScoreGate(options: AgentScoreGateOptions): (req: Request) => Promise<GuardResult> {
  const guard = createAgentScoreGate(options);
  return async (req: Request): Promise<GuardResult> => {
    if (!hasPaymentHeader(req)) return { allowed: true };
    return guard(req);
  };
}

/** Wrapper variant matching `withAgentScoreGate(opts, handler)` that only
 *  invokes the gate when a payment credential is attached. */
export function withConditionalAgentScoreGate<TCtx = unknown>(
  options: AgentScoreGateOptions,
  handler: Parameters<typeof withAgentScoreGate<TCtx>>[1],
): (req: Request, ctx: TCtx) => Promise<Response> {
  const wrapped = withAgentScoreGate<TCtx>(options, handler);
  return async (req: Request, ctx: TCtx): Promise<Response> => {
    if (!hasPaymentHeader(req)) return handler(req, {}, ctx);
    return wrapped(req, ctx);
  };
}

// ---------------------------------------------------------------------------
// AIP gate (Agentic Identity Protocol) — Web Fetch
//
// `createAipGate` verifies a key-bound Agent Identity Token (AIT) from a trusted IdP and
// returns a guard result; `withAipGate` wraps a handler. Fetch-native, so it reuses
// `verifyAitRequest` directly. Identity verification only — merchants enrich via /v1/assess.
// ---------------------------------------------------------------------------

export type AipGuardResult =
  | { allowed: true; ait: VerifiedAit }
  | { allowed: false; response: Response };

export interface AipGateWebOptions extends AipGateOptions {
  /** Custom denial responder. Defaults to a 401/403 `application/problem+json` Response. */
  onDenied?: (req: Request, body: ReturnType<typeof buildAipErrorBody>) => Response | Promise<Response>;
}

const defaultAipResponse = (body: ReturnType<typeof buildAipErrorBody>): Response =>
  new Response(JSON.stringify(body), { status: body.status, headers: { 'content-type': 'application/problem+json' } });

/** Create a Web Fetch AIP guard: returns `{ allowed, ait }` or `{ allowed: false, response }`. */
export function createAipGate(options: AipGateWebOptions): (req: Request) => Promise<AipGuardResult> {
  const { onDenied, ...gateOpts } = options;
  return async (req: Request): Promise<AipGuardResult> => {
    const result = await verifyAitRequest(req, gateOpts);
    if (result.ok) { return { allowed: true, ait: result.ait }; }
    const body = buildAipErrorBody(result.failure);
    const response = onDenied ? await onDenied(req, body) : defaultAipResponse(body);
    return { allowed: false, response };
  };
}

/** Wrap a Web Fetch handler with the AIP gate. Denied requests return the problem+json Response. */
export function withAipGate<TCtx = unknown>(
  options: AipGateWebOptions,
  handler: (req: Request, gate: { ait: VerifiedAit }, ctx?: TCtx) => Response | Promise<Response>,
): (req: Request, ctx?: TCtx) => Promise<Response> {
  const guard = createAipGate(options);
  return async (req, ctx) => {
    const result = await guard(req);
    if (!result.allowed) { return result.response; }
    return handler(req, { ait: result.ait }, ctx);
  };
}

/** Conditional variant: only runs the AIP gate when an `Agent-Identity` header is present. */
export function withConditionalAipGate<TCtx = unknown>(
  options: AipGateWebOptions,
  handler: (req: Request, gate: { ait?: VerifiedAit }, ctx?: TCtx) => Response | Promise<Response>,
): (req: Request, ctx?: TCtx) => Promise<Response> {
  const guard = createAipGate(options);
  return async (req, ctx) => {
    if (!hasAgentIdentityHeader(req)) { return handler(req, {}, ctx); }
    const result = await guard(req);
    if (!result.allowed) { return result.response; }
    return handler(req, { ait: result.ait }, ctx);
  };
}
