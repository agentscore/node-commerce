import { describe, expect, it } from 'vitest';
import { buildHowToPay } from '../../src/challenge/how_to_pay';

const baseInput = {
  url: 'https://agents.merchant.example/api/buy',
  retryBodyJson: '{"product":"x"}',
  totalUsd: 250,
  rails: {},
};

describe('buildHowToPay', () => {
  it('returns empty block when no rails configured', () => {
    expect(buildHowToPay(baseInput)).toEqual({});
  });

  it('builds tempo entry with both tempo + agentscore-pay commands by default', () => {
    const block = buildHowToPay({ ...baseInput, rails: { tempo: { recipient: '0xabc' } } });
    expect(block.tempo).toBeDefined();
    expect(block.tempo!.command).toContain('tempo request');
    expect(block.tempo!.alternative_command).toContain('agentscore-pay pay POST');
    expect(block.tempo!.command).toContain('--max-spend 251.00');
  });

  it('respects recommend=agentscore-pay (swaps primary/alternative)', () => {
    const block = buildHowToPay({
      ...baseInput,
      rails: { tempo: { recipient: '0xabc', recommend: 'agentscore-pay' } },
    });
    expect(block.tempo!.command).toContain('agentscore-pay pay POST');
    expect(block.tempo!.alternative_command).toContain('tempo request');
  });

  it('builds x402_base + solana_mpp entries with --chain flags', () => {
    const block = buildHowToPay({
      ...baseInput,
      rails: { x402_base: { recipient: '0xb' }, solana_mpp: { recipient: 'sol1' } },
    });
    expect(block.x402_base!.command).toContain('--chain base');
    expect(block.solana_mpp!.command).toContain('--chain solana');
  });

  it('builds stripe entry with link-cli commands when profileId set + amount under cap', () => {
    const block = buildHowToPay({
      ...baseInput,
      totalUsd: 100, // 10000 cents — well under $500 cap
      rails: { stripe: { profileId: 'acct_test_123', productName: 'Cabernet 2021' } },
    });
    expect(block.stripe!.command_link_cli).toBeDefined();
    expect(block.stripe!.command_link_cli![0]).toContain('--network-id acct_test_123');
    expect(block.stripe!.command_link_cli![0]).toContain('--amount 10000');
    expect(block.stripe!.command_link_cli![1]).toContain('link-cli mpp pay');
  });

  it('emits stripe note (not link-cli commands) when amount over $500 cap', () => {
    const block = buildHowToPay({
      ...baseInput,
      totalUsd: 1000, // 100000 cents — over cap
      rails: { stripe: { profileId: 'acct_test_123' } },
    });
    expect(block.stripe!.command_link_cli).toBeUndefined();
    expect(block.stripe!.note).toContain('link-cli SPT path not available');
  });

  it('respects custom maxSpend override', () => {
    const block = buildHowToPay({
      ...baseInput,
      maxSpend: 500,
      rails: { tempo: { recipient: '0xabc' } },
    });
    expect(block.tempo!.command).toContain('--max-spend 500');
  });

  it('uses custom opTokenPlaceholder', () => {
    const block = buildHowToPay({
      ...baseInput,
      opTokenPlaceholder: 'opc_REPLACE_ME',
      rails: { tempo: { recipient: '0xabc' } },
    });
    expect(block.tempo!.command).toContain("'X-Operator-Token: opc_REPLACE_ME'");
  });
});
