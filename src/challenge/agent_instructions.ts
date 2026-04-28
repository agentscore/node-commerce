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

const TEMPO_WARNING =
  'Do NOT use `tempo wallet transfer` to pay to the address above. That moves USDC on-chain but does not notify this server, leaving your order in pending_identity state. Use `tempo request` instead — it performs the full MPP handshake (signs, submits Authorization: Payment, waits for server confirmation).';

const X402_WARNING =
  'Do NOT send USDC manually to the x402 deposit addresses (e.g. via a bare wallet `transfer`). Use `agentscore-pay pay` so the X-Payment credential is signed and submitted; otherwise the order stays in pending_identity even though the deposit lands.';

const TEMPO_TOOL = '`tempo request` for Tempo USDC (installs via `tempo add request`)';
const AGENTSCORE_PAY_TOOL =
  '`agentscore-pay` (npm: `@agent-score/pay`) — single CLI for x402 on Base + Solana, also speaks tempo MPP via `--chain tempo`';

const DEFAULT_WALLET_COMPATIBILITY =
  'No specific wallet stack required. The 402 challenge is rail-neutral: any client that can produce a valid MPP credential (Authorization: Payment) or x402 X-Payment header is accepted. The CLI commands above are the easiest path; sign-it-yourself is fine too.';

function defaultRecommendedTools(howToPay: HowToPayBlock): string[] {
  const tools: string[] = [];
  if (howToPay.tempo) tools.push(TEMPO_TOOL);
  if (howToPay.tempo || howToPay.x402_base || howToPay.x402_solana) tools.push(AGENTSCORE_PAY_TOOL);
  return tools;
}

function defaultWarnings(howToPay: HowToPayBlock): string[] {
  const w: string[] = [];
  if (howToPay.tempo) w.push(TEMPO_WARNING);
  if (howToPay.x402_base || howToPay.x402_solana) w.push(X402_WARNING);
  return w;
}

/**
 * Build the agent_instructions object for the 402 body. Combines how_to_pay with
 * recommended tools, warnings, wallet-compatibility note, and timeout.
 *
 * Defaults adapt to the rails declared in `howToPay`: only tempo-relevant warnings/tools
 * appear if `howToPay.tempo` is set, only x402-relevant ones if `x402_base`/`x402_solana`
 * are set. Stripe-only merchants get neither rail-specific warning. Vendors override
 * `warnings`/`recommendedTools` for full control.
 */
export function buildAgentInstructions(input: BuildAgentInstructionsInput): AgentInstructions {
  return {
    how_to_pay: input.howToPay,
    recommended_tools: input.recommendedTools ?? defaultRecommendedTools(input.howToPay),
    wallet_compatibility: input.walletCompatibility ?? DEFAULT_WALLET_COMPATIBILITY,
    timeout_seconds: input.timeoutSeconds ?? 300,
    warnings: input.warnings ?? defaultWarnings(input.howToPay),
    ...(input.recommended ? { recommended: input.recommended } : {}),
    ...(input.extra ?? {}),
  };
}
