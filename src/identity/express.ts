import { denialReasonStatus } from '../_denial';
import { denialReasonToBody } from '../_response';
import { buildAipErrorBody, evaluateAipParts, type AipGateOptions } from '../aip/gate';
import { hasAgentIdentityHeaderNode } from '../aip/request';
import { createAgentScoreCore } from '../core';
import { hasPaymentHeader } from '../payment/payment_header';
import { extractPaymentSignerFromAuth } from '../signer';
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
  /** Per-REQUEST signer verdicts (signer_match + signer_sanctions) from this request's assess
   *  call. Request-scoped (lives on the Express `req`, not the shared core) so concurrent
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
        if (outcome.signerVerdict) state.signerVerdict = outcome.signerVerdict;
        if (outcome.operatorHandle) state.operatorHandle = outcome.operatorHandle;
      }
      if (outcome.data) (req as unknown as Record<string, unknown>).agentscore = outcome.data;
      next();
      return;
    }

    // Stash on the DENY path too: a merchant recording a denial against the buyer needs the
    // handle on exactly the path where its handler never runs.
    if (outcome.signerVerdict || outcome.operatorHandle) {
      const state = (req as unknown as Record<string, GateState | undefined>)[GATE_STATE_KEY];
      if (state) {
        if (outcome.signerVerdict) state.signerVerdict = outcome.signerVerdict;
        if (outcome.operatorHandle) state.operatorHandle = outcome.operatorHandle;
      }
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
 * Wallet-OFAC SDN enforcement is unconditional whenever a signer is in the request — an
 * SDN hit (or unavailable lookup) is already enforced by the gate (decision → deny before
 * the handler runs); merchant code typically only needs to consume this getter for the
 * `signer_match` wallet-binding verdict.
 */
export function getSignerVerdict(req: Request): SignerVerdict | undefined {
  const state = (req as unknown as Record<string, GateState | undefined>)[GATE_STATE_KEY];
  return state?.signerVerdict;
}


/** Wrap `agentscoreGate(...)` so it only fires when a payment credential is
 *  attached to the request. Discovery legs (no payment header) flow through
 *  unauthenticated and the handler emits a 402 with all rails; settle legs
 *  trigger the full gate. */
export function conditionalAgentscoreGate(options: AgentScoreGateOptions) {
  const gate = agentscoreGate(options);
  return async function conditionalGateMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!hasPaymentHeader(req.headers as Record<string, string | string[] | undefined>)) {
      next();
      return;
    }
    return gate(req, res, next);
  };
}

// ---------------------------------------------------------------------------
// AIP gate (Agentic Identity Protocol) — verifies a key-bound Agent Identity Token (AIT)
// from a trusted IdP instead of an opaque operator token. Cryptographic identity only;
// merchants who want compliance enrichment feed the verified claims to /v1/assess.
// ---------------------------------------------------------------------------

const AIT_STATE_KEY = '__agentscoreAit';

export interface AipGateExpressOptions extends AipGateOptions {
  /** Custom denial responder. Defaults to a 401/403 `application/problem+json` body. */
  onDenied?: (req: Request, res: Response, body: ReturnType<typeof buildAipErrorBody>) => void;
}

function defaultAipOnDenied(_req: Request, res: Response, body: ReturnType<typeof buildAipErrorBody>): void {
  res.status(body.status).type('application/problem+json').json(body);
}

/**
 * Express middleware that requires a valid AIT on every request it guards.
 *
 * ```ts
 * import { JwksCache } from '@agent-score/commerce';
 * import { aipGate, getVerifiedAit } from '@agent-score/commerce/identity/express';
 *
 * const jwks = new JwksCache({ trustedIssuers: ['https://issuer.example'] }); // AgentScore always trusted
 * app.post('/checkout', aipGate({ jwks }), (req, res) => {
 *   const ait = getVerifiedAit(req)!;
 *   res.json({ buyer: ait.payload.identity?.email });
 * });
 * ```
 */
export function aipGate(options: AipGateExpressOptions) {
  const { onDenied = defaultAipOnDenied, ...gateOpts } = options;
  return async function aipGateMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    const result = await evaluateAipParts(
      { method: req.method, url: req.url, headers: req.headers as Record<string, string | string[] | undefined> },
      gateOpts,
    );
    if (!result.ok) {
      onDenied(req, res, result.body);
      return;
    }
    (req as unknown as Record<string, unknown>)[AIT_STATE_KEY] = result.ait;
    next();
  };
}

/** Wrap {@link aipGate} so it only runs when an `Agent-Identity` header is present. */
export function conditionalAipGate(options: AipGateExpressOptions) {
  const gate = aipGate(options);
  return async function conditionalAipMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!hasAgentIdentityHeaderNode(req.headers as Record<string, string | string[] | undefined>)) {
      next();
      return;
    }
    return gate(req, res, next);
  };
}

/** Read the verified AIT attached to an Express request by {@link aipGate}. */
export function getVerifiedAit(req: Request): VerifiedAit | undefined {
  return (req as unknown as Record<string, VerifiedAit | undefined>)[AIT_STATE_KEY];
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
export function getOperatorHandle(req: Request): OperatorHandle | undefined {
  const state = (req as unknown as Record<string, GateState | undefined>)[GATE_STATE_KEY];
  return state?.operatorHandle;
}
