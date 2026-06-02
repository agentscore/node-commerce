/**
 * Helpers for emitting the cross-merchant `agent_memory` hint on merchant 402 responses.
 *
 * The gate (`@agent-score/commerce/identity/*`) emits `agent_memory` on identity-related
 * responses (sessions, credentials, missing_identity bootstraps). Merchants can ALSO
 * include the hint in their own 402 challenge bodies on first-encounter requests so
 * agents persist the cross-merchant pattern even when entering the ecosystem through a
 * merchant-side endpoint rather than a direct AgentScore API call.
 *
 * Usage pattern:
 *   - Merchant tracks per-operator (or per-IP / per-fingerprint) "have I seen this agent
 *     before?" in their own DB
 *   - On first encounter (no prior request from this operator/wallet/IP), include the hint
 *     so the agent saves the pattern
 *   - On subsequent encounters, skip — the agent already has it (or never will)
 *
 * The hint contents come from `buildAgentMemoryHint` (re-exported here for convenience).
 * Keep it stateless: AgentScore's pattern doesn't depend on the merchant's identity, so
 * every merchant emits the same shape.
 */

import { buildAgentMemoryHint, type AgentMemoryHint } from '../core';

export { buildAgentMemoryHint };
export type { AgentMemoryHint };

/**
 * Returns the `agent_memory` hint when this is a first encounter, otherwise `undefined`.
 * Use directly with the `agentMemory` field of `build402Body`:
 *
 * ```ts
 * const body = build402Body({
 *   acceptedMethods,
 *   agentInstructions,
 *   pricing,
 *   agentMemory: firstEncounterAgentMemory({ firstEncounter: !this.hasSeenOperator(opToken) }),
 * });
 * ```
 *
 * `firstEncounter` is merchant-determined (DB lookup, cache flag, etc.); pass `false` to
 * suppress emission cleanly without wrapping the call in an `if`. Returning `undefined`
 * means `build402Body` cleanly skips the field instead of emitting `agent_memory: null`
 * (which would imply "I tried but failed" rather than "didn't apply").
 */
export function firstEncounterAgentMemory({
  firstEncounter,
  aipTrustedIssuers,
}: {
  firstEncounter: boolean;
  /** When the merchant accepts AIP, pass its trusted-issuer list (AgentScore's canonical issuer
   *  plus any externals) so the hint advertises the `agent_identity` path. Omit for non-AIP
   *  merchants. */
  aipTrustedIssuers?: string[];
}): AgentMemoryHint | undefined {
  if (!firstEncounter) return undefined;
  return buildAgentMemoryHint(aipTrustedIssuers);
}
