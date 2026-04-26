import type { HowToPayBlock } from './how_to_pay';

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
  [key: string]: unknown;
}

const DEFAULT_RECOMMENDED_TOOLS = [
  '`tempo request` for Tempo USDC (installs via `tempo add request`)',
  '`agentscore-pay` (npm: `@agent-score/pay`) — single CLI for x402 on Base + Solana, also speaks tempo MPP via `--chain tempo`',
];

const DEFAULT_WALLET_COMPATIBILITY =
  'No specific wallet stack required. The 402 challenge is rail-neutral: any client that can produce a valid MPP credential (Authorization: Payment) or x402 X-Payment header is accepted. The CLI commands above are the easiest path; sign-it-yourself is fine too.';

const DEFAULT_WARNINGS = [
  'Do NOT use `tempo wallet transfer` to pay to the address above. That moves USDC on-chain but does not notify this server, leaving your order in pending_identity state. Use `tempo request` instead — it performs the full MPP handshake (signs, submits Authorization: Payment, waits for server confirmation).',
  'Do NOT send USDC manually to the x402 deposit addresses (e.g. via a bare wallet `transfer`). Use `agentscore-pay pay` so the X-Payment credential is signed and submitted; otherwise the order stays in pending_identity even though the deposit lands.',
];

/**
 * Build the agent_instructions object for the 402 body. Combines how_to_pay with
 * recommended tools, warnings, wallet-compatibility note, and timeout. All copy is
 * configurable; defaults match the conventions in martin-estate's reference 402.
 */
export function buildAgentInstructions(input: BuildAgentInstructionsInput): AgentInstructions {
  return {
    how_to_pay: input.howToPay,
    recommended_tools: input.recommendedTools ?? DEFAULT_RECOMMENDED_TOOLS,
    wallet_compatibility: input.walletCompatibility ?? DEFAULT_WALLET_COMPATIBILITY,
    timeout_seconds: input.timeoutSeconds ?? 300,
    warnings: input.warnings ?? DEFAULT_WARNINGS,
    ...(input.recommended ? { recommended: input.recommended } : {}),
    ...(input.extra ?? {}),
  };
}
