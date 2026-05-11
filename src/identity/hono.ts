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
  AgentScoreCore,
  AgentScoreCoreOptions,
  AssessResult,
  CreateSessionOnMissing,
  DenialReason,
  FailOpenInfraReason,
  GateQuotaInfo,
  SignerVerdict,
} from '../core';
import type { Context, MiddlewareHandler } from 'hono';

const CONTEXT_KEY = 'agentscore';
const GATE_STATE_KEY = '__agentscoreGate';

interface GateState {
  core: AgentScoreCore;
  operatorToken?: string;
  walletAddress?: string;
  /** Set to `true` only when the gate fail-open'd due to AgentScore-side infra failure
   *  (429/5xx/network timeout). Compliance was NOT enforced for this request — log/alert
   *  in your handler. See {@link getGateDegradedState}. */
  degraded?: boolean;
  /** Why the gate degraded — quota_exceeded / api_error / network_timeout. */
  infraReason?: FailOpenInfraReason;
  /** Per-account assess quota observability captured from `X-Quota-*` response headers
   *  on the success path. Absent on Enterprise / unlimited tiers, or when the gate didn't
   *  call assess. */
  quota?: GateQuotaInfo;
}

export interface AgentScoreGateOptions extends Omit<AgentScoreCoreOptions, 'createSessionOnMissing'> {
  /** Custom function to extract agent identity (wallet address and/or operator token). */
  extractIdentity?: (c: Context) => AgentIdentity | undefined;
  /** Custom handler invoked when a request is denied. Must return a Hono `Response`. */
  onDenied?: (c: Context, reason: DenialReason) => Response | Promise<Response>;
  /** Auto-create a verification session when no identity is present. The `getSessionOptions`
   *  and `onBeforeSession` hooks receive the Hono `Context` so they can read the request body,
   *  look up product metadata, and pre-create merchant-specific resume tokens. */
  createSessionOnMissing?: CreateSessionOnMissing<Context>;
}

function defaultExtractIdentity(c: Context): AgentIdentity | undefined {
  const token = c.req.header('x-operator-token');
  const addr = c.req.header('x-wallet-address');
  const identity: AgentIdentity = {};
  if (token && token.length > 0) identity.operatorToken = token;
  if (addr && addr.length > 0) identity.address = addr;
  if (identity.operatorToken || identity.address) return identity;
  return undefined;
}

function defaultOnDenied(c: Context, reason: DenialReason): Response {
  return c.json(denialReasonToBody(reason), denialReasonStatus(reason));
}

/**
 * Hono middleware that gates requests using AgentScore trust and policy evaluation.
 *
 * ```ts
 * import { Hono } from 'hono';
 * import { agentscoreGate } from '@agent-score/commerce/identity/hono';
 *
 * const app = new Hono();
 * app.use('/purchase', agentscoreGate({ apiKey: 'as_live_...', requireKyc: true, minAge: 21 }));
 * ```
 */
export function agentscoreGate(options: AgentScoreGateOptions): MiddlewareHandler {
  const { extractIdentity = defaultExtractIdentity, onDenied = defaultOnDenied, ...coreOptions } = options;
  const core = createAgentScoreCore(coreOptions as AgentScoreCoreOptions);

  return async (c, next) => {
    const identity = extractIdentity(c);
    c.set(GATE_STATE_KEY, {
      core,
      operatorToken: identity?.operatorToken,
      walletAddress: identity?.address,
    } satisfies GateState);

    // Extract the payment signer from MPP / x402 headers before the assess call. When a
    // signer is recovered, the API composes both signer_match + signer_sanctions on the
    // primary assess response in one round trip; under policy.require_sanctions_clear a
    // wallet-sanctions hit flips decision -> deny inline so the gate's onDenied fires
    // before the handler runs. No-op on discovery legs (no payment header present).
    const signer = await extractPaymentSigner(c.req.raw, readX402PaymentHeader(c.req.raw));
    const outcome = await core.evaluate(identity, c, signer);

    if (outcome.kind === 'allow') {
      if (outcome.degraded || outcome.quota) {
        const prev = c.get(GATE_STATE_KEY) as GateState;
        c.set(GATE_STATE_KEY, {
          ...prev,
          ...(outcome.degraded && { degraded: true, infraReason: outcome.infraReason }),
          ...(outcome.quota && { quota: outcome.quota }),
        } satisfies GateState);
      }
      if (outcome.data) c.set(CONTEXT_KEY, outcome.data);
      await next();
      return;
    }

    return onDenied(c, outcome.reason);
  };
}

