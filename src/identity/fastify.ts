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
import { extractPaymentSignerAddress, readX402PaymentHeader } from '../signer';
import type {
  AgentIdentity,
  AgentScoreCore,
  AgentScoreCoreOptions,
  AssessResult,
  CreateSessionOnMissing,
  DenialReason,
  FailOpenInfraReason,
  GateQuotaInfo,
  VerifyWalletSignerResult,
} from '../core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

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
  /** Per-account assess quota observability captured from `X-Quota-*` response headers. */
  quota?: GateQuotaInfo;
}

export interface AgentScoreGateOptions extends Omit<AgentScoreCoreOptions, 'createSessionOnMissing'> {
  /** Custom function to extract agent identity from a Fastify request. */
  extractIdentity?: (req: FastifyRequest) => AgentIdentity | undefined;
  /** Custom handler invoked when a request is denied. */
  onDenied?: (req: FastifyRequest, reply: FastifyReply, reason: DenialReason) => void | Promise<void>;
  /** Auto-create a verification session on missing identity. Hooks receive the Fastify `request`. */
  createSessionOnMissing?: CreateSessionOnMissing<FastifyRequest>;
}

function defaultExtractIdentity(req: FastifyRequest): AgentIdentity | undefined {
  const token = req.headers['x-operator-token'];
  const addr = req.headers['x-wallet-address'];
  const identity: AgentIdentity = {};
  if (typeof token === 'string' && token.length > 0) identity.operatorToken = token;
  if (typeof addr === 'string' && addr.length > 0) identity.address = addr;
  if (identity.operatorToken || identity.address) return identity;
  return undefined;
}

function defaultOnDenied(_req: FastifyRequest, reply: FastifyReply, reason: DenialReason): void {
  reply.code(denialReasonStatus(reason)).send(denialReasonToBody(reason));
}

/**
 * Fastify plugin that gates requests using AgentScore. Register scoped to a prefix or
 * globally; assess data is attached to `request.agentscore` on allow.
 *
 * ```ts
 * import Fastify from 'fastify';
 * import { agentscoreGate } from '@agent-score/commerce/identity/fastify';
 *
 * const app = Fastify();
 * await app.register(agentscoreGate, {
 *   apiKey: 'as_live_...',
 *   requireKyc: true,
 *   minAge: 21,
 * });
 *
 * app.post('/purchase', async (req, reply) => {
 *   // req.agentscore has the assess data
 *   return { ok: true };
 * });
 * ```
 */
const agentscoreGatePlugin: FastifyPluginAsync<AgentScoreGateOptions> = async (fastify, options) => {
  const { extractIdentity = defaultExtractIdentity, onDenied = defaultOnDenied, ...coreOptions } = options as AgentScoreGateOptions & AgentScoreCoreOptions;
  const core = createAgentScoreCore(coreOptions as AgentScoreCoreOptions);

  fastify.addHook('preHandler', async (request, reply) => {
    const identity = extractIdentity(request);
    (request as unknown as Record<string, unknown>)[GATE_STATE_KEY] = {
      core,
      operatorToken: identity?.operatorToken,
      walletAddress: identity?.address,
    } satisfies GateState;

    const outcome = await core.evaluate(identity, request);

    if (outcome.kind === 'allow') {
      const state = (request as unknown as Record<string, GateState | undefined>)[GATE_STATE_KEY];
      if (state) {
        if (outcome.degraded) {
          state.degraded = true;
          state.infraReason = outcome.infraReason;
        }
        if (outcome.quota) state.quota = outcome.quota;
      }
      if (outcome.data) (request as unknown as Record<string, unknown>).agentscore = outcome.data;
      return;
    }

    await onDenied(request, reply, outcome.reason);
  });
};

/**
 * Retrieve AgentScore assess data attached to a Fastify request by the gate. Returns
 * `undefined` if the gate did not run or attached no data.
 */
export function getAgentScoreData(request: FastifyRequest): AssessResult | undefined {
  return (request as unknown as Record<string, AssessResult | undefined>).agentscore;
}

/**
 * Read whether the gate fail-open'd due to AgentScore-side infrastructure failure on
 * this request. Returns `{ degraded: false }` for normal allows; `{ degraded: true,
 * infraReason }` when bypassed (compliance NOT enforced — log/alert).
 */
export function getGateDegradedState(
  request: FastifyRequest,
): { degraded: boolean; infraReason?: FailOpenInfraReason } {
  const state = (request as unknown as Record<string, GateState | undefined>)[GATE_STATE_KEY];
  return { degraded: state?.degraded ?? false, infraReason: state?.infraReason };
}

/**
 * Read AgentScore assess quota observability captured from `X-Quota-*` response headers
 * on this request's gate evaluate. Returns `undefined` when the request was a fail-open
 * pass-through (no assess call) or when the API didn't emit quota headers.
 */
export function getGateQuotaInfo(request: FastifyRequest): GateQuotaInfo | undefined {
  const state = (request as unknown as Record<string, GateState | undefined>)[GATE_STATE_KEY];
  return state?.quota;
}

/**
 * Report a wallet that paid under the operator_token extracted by the gate on this request.
 * Fire-and-forget: no-ops silently if the gate didn't run, the request was wallet-authenticated,
 * or the API call fails.
 */
export async function captureWallet(
  request: FastifyRequest,
  options: { walletAddress: string; network: 'evm' | 'solana'; idempotencyKey?: string },
): Promise<void> {
  const state = (request as unknown as Record<string, GateState | undefined>)[GATE_STATE_KEY];
  if (!state?.operatorToken) return;
  await state.core.captureWallet({
    operatorToken: state.operatorToken,
    walletAddress: options.walletAddress,
    network: options.network,
    idempotencyKey: options.idempotencyKey,
  });
}

/**
 * Verify the payment signer resolves to the same operator as the claimed X-Wallet-Address.
 * Pass `options.signer` explicitly (extracted from the payment credential); no auto-extraction
 * because Fastify's request isn't a Fetch Request.
 */
export async function verifyWalletSignerMatch(
  request: FastifyRequest,
  options: { signer: string | null; network?: 'evm' | 'solana' },
): Promise<VerifyWalletSignerResult> {
  const state = (request as unknown as Record<string, GateState | undefined>)[GATE_STATE_KEY];
  // Operator-token wins when both headers sent — signer-match must no-op on non-strict-wallet-auth.
  if (!state?.walletAddress || state.operatorToken) {
    return { kind: 'pass', claimedOperator: null, signerOperator: null };
  }
  return state.core.verifyWalletSignerMatch({
    claimedWallet: state.walletAddress,
    signer: options.signer,
    network: options.network,
  });
}

export { extractPaymentSignerAddress, readX402PaymentHeader };
export {
  FIXABLE_DENIAL_REASONS,
  buildContactSupportNextSteps,
  buildSignerMismatchBody,
  denialReasonStatus,
  isFixableDenial,
  verificationAgentInstructions,
};
export { denialReasonToBody };

// Escape Fastify's plugin encapsulation so the preHandler hook applies to routes
// registered at the parent scope (the common case: `app.register(agentscoreGate, ...)`
// followed by `app.get(...)` at the root). Equivalent to fastify-plugin without the
// extra dependency.
(agentscoreGatePlugin as unknown as Record<symbol, boolean>)[Symbol.for('skip-override')] = true;

export const agentscoreGate = agentscoreGatePlugin;
export default agentscoreGatePlugin;
