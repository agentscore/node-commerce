import {
  AgentScore,
  InvalidCredentialError,
  PaymentRequiredError,
  QuotaExceededError,
  TimeoutError as SdkTimeoutError,
  TokenExpiredError,
} from '@agent-score/sdk';
import { isFixableDenial } from './_denial';
import { QUOTA_EXCEEDED_INSTRUCTIONS } from './_response';
import { normalizeAddress } from './address';
import { TTLCache } from './cache';
import type { PaymentSigner } from './signer';

// Character-based trim avoids a CodeQL polynomial-redos false positive on
// `/\/+$/` patterns that report library-input strings.
function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return end === s.length ? s : s.slice(0, end);
}

declare const __VERSION__: string;

// ---------------------------------------------------------------------------
// Public types (framework-agnostic)
// ---------------------------------------------------------------------------

export interface AgentIdentity {
  address?: string;
  operatorToken?: string;
}

/**
 * Session metadata returned from `POST /v1/sessions`. Surfaced to the `onBeforeSession`
 * hook so merchants can correlate an AgentScore session with their own resume token
 * (e.g. a pending-order id).
 */
export interface SessionMetadata {
  session_id: string;
  verify_url: string;
  poll_secret: string;
  poll_url: string;
  expires_at?: string;
}

/**
 * Configuration for auto-creating a verification session when no identity is present.
 *
 * The static `context` / `productName` options are sent on every session request. For
 * per-request context (e.g. the specific product the agent was trying to buy), pass
 * a `getSessionOptions` callback that returns dynamic values; its return is merged
 * over the static defaults.
 *
 * `onBeforeSession` is a side-effect hook that runs after the session is minted but
 * before the 403 is built. Use it to pre-create a reservation/draft/pending-order
 * row in your DB so agents can resume via a merchant-specific id. Return value is
 * merged into `DenialReason.extra`, so it surfaces in both the default 403 body and
 * in a custom `onDenied` handler.
 */
export interface CreateSessionOnMissing<TCtx = unknown> {
  apiKey: string;
  baseUrl?: string;
  context?: string;
  productName?: string;
  /** Per-request override of `context` / `productName`. Invoked with the framework context. */
  getSessionOptions?: (ctx: TCtx) => Promise<{ context?: string; productName?: string }>
                                  |          { context?: string; productName?: string };
  /** Side-effect hook that runs after the session is minted. Return value is merged
   *  into `DenialReason.extra` so custom `onDenied` handlers can include merchant-specific
   *  fields (e.g. `order_id`) in the 403 response. Hook errors are logged and swallowed —
   *  a failing side effect should not block the 403 from reaching the agent. */
  onBeforeSession?: (ctx: TCtx, session: SessionMetadata) => Promise<Record<string, unknown>>
                                                          |          Record<string, unknown>;
}

export interface AgentScoreCoreOptions {
  /** AgentScore API key. Required. */
  apiKey: string;
  /** Require KYC verification. */
  requireKyc?: boolean;
  /** Require operator to be clear of sanctions. */
  requireSanctionsClear?: boolean;
  /** Minimum operator age bracket (18 or 21). */
  minAge?: number;
  /** List of blocked jurisdictions (blocklist). */
  blockedJurisdictions?: string[];
  /** List of allowed jurisdictions (allowlist — only these pass). */
  allowedJurisdictions?: string[];
  /** If true, allow the request through when the API is unreachable. Defaults to false. */
  failOpen?: boolean;
  /** How long to cache results, in seconds. Defaults to 300. */
  cacheSeconds?: number;
  /** AgentScore API base URL. Defaults to "https://api.agentscore.sh". */
  baseUrl?: string;
  /** Optional chain to filter scoring to. */
  chain?: string;
  /** Prepended to the default User-Agent as `"{userAgent} (@agent-score/commerce@{version})"`. Use to attribute API calls to your app. */
  userAgent?: string;
  /** When set and no identity is found, create a verification session instead of denying immediately. */
  createSessionOnMissing?: CreateSessionOnMissing;
}

export type DenialCode =
  | 'wallet_not_trusted'
  | 'missing_identity'
  | 'api_error'
  | 'payment_required'
  | 'identity_verification_required'
  // Wallet-signer binding: claimed X-Wallet-Address must resolve to the same operator as
  // the payment signer; wallet-auth is rejected on rails with no wallet signer.
  | 'wallet_signer_mismatch'
  | 'wallet_auth_requires_wallet_signing'
  // Granular credential-state denials passed through from /v1/assess.
  // - `token_expired`: revoked + TTL-expired (the API unifies these). The 401 body carries
  //   an auto-minted session, forwarded into DenialReason for one-shot recovery.
  // - `invalid_credential`: the token doesn't exist at all (typo, never minted, fabricated).
  //   No auto-session is minted by the API for this case — agents should switch to a
  //   different stored token or drop the header to bootstrap a fresh session.
  | 'token_expired'
  | 'invalid_credential';

/**
 * Cross-merchant pattern hint emitted on bootstrap denials and session-create responses.
 * LLM-hosted agents should persist this to long-term memory so future AgentScore encounters skip
 * the cold-start session flow. Contents are the pattern, not secrets.
 */
