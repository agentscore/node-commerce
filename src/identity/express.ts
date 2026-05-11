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
import { extractPaymentSignerFromAuth, readX402PaymentHeader } from '../signer';
import type {
  AgentIdentity,
  AgentScoreCore,
  AgentScoreCoreOptions,
  AssessResult,
  CreateSessionOnMissing,
  DenialReason,
  FailOpenInfraReason,
  GateQuotaInfo,
  SignerVerdict,
} from '../core';
import type { Request, Response, NextFunction } from 'express';

const GATE_STATE_KEY = '__agentscoreGate';

interface GateState {
  core: AgentScoreCore;
  operatorToken?: string;
  walletAddress?: string;
  /** Set to `true` only when the gate fail-open'd due to AgentScore-side infra failure
   *  (429/5xx/network timeout). Compliance was NOT enforced — log/alert in your handler. */
  degraded?: boolean;
  /** Why the gate degraded — quota_exceeded / api_error / network_timeout. */
  infraReason?: FailOpenInfraReason;
  /** Per-account assess quota observability captured from `X-Quota-*` response headers
   *  on the success path. Absent on Enterprise / unlimited tiers, or when the gate didn't
   *  call assess (failOpen + missing identity). */
  quota?: GateQuotaInfo;
}

export interface AgentScoreGateOptions extends Omit<AgentScoreCoreOptions, 'createSessionOnMissing'> {
  /** Custom function to extract agent identity (wallet address and/or operator token). */
  extractIdentity?: (req: Request) => AgentIdentity | undefined;
  /** Custom handler invoked when a request is denied. */
  onDenied?: (req: Request, res: Response, reason: DenialReason) => void;
  /** Auto-create a verification session on missing identity. Hooks receive the Express `Request`. */
  createSessionOnMissing?: CreateSessionOnMissing<Request>;
}

function defaultExtractIdentity(req: Request): AgentIdentity | undefined {
  const token = req.headers['x-operator-token'];
  const addr = req.headers['x-wallet-address'];
  const identity: AgentIdentity = {};
  if (typeof token === 'string' && token.length > 0) identity.operatorToken = token;
  if (typeof addr === 'string' && addr.length > 0) identity.address = addr;
  if (identity.operatorToken || identity.address) return identity;
  return undefined;
}

function defaultOnDenied(_req: Request, res: Response, reason: DenialReason): void {
  res.status(denialReasonStatus(reason)).json(denialReasonToBody(reason));
}

export function agentscoreGate(options: AgentScoreGateOptions) {
  const { extractIdentity = defaultExtractIdentity, onDenied = defaultOnDenied, ...coreOptions } = options;
  // Adapter's CreateSessionOnMissing<Request> is narrower than core's CreateSessionOnMissing<unknown>;
  // the cast is safe because core passes whatever ctx the adapter hands it to the hook.
  const core = createAgentScoreCore(coreOptions as AgentScoreCoreOptions);

  return async function agentscoreMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const identity = extractIdentity(req);
    (req as unknown as Record<string, unknown>)[GATE_STATE_KEY] = {
      core,
      operatorToken: identity?.operatorToken,
      walletAddress: identity?.address,
    } satisfies GateState;

    // Extract the payment signer from Authorization (MPP) / payment-signature / x-payment
    // (x402) headers before the assess call. When present, the API composes both
    // signer_match + signer_sanctions verdicts on the primary response in one round trip.
    // Express doesn't expose a Web Fetch Request, so use the header-only extractor.
    const authHeader = (req.headers.authorization as string | undefined) ?? null;
    const x402Header =
      (req.headers['payment-signature'] as string | undefined) ??
      (req.headers['x-payment'] as string | undefined);
    const signer = await extractPaymentSignerFromAuth(authHeader, x402Header);
    const outcome = await core.evaluate(identity, req, signer);

    if (outcome.kind === 'allow') {
      const state = (req as unknown as Record<string, GateState | undefined>)[GATE_STATE_KEY];
      if (state) {
        if (outcome.degraded) {
          state.degraded = true;
          state.infraReason = outcome.infraReason;
        }
        if (outcome.quota) state.quota = outcome.quota;
      }
      if (outcome.data) (req as unknown as Record<string, unknown>).agentscore = outcome.data;
      next();
      return;
    }

    onDenied(req, res, outcome.reason);
  };
}

/**
 * Read whether the gate fail-open'd due to AgentScore-side infrastructure failure on
 * this request. Returns `{ degraded: false }` for normal allows; `{ degraded: true,
 * infraReason }` when bypassed (compliance NOT enforced — log/alert).
 */
export function getGateDegradedState(
  req: Request,
): { degraded: boolean; infraReason?: FailOpenInfraReason } {
  const state = (req as unknown as Record<string, GateState | undefined>)[GATE_STATE_KEY];
  return { degraded: state?.degraded ?? false, infraReason: state?.infraReason };
}

/**
 * Read AgentScore assess quota observability captured from `X-Quota-*` response headers
 * on this request's gate evaluate. Returns `undefined` when the request was a fail-open
 * pass-through (no assess call) or when the API didn't emit quota headers (Enterprise /
 * unlimited tiers). Use to monitor approach-to-cap proactively (warn at 80%, alert at 95%).
 */
export function getGateQuotaInfo(req: Request): GateQuotaInfo | undefined {
  const state = (req as unknown as Record<string, GateState | undefined>)[GATE_STATE_KEY];
  return state?.quota;
}

/**
 * Retrieve AgentScore assess data attached to an Express request by the gate. Returns
 * `undefined` if the gate did not run or attached no data (fail-open mode + missing identity,
 * or a route the middleware was not mounted on).
 */
export function getAgentScoreData(req: Request): AssessResult | undefined {
  return (req as unknown as Record<string, AssessResult | undefined>).agentscore;
}

/**
 * Report a wallet that paid under the operator_token extracted by the gate on this request.
 * Fire-and-forget: no-ops silently if the gate didn't run, the request was wallet-authenticated,
 * or the API call fails.
 */
export async function captureWallet(
  req: Request,
  options: { walletAddress: string; network: 'evm' | 'solana'; idempotencyKey?: string },
): Promise<void> {
  const state = (req as unknown as Record<string, GateState | undefined>)[GATE_STATE_KEY];
  if (!state?.operatorToken) return;
  await state.core.captureWallet({
    operatorToken: state.operatorToken,
    walletAddress: options.walletAddress,
    network: options.network,
    idempotencyKey: options.idempotencyKey,
  });
}

/**
 * Synchronous read of the cached signer verdicts (`signer_match` + `signer_sanctions`).
 * Both verdicts were composed by the gate's primary `/v1/assess` call on this request —
 * single round trip, no extra API cost vs the legacy 2-call pattern. Returns `undefined`
 * for operator-token paths, discovery legs, or routes the gate didn't run on.
 *
 * Under `policy.require_sanctions_clear`, OFAC SDN wallet-address hits are already
 * enforced by the gate (decision → deny before the handler runs); merchant code typically
 * only needs to consume this getter for the `signer_match` wallet-binding verdict.
 */
export function getSignerVerdict(req: Request): SignerVerdict | undefined {
  const state = (req as unknown as Record<string, GateState | undefined>)[GATE_STATE_KEY];
  if (!state?.walletAddress) return undefined;
  return state.core.getSignerVerdict(state.walletAddress);
}

// Re-export shared signer helpers so Express consumers can extract from Fetch-style Requests
// if they have one on hand (e.g. edge proxies forwarding the raw Request).
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
