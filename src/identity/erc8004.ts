/**
 * ERC-8004 (Trustless Agents) attribute publisher.
 *
 * Format an operator's AgentScore identity into the attribute payload an ERC-8004
 * registry expects. The merchant (or AgentScore itself) writes the resulting object
 * on-chain via their own wallet — this helper does NOT submit transactions; it only
 * shapes the payload so the on-chain write is deterministic.
 *
 * Why publish: ERC-8004 is the canonical on-chain standard for agent identity
 * (mainnet Jan 2026, ENS / EigenLayer / Graph / Taiko backed). Publishing operator
 * identity in this format means any ERC-8004 reader (other agent platforms, on-chain
 * reputation systems, downstream contracts) can discover AgentScore-verified operators
 * without an API call.
 *
 * Spec reference: https://eips.ethereum.org/EIPS/eip-8004
 */

import type { AgentScoreData } from '../core';

export interface AgentScoreERC8004Attribute {
  /** Schema name — `"agentscore.identity.v1"`. Reads can filter on this to find AgentScore attributes. */
  schema: string;
  /** AgentScore's canonical operator id — the cross-merchant primary key. */
  operator_id: string;
  /** ISO-3166-1 alpha-2 jurisdiction (or empty when not applicable). */
  jurisdiction: string;
  /** KYC tier — `"none"`, `"basic"`, `"verified"`, `"enhanced"`. */
  kyc_level: string;
  /** True when sanctions screening has cleared. */
  sanctions_clear: boolean;
  /** Age bracket — `"unknown"`, `"18+"`, `"21+"`. */
  age_bracket: string;
  /** ISO-8601 timestamp of when the underlying verification last refreshed. */
  verified_at: string | null;
  /** AgentScore's verify URL for this operator (where the identity was minted). */
  verify_url: string;
  /** Issuer URL — always `"https://agentscore.sh"`. */
  issuer: string;
  /** Schema version. Bumped on breaking changes; readers should be tolerant of unknown extras. */
  version: number;
}

export interface BuildERC8004AttributeInput {
  /** AgentScore assess data — what `getAgentScoreData(c)` returns or what `assess()` returned directly. */
  data: AgentScoreData;
  /** Override the default issuer URL. Default `"https://agentscore.sh"`. */
  issuer?: string;
  /** Override the verify URL. Default derived from `data.verify_url` or `${issuer}/verify`. */
  verifyUrl?: string;
}

const SCHEMA_NAME = 'agentscore.identity.v1';
const SCHEMA_VERSION = 1;

/**
 * Format an operator's AgentScore identity as an ERC-8004 attribute payload, ready for
 * the merchant (or AgentScore) to publish to an ERC-8004 registry contract.
 *
 * Returns `null` when the assess data lacks the minimum fields needed (no operator id —
 * pre-KYC bootstrap state). Caller should check before submitting.
 *
 * Example:
 * ```ts
 * import { buildERC8004Attribute } from '@agent-score/commerce/identity/hono';
 * import { encodeAttributeData } from 'erc8004-js'; // hypothetical encoding lib
 *
 * app.post('/purchase', async (c) => {
 *   const data = getAgentScoreData(c);
 *   if (data) {
 *     const attr = buildERC8004Attribute({ data });
 *     if (attr) {
 *       const encoded = encodeAttributeData(attr); // or JSON.stringify(attr) for off-chain use
 *       // ... submit via merchant wallet to the ERC-8004 registry contract ...
 *     }
 *   }
 *   return c.json({ ok: true });
 * });
 * ```
 *
 * The actual on-chain write (transaction signing + gas + contract address) is vendor-side.
 * This helper just composes the payload so every AgentScore consumer publishes the same
 * shape — readers (other agent platforms, on-chain reputation systems) get a stable schema.
 */
export function buildERC8004Attribute(input: BuildERC8004AttributeInput): AgentScoreERC8004Attribute | null {
  const data = input.data;
  const operatorId = (data.resolved_operator as string | undefined) ?? null;
  if (!operatorId) return null;

  const issuer = input.issuer ?? 'https://agentscore.sh';
  const verifyUrl =
    input.verifyUrl
    ?? (data.verify_url as string | undefined)
    ?? `${issuer}/verify`;

  const operatorVerification = data.operator_verification;
  const accountVerification = data.account_verification;

  return {
    schema: SCHEMA_NAME,
    operator_id: operatorId,
    jurisdiction: accountVerification?.jurisdiction ?? '',
    kyc_level: accountVerification?.kyc_level ?? operatorVerification?.level ?? 'none',
    sanctions_clear: accountVerification?.sanctions_clear === true,
    age_bracket: accountVerification?.age_bracket ?? 'unknown',
    verified_at: accountVerification?.verified_at ?? operatorVerification?.verified_at ?? null,
    verify_url: verifyUrl,
    issuer,
    version: SCHEMA_VERSION,
  };
}

/**
 * The schema name AgentScore writes for ERC-8004 attributes. Consumers reading from an
 * ERC-8004 registry filter on this string to find AgentScore-verified operators.
 */
export const AGENTSCORE_ERC8004_SCHEMA = SCHEMA_NAME;