export interface AgentMemoryHint {
  save_for_future_agentscore_gates: true;
  pattern_summary: string;
  quickstart: string;
  identity_check_endpoint: string;
  list_wallets_endpoint?: string;
  identity_paths: { wallet: string; operator_token: string };
  bootstrap: string;
  do_not_persist_in_memory: string[];
  persist_in_credential_store: string[];
}

export interface DenialReason {
  code: DenialCode;
  /** Human-readable explanation. When omitted, `denialReasonToBody` substitutes a per-code default. */
  message?: string;
  decision?: string;
  reasons?: string[];
  verify_url?: string;
  session_id?: string;
  poll_secret?: string;
  poll_url?: string;
  agent_instructions?: string;
  /** Cross-merchant memory hint. Emitted on bootstrap denials only by default. */
  agent_memory?: AgentMemoryHint;
  /** Full assess response when the denial came from `/v1/assess`. Lets consumers access fields
   *  not promoted to first-class DenialReason properties (e.g., `policy_result`). Undefined for
   *  denials that did not originate from an assess call (missing_identity, api_error,
   *  payment_required, identity_verification_required). */
  data?: AssessResult;
  /** Extra fields returned from the `createSessionOnMissing.onBeforeSession` hook. Merged
   *  into the default 403 body; custom `onDenied` handlers can spread these into their own
   *  response shape (e.g. to include a merchant-minted `order_id`). */
  extra?: Record<string, unknown>;
  // ---------------------------------------------------------------------------
  // Wallet-signer-match fields — populated for wallet_signer_mismatch only.
  // ---------------------------------------------------------------------------
  /** Operator id resolved from `X-Wallet-Address`. */
  claimed_operator?: string;
  /** Operator id the actual payment signer resolves to. `null` when the signer wallet isn't
   *  linked to any operator (treat as a different identity). */
  actual_signer_operator?: string | null;
  /** The wallet the agent claimed via header. Echoed back for self-correction. */
  expected_signer?: string;
  /** The wallet that actually signed the payment. */
  actual_signer?: string;
  /** Wallets the claimed operator could sign with (if enumerable). Present when non-empty. */
  linked_wallets?: string[];
}

/** Operator verification details from the assess response. Mirrors python's
 *  `OperatorVerification` dataclass. */
export interface OperatorVerification {
  level: string;
  operator_type: string | null;
  verified_at: string | null;
}

/** Account-level KYC facts that apply to every operator under the same account.
 *  Populated when the API returns account_verification (post-KYC operator).
 *  Mirrors python's account_verification dict shape. */
export interface AccountVerification {
  kyc_level?: string;
  sanctions_clear?: boolean;
  age_bracket?: string;
  jurisdiction?: string;
  verified_at?: string | null;
}

/** A single policy check from the assess response. Mirrors python's `PolicyCheck`. */
export interface PolicyCheck {
  rule: string;
  passed: boolean;
  required?: unknown;
  actual?: unknown;
}

/** Policy evaluation result from the assess response. Mirrors python's `PolicyResult`. */
export interface PolicyResult {
  all_passed: boolean;
  checks: PolicyCheck[];
}

export interface AssessResult {
  decision: string | null;
  decision_reasons: string[];
  identity_method?: string;
  operator_verification?: OperatorVerification;
  account_verification?: AccountVerification;
  resolved_operator?: string | null;
  /** Wallets linked to the same operator as the resolved identity. Capped at 100 entries
   *  by the API. Useful for advertising in 402 challenges so wallet-auth agents know which
   *  alt-signers will satisfy `wallet_signer_mismatch`. */
  linked_wallets?: string[];
  verify_url?: string;
  policy_result?: PolicyResult | null;
}

/**
 * Reason a failOpen allow short-circuited an evaluate call due to AgentScore-side
 * infrastructure issues. Surfaced on `EvaluateOutcome` so merchants can log/alert when
 * their gate is running in degraded mode (compliance not actually enforced this request).
 *
 * - `quota_exceeded` — AgentScore returned 429
 * - `api_error` — AgentScore returned 5xx or non-2xx that isn't 429
 * - `network_timeout` — request to /v1/assess timed out or failed at the network layer
 */
export type FailOpenInfraReason = 'quota_exceeded' | 'api_error' | 'network_timeout';

/** Per-account assess quota observability, captured from `X-Quota-*` response headers
 *  on the success path. Mirrors the SDK's `QuotaInfo` shape — re-exported from gate state
 *  so merchants can monitor approach-to-cap proactively (warn at 80%, alert at 95%). */
export interface GateQuotaInfo {
  limit: number | null;
  used: number | null;
  /** ISO-8601 timestamp, or the literal string `"never"` for unlimited tiers. */
  reset: string | null;
}

/**
 * Outcome from `AgentScoreCore.evaluate()`. Adapters map this to framework-specific responses.
 *
 * - `{ kind: 'allow', data }` — the request passed the policy. `data` is present on a normal
 *   allow; `undefined` when fail-open short-circuited (identity missing, API unreachable,
 *   timeout, or 402 paid-tier required).
 * - When `failOpen: true` and the allow was the result of an AgentScore-side infrastructure
 *   failure (429/5xx/timeout), the result also carries `degraded: true` + `infraReason` so
 *   merchants can alert/log without parsing console output.
 * - `quota` propagates the SDK's per-request quota observability when the API emits the
 *   `X-Quota-*` headers. Optional; absent on Enterprise / unlimited tiers.
 * - `{ kind: 'deny', reason }` — the request was denied. Adapters should render a 403 with the
 *   reason, or invoke the caller's custom denial handler.
 */
