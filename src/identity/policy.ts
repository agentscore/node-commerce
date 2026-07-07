/**
 * Per-product / per-tier compliance policy helpers.
 *
 * A *policy* is a small bag of fields describing what identity the merchant wants
 * verified for a given resource:
 *
 * - `enforcement`: `"hard"` (the regulated-goods path — 403 on miss) or `"soft"` (gate
 *   denial is swallowed; the order completes with a degraded `identity_status`).
 *   `null` / absent = no gate at all.
 * - `requireKyc` / `requireSanctionsClear` / `minAge`: passed through to the
 *   per-framework `agentscoreGate(...)` factory.
 * - `allowedJurisdictions`: buyer-verified country list (`["US", "CA", ...]`).
 * - `allowedShippingCountries` / `allowedShippingStates`: optional shipping
 *   allowlists. State list is only enforced for US shipments.
 *
 * This module ships three primitives:
 *
 * 1. {@link PolicyBlock} — the typed shape.
 * 2. {@link buildGateFromPolicy} — translate a block into the options object the
 *    per-framework `agentscoreGate(...)` accepts. Returns `null` when the policy
 *    has no enforcement (treat as "no gate; anonymous OK").
 * 3. {@link runGateWithEnforcement} — wrap a per-framework middleware in the
 *    hard/soft enforcement runner. The middleware is given an `onDenied` shim
 *    that captures the denial body and status; the runner returns a structured
 *    {@link GateResult} so the vendor decides how to surface it.
 *
 * All three are additive — vendors using `agentscoreGate(...)` directly are
 * unaffected.
 */

import { CheckoutValidationError } from '../errors';
import type { AgentScoreCoreOptions, DenialReason } from '../core.js';

/** Hard = 403 propagates; soft = swallowed + identity_status="unverified". */
export type EnforcementMode = 'hard' | 'soft';

/** Per-order trust level captured at settle time. */
export type IdentityStatus = 'verified' | 'unverified' | 'anonymous' | 'denied';

/** Compliance fields a merchant attaches per product / per tier. All optional. */
export interface PolicyBlock {
  enforcement?: EnforcementMode;
  requireKyc?: boolean;
  requireSanctionsClear?: boolean;
  minAge?: number;
  /** Buyer-verified country blocklist (`["RU", "KP", ...]`) — these jurisdictions are denied. */
  blockedJurisdictions?: readonly string[];
  allowedJurisdictions?: readonly string[];
  allowedShippingCountries?: readonly string[];
  allowedShippingStates?: readonly string[];
}

/**
 * Outcome of running a gate under an enforcement mode.
 *
 * - `verified`: gate accepted; identity is fully verified for the policy.
 * - `unverified`: soft mode swallowed a gate denial; the agent had *some*
 *   identity but didn't meet the policy. Stamp this on the order so
 *   ops/analytics can tell apart soft passes from hard passes.
 * - `anonymous`: no gate ran (policy was null / no enforcement).
 * - `denied`: hard mode rejected; the caller must propagate the 403. The
 *   `denialBody` and `denialStatus` carry the original gate response so the
 *   caller can return it as-is.
 */
export interface GateResult {
  status: IdentityStatus;
  denialStatus?: number;
  denialBody?: Record<string, unknown>;
  denialReason?: DenialReason;
}

/**
 * Translate a {@link PolicyBlock} into the options the per-framework
 * `agentscoreGate(...)` expects. Returns `null` when the block has no
 * `enforcement` set — the caller should treat that as "no gate; anonymous OK".
 *
 * Use a fresh gate per request rather than constructing once at module scope
 * when the policy varies per resource (e.g. per product). Each adapter's gate
 * is cheap to instantiate.
 */
export function buildGateFromPolicy(
  policy: PolicyBlock | null | undefined,
  base: { apiKey: string; baseUrl?: string },
): AgentScoreCoreOptions | null {
  if (!policy || !policy.enforcement) return null;
  return {
    apiKey: base.apiKey,
    ...(base.baseUrl !== undefined && { baseUrl: base.baseUrl }),
    ...(policy.requireKyc !== undefined && { requireKyc: policy.requireKyc }),
    ...(policy.requireSanctionsClear !== undefined && {
      requireSanctionsClear: policy.requireSanctionsClear,
    }),
    ...(policy.minAge !== undefined && { minAge: policy.minAge }),
    ...(policy.blockedJurisdictions !== undefined && {
      blockedJurisdictions: [...policy.blockedJurisdictions],
    }),
    ...(policy.allowedJurisdictions !== undefined && {
      allowedJurisdictions: [...policy.allowedJurisdictions],
    }),
  };
}

