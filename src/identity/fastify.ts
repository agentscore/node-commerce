import { denialReasonStatus } from '../_denial';
import { denialReasonToBody } from '../_response';
import { createAgentScoreCore } from '../core';
import { shouldRunConditionalGate } from '../payment/payment_header';
import { extractPaymentSignerFromAuth } from '../signer';
import type {
  AgentIdentity,
  AgentScoreCore,
  AgentScoreCoreOptions,
  AssessResult,
  CreateSessionOnMissing,
  DenialReason,
  FailOpenInfraReason,
  GateQuotaInfo,
  OperatorHandle,
  SignerVerdict,
} from '../core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

const GATE_STATE_KEY = '__agentscoreGate';

interface GateState {
  core: AgentScoreCore;
  operatorToken?: string;
  walletAddress?: string;
  /** Set to `true` only when the gate fail-open'd due to AgentScore-side infra failure
   *  (429/5xx/network timeout). Compliance was NOT enforced: log/alert in your handler. */
  degraded?: boolean;
  /** Why the gate degraded: quota_exceeded / api_error / network_timeout. */
  infraReason?: FailOpenInfraReason;
  /** Per-account assess quota observability captured from `X-Quota-*` response headers. */
  quota?: GateQuotaInfo;
  /** Per-REQUEST signer verdicts (signer_match + signer_sanctions) from this request's assess
   *  call. Request-scoped (lives on the Fastify `request`, not the shared core) so concurrent
   *  same-wallet/different-signer requests can't read each other's verdict. Read via
   *  {@link getSignerVerdict}. */
  signerVerdict?: SignerVerdict;
  /** Stable pairwise handle for the account behind this request's operator token,
   *  projected off the same assess response as {@link signerVerdict}. Read via
   *  {@link getOperatorHandle}. */
  operatorHandle?: OperatorHandle;
}

interface AgentScoreGateOptions extends Omit<AgentScoreCoreOptions, 'createSessionOnMissing'> {
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

    // Extract the payment signer pre-evaluate so the gate's primary /v1/assess call
    // composes signer_match + signer_sanctions in one round trip. Fastify's request
    // isn't a Fetch Request, so go through the header-only extractor.
    const authHeader = (request.headers.authorization as string | undefined) ?? null;
    const x402Header =
      (request.headers['payment-signature'] as string | undefined) ??
      (request.headers['x-payment'] as string | undefined);
    const signer = await extractPaymentSignerFromAuth(authHeader, x402Header);
    const outcome = await core.evaluate(identity, request, signer);

    if (outcome.kind === 'allow') {
      const state = (request as unknown as Record<string, GateState | undefined>)[GATE_STATE_KEY];
      if (state) {
        if (outcome.degraded) {
          state.degraded = true;
          state.infraReason = outcome.infraReason;
        }
        if (outcome.quota) state.quota = outcome.quota;
        if (outcome.signerVerdict) state.signerVerdict = outcome.signerVerdict;
        if (outcome.operatorHandle) state.operatorHandle = outcome.operatorHandle;
      }
      if (outcome.data) (request as unknown as Record<string, unknown>).agentscore = outcome.data;
      return;
    }

