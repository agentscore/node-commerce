/**
 * Per-product / per-tier compliance policy helpers.
 *
 * A *policy* is a small bag of fields describing what identity the merchant wants
 * verified for a given resource:
 *
 * - `enforcement`: `"hard"` (today's wine path — 403 on miss) or `"soft"` (gate
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
    ...(policy.allowedJurisdictions !== undefined && {
      allowedJurisdictions: [...policy.allowedJurisdictions],
    }),
  };
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
 */
export async function runGateWithEnforcement(
  enforcement: EnforcementMode | undefined,
  runGate: (() => Promise<{ ok: true } | { ok: false; status: number; body: Record<string, unknown>; reason?: DenialReason }>) | null,
): Promise<GateResult> {
  if (!runGate || !enforcement) return { status: 'anonymous' };

  const outcome = await runGate();
  if (outcome.ok) return { status: 'verified' };

  if (enforcement === 'hard') {
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
