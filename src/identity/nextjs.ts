import { hasPaymentHeader } from '../payment/payment_header';
import { createAgentScoreGate } from './web';
import type { AssessResult, FailOpenInfraReason, GateQuotaInfo, OperatorHandle, SignerVerdict } from '../core';


/**
 * Wrap a Next.js App Router route handler with the gate.
 *
 * Denied requests get a 403 JSON response; allowed requests reach `handler` with the
 * assess data on `gate.data`.
 *
 * ```ts
 * // app/api/purchase/route.ts
 * import { withAgentScoreGate } from '@agent-score/commerce/identity/nextjs';
 *
 * export const POST = withAgentScoreGate(
 *   { apiKey: process.env.AGENTSCORE_API_KEY!, requireKyc: true, minAge: 21 },
 *   async (req, { data }) => {
 *     // ... purchase logic
 *     return Response.json({ ok: true });
 *   },
 * );
 * ```
 *
 * Works with any Request type, including Next's `NextRequest`.
 */
export function withAgentScoreGate<TReq extends Request = Request, TCtx = unknown>(
  options: Parameters<typeof createAgentScoreGate>[0],
  handler: (
    req: TReq,
    gate: {
      data?: AssessResult;
      captureWallet?: (opts: {
        walletAddress: string;
        network: 'evm' | 'solana';
        idempotencyKey?: string;
      }) => Promise<void>;
      /** Synchronous read of the cached signer verdicts (`signer_match` wallet-binding
       *  + `signer_sanctions` OFAC SDN wallet-address check). Both composed by the gate's
       *  primary `/v1/assess` in one round trip. Bound only on strict wallet-auth
       *  requests; `undefined` otherwise. */
      getSignerVerdict?: () => SignerVerdict | undefined;
      /** Stable pairwise handle for the ACCOUNT behind this request's operator token, and
       *  what durable merchant state (prepaid balances first) should key on: it survives
       *  the token rotating, expiring or being revoked. Rides the gate's existing
       *  `/v1/assess` call, so it costs no extra round trip and nothing extra against
       *  quota. `undefined` on wallet or AIT paths, or when the API has no handle salt. */
      operatorHandle?: OperatorHandle;
      /** Set to `true` only when the gate fail-open'd due to AgentScore-side infra failure
       *  (429/5xx/network timeout). Compliance was NOT enforced — log/alert in your handler. */
      degraded?: boolean;
      /** Why the gate degraded — quota_exceeded / api_error / network_timeout. */
      infraReason?: FailOpenInfraReason;
      /** Per-account assess quota observability from X-Quota-* response headers. */
      quota?: GateQuotaInfo;
    },
    ctx?: TCtx,
  ) => Response | Promise<Response>,
): (req: TReq, ctx?: TCtx) => Promise<Response> {
  const guard = createAgentScoreGate(options);
  return async (req, ctx) => {
    const result = await guard(req as Request);
    if (!result.allowed) return result.response;
    return handler(
      req,
      {
        data: result.data,
        captureWallet: result.captureWallet,
        getSignerVerdict: result.getSignerVerdict,
        ...(result.operatorHandle ? { operatorHandle: result.operatorHandle } : {}),
        ...(result.degraded ? { degraded: true, infraReason: result.infraReason } : {}),
        ...(result.quota ? { quota: result.quota } : {}),
      },
      ctx,
    );
  };
}

/**
 * Build a Next.js middleware function. Returns a `Response` when the request is denied;
 * returns `undefined` when the request should continue down the middleware chain.
 *
 * ```ts
 * // middleware.ts
 * import { NextResponse, type NextRequest } from 'next/server';
 * import { agentscoreMiddleware } from '@agent-score/commerce/identity/nextjs';
 *
 * const gate = agentscoreMiddleware({ apiKey: process.env.AGENTSCORE_API_KEY!, requireKyc: true });
 *
 * export async function middleware(req: NextRequest) {
 *   const denied = await gate(req);
 *   if (denied) return denied;
 *   return NextResponse.next();
 * }
 *
 * export const config = { matcher: '/api/purchase/:path*' };
 * ```
 */
export function agentscoreMiddleware(options: Parameters<typeof createAgentScoreGate>[0]): (req: Request) => Promise<Response | undefined> {
  const guard = createAgentScoreGate(options);
  return async (req: Request) => {
    const result = await guard(req);
    return result.allowed ? undefined : result.response;
  };
}

/** Wrapper variant of `withAgentScoreGate` that only invokes the gate when a
 *  payment credential is attached. Discovery legs flow through to `handler`
 *  with an empty `gate` arg so the handler emits a 402 with all rails. */
export function withConditionalAgentScoreGate<TReq extends Request = Request, TCtx = unknown>(
  options: Parameters<typeof withAgentScoreGate<TReq, TCtx>>[0],
  handler: Parameters<typeof withAgentScoreGate<TReq, TCtx>>[1],
): (req: TReq, ctx?: TCtx) => Promise<Response> {
  const wrapped = withAgentScoreGate<TReq, TCtx>(options, handler);
  return async (req: TReq, ctx?: TCtx): Promise<Response> => {
    if (!hasPaymentHeader(req as unknown as Request)) {
      const result = handler(req, {}, ctx);
      return result instanceof Promise ? result : Promise.resolve(result);
    }
    return wrapped(req, ctx);
  };
}

/** Middleware variant: returns a denial Response only when a payment header
 *  IS present and the gate denies; otherwise returns undefined so the chain
 *  continues. */
export function conditionalAgentscoreMiddleware(options: Parameters<typeof createAgentScoreGate>[0]): (req: Request) => Promise<Response | undefined> {
  const guard = createAgentScoreGate(options);
  return async (req: Request) => {
    if (!hasPaymentHeader(req)) return undefined;
    const result = await guard(req);
    return result.allowed ? undefined : result.response;
  };
}


// ---------------------------------------------------------------------------
// AIP gate (Agentic Identity Protocol) — Next.js App Router. Fetch-native, so these are
// thin re-exports of web's AIP gate (works with NextRequest, which extends Request).
// ---------------------------------------------------------------------------
export {
  createAipGate,
  withAipGate,
  withConditionalAipGate,
  type AipGateWebOptions,
  type AipGuardResult,
} from './web';