    // Stash on the DENY path too: a merchant recording a denial against the buyer needs the
    // handle on exactly the path where its handler never runs.
    if (outcome.signerVerdict || outcome.operatorHandle) {
      const state = (request as unknown as Record<string, GateState | undefined>)[GATE_STATE_KEY];
      if (state) {
        if (outcome.signerVerdict) state.signerVerdict = outcome.signerVerdict;
        if (outcome.operatorHandle) state.operatorHandle = outcome.operatorHandle;
      }
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
 * infraReason }` when bypassed (compliance NOT enforced: log/alert).
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
 * Synchronous read of the cached signer verdicts (`signer_match` + `signer_sanctions`).
 * Both composed by the gate's primary /v1/assess in one round trip. Returns `undefined`
 * for operator-token paths, discovery legs, or routes the gate didn't run on.
 *
 * Wallet-OFAC SDN enforcement is unconditional whenever a signer is in the request: an
 * SDN hit (or unavailable lookup) is already enforced by the gate (decision → deny before
 * the handler runs); merchant code typically only needs this getter for the `signer_match`
 * wallet-binding verdict.
 */
export function getSignerVerdict(request: FastifyRequest): SignerVerdict | undefined {
  const state = (request as unknown as Record<string, GateState | undefined>)[GATE_STATE_KEY];
  return state?.signerVerdict;
}


// Escape Fastify's plugin encapsulation so the preHandler hook applies to routes
// registered at the parent scope (the common case: `app.register(agentscoreGate, ...)`
// followed by `app.get(...)` at the root). Equivalent to fastify-plugin without the
// extra dependency.
(agentscoreGatePlugin as unknown as Record<symbol, boolean>)[Symbol.for('skip-override')] = true;

export const agentscoreGate = agentscoreGatePlugin;
export default agentscoreGatePlugin;

/** Plugin variant of `agentscoreGate` that only runs the preHandler when a
 *  payment credential is attached. Discovery legs (no payment header) flow
 *  through to the handler unauthenticated; settle legs trigger the full gate
 *  evaluation.
 *  It also fires on an `X-Verification-Session: create` request with no identity and no payment
 *  (`requestsVerificationSession`), so a buyer can get a verify_url before paying.
 *  Replaces the hand-rolled
 *  `addHook('preHandler', (req, reply) => hasPaymentHeader(req.headers) ? gate(...) : undefined)`
 *  wrap pattern. */
const conditionalAgentscoreGatePlugin: FastifyPluginAsync<AgentScoreGateOptions> = async (fastify, options) => {
  const { extractIdentity = defaultExtractIdentity, onDenied = defaultOnDenied, ...coreOptions } = options as AgentScoreGateOptions & AgentScoreCoreOptions;
  const core = createAgentScoreCore(coreOptions as AgentScoreCoreOptions);

  fastify.addHook('preHandler', async (request, reply) => {
    if (!shouldRunConditionalGate(request.headers as Record<string, string | string[] | undefined>)) return;
    const identity = extractIdentity(request);
    (request as unknown as Record<string, unknown>)[GATE_STATE_KEY] = {
      core,
      operatorToken: identity?.operatorToken,
      walletAddress: identity?.address,
    } satisfies GateState;
    const authHeader = (request.headers.authorization as string | undefined) ?? null;
    const x402Header =
      (request.headers['payment-signature'] as string | undefined) ??
      (request.headers['x-payment'] as string | undefined);
    const signer = await extractPaymentSignerFromAuth(authHeader, x402Header);
    const outcome = await core.evaluate(identity, request, signer);
    if (outcome.kind === 'allow') {
      const state = (request as unknown as Record<string, GateState | undefined>)[GATE_STATE_KEY];
      if (state) {
        if (outcome.degraded) {
          state.degraded = true;
          state.infraReason = outcome.infraReason;
        }
        if (outcome.quota) state.quota = outcome.quota;
        if (outcome.signerVerdict) state.signerVerdict = outcome.signerVerdict;
      }
      return;
    }
    if (outcome.signerVerdict) {
      const state = (request as unknown as Record<string, GateState | undefined>)[GATE_STATE_KEY];
      if (state) state.signerVerdict = outcome.signerVerdict;
    }
    return onDenied(request, reply, outcome.reason);
  });
};
(conditionalAgentscoreGatePlugin as unknown as Record<symbol, boolean>)[Symbol.for('skip-override')] = true;
export const conditionalAgentscoreGate = conditionalAgentscoreGatePlugin;

/**
 * Read the stable pairwise {@link OperatorHandle} for the ACCOUNT behind this request's
 * operator token. This is what durable merchant state (prepaid balances first) should key
 * on, because it survives the token rotating, expiring, or being revoked, whereas anything
 * keyed on the token instance is stranded every time one rotates.
 *
 * Synchronous and free: the handle rides the gate's existing `/v1/assess` call, so reading
 * it costs no extra round trip and nothing extra against the merchant's quota.
 *
 * Returns `undefined` when the gate did not run, no operator token was presented (wallet
 * paths), or the API has no handle salt configured. Available on denied requests too,
 * so a merchant recording a denial against a buyer can still key it.
 */
export function getOperatorHandle(request: FastifyRequest): OperatorHandle | undefined {
  const state = (request as unknown as Record<string, GateState | undefined>)[GATE_STATE_KEY];
  return state?.operatorHandle;
}
