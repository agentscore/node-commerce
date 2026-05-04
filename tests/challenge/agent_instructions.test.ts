import { describe, expect, it } from 'vitest';
import { buildAgentInstructions } from '../../src/challenge/agent_instructions';

describe('buildAgentInstructions', () => {
  it('wraps howToPay with sensible defaults for tools/wallet/warnings/timeout', () => {
    const instructions = buildAgentInstructions({ howToPay: { tempo: { command: 'x', what_it_does: 'y' } } });
    expect(instructions.how_to_pay.tempo).toBeDefined();
    expect(instructions.recommended_tools).toContain('`tempo request` for Tempo USDC');
    expect(instructions.timeout_seconds).toBe(300);
    expect(instructions.warnings.length).toBeGreaterThan(0);
    expect(instructions.warnings[0]).toContain('tempo wallet transfer');
  });

  it('warnings + tools default to ONLY the rails actually present in howToPay', () => {
    const x402Only = buildAgentInstructions({
      howToPay: { x402_base: { command: 'x', what_it_does: 'y' } },
    });
    expect(x402Only.warnings.some((w) => w.includes('tempo wallet transfer'))).toBe(false);
    expect(x402Only.warnings.some((w) => w.includes('deposit addresses'))).toBe(true);
    expect(x402Only.recommended_tools.some((t) => t.includes('tempo request'))).toBe(false);
    expect(x402Only.recommended_tools.some((t) => t.includes('agentscore-pay'))).toBe(true);

    const tempoOnly = buildAgentInstructions({
      howToPay: { tempo: { command: 'x', what_it_does: 'y' } },
    });
    expect(tempoOnly.warnings.some((w) => w.includes('deposit addresses'))).toBe(false);

    const solanaOnly = buildAgentInstructions({
      howToPay: { solana_mpp: { command: 'x', what_it_does: 'y' } },
    });
    expect(solanaOnly.warnings.some((w) => w.includes('tempo wallet transfer'))).toBe(false);
    expect(solanaOnly.warnings.some((w) => w.includes('deposit addresses'))).toBe(false);
    expect(solanaOnly.recommended_tools.some((t) => t.includes('agentscore-pay'))).toBe(true);

    const stripeOnly = buildAgentInstructions({
      howToPay: { stripe: { prerequisite: 'x', instructions: 'y' } },
    });
    expect(stripeOnly.warnings).toEqual([]);
    expect(stripeOnly.recommended_tools).toEqual([]);
  });

  it('overrides defaults when vendor passes them', () => {
    const instructions = buildAgentInstructions({
      howToPay: {},
      recommendedTools: ['use my-cli'],
      timeoutSeconds: 600,
      warnings: ['custom warning'],
      walletCompatibility: 'use only my wallet',
      recommended: 'tempo',
    });
    expect(instructions.recommended_tools).toEqual(['use my-cli']);
    expect(instructions.timeout_seconds).toBe(600);
    expect(instructions.warnings).toEqual(['custom warning']);
    expect(instructions.wallet_compatibility).toBe('use only my wallet');
    expect(instructions.recommended).toBe('tempo');
  });

  it('merges extra fields into the result', () => {
    const instructions = buildAgentInstructions({
      howToPay: {},
      extra: { custom_field: 'custom_value' },
    });
    expect(instructions.custom_field).toBe('custom_value');
  });
});
