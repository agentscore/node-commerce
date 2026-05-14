import {
  FIXABLE_DENIAL_REASONS,
  buildContactSupportNextSteps,
  buildSignerMismatchBody,
  denialReasonStatus,
  isFixableDenial,
  verificationAgentInstructions,
} from '../_denial';
import { denialReasonToBody } from '../_response';
import { createAgentScoreCore } from '../core';
import { extractPaymentSigner, readX402PaymentHeader } from '../signer';
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
    // round trip — under policy.require_sanctions_clear, OFAC SDN wallet hits flip
    // decision -> deny inline before the handler runs.
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

export { readX402PaymentHeader };
export {
  FIXABLE_DENIAL_REASONS,
  buildContactSupportNextSteps,
  buildSignerMismatchBody,
  denialReasonStatus,
  isFixableDenial,
  verificationAgentInstructions,
};
export { denialReasonToBody };
