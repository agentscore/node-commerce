/**
 * AIP presentation surfaces: agent_memory, llms.txt, skill.md, and OpenAPI security schemes all
 * advertise the Agent Identity Token path when the merchant accepts AIP. AgentScore's own issuer is
 * always trusted, so the path shows up even with no external issuers configured.
 */
import { describe, expect, it } from 'vitest';
import { AGENTSCORE_CANONICAL_ISSUER } from '../src/aip/jwks';
import { firstEncounterAgentMemory } from '../src/challenge/agent_memory';
import { buildAipTrustedIssuers } from '../src/checkout';
import { buildAgentMemoryHint } from '../src/core';
import { llmsTxtIdentitySection } from '../src/discovery/llms_txt';
import { agentscoreSecuritySchemes } from '../src/discovery/openapi';
import { buildSkillMd } from '../src/discovery/skill_md';

describe('buildAipTrustedIssuers', () => {
  it('always includes the canonical AgentScore issuer', () => {
    expect(buildAipTrustedIssuers()).toEqual([AGENTSCORE_CANONICAL_ISSUER]);
    expect(buildAipTrustedIssuers([])).toEqual([AGENTSCORE_CANONICAL_ISSUER]);
  });
  it('appends externals and de-dupes the canonical issuer', () => {
    const out = buildAipTrustedIssuers(['https://issuer.example', 'https://agentscore.sh/']);
    expect(out).toContain(AGENTSCORE_CANONICAL_ISSUER);
    expect(out).toContain('https://issuer.example');
    expect(out.filter((i) => i.includes('agentscore.sh'))).toHaveLength(1);
  });
});

describe('agent_memory AIP path', () => {
  it('omits agent_identity when no aip issuers are passed', () => {
    const hint = buildAgentMemoryHint();
    expect(hint.identity_paths.agent_identity).toBeUndefined();
    expect(hint.aip_trusted_issuers).toBeUndefined();
  });
  it('advertises agent_identity + aip_trusted_issuers when aip is accepted (canonical-only)', () => {
    const hint = buildAgentMemoryHint(buildAipTrustedIssuers());
    expect(hint.identity_paths.agent_identity).toMatch(/Agent-Identity/);
    expect(hint.aip_trusted_issuers).toEqual([AGENTSCORE_CANONICAL_ISSUER]);
  });
  it('firstEncounterAgentMemory forwards the aip issuers', () => {
    const hint = firstEncounterAgentMemory({ firstEncounter: true, aipTrustedIssuers: buildAipTrustedIssuers() });
    expect(hint?.identity_paths.agent_identity).toMatch(/RFC 9421/);
    expect(hint?.aip_trusted_issuers).toEqual([AGENTSCORE_CANONICAL_ISSUER]);
  });
  it('firstEncounterAgentMemory without aip stays wallet/operator only', () => {
    const hint = firstEncounterAgentMemory({ firstEncounter: true });
    expect(hint?.identity_paths.agent_identity).toBeUndefined();
  });
});

describe('llms.txt identity section', () => {
  it('adds the Agent-Identity bullet when aip is true', () => {
    const out = llmsTxtIdentitySection({ agentscore: true, aip: true });
    expect(out).toMatch(/Agent-Identity/);
    expect(out).toMatch(/RFC 9421/);
  });
  it('omits the AIP bullet by default', () => {
    const out = llmsTxtIdentitySection({ agentscore: true });
    expect(out).not.toMatch(/Agent-Identity/);
    expect(out).toMatch(/X-Operator-Token/);
  });
});

describe('skill.md identity section', () => {
  const base = {
    name: 'test-merchant',
    description: 'Test merchant skill for AIP presentation.',
    homepage: 'https://merchant.example',
    merchantName: 'Test Merchant',
    acceptedRails: ['tempo_mpp' as const],
    endpoints: [{ method: 'POST' as const, path: '/purchase', authRequired: true, description: 'Buy' }],
    triggers: ['buy something'],
  };
  it('documents the AIT path when identity.aip is set', () => {
    const md = buildSkillMd({ ...base, identity: { kycRequired: true, aip: true } });
    expect(md).toMatch(/Agent Identity Token/);
    expect(md).toMatch(/Agent-Identity/);
  });
  it('does not mention AIP when identity.aip is unset', () => {
    const md = buildSkillMd({ ...base, identity: { kycRequired: true } });
    expect(md).not.toMatch(/Agent-Identity/);
  });
});

describe('openapi security schemes', () => {
  it('includes the AgentIdentity scheme', () => {
    const schemes = agentscoreSecuritySchemes();
    expect(schemes.AgentIdentity).toMatchObject({ type: 'apiKey', in: 'header', name: 'Agent-Identity' });
  });
});