export type EvaluateOutcome =
  | { kind: 'allow'; data?: AssessResult; degraded?: boolean; infraReason?: FailOpenInfraReason; quota?: GateQuotaInfo }
  | { kind: 'deny'; reason: DenialReason };

interface CaptureWalletOptions {
  /** Operator credential (`opc_...`) that the agent authenticated with. */
  operatorToken: string;
  /** Signer wallet recovered from the payment payload. */
  walletAddress: string;
  /** Key-derivation family — `"evm"` for any EVM chain, `"solana"` for Solana. */
  network: 'evm' | 'solana';
  /** Optional stable key for the logical payment (e.g., payment intent id, tx hash). When the
   *  same key is seen again for the same (credential, wallet, network), the server no-ops —
   *  prevents agent retries from inflating transaction_count. */
  idempotencyKey?: string;
}

/** Combined wallet-signer verdict surfaced by `getSignerVerdict(c)` — both verdicts come
 *  through the gate's primary `/v1/assess` call (single round trip). `signer_match` describes
 *  the wallet-binding (claimed wallet's operator ≡ signer wallet's operator); `signer_sanctions`
 *  describes the OFAC SDN wallet-address check.
 *
 *  `signer_match` is projected to the gate's camelCase `VerifyWalletSignerResult` shape so
 *  existing `buildSignerMismatchBody(...)` helpers consume it unchanged. `signer_sanctions`
 *  passes through in the API's wire shape (already short and stable). Returned `undefined`
 *  from `getSignerVerdict` when the gate didn't run with a signer (operator-token-only
 *  paths, discovery legs with no payment header). */
export interface SignerVerdict {
  signer_match: VerifyWalletSignerResult | null;
  signer_sanctions:
    | { status: 'clear' }
    | { sanctioned: true; ofac_label: string; sdn_uid: string; listed_at: string | null }
    | { status: 'unavailable' }
    | null;
}

export type VerifyWalletSignerResult =
  | { kind: 'pass'; claimedOperator: string | null; signerOperator: string | null }
  | {
      kind: 'wallet_signer_mismatch';
      claimedOperator: string | null;
      actualSignerOperator: string | null;
      expectedSigner: string;
      actualSigner: string;
      linkedWallets: string[];
      /** JSON-encoded action copy (action + steps + user_message). Spread into the 403 body
       *  verbatim so agents get a concrete recovery path inside the denial response itself. */
      agentInstructions: string;
    }
  | {
      kind: 'wallet_auth_requires_wallet_signing';
      claimedWallet: string;
      agentInstructions: string;
    };

