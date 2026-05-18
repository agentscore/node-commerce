/**
 * Compile-time guard: a card produced by `buildA2AAgentCard` MUST be assignable to
 * the canonical `AgentCard` type from `@a2a-js/sdk`. If Google ships a new required
 * field or renames a key in a future `@a2a-js/sdk` release, the type assignment
 * below fails to compile and CI catches the drift.
 *
 * Runtime assertions here are minimal — the value of this file is in the TS error
 * surface, not in vitest output.
 *
 * Note on cross-SDK drift: `a2a-sdk` (PyPI) ships an OLDER proto schema (uses
 * `supportedInterfaces[]` + `securityRequirements` and lacks top-level
 * `url`/`protocolVersion`/`preferredTransport`). We pin to the TypeScript SDK,
 * which mirrors the latest spec at https://a2a-protocol.org/latest/.
 */

import { describe, expect, it } from 'vitest';
import { buildA2AAgentCard, ucpA2AExtension } from '../../src/identity/a2a';
import type { AgentCard as CanonicalAgentCard } from '@a2a-js/sdk';

describe('A2A canonical type guard (@a2a-js/sdk)', () => {
  it('buildA2AAgentCard output is assignable to canonical AgentCard', () => {
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
        },
      ],
      extensions: [ucpA2AExtension()],
      documentationUrl: 'https://agents.example.com/docs',
      iconUrl: 'https://agents.example.com/icon.png',
      provider: { organization: 'Example Inc', url: 'https://example.com' },
      pushNotifications: true,
      stateTransitionHistory: false,
      streaming: true,
      supportsAuthenticatedExtendedCard: false,
      security: [{ bearer: [] }],
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      additionalInterfaces: [{ transport: 'GRPC', url: 'https://agents.example.com/grpc' }],
    });

    // If buildA2AAgentCard's output ever drifts from the canonical AgentCard,
    // this line fails to compile.
    const canonical: CanonicalAgentCard = card;
    expect(canonical.name).toBe('Example Merchant');
    expect(canonical.url).toBe('https://agents.example.com');
    expect(canonical.protocolVersion).toBe('1.0');
  });

  it('JSON round-trip parses back into the canonical AgentCard shape', () => {
    const card = buildA2AAgentCard({
      name: 'X',
      description: 'y',
      url: 'https://x.example',
      skills: [{ id: 'p', name: 'P', description: 'd', tags: ['t'] }],
    });
    const parsed: CanonicalAgentCard = JSON.parse(JSON.stringify(card));
    expect(parsed.name).toBe('X');
    expect(parsed.url).toBe('https://x.example');
    expect(parsed.skills).toHaveLength(1);
  });
});