/**
 * Retrieve AgentScore assess data from a Hono `Context`. Returns `undefined` if the gate
 * did not run (e.g. in fail-open mode with a missing identity, or on a route without the
 * gate middleware).
 */
export function getAgentScoreData(c: Context): AssessResult | undefined {
  return c.get(CONTEXT_KEY) as AssessResult | undefined;
}

/**
 * Read whether the gate fail-open'd due to AgentScore-side infrastructure failure on
 * this request. Returns `{ degraded: false }` for normal allows; `{ degraded: true,
 * infraReason }` when the gate was bypassed (compliance NOT enforced — log/alert).
 *
 * Only set when `failOpen: true` was configured AND the failure was an infra failure
 * (429 quota_exceeded, 5xx api_error, network_timeout). Real compliance denials never
 * trigger fail-open and so never set this flag.
 */
export function getGateDegradedState(c: Context): { degraded: boolean; infraReason?: FailOpenInfraReason } {
  const state = c.get(GATE_STATE_KEY) as GateState | undefined;
  return { degraded: state?.degraded ?? false, infraReason: state?.infraReason };
}

/**
 * Read AgentScore assess quota observability captured from `X-Quota-*` response headers
 * on this request's gate evaluate. Returns `undefined` when the request was a fail-open
 * pass-through (no assess call) or when the API didn't emit quota headers (Enterprise /
 * unlimited tiers). Use to monitor approach-to-cap proactively.
 */
export function getGateQuotaInfo(c: Context): GateQuotaInfo | undefined {
  const state = c.get(GATE_STATE_KEY) as GateState | undefined;
  return state?.quota;
}

/**
 * Report a wallet that paid under the operator_token the gate extracted on this request.
 * Call this after a successful payment to build AgentScore's cross-merchant credential↔wallet
 * profile. No-ops silently if the gate never ran, the request was wallet-authenticated (no
 * operator_token to associate), or the API call fails — capture is fire-and-forget by design.
 *
 * ```ts
 * app.post('/purchase', async (c) => {
 *   const assess = getAgentScoreData(c);
 *   // ... run payment, recover signer wallet from the payload ...
 *   await captureWallet(c, { walletAddress: signer, network: 'evm' });
 *   return c.json({ ok: true });
 * });
 * ```
 */
export async function captureWallet(
  c: Context,
  options: { walletAddress: string; network: 'evm' | 'solana'; idempotencyKey?: string },
): Promise<void> {
  const state = c.get(GATE_STATE_KEY) as GateState | undefined;
  if (!state?.operatorToken) return;
  await state.core.captureWallet({
    operatorToken: state.operatorToken,
    walletAddress: options.walletAddress,
    network: options.network,
    idempotencyKey: options.idempotencyKey,
  });
}

/**
 * Synchronous read of the cached signer verdicts (`signer_match` wallet-binding +
 * `signer_sanctions` OFAC SDN wallet-address check). Both verdicts were composed by the
 * gate's primary `/v1/assess` call on this request — single round trip, no extra API
 * cost vs the legacy 2-call pattern via `verifyWalletSignerMatch`.
 *
 * Returns `undefined` when the gate didn't run, the request was operator-token-only, or
 * no payment credential was attached (discovery legs).
 *
 * Under `policy.require_sanctions_clear`, an OFAC SDN hit (or unavailable lookup) is
 * already enforced by the gate (decision → deny before the handler runs); merchant code
 * typically only needs this getter for the `signer_match` wallet-binding verdict.
 */
export function getSignerVerdict(c: Context): SignerVerdict | undefined {
  const state = c.get(GATE_STATE_KEY) as GateState | undefined;
  if (!state?.walletAddress) return undefined;
  return state.core.getSignerVerdict(state.walletAddress);
}


// Re-export the denial helpers so vendors can compose custom onDenied handlers
// without reaching into the internal _denial module.
export {
  FIXABLE_DENIAL_REASONS,
  buildContactSupportNextSteps,
  buildSignerMismatchBody,
  denialReasonStatus,
  isFixableDenial,
  verificationAgentInstructions,
};
export { denialReasonToBody };
export { readX402PaymentHeader };