export interface AgentScoreCore {
  /**
   * Evaluate the request's identity against the configured policy.
   * @param identity - extracted identity (wallet address and/or operator token)
   * @param ctx - optional framework-specific context (Hono c, Express req, etc.) passed
   *   through to `createSessionOnMissing` hooks. Opaque to core.
   */
  evaluate(
    identity: AgentIdentity | undefined,
    ctx?: unknown,
    /** Pre-extracted payment signer from the inbound request (the adapter middleware
     *  extracts it via `extractPaymentSigner`). When provided, the assess call carries
     *  it and the response includes `signer_match` + `signer_sanctions` verdicts in one
     *  round trip. */
    signer?: PaymentSigner | null,
  ): Promise<EvaluateOutcome>;
  /** Synchronous read of the cached signer verdicts (signer_match + signer_sanctions)
   *  populated when the gate's evaluate call was made with a pre-extracted signer. Returns
   *  `undefined` when the gate didn't run, the request was operator-token-authenticated,
   *  or no signer was extractable (discovery legs). */
  getSignerVerdict(claimedAddress: string): SignerVerdict | undefined;
  /** Report a wallet seen paying under an operator credential. Fire-and-forget; silently
   *  swallows non-fatal errors because capture is informational, not on the critical path. */
  captureWallet(options: CaptureWalletOptions): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Internal cache entry for the gate's per-`(identity, policy)` assess result memo.
 *  Distinct from the public `AssessResult` interface (the typed `/v1/assess` response
 *  shape returned to merchants); this carries the cached decision plus the per-signer
 *  wallet-match sub-cache. */
interface CachedAssessResult {
  allow: boolean;
  decision?: string;
  reasons?: string[];
  raw?: unknown;
}

/**
 * Build the cross-merchant memory hint emitted on bootstrap denials. Base URLs are
 * derived from the gate's AgentScore API base so self-hosted / staging deployments get
 * correct pointers. Contents describe the AgentScore identity substrate in transferable
 * terms; merchant-specific context lives in other `agent_instructions` fields.
 */
// Canonical production AgentScore API — used as the authoritative source for endpoint pointers
// emitted to agent memory regardless of how a given merchant configured their gate's baseUrl.
const CANONICAL_AGENTSCORE_API = 'https://api.agentscore.sh';

// JSON-encoded action copy emitted on wallet-signer-match denials. Spread into 403 bodies
// by merchants so agents get a concrete recovery path inside the denial response itself —
// no discovery-doc round trip required.
const WALLET_SIGNER_MISMATCH_INSTRUCTIONS = JSON.stringify({
  action: 'resign_or_switch_to_operator_token',
  steps: [
    'Preferred: re-submit the payment signed by expected_signer (or any entry in linked_wallets — same-operator wallets are fungible) and retry with the same X-Wallet-Address.',
    'Alternative: drop X-Wallet-Address and retry with X-Operator-Token. Use a stored opc_... if you have one; otherwise retry this request with NO identity header — the merchant will mint a verification session in the 403 body (verify_url + poll_secret). Share verify_url with the user, poll, receive a fresh opc_...',
  ],
  user_message:
    'The payment signer resolves to a different operator than X-Wallet-Address. Re-sign from expected_signer or any linked_wallets entry, or switch to X-Operator-Token.',
});

const WALLET_AUTH_REQUIRES_WALLET_SIGNING_INSTRUCTIONS = JSON.stringify({
  action: 'switch_to_operator_token',
  steps: [
    'This payment rail (Stripe SPT, card) carries no wallet signature — X-Wallet-Address cannot be verified against the payment.',
    'Drop X-Wallet-Address and retry with X-Operator-Token. If you do not have a stored opc_..., retry with no identity header to receive a verification session.',
  ],
  user_message:
    'Wallet-address identity is only supported on wallet-signing rails (Tempo MPP, x402). On Stripe or card, use X-Operator-Token instead.',
});

// `invalid_credential` is permanent — the token doesn't exist (typo, never minted, fabricated).
// Distinct from `token_expired` (which carries an auto-session for one-shot recovery): the
// API doesn't auto-mint a session here because the client may simply have a different valid
// token to try. Agents should switch tokens or drop the header to bootstrap a session.
const INVALID_CREDENTIAL_INSTRUCTIONS = JSON.stringify({
  action: 'switch_token_or_restart_session',
  steps: [
    'The X-Operator-Token you sent does not match any credential. This is a permanent state — retrying with the same token will keep failing.',
    'If you have other stored opc_... credentials, retry with one of them.',
    'Otherwise drop X-Operator-Token and retry with no identity header — the merchant will mint a fresh verification session in the 403 body (verify_url + poll_secret) so the user can re-verify and you can poll for a new operator_token.',
  ],
  user_message:
    'The operator_token is not recognized. Use a different stored token, or restart the verification session flow to mint a new one.',
});

export function buildAgentMemoryHint(): AgentMemoryHint {
  // Memory pointers always point at the canonical production API — merchants must not be
  // able to redirect the cross-merchant memory surface, since that would be a phishing
  // vector for the verify URL.
  const api = CANONICAL_AGENTSCORE_API;
  return {
    save_for_future_agentscore_gates: true,
    pattern_summary:
      'AgentScore is a cross-merchant identity substrate for agent commerce. Any endpoint that ' +
      'returns 403 missing_identity / identity_verification_required or 402 challenges referencing AgentScore uses ' +
      'the same identity system. One KYC works across all AgentScore merchants — no re-verification ' +
      'per site. Save this pattern (and the endpoints below) to persistent memory so future ' +
      'AgentScore encounters skip the cold-start session flow.',
    quickstart: 'https://docs.agentscore.sh/guides/agent-identity',
    identity_check_endpoint: `${api}/v1/credentials`,
    identity_paths: {
      wallet:
        'If paying from a crypto wallet you have used before on any AgentScore merchant, send ' +
        '`X-Wallet-Address: 0x...`. Shortest path; no token lifecycle to manage.',
      operator_token:
        'For any rail (Stripe SPT, card, or a wallet you have not linked yet), send ' +
        '`X-Operator-Token: opc_...`. Reusable across merchants until the token expires.',
    },
    bootstrap:
      'If you have neither a linked wallet nor a valid operator_token, follow the session/verify ' +
      'flow in the per-request `agent_instructions` block. This happens at most once per agent ' +
      'identity — after first verification, the operator_token and any subsequently used wallet ' +
      'are reusable everywhere.',
    do_not_persist_in_memory: ['operator_token', 'poll_secret'],
    persist_in_credential_store: ['operator_token'],
  };
}

// ---------------------------------------------------------------------------
// Core factory
// ---------------------------------------------------------------------------

export function createAgentScoreCore(options: AgentScoreCoreOptions): AgentScoreCore {
  if (!options.apiKey) {
    throw new Error('AgentScore API key is required. Get one at https://agentscore.sh/sign-up');
  }

  const {
    apiKey,
    requireKyc,
    requireSanctionsClear,
    minAge,
    blockedJurisdictions,
    allowedJurisdictions,
    failOpen = false,
    cacheSeconds = 300,
    baseUrl: rawBaseUrl = 'https://api.agentscore.sh',
    chain: gateChain,
    userAgent,
    createSessionOnMissing,
  } = options;

  const baseUrl = stripTrailingSlashes(rawBaseUrl);
  const agentMemoryHint = buildAgentMemoryHint();

  const defaultUa = `@agent-score/commerce@${__VERSION__}`;
  const userAgentHeader = userAgent ? `${userAgent} (${defaultUa})` : defaultUa;

  // Single shared SDK instance for every API call this gate makes (assess, sessions,
  // credentials/wallets, telemetry). Connection pooling + typed-error classification +
  // X-Quota-* header capture all flow through here. The SDK owns the transport layer
  // (timeouts, retry-on-429); the gate adds policy semantics on top. Pass the
  // merchant-prefixed UA — SDK appends its own default to produce a chain like
  // `<merchant-app> (@agent-score/commerce@<v>) (@agent-score/sdk@<v>)`.
  const sdk = new AgentScore({ apiKey, baseUrl, userAgent: userAgentHeader });

  // createSessionOnMissing can carry its own apiKey + baseUrl (merchants sometimes wire
  // a session-only key for this hook). Lazily build a separate SDK instance keyed on
  // (apiKey, baseUrl) so we don't construct a new client per request.
  const sessionSdkCache = new Map<string, AgentScore>();
  function getSessionSdk(sessionApiKey: string, sessionBaseUrl?: string): AgentScore {
    const key = `${sessionApiKey}|${sessionBaseUrl ?? ''}`;
    let s = sessionSdkCache.get(key);
    if (!s) {
      s = new AgentScore({
        apiKey: sessionApiKey,
        baseUrl: sessionBaseUrl ?? baseUrl,
        userAgent: userAgentHeader,
      });
      sessionSdkCache.set(key, s);
    }
    return s;
  }

  const cache = new TTLCache<CachedAssessResult>(cacheSeconds * 1000);

  // Mint a verification session via /v1/sessions and return the resulting
  // identity_verification_required DenialReason — or undefined if the mint failed (network
  // error, non-2xx, missing fields). Used for both the missing-identity path and the
  // fixable-wallet bootstrap path: in both cases the UX is identical (agent polls the
  // returned poll_url until it gets a fresh opc_... and retries).
  async function tryMintSessionDenial(ctx: unknown): Promise<DenialReason | undefined> {
    if (!createSessionOnMissing) return undefined;
    try {
      const sessionBody: { context?: string; product_name?: string } = {};
      if (createSessionOnMissing.context != null) sessionBody.context = createSessionOnMissing.context;
      if (createSessionOnMissing.productName != null) sessionBody.product_name = createSessionOnMissing.productName;

      if (createSessionOnMissing.getSessionOptions && ctx !== undefined) {
        try {
          const dynamic = await createSessionOnMissing.getSessionOptions(ctx);
          if (dynamic?.context != null) sessionBody.context = dynamic.context;
          if (dynamic?.productName != null) sessionBody.product_name = dynamic.productName;
        } catch (err) {
          console.warn('[gate] createSessionOnMissing.getSessionOptions hook failed:', err instanceof Error ? err.message : err);
        }
      }

      // createSessionOnMissing.apiKey may differ from the gate's apiKey (e.g. merchant
      // wires a session-only key for this hook). Build a per-config SDK lazily.
      const sessionSdk = getSessionSdk(createSessionOnMissing.apiKey, createSessionOnMissing.baseUrl);
      const data = (await sessionSdk.createSession({
        ...(sessionBody.context !== undefined ? { context: sessionBody.context } : {}),
        ...(sessionBody.product_name !== undefined ? { product_name: sessionBody.product_name } : {}),
      })) as unknown as Record<string, unknown>;

      // Validate required fields before trusting the response. A misbehaving (or mocked-wrong)
      // API could 200 without session_id/poll_secret/verify_url, which would propagate
      // `undefined` into the 403 body and leave the agent stuck — treat as session-create
      // failure and fall back to the caller's bare denial.
      if (
        typeof data.session_id !== 'string' ||
        typeof data.poll_secret !== 'string' ||
        typeof data.verify_url !== 'string'
      ) {
        console.warn('[gate] /v1/sessions returned 200 without required fields — falling back to bare denial');
        return undefined;
      }

      // Run onBeforeSession side-effect hook. Errors are swallowed — a failing DB write
      // (e.g. can't insert pending order) should not block the 403.
      let extra: Record<string, unknown> | undefined;
      if (createSessionOnMissing.onBeforeSession && ctx !== undefined) {
        try {
          const sessionMeta = {
            session_id: data.session_id as string,
            verify_url: data.verify_url as string,
            poll_secret: data.poll_secret as string,
            poll_url: data.poll_url as string,
            expires_at: data.expires_at as string | undefined,
          };
          const result = await createSessionOnMissing.onBeforeSession(ctx, sessionMeta);
          if (result && typeof result === 'object') extra = result;
        } catch (err) {
          console.warn('[gate] createSessionOnMissing.onBeforeSession hook failed:', err instanceof Error ? err.message : err);
        }
      }

      // The API emits `next_steps` (structured object) on /v1/sessions success. Stringify it
      // into the gate's `agent_instructions` contract so merchants get the same JSON-encoded
      // {action, steps, user_message} envelope as every other gate-emitted denial.
      const apiNextSteps = data.next_steps as Record<string, unknown> | undefined;
      return {
        code: 'identity_verification_required',
        verify_url: data.verify_url as string,
        session_id: data.session_id as string,
        poll_secret: data.poll_secret as string,
        poll_url: data.poll_url as string | undefined,
        agent_instructions: apiNextSteps ? JSON.stringify(apiNextSteps) : undefined,
        agent_memory: agentMemoryHint,
        ...(extra && { extra }),
      };
    } catch (err) {
      // Session-mint failed (network, /v1/sessions returned non-2xx, body parse error,
      // onBeforeSession threw inside the inner try). Caller falls back to a bare denial —
      // agents still get a 403 with a probe-strategy hint. Log loudly so a persistent
      // /v1/sessions outage isn't masked.
      console.warn('[gate] createSessionOnMissing path failed — falling back to bare denial:', err instanceof Error ? err.message : err);
      return undefined;
    }
  }

  async function evaluate(
    identity: AgentIdentity | undefined,
    ctx?: unknown,
    signer?: PaymentSigner | null,
  ): Promise<EvaluateOutcome> {
    // Treat "returned identity object with no usable fields" the same as "no identity at all" —
    // otherwise a misbehaving custom extractIdentity would send an empty body to /v1/assess.
    if (!identity || (!identity.address && !identity.operatorToken)) {
      // failOpen short-circuits BEFORE the session mint. This branch isn't an infra failure
      // (no AgentScore call has been made yet) so we don't mark the gate state as degraded —
      // missing identity + failOpen is the explicit opt-in pass-through behavior, not a
      // graceful-degradation event. Merchants who need identity-or-deny on a failOpen gate
      // should add a guard at the handler that checks for X-Wallet-Address / X-Operator-Token
      // before reading the gate state.
      if (failOpen) return { kind: 'allow' };

      const sessionReason = await tryMintSessionDenial(ctx);
      if (sessionReason) return { kind: 'deny', reason: sessionReason };

      // Bare missing-identity denial (no session was auto-created). Describe the probe
      // strategy so agents without memory can recover: try wallet first on signing rails,
      // fall back to stored opc_..., fall back to session flow (noting that only
      // auto-session merchants return verify_url + poll data on the retry).
      const missingIdentityInstructions = JSON.stringify({
        action: 'probe_identity_then_session',
        steps: [
          'If you have a wallet AND this merchant accepts a wallet-signing rail (Tempo MPP or x402 — see openapi.json x-payment-info): send X-Wallet-Address and retry. If the wallet is already linked to an AgentScore operator (via prior SIWE claim or prior captureWallet), this passes in one round trip. If the wallet is unlinked or the account has no KYC, the 403 will include a verify_url — share it with the user to claim the wallet + complete KYC, then retry.',
          'If step 1 is denied or you already have a stored operator_token (valid + not expired): send X-Operator-Token: opc_... and retry.',
          'If neither applies: retry with NO identity header. Merchants that auto-create verification sessions (most AgentScore merchants do) return verify_url + session_id + poll_secret in the 403 body — share verify_url with the user, then poll poll_url every 5s with the X-Poll-Secret header until status=verified (the poll returns a one-time operator_token). If the retry returns the same bare 403, this merchant does not support self-service session bootstrapping — direct the user to https://agentscore.sh/sign-up to create an AgentScore identity and mint an operator_token from their dashboard (https://agentscore.sh/dashboard/verify). The user hands the opc_... to you, and you retry with X-Operator-Token.',
        ],
        user_message:
          'Try X-Wallet-Address first if you have a wallet and the merchant accepts Tempo/x402; fall back to a stored X-Operator-Token, then to the session/verify flow described in agent_memory.bootstrap.',
      });
      return {
        kind: 'deny',
        reason: {
          code: 'missing_identity',
          agent_instructions: missingIdentityInstructions,
          agent_memory: agentMemoryHint,
        },
      };
    }

    // operator_token is opaque + ASCII-only — lowercasing is safe. Wallet addresses go
    // through normalizeAddress because Solana base58 is case-sensitive and lowercasing
    // would corrupt the cache key (a Solana cache miss every time, plus collision risk
    // with mixed-case variants of the same operator).
    const cacheKey = identity.operatorToken?.toLowerCase() ?? (identity.address ? normalizeAddress(identity.address) : '');

    const cached = cache.get(cacheKey);
    if (cached) {
      if (cached.allow) {
        const cachedRaw = cached.raw as Record<string, unknown> | undefined;
        const cachedQuota = cachedRaw?.quota as GateQuotaInfo | undefined;
        return {
          kind: 'allow',
          data: cachedRaw as unknown as AssessResult,
          ...(cachedQuota !== undefined && { quota: cachedQuota }),
        };
      }
      // Fixable compliance denials (kyc_required, kyc_pending, kyc_failed) get the
      // same UX as missing_identity: mint a fresh verification session, agent polls
      // until status=verified, gets a fresh opc_..., retries. Unfixable reasons
      // (sanctions_flagged, age_insufficient, jurisdiction_restricted) keep the bare
      // wallet_not_trusted denial. `jurisdiction_restricted` is unfixable: the API
      // only emits it after KYC is verified (the user's KYC'd country is in the
      // blocked list — re-doing KYC won't change the country).
      if (isFixableDenial(cached.reasons)) {
        const sessionReason = await tryMintSessionDenial(ctx);
        if (sessionReason) return { kind: 'deny', reason: sessionReason };
      }
      return {
        kind: 'deny',
        reason: {
          code: 'wallet_not_trusted',
          decision: cached.decision,
          reasons: cached.reasons,
          verify_url: (cached.raw as Record<string, unknown> | undefined)?.verify_url as string | undefined,
          data: cached.raw as AssessResult | undefined,
        },
      };
    }

    const policy: Record<string, unknown> = {};
    if (requireKyc != null) policy.require_kyc = requireKyc;
    if (requireSanctionsClear != null) policy.require_sanctions_clear = requireSanctionsClear;
    if (minAge != null) policy.min_age = minAge;
    if (blockedJurisdictions != null) policy.blocked_jurisdictions = blockedJurisdictions;
    if (allowedJurisdictions != null) policy.allowed_jurisdictions = allowedJurisdictions;

    let data: Record<string, unknown>;
    try {
      // Single SDK call: typed-error subclasses (PaymentRequiredError / TokenExpiredError /
      // InvalidCredentialError / QuotaExceededError / TimeoutError) flow through the
      // catch below; success path captures `quota` from X-Quota-* headers automatically.
      const opts = {
        chain: gateChain,
        ...(Object.keys(policy).length > 0 ? { policy: policy as never } : {}),
        // Pre-extracted payment signer (by the adapter middleware). When present, the API
        // composes BOTH signer_match (wallet-binding) and signer_sanctions (OFAC SDN wallet
        // check) verdicts on the response in one round trip. Under
        // policy.require_sanctions_clear, a signer_sanctions hit flips decision -> deny inline.
        ...(signer && { signer: { address: signer.address, network: signer.network } }),
      };
      // SDK has two overloads — narrow by which identity is set so TS picks the right one.
      const result = identity.address
        ? await sdk.assess(identity.address, { ...opts, operatorToken: identity.operatorToken })
        : await sdk.assess(null, { ...opts, operatorToken: identity.operatorToken! });
      data = result as unknown as Record<string, unknown>;
    } catch (err) {
      if (err instanceof PaymentRequiredError) {
        if (failOpen) return { kind: 'allow' };
        return { kind: 'deny', reason: { code: 'payment_required' } };
      }
      if (err instanceof TokenExpiredError) {
        // SDK extracts the auto-minted session fields onto the error instance — no body
        // re-parsing needed here.
        return {
          kind: 'deny',
          reason: {
            code: 'token_expired',
            data: err.details as unknown as AssessResult,
            ...(err.verifyUrl ? { verify_url: err.verifyUrl } : {}),
            ...(err.sessionId ? { session_id: err.sessionId } : {}),
            ...(err.pollSecret ? { poll_secret: err.pollSecret } : {}),
            ...(err.pollUrl ? { poll_url: err.pollUrl } : {}),
            ...(err.nextSteps ? { agent_instructions: JSON.stringify(err.nextSteps) } : {}),
            ...(err.agentMemory ? { agent_memory: err.agentMemory as AgentMemoryHint } : {}),
          },
        };
      }
      if (err instanceof InvalidCredentialError) {
        // Permanent — no auto-session, agent should switch tokens or restart.
        return {
          kind: 'deny',
          reason: {
            code: 'invalid_credential',
            agent_instructions: INVALID_CREDENTIAL_INSTRUCTIONS,
            agent_memory: agentMemoryHint,
          },
        };
      }
      if (err instanceof QuotaExceededError) {
        console.warn('[gate] /v1/assess returned 429 quota_exceeded');
        if (failOpen) return { kind: 'allow', degraded: true, infraReason: 'quota_exceeded' };
        return {
          kind: 'deny',
          reason: { code: 'api_error', agent_instructions: QUOTA_EXCEEDED_INSTRUCTIONS },
        };
      }
      if (err instanceof SdkTimeoutError) {
        console.warn('[gate] /v1/assess timed out:', err.message);
        if (failOpen) return { kind: 'allow', degraded: true, infraReason: 'network_timeout' };
        return { kind: 'deny', reason: { code: 'api_error' } };
      }
      // Status-based fallbacks for AgentScoreError instances the SDK couldn't classify
      // into a typed subclass (e.g. 429 with body that lacked error.code, or a fetch
      // rejection whose .name doesn't match AbortError but whose status code is set).
      // The real API always emits error.code on 429, so this is purely defensive.
      const status = (err as { status?: number } | null)?.status;
      const errName = err instanceof Error ? err.name : '';
      if (status === 429) {
        console.warn('[gate] /v1/assess returned 429 (untyped — defensive)');
        if (failOpen) return { kind: 'allow', degraded: true, infraReason: 'quota_exceeded' };
        return {
          kind: 'deny',
          reason: { code: 'api_error', agent_instructions: QUOTA_EXCEEDED_INSTRUCTIONS },
        };
      }
      if (errName === 'TimeoutError' || errName === 'AbortError') {
        console.warn('[gate] /v1/assess timed out (by Error.name):', err instanceof Error ? err.message : err);
        if (failOpen) return { kind: 'allow', degraded: true, infraReason: 'network_timeout' };
        return { kind: 'deny', reason: { code: 'api_error' } };
      }
      // Generic AgentScoreError (rate_limited, 5xx, network_error, body parse, unknown 4xx)
      // or any non-AgentScoreError unexpected throw — surface as api_error.
      // Include the SDK-classified error code (when available) so ops/dev see
      // schema-drift cases like a new 401 error.code rather than a silent 503.
      const errCode = (err as { code?: string } | null)?.code;
      const msg = err instanceof Error ? err.message : String(err);
      const detail = errCode ? `${errCode}: ${msg}` : msg;
      console.warn(`[gate] /v1/assess call failed — surfacing as api_error: ${detail}`);
      if (failOpen) return { kind: 'allow', degraded: true, infraReason: 'api_error' };
      return { kind: 'deny', reason: { code: 'api_error' } };
    }

    const decision = data.decision as string | null | undefined;
    const decisionReasons = (data.decision_reasons as string[]) ?? [];
    const allow = decision === 'allow' || decision == null;

    cache.set(cacheKey, { allow, decision: decision ?? undefined, reasons: decisionReasons, raw: data });

    if (allow) {
      // SDK populates `quota` on the assess response from X-Quota-* headers when the
      // API emits them. Surface up to the adapter so merchants can monitor approach-to-cap.
      const quota = data.quota as GateQuotaInfo | undefined;
      return {
        kind: 'allow',
        data: data as unknown as AssessResult,
        ...(quota !== undefined && { quota }),
      };
    }

    // Fixable compliance denials (kyc_required, kyc_pending, kyc_failed) get the
    // same UX as missing_identity: mint a fresh verification session, agent polls
    // until status=verified, gets a fresh opc_..., retries. Unfixable reasons
    // (sanctions_flagged, age_insufficient, jurisdiction_restricted) keep the bare
    // wallet_not_trusted denial. `jurisdiction_restricted` is unfixable: the API
    // only emits it after KYC is verified (the user's KYC'd country is in the
    // blocked list — re-doing KYC won't change the country).
    if (isFixableDenial(decisionReasons)) {
      const sessionReason = await tryMintSessionDenial(ctx);
      if (sessionReason) return { kind: 'deny', reason: sessionReason };
    }

    return {
      kind: 'deny',
      reason: {
        code: 'wallet_not_trusted',
        decision: decision ?? undefined,
        reasons: decisionReasons,
        verify_url: data.verify_url as string | undefined,
        data: data as unknown as AssessResult,
      },
    };
  }

  async function captureWallet(options: CaptureWalletOptions): Promise<void> {
    try {
      await sdk.associateWallet({
        operatorToken: options.operatorToken,
        walletAddress: options.walletAddress,
        network: options.network,
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      });
    } catch (err) {
      // Fire-and-forget: don't throw. Log so a persistent capture outage is visible
      // to merchant ops — otherwise wallet↔operator linkage silently stops.
      console.warn('[agentscore-commerce] captureWallet failed:', err instanceof Error ? err.message : err);
    }
  }

  // Project the API's signer_match block onto the gate's VerifyWalletSignerResult shape.
  // The API authors agent_instructions, claimed/signer operators, and the linked-wallet
  // set (deny-guarded server-side); the gate just shapes those fields into camelCase.
  function projectSignerMatch(
    sm: Record<string, unknown>,
    claimedNorm: string,
    signerNorm: string,
  ): VerifyWalletSignerResult {
    const kind = sm.kind as string;
    if (kind === 'pass') {
      return {
        kind: 'pass',
        claimedOperator: (sm.claimed_operator as string | null | undefined) ?? null,
        signerOperator: (sm.signer_operator as string | null | undefined) ?? null,
      };
    }
    if (kind === 'wallet_auth_requires_wallet_signing') {
      return {
        kind: 'wallet_auth_requires_wallet_signing',
        claimedWallet: (sm.claimed_wallet as string | undefined) ?? claimedNorm,
        agentInstructions:
          (sm.agent_instructions as string | undefined) ?? WALLET_AUTH_REQUIRES_WALLET_SIGNING_INSTRUCTIONS,
      };
    }
    // Default: wallet_signer_mismatch
    const linked = sm.linked_wallets;
    return {
      kind: 'wallet_signer_mismatch',
      claimedOperator: (sm.claimed_operator as string | null | undefined) ?? null,
      actualSignerOperator: (sm.signer_operator as string | null | undefined) ?? null,
      expectedSigner: (sm.expected_signer as string | undefined) ?? claimedNorm,
      actualSigner: (sm.actual_signer as string | undefined) ?? signerNorm,
      linkedWallets: Array.isArray(linked)
        ? (linked as unknown[]).filter((w): w is string => typeof w === 'string')
        : [],
      agentInstructions:
        (sm.agent_instructions as string | undefined) ?? WALLET_SIGNER_MISMATCH_INSTRUCTIONS,
    };
  }

  /**
   * Synchronous read of the cached signer verdicts. Adapter middleware extracts the
   * signer pre-evaluate and the gate's primary /v1/assess call composes both verdicts
   * (signer_match + signer_sanctions) in one round trip — this getter just reads the
   * cached response. Returns `undefined` for operator-token-only paths, discovery legs
   * with no payment credential, or when the gate didn't run.
   */
  function getSignerVerdict(claimedAddress: string): SignerVerdict | undefined {
    const claimedNorm = normalizeAddress(claimedAddress);
    const cached = cache.get(claimedNorm);
    if (!cached) return undefined;
    const raw = cached.raw as Record<string, unknown> | undefined;
    if (!raw) return undefined;
    const rawMatch = raw.signer_match as Record<string, unknown> | undefined;
    const rawSanctions = raw.signer_sanctions as SignerVerdict['signer_sanctions'] | undefined;
    if (!rawMatch && !rawSanctions) return undefined;
    // The API's signer_match has the actual signer wallet baked in (actual_signer); we
    // didn't track it separately in the cache key (only claimed-side). Pass the API's own
    // actual_signer as signerNorm so the projected shape is consistent.
    const signerNorm = (rawMatch?.actual_signer as string | undefined) ?? claimedNorm;
    return {
      signer_match: rawMatch ? projectSignerMatch(rawMatch, claimedNorm, signerNorm) : null,
      signer_sanctions: rawSanctions ?? null,
    };
  }

  return { evaluate, captureWallet, getSignerVerdict };
}
