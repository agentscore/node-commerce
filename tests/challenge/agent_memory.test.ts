import { describe, expect, it } from 'vitest';
import { firstEncounterAgentMemory, buildAgentMemoryHint } from '../../src/challenge/agent_memory';

describe('firstEncounterAgentMemory', () => {
  it('returns undefined when firstEncounter is false (so build402Body skips the field)', () => {
    expect(firstEncounterAgentMemory({ firstEncounter: false })).toBeUndefined();
  });

  it('returns the canonical hint when firstEncounter is true', () => {
    const hint = firstEncounterAgentMemory({ firstEncounter: true });
    expect(hint).toBeDefined();
    expect(hint).toEqual(buildAgentMemoryHint());
  });

  it('forwards baseUrl to buildAgentMemoryHint without crashing (param accepted but currently ignored)', () => {
    const hint = firstEncounterAgentMemory({ firstEncounter: true, baseUrl: 'https://api.example' });
    expect(hint).toBeDefined();
  });
});
