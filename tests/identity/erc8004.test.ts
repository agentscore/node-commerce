import { describe, expect, it } from 'vitest';
import { AGENTSCORE_ERC8004_SCHEMA, buildERC8004Attribute } from '../../src/identity/erc8004';
import type { AgentScoreData } from '../../src/core';

const fullData: AgentScoreData = {
  decision: 'allow',
  decision_reasons: [],
  resolved_operator: 'op_abc123',
  verify_url: 'https://agentscore.sh/verify?op=op_abc123',
  operator_verification: {
    level: 'verified',
    operator_type: 'human',
    verified_at: '2026-04-01T00:00:00Z',
  },
  account_verification: {
    kyc_level: 'enhanced',
    sanctions_clear: true,
    age_bracket: '21+',
    jurisdiction: 'US',
    verified_at: '2026-04-01T00:00:00Z',
  },
};

describe('buildERC8004Attribute', () => {
  it('returns null when data has no resolved_operator (pre-KYC)', () => {
    const result = buildERC8004Attribute({ data: { decision: null, decision_reasons: [] } });
    expect(result).toBeNull();
  });

  it('formats full data into the canonical schema', () => {
    const attr = buildERC8004Attribute({ data: fullData });
    expect(attr).toEqual({
      schema: AGENTSCORE_ERC8004_SCHEMA,
      operator_id: 'op_abc123',
      jurisdiction: 'US',
      kyc_level: 'enhanced',
      sanctions_clear: true,
      age_bracket: '21+',
      verified_at: '2026-04-01T00:00:00Z',
      verify_url: 'https://agentscore.sh/verify?op=op_abc123',
      issuer: 'https://agentscore.sh',
      version: 1,
    });
  });

  it('falls back to operator_verification.level when account_verification missing', () => {
    const attr = buildERC8004Attribute({
      data: {
        decision: 'allow',
        decision_reasons: [],
        resolved_operator: 'op_x',
        operator_verification: { level: 'basic', operator_type: null, verified_at: '2026-04-01T00:00:00Z' },
      },
    });
    expect(attr?.kyc_level).toBe('basic');
    expect(attr?.sanctions_clear).toBe(false);
    expect(attr?.age_bracket).toBe('unknown');
    expect(attr?.verified_at).toBe('2026-04-01T00:00:00Z');
  });

  it('respects custom issuer + verifyUrl overrides', () => {
    const attr = buildERC8004Attribute({
      data: fullData,
      issuer: 'https://custom.example',
      verifyUrl: 'https://custom.example/v?op=x',
    });
    expect(attr?.issuer).toBe('https://custom.example');
    expect(attr?.verify_url).toBe('https://custom.example/v?op=x');
  });

  it('emits stable schema name (consumers rely on this string)', () => {
    expect(AGENTSCORE_ERC8004_SCHEMA).toBe('agentscore.identity.v1');
    const attr = buildERC8004Attribute({ data: fullData });
    expect(attr?.schema).toBe('agentscore.identity.v1');
  });

  it('sanctions_clear is strictly boolean (treats absent as false)', () => {
    const attr = buildERC8004Attribute({
      data: {
        decision: 'allow',
        decision_reasons: [],
        resolved_operator: 'op_x',
      },
    });
    expect(attr?.sanctions_clear).toBe(false);
  });
});
