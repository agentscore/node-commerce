import type { HowToPayBlock } from './how_to_pay';

/** Map of rail key (e.g. 'x402_base', 'tempo_mpp', 'stripe') → list of client identifiers
 *  that have been smoke-verified by the merchant against the protocol shape they emit.
 *  Strings are display labels, not install commands — agents already get install commands
 *  via `how_to_pay.<rail>.setup`. Use these as a "what's known to work" hint. */
export type CompatibleClients = Record<string, string[]>;

export interface BuildAgentInstructionsInput {
  /** Per-rail commands. Build with `buildHowToPay`. */
  howToPay: HowToPayBlock;
  /** Tool recommendations as human-readable strings. Defaults to a sensible set covering tempo + agentscore-pay. */
  recommendedTools?: string[];
  /** Wallet-stack compatibility note for the agent. Default: rail-neutral, no specific wallet stack required. */
  walletCompatibility?: string;
  /** How long the merchant will wait for payment after the 402. Default 300 (5 minutes). */
  timeoutSeconds?: number;
  /** Warnings about common footguns. Defaults include tempo wallet transfer + raw on-chain x402 deposits. */
  warnings?: string[];
  /** Recommended rail (e.g., 'tempo', 'x402_base'). Surfaced for agents to default to. */
  recommended?: string;
  /** Per-rail list of client names the merchant has verified work end-to-end. Vendors set
   *  this from their own smoke matrix — defaults to none (avoids vouching for clients the
   *  merchant has not tested). When omitted, the field is not emitted. */
  compatibleClients?: CompatibleClients;
  /** Arbitrary additional fields the vendor wants merged into the agent_instructions object. */
  extra?: Record<string, unknown>;
}

export interface AgentInstructions {
  how_to_pay: HowToPayBlock;
  recommended_tools: string[];
  wallet_compatibility: string;
  timeout_seconds: number;
  warnings: string[];
  recommended?: string;
  compatible_clients?: CompatibleClients;
  [key: string]: unknown;
}

const TEMPO_WARNING =
  'Do NOT use `tempo wallet transfer`. That moves USDC on-chain without completing the protocol handshake; your order stays in pending_identity. Use `tempo request` instead.';

const X402_WARNING =
  'Do NOT send USDC manually to the deposit addresses. Use `agentscore-pay pay` so the credential is signed and submitted; otherwise the order stays in pending_identity even though the deposit lands.';

const TEMPO_TOOL = '`tempo request` for Tempo USDC';
const AGENTSCORE_PAY_TOOL = '`agentscore-pay` — Base + Solana + Tempo from one CLI';

const DEFAULT_WALLET_COMPATIBILITY =
  'Any client that can produce a valid MPP credential (Authorization: Payment) or x402 X-Payment header. Use the CLI commands above; sign-it-yourself is also fine.';

function defaultRecommendedTools(howToPay: HowToPayBlock): string[] {
  const tools: string[] = [];
  if (howToPay.tempo) tools.push(TEMPO_TOOL);
  if (howToPay.tempo || howToPay.x402_base || howToPay.solana_mpp) tools.push(AGENTSCORE_PAY_TOOL);
  return tools;
}

function defaultWarnings(howToPay: HowToPayBlock): string[] {
  const w: string[] = [];
  if (howToPay.tempo) w.push(TEMPO_WARNING);
  if (howToPay.x402_base) w.push(X402_WARNING);
  return w;
}

/**
 * Default `compatible_clients` derived from the rails declared in `howToPay`. Lists
 * clients the AgentScore team has smoke-verified end-to-end against an `@agent-score/commerce`
 * merchant; entries appear only for rails the vendor actually offers. Vendors override
 * this in `buildAgentInstructions({compatibleClients: {...}})` to add their own tested
 * clients or remove entries that don't fit their endpoint.
 *
 * Verified state as of the SDK release. The same data is also published as a docs page
 * for humans (rationale, per-rail commands, why some clients don't fully work, last
 * verified date) — this default keeps the merchant-side surface in sync.
 */
/** Symbolic rail keys agent-facing surfaces use to talk about a rail without spelling out
 *  network/scheme details. Same keys as `CompatibleClients` map keys. */
export type RailKey = 'tempo_mpp' | 'x402_base' | 'solana_mpp' | 'stripe';

const RAIL_CLIENTS: Record<RailKey, readonly string[]> = {
  tempo_mpp: ['agentscore-pay', 'tempo request', 'x402-proxy'],
  x402_base: ['agentscore-pay', 'x402-proxy', 'purl (omit --network flag)'],
  solana_mpp: ['agentscore-pay'],
  stripe: ['link-cli'],
};

/** Returns the smoke-verified client list for a set of rail keys. The single source of
 *  truth for "which CLIs we've verified end-to-end on each rail" — consumed both by the
 *  402-body builder (`defaultCompatibleClients`) and by discovery surfaces (skill.md,
 *  llms.txt, etc.). Update here, every surface inherits. */
export function compatibleClientsByRails(rails: readonly RailKey[]): CompatibleClients | undefined {
  const out: CompatibleClients = {};
  for (const r of rails) out[r] = [...RAIL_CLIENTS[r]];
  return Object.keys(out).length === 0 ? undefined : out;
}

function defaultCompatibleClients(howToPay: HowToPayBlock): CompatibleClients | undefined {
  const rails: RailKey[] = [];
  if (howToPay.tempo) rails.push('tempo_mpp');
  if (howToPay.x402_base) rails.push('x402_base');
  if (howToPay.solana_mpp) rails.push('solana_mpp');
  if (howToPay.stripe) rails.push('stripe');
  return compatibleClientsByRails(rails);
}

/**
 * Build the agent_instructions object for the 402 body. Combines how_to_pay with
 * recommended tools, warnings, wallet-compatibility note, and timeout.
 *
 * Defaults adapt to the rails declared in `howToPay`: only tempo-relevant warnings/tools
 * appear if `howToPay.tempo` is set, only x402-relevant ones if `x402_base` is set.
 * Stripe-only merchants get neither rail-specific warning. Vendors override
 * `warnings`/`recommendedTools` for full control.
 */
export function buildAgentInstructions(input: BuildAgentInstructionsInput): AgentInstructions {
  const compatibleClients = input.compatibleClients ?? defaultCompatibleClients(input.howToPay);
  return {
    how_to_pay: input.howToPay,
    recommended_tools: input.recommendedTools ?? defaultRecommendedTools(input.howToPay),
    wallet_compatibility: input.walletCompatibility ?? DEFAULT_WALLET_COMPATIBILITY,
    timeout_seconds: input.timeoutSeconds ?? 300,
    warnings: input.warnings ?? defaultWarnings(input.howToPay),
    ...(input.recommended ? { recommended: input.recommended } : {}),
    ...(compatibleClients ? { compatible_clients: compatibleClients } : {}),
    ...(input.extra ?? {}),
  };
}
