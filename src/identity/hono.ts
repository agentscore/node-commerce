import { denialReasonStatus } from '../_denial';
import { denialReasonToBody } from '../_response';
import { buildAipErrorBody, evaluateAipRequest, type AipGateOptions } from '../aip/gate';
import { hasAgentIdentityHeader } from '../aip/request';
import { createAgentScoreCore } from '../core';
import { hasPaymentHeader } from '../payment/payment_header';
import { extractPaymentSigner, readX402PaymentHeader } from '../signer';
import type { VerifiedAit } from '../aip/verify';
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
  /** Per-REQUEST signer verdicts (signer_match + signer_sanctions) from this request's assess
   *  call. Request-scoped (lives on the Hono context, not the shared core) so concurrent
   *  same-wallet/different-signer requests can't read each other's verdict. Read via
   *  {@link getSignerVerdict}. */
  signerVerdict?: SignerVerdict;
  /** Stable pairwise handle for the account behind this request's operator token,
   *  projected off the same assess response as {@link signerVerdict}. Read via
   *  {@link getOperatorHandle}. */
  operatorHandle?: OperatorHandle;
}

interface AgentScoreGateOptions extends Omit<AgentScoreCoreOptions, 'createSessionOnMissing'> {
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
      if (outcome.degraded || outcome.quota || outcome.signerVerdict || outcome.operatorHandle) {
        const prev = c.get(GATE_STATE_KEY) as GateState;
        c.set(GATE_STATE_KEY, {
          ...prev,
          ...(outcome.degraded && { degraded: true, infraReason: outcome.infraReason }),
          ...(outcome.quota && { quota: outcome.quota }),
          ...(outcome.signerVerdict && { signerVerdict: outcome.signerVerdict }),
          ...(outcome.operatorHandle && { operatorHandle: outcome.operatorHandle }),
        } satisfies GateState);
      }
      if (outcome.data) c.set(CONTEXT_KEY, outcome.data);
      await next();
      return;
    }

    // Stash on the DENY path too: a merchant recording a denial against the buyer needs the
    // handle on exactly the path where its handler never runs.
    if (outcome.signerVerdict || outcome.operatorHandle) {
      const prev = c.get(GATE_STATE_KEY) as GateState;
      c.set(GATE_STATE_KEY, {
        ...prev,
        ...(outcome.signerVerdict && { signerVerdict: outcome.signerVerdict }),
        ...(outcome.operatorHandle && { operatorHandle: outcome.operatorHandle }),
      } satisfies GateState);
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
 * gate's primary `/v1/assess` call on this request — single round trip, no extra API call.
 *
 * Returns `undefined` when the gate didn't run, the request was operator-token-only, or
 * no payment credential was attached (discovery legs).
 *
 * Wallet-OFAC SDN enforcement is unconditional whenever a signer is in the request — an
 * SDN hit (or unavailable lookup) is already enforced by the gate (decision → deny before
 * the handler runs); merchant code typically only needs this getter for the `signer_match`
 * wallet-binding verdict.
 */
export function getSignerVerdict(c: Context): SignerVerdict | undefined {
  const state = c.get(GATE_STATE_KEY) as GateState | undefined;
  return state?.signerVerdict;
}



/** Wrap `agentscoreGate(...)` so it only fires when a payment credential is
 *  attached to the request. Discovery legs (no payment header) flow through
 *  unauthenticated and the handler emits a 402 with all rails; settle legs
 *  trigger the full gate.
 *
 *  Replaces the hand-rolled `if (!hasPaymentHeader(...)) { await next(); return; }`
 *  wrap pattern in consumer codebases.
 */
export function conditionalAgentscoreGate(options: AgentScoreGateOptions): MiddlewareHandler {
  const gate = agentscoreGate(options);
  return async (c, next) => {
    if (!hasPaymentHeader(c.req.raw)) {
      await next();
      return;
    }
    return gate(c, next);
  };
}

// ---------------------------------------------------------------------------
// AIP gate (Agentic Identity Protocol) — verifies a key-bound Agent Identity Token (AIT)
// from a trusted IdP instead of an opaque operator token. Cryptographic identity only;
// merchants who want compliance enrichment feed the verified claims to /v1/assess. Hono is
// Fetch-native, so this reuses `verifyAitRequest(c.req.raw)` directly while keeping the same
// middleware + `getVerifiedAit` accessor shape as the express/fastify adapters.
// ---------------------------------------------------------------------------

const AIT_CONTEXT_KEY = '__agentscoreAit';

export interface AipGateHonoOptions extends AipGateOptions {
  /** Custom denial responder. Defaults to a 401/403 `application/problem+json` Response. */
  onDenied?: (c: Context, body: ReturnType<typeof buildAipErrorBody>) => Response | Promise<Response>;
}

function defaultAipOnDenied(_c: Context, body: ReturnType<typeof buildAipErrorBody>): Response {
  return new Response(JSON.stringify(body), {
    status: body.status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

/**
 * Hono middleware that requires a valid AIT on every request it guards.
 *
 * ```ts
 * import { JwksCache } from '@agent-score/commerce';
 * import { aipGate, getVerifiedAit } from '@agent-score/commerce/identity/hono';
 *
 * const jwks = new JwksCache({ trustedIssuers: ['https://issuer.example'] }); // AgentScore always trusted
 * app.post('/checkout', aipGate({ jwks }), (c) => {
 *   const ait = getVerifiedAit(c)!;
 *   return c.json({ buyer: ait.payload.identity?.email });
 * });
 * ```
 */
export function aipGate(options: AipGateHonoOptions): MiddlewareHandler {
  const { onDenied = defaultAipOnDenied, ...gateOpts } = options;
  return async (c, next) => {
    const result = await evaluateAipRequest(c.req.raw, gateOpts);
    if (!result.ok) {
      return onDenied(c, result.body);
    }
    c.set(AIT_CONTEXT_KEY, result.ait);
    await next();
  };
}

/** Wrap {@link aipGate} so it only runs when an `Agent-Identity` header is present. */
export function conditionalAipGate(options: AipGateHonoOptions): MiddlewareHandler {
  const gate = aipGate(options);
  return async (c, next) => {
    if (!hasAgentIdentityHeader(c.req.raw)) {
      await next();
      return;
    }
    return gate(c, next);
  };
}

/** Read the verified AIT attached to a Hono `Context` by {@link aipGate}. */
export function getVerifiedAit(c: Context): VerifiedAit | undefined {
  return c.get(AIT_CONTEXT_KEY) as VerifiedAit | undefined;
}

/**
 * Read the stable pairwise {@link OperatorHandle} for the ACCOUNT behind this request's
 * operator token. This is what durable merchant state (prepaid balances first) should key
 * on, because it survives the token rotating, expiring, or being revoked, whereas anything
 * keyed on the token instance is stranded every time one rotates.
 *
 * Synchronous and free: the handle rides the gate's existing `/v1/assess` call, so reading
 * it costs no extra round trip and nothing extra against the merchant's quota.
 *
 * Returns `undefined` when the gate did not run, no operator token was presented (wallet or
 * AIT paths), or the API has no handle salt configured. Available on denied requests too,
 * so a merchant recording a denial against a buyer can still key it.
 */
export function getOperatorHandle(c: Context): OperatorHandle | undefined {
  const state = c.get(GATE_STATE_KEY) as GateState | undefined;
  return state?.operatorHandle;
}