/**
 * OFAC SDN denial reasons. These are strict-liability: soft enforcement may
 * downgrade KYC / age / jurisdiction misses (the merchant accepts the order with a
 * degraded `identity_status`), but it must NEVER swallow a sanctions deny — falsely
 * settling for a sanctioned wallet is an OFAC violation regardless of the merchant's
 * soft posture. The API emits `sanctions_flagged` in `decision_reasons` for BOTH the
 * operator/wallet SDN hit and the payment-signer OFAC SDN hit;
 * `sanctions_check_unavailable` is the fail-closed unavailable-lookup variant (a
 * missing screen on a strict rail is also a hard deny). Match the canonical strings
 * from `the AgentScore API`.
 */
const SANCTIONS_DENIAL_REASONS: ReadonlySet<string> = new Set([
  'sanctions_flagged',
  'sanctions_check_unavailable',
]);

/**
 * True when a gate denial body indicates an OFAC SDN sanctions hit (or unavailable screen).
 *
 * Inspects the flat denial body emitted by `denialReasonToBody`: a `wallet_not_trusted`
 * (or signer-sanctions) deny carries the sanctions reason in `reasons` / `decision_reasons`,
 * or surfaces it as a top-level `error.code`. Used by {@link runGateWithEnforcement} so soft
 * mode can downgrade non-sanctions denials while leaving a sanctions deny terminal.
 */
export function isSanctionsDenial(body: Record<string, unknown> | null | undefined): boolean {
  if (!body || typeof body !== 'object') return false;
  for (const key of ['reasons', 'decision_reasons'] as const) {
    const raw = body[key];
    if (Array.isArray(raw) && raw.some((r) => typeof r === 'string' && SANCTIONS_DENIAL_REASONS.has(r))) {
      return true;
    }
  }
  // The signer-sanctions SDN deny may also surface as a top-level error code.
  const error = body.error;
  const code = error && typeof error === 'object' ? (error as Record<string, unknown>).code : undefined;
  return typeof code === 'string' && SANCTIONS_DENIAL_REASONS.has(code);
}

/**
 * Run a per-framework gate middleware respecting the enforcement mode.
 *
 * The vendor passes:
 * - `gate`: their framework's middleware (Hono `MiddlewareHandler`, Express
 *   `(req, res, next) => void`, etc.) — anything that resolves on accept and
 *   throws or returns a `Response` on deny.
 * - `runGate`: a thin adapter that calls the middleware with the framework
 *   context and returns either `{ ok: true }` (gate accepted) or
 *   `{ ok: false, status, body, reason? }` (gate denied with details).
 *
 * `runGateWithEnforcement` wraps that in the hard/soft split:
 *
 * - `gate=null` or `enforcement=null`: no gate fires; status="anonymous".
 * - `enforcement="hard"` + denied: status="denied"; caller propagates denialStatus + denialBody.
 * - `enforcement="soft"` + denied: swallow; status="unverified".
 * - accepted: status="verified".
 *
 * **Sanctions are never swallowed.** Soft mode is a commercial knob — it lets a merchant
 * accept an order from an agent that didn't satisfy KYC / age / jurisdiction (stamping a
 * degraded `identity_status` for ops). But an OFAC SDN sanctions deny is strict-liability:
 * settling for a sanctioned wallet is a violation regardless of the merchant's posture. So a
 * denial whose body indicates sanctions ({@link isSanctionsDenial}) returns `status="denied"`
 * even under `enforcement="soft"`; soft only downgrades the non-sanctions reasons.
 */
