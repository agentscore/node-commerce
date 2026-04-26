import { describe, expect, it } from 'vitest';
import { AgentScore, AgentScoreError } from '../../src/api';

describe('@agent-score/commerce/api re-export', () => {
  it('re-exports the AgentScore client class', () => {
    expect(AgentScore).toBeDefined();
    expect(typeof AgentScore).toBe('function');
    const client = new AgentScore({ apiKey: 'as_test_xxx' });
    expect(client).toBeDefined();
  });

  it('re-exports the AgentScoreError class', () => {
    expect(AgentScoreError).toBeDefined();
    expect(typeof AgentScoreError).toBe('function');
  });
});
