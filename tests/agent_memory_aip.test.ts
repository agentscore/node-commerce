/**
 * `buildAgentMemoryHint` × AIP.
 *
 * The cross-merchant memory hint advertises the AIT identity path ONLY when the merchant opted
 * into AIP (passed a non-empty trusted-issuer list). Merchants that don't accept AITs must not
 * tell agents to present one — that would be wrong guidance and leak a capability the route
 * doesn't honor. Verifies both branches.
 */
import { describe, expect, it } from 'vitest';
import { buildAgentMemoryHint } from '../src/core';

describe('buildAgentMemoryHint × AIP', () => {
  it('omits the agent_identity path + aip_trusted_issuers when no issuers are configured', () => {
    const hint = buildAgentMemoryHint();
    expect(hint.identity_paths.wallet).toBeTruthy();
    expect(hint.identity_paths.operator_token).toBeTruthy();
    expect(hint.identity_paths.agent_identity).toBeUndefined();
    expect(hint.aip_trusted_issuers).toBeUndefined();
  });

  it('omits AIP guidance for an empty issuer list (opted out)', () => {
    const hint = buildAgentMemoryHint([]);
    expect(hint.identity_paths.agent_identity).toBeUndefined();
    expect(hint.aip_trusted_issuers).toBeUndefined();
  });

  it('advertises the agent_identity path + issuers when AIP is configured', () => {
    const issuers = ['https://issuer.example', 'https://agentscore.com'];
    const hint = buildAgentMemoryHint(issuers);
    expect(hint.aip_trusted_issuers).toEqual(issuers);
    expect(hint.identity_paths.agent_identity).toMatch(/Agent-Identity/);
    expect(hint.identity_paths.agent_identity).toMatch(/RFC 9421/);
    // The opaque-token + wallet paths remain present (AIP is additive, not a replacement).
    expect(hint.identity_paths.wallet).toBeTruthy();
    expect(hint.identity_paths.operator_token).toBeTruthy();
  });
});