export async function runGateWithEnforcement(
  enforcement: EnforcementMode | undefined,
  runGate: (() => Promise<{ ok: true } | { ok: false; status: number; body: Record<string, unknown>; reason?: DenialReason }>) | null,
): Promise<GateResult> {
  if (!runGate || !enforcement) return { status: 'anonymous' };

  const outcome = await runGate();
  if (outcome.ok) return { status: 'verified' };

  // A sanctions deny stays terminal in BOTH modes — soft only downgrades non-sanctions reasons.
  if (enforcement === 'hard' || isSanctionsDenial(outcome.body)) {
    return {
      status: 'denied',
      denialStatus: outcome.status,
      denialBody: outcome.body,
      ...(outcome.reason !== undefined && { denialReason: outcome.reason }),
    };
  }
  return {
    status: 'unverified',
    denialStatus: outcome.status,
    denialBody: outcome.body,
    ...(outcome.reason !== undefined && { denialReason: outcome.reason }),
  };
}

/** NULL policy / NULL allowlist → ship anywhere. Otherwise country must be in the list. */
export function shippingCountryAllowed(country: string, policy: PolicyBlock | null | undefined): boolean {
  if (!policy?.allowedShippingCountries || policy.allowedShippingCountries.length === 0) return true;
  const allowed = new Set(policy.allowedShippingCountries.map((c) => c.toUpperCase()));
  return allowed.has(country.toUpperCase());
}

/**
 * US-state allowlist (e.g. wine).
 *
 * Only enforced for US shipments — non-US shipments are governed by
 * {@link shippingCountryAllowed} independently.
 */
export function shippingStateAllowed(
  state: string,
  country: string,
  policy: PolicyBlock | null | undefined,
): boolean {
  if (!policy?.allowedShippingStates || policy.allowedShippingStates.length === 0) return true;
  if (country.toUpperCase() !== 'US') return true;
  const allowed = new Set(policy.allowedShippingStates.map((s) => s.toUpperCase()));
  return allowed.has(state.toUpperCase());
}

/**
 * Throw {@link CheckoutValidationError} when shipping isn't allowed by the policy.
 *
 * One-call replacement for the
 *
 *     if (!shippingCountryAllowed(...)) throw new CheckoutValidationError(...);
 *     if (!shippingStateAllowed(...))   throw new CheckoutValidationError(...);
 *
 * boilerplate every goods merchant writes in their `preValidate` hook.
 *
 * `policy` is a {@link PolicyBlock} (or `null`/`undefined`); NULL policy means
 * "ship anywhere" and the function is a no-op. The reason a location is
 * excluded is **merchant-defined**: it might be regulatory (regulated goods
 * + state allowlist), operational (no fulfillment partner), or commercial
 * (fragility, fraud-rate-by-region, etc.) — the helper doesn't assume.
 *
 * `productName` is the user-facing item name surfaced in the error message
 * ("Cannot ship 'Wine 2020' to NY ..."). Omit for a generic message.
 *
 * `errorCode` and `errorAction` let merchants override the canonical denial
 * codes if their consumer agents expect different shapes.
 *
 * `countryMessage` / `stateMessage` override the default messages verbatim
 * (use these when the default phrasing isn't right for your consumer agents
 * — e.g. you want to surface the regulatory reason explicitly, or you want
 * the message in a different language).
 */
export function validateShippingAgainstPolicy(opts: {
  country: string;
  state: string;
  policy: PolicyBlock | null | undefined;
  productName?: string;
  errorCode?: string;
  errorAction?: string;
  countryMessage?: string;
  stateMessage?: string;
}): void {
  const code = opts.errorCode ?? 'unsupported_jurisdiction';
  const action = opts.errorAction ?? 'change_shipping_state';
  const item = opts.productName ? `'${opts.productName}'` : 'this item';
  if (!shippingCountryAllowed(opts.country, opts.policy)) {
    throw new CheckoutValidationError({
      code,
      message:
        opts.countryMessage ??
        `We can't ship ${item} to ${opts.country.toUpperCase() || '<unset>'}.`,
      action,
    });
  }
  if (!shippingStateAllowed(opts.state, opts.country, opts.policy)) {
    throw new CheckoutValidationError({
      code,
      message:
        opts.stateMessage ??
        `We can't ship ${item} to ${opts.state.toUpperCase() || '<unset>'}.`,
      action,
    });
  }
}
