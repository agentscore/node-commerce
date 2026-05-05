import { describe, expect, it } from 'vitest';
import { buildA2AAgentCard } from '../../src/identity/a2a';
import type { AgentScoreData } from '../../src/core';

const fullData: AgentScoreData = {
  decision: 'allow',
  decision_reasons: [],
  resolved_operator: 'op_abc',
  verify_url: 'https://agentscore.sh/verify',
  operator_verification: { level: 'verified', operator_type: 'human', verified_at: '2026-04-01T00:00:00Z' },
  account_verification: {
    kyc_level: 'enhanced',
    sanctions_clear: true,
    age_bracket: '21+',
    jurisdiction: 'US',
    verified_at: '2026-04-01T00:00:00Z',
  },
};

describe('buildA2AAgentCard', () => {
  it('emits a card with identity claims when data is provided', () => {
    const card = buildA2AAgentCard({
      name: 'Example Merchant',
      url: 'https://agents.example.com',
      data: fullData,
    });
    expect(card.protocol_version).toBe('1.0');
    expect(card.card_version).toBe(1);
    expect(card.name).toBe('Example Merchant');
    expect(card.url).toBe('https://agents.example.com');
    expect(card.identity).not.toBeNull();
    expect(card.identity?.operator_id).toBe('op_abc');
    expect(card.identity?.kyc_level).toBe('enhanced');
    expect(card.identity?.sanctions_clear).toBe(true);
    expect(card.identity?.age_bracket).toBe('21+');
    expect(card.identity?.jurisdiction).toBe('US');
  });

  it('emits identity: null when data is omitted entirely', () => {
    const card = buildA2AAgentCard({ name: 'X' });
    expect(card.identity).toBeNull();
    expect(card.name).toBe('X');
  });

  it('emits identity: null when data has no resolved_operator', () => {
    const card = buildA2AAgentCard({
      name: 'X',
      data: { decision: null, decision_reasons: [] },
    });
    expect(card.identity).toBeNull();
  });

  it('passes through capabilities + description + extras', () => {
    const card = buildA2AAgentCard({
      name: 'X',
      description: 'test agent',
      capabilities: { endpoints: [{ name: 'pay', method: 'POST' }], skills: ['wine'] },
      extras: { custom: 'value' },
    });
    expect(card.description).toBe('test agent');
    expect(card.capabilities?.endpoints?.[0]?.name).toBe('pay');
    expect(card.capabilities?.skills).toEqual(['wine']);
    expect(card.extras).toEqual({ custom: 'value' });
  });

  it('respects issuer + verifyUrl overrides', () => {
    const card = buildA2AAgentCard({
      name: 'X',
      data: fullData,
      issuer: 'https://other.example',
      verifyUrl: 'https://other.example/v',
    });
    expect(card.identity?.issuer).toBe('https://other.example');
    expect(card.identity?.verify_url).toBe('https://other.example/v');
  });
});
