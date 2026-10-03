/**
 * Guard: a card produced by `buildA2AAgentCard` MUST survive the canonical A2A codec
 * from `@a2a-js/sdk` unchanged. The SDK's `AgentCard.fromJSON` keeps only the fields
 * the current A2A specification defines, so a field we emit that the spec renamed or
 * removed is dropped on the round-trip and this test fails.
 *
 * It is a runtime check on purpose. The earlier form was a type assignment, and vitest
 * does not typecheck while `tsc` covered `src` alone, so it never ran: the card sat a
 * whole protocol version behind the SDK it claimed to match. A codec round-trip runs
 * wherever the tests run.
 */

import { AgentCard as CanonicalAgentCard } from '@a2a-js/sdk';
import { describe, expect, it } from 'vitest';
import { buildA2AAgentCard, ucpA2AExtension } from '../../src/identity/a2a';

// Proto3 JSON omits default values (false, empty strings, empty lists), so a field
// set to its default disappears on the round-trip without being wrong. Strip those on
// both sides before comparing; everything else must come back as it went in.
function withoutDefaults(v: unknown): unknown {
  if (Array.isArray(v)) return v.length === 0 ? undefined : v.map(withoutDefaults);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      const n = withoutDefaults(val);
      if (n !== undefined && n !== false && n !== '') out[k] = n;
    }
    return out;
  }
  return v;
}

const roundTrip = (card: unknown) => CanonicalAgentCard.toJSON(CanonicalAgentCard.fromJSON(card));

describe('A2A canonical codec guard (@a2a-js/sdk)', () => {
  it('a fully-populated card survives the canonical codec field for field', () => {
    const card = buildA2AAgentCard({
      name: 'Example Merchant',
      description: 'Buy products via agent payments.',
      url: 'https://agents.example.com',
      version: '1.0.0',
      skills: [
        {
          id: 'purchase',
          name: 'Purchase',
          description: 'Buy products via agent payments.',
          tags: ['commerce', 'payment'],
          examples: ['buy a wine'],
          security: [{ bearer: ['read'] }],
        },
      ],
      extensions: [ucpA2AExtension({ 'dev.ucp.shopping.checkout': [{ version: '2026-08-25' }] }, { required: true })],
      documentationUrl: 'https://agents.example.com/docs',
      iconUrl: 'https://agents.example.com/icon.png',
      provider: { organization: 'Example Inc', url: 'https://example.com' },
      pushNotifications: true,
      streaming: true,
      extendedAgentCard: true,
      security: [{ bearer: [] }],
      securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'bearer' } } },
      additionalInterfaces: [{ transport: 'GRPC', url: 'https://agents.example.com/grpc' }],
    });
    expect(withoutDefaults(roundTrip(card))).toEqual(withoutDefaults(card));
  });

  it('fails on a field the spec does not define, which is what makes it a guard', () => {
    const card = buildA2AAgentCard({ name: 'X', description: 'y', url: 'https://x.example', skills: [{ id: 'p', name: 'P', description: 'd', tags: ['t'] }] });
    const stale = { ...card, url: 'https://x.example', preferredTransport: 'HTTP+JSON', protocolVersion: '1.0' };
    expect(withoutDefaults(roundTrip(stale))).not.toEqual(withoutDefaults(stale));
  });
});
