import { describe, expect, it } from 'vitest';
import {
  UCP_A2A_EXTENSION_URI,
  buildA2AAgentCard,
  ucpA2AExtension,
} from '../../src/identity/a2a';
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

  it('falls back to operator_verification fields when account_verification is absent', () => {
    // Drives the `?? operatorVerification?.level` and `?? operatorVerification?.verified_at`
    // branches plus the default `'unknown'` / `''` / `verify_url` fallbacks.
    const card = buildA2AAgentCard({
      name: 'X',
      data: {
        decision: 'allow',
        decision_reasons: [],
        resolved_operator: 'op_only_op_verif',
        operator_verification: {
          level: 'basic',
          operator_type: 'agent',
          verified_at: '2026-01-01T00:00:00Z',
        },
      },
    });
    expect(card.identity).not.toBeNull();
    expect(card.identity?.kyc_level).toBe('basic');
    expect(card.identity?.sanctions_clear).toBe(false);
    expect(card.identity?.age_bracket).toBe('unknown');
    expect(card.identity?.jurisdiction).toBe('');
    expect(card.identity?.verified_at).toBe('2026-01-01T00:00:00Z');
    expect(card.identity?.verify_url).toBe('https://agentscore.sh/verify');
  });

  it('falls back to default kyc_level "none" when neither verification block is present', () => {
    // Drives the trailing `?? 'none'` fallback in the kyc_level chain plus the
    // `?? null` fallback for verified_at.
    const card = buildA2AAgentCard({
      name: 'X',
      data: {
        decision: 'allow',
        decision_reasons: [],
        resolved_operator: 'op_no_verif',
      },
    });
    expect(card.identity).not.toBeNull();
    expect(card.identity?.kyc_level).toBe('none');
    expect(card.identity?.verified_at).toBeNull();
  });

  it('reads verify_url from data when input.verifyUrl is absent', () => {
    // Drives the `data.verify_url` branch of the verify_url ?? chain.
    const card = buildA2AAgentCard({
      name: 'X',
      data: {
        decision: 'allow',
        decision_reasons: [],
        resolved_operator: 'op_with_verify_url',
        verify_url: 'https://from-data.example/verify',
      },
    });
    expect(card.identity?.verify_url).toBe('https://from-data.example/verify');
  });
});

describe('UCP A2A extension', () => {
  it('exports the canonical UCP A2A extension URI pinned to 2026-04-08', () => {
    expect(UCP_A2A_EXTENSION_URI).toBe('https://ucp.dev/2026-04-08/specification/reference');
  });

  it('ucpA2AExtension() with no args produces empty-capabilities entry', () => {
    const ext = ucpA2AExtension();
    expect(ext.uri).toBe(UCP_A2A_EXTENSION_URI);
    expect(ext.params).toEqual({ capabilities: {} });
  });

  it('ucpA2AExtension(map) wraps the capabilities map under params.capabilities', () => {
    const ext = ucpA2AExtension({
      'dev.ucp.shopping.checkout': [{ version: '2026-04-08' }],
      'dev.ucp.shopping.cart': [{ version: '2026-04-08' }],
    });
    expect(ext.params).toEqual({
      capabilities: {
        'dev.ucp.shopping.checkout': [{ version: '2026-04-08' }],
        'dev.ucp.shopping.cart': [{ version: '2026-04-08' }],
      },
    });
  });

  it('buildA2AAgentCard emits extensions[] when passed', () => {
    const card = buildA2AAgentCard({
      name: 'X',
      data: null,
      extensions: [ucpA2AExtension()],
    });
    expect(card.extensions).toHaveLength(1);
    expect(card.extensions?.[0]?.uri).toBe(UCP_A2A_EXTENSION_URI);
    expect(card.extensions?.[0]?.params).toEqual({ capabilities: {} });
  });

  it('buildA2AAgentCard omits extensions[] when not passed', () => {
    const card = buildA2AAgentCard({ name: 'X', data: null });
    expect(card.extensions).toBeUndefined();
  });
});
