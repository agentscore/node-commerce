import { describe, expect, it } from 'vitest';
import {
  A2A_DEFAULT_TRANSPORT,
  A2A_PROTOCOL_VERSION,
  AIP_A2A_EXTENSION_URI,
  UCP_A2A_EXTENSION_URI,
  aipA2AExtension,
  buildA2AAgentCard,
  ucpA2AExtension,
  type A2AAgentCardExtension,
  type A2AAgentCardSignature,
  type A2AAgentInterface,
  type A2AAgentSkill,
} from '../../src/identity/a2a';

const DEFAULT_SKILL: A2AAgentSkill = {
  id: 'purchase',
  name: 'Purchase',
  description: 'Buy products via agent payments.',
  tags: ['commerce', 'payment'],
};

describe('aipA2AExtension', () => {
  it('advertises AIP with the canonical URI, header, RFC 9421, and trusted issuers', () => {
    const ext = aipA2AExtension({ trustedIssuers: ['https://www.agentscore.com', 'https://issuer.example'] });
    expect(ext.uri).toBe(AIP_A2A_EXTENSION_URI);
    expect(ext.required).toBe(false);
    expect(ext.params).toMatchObject({
      header: 'Agent-Identity',
      signature: 'RFC 9421',
      trusted_issuers: ['https://www.agentscore.com', 'https://issuer.example'],
    });
  });

  it('surfaces required_trust_level / required_amr when set; omits them otherwise', () => {
    expect(aipA2AExtension().params).not.toHaveProperty('required_trust_level');
    const ext = aipA2AExtension({ requiredTrustLevel: 'human_confirmed', requiredAmr: ['face', 'hwk'] });
    expect(ext.params).toMatchObject({ required_trust_level: 'human_confirmed', required_amr: ['face', 'hwk'] });
  });

  it('appears in a built card\'s capabilities.extensions[]', () => {
    const card = buildA2AAgentCard({
      name: 'M', description: 'd', url: 'https://m.example', skills: [DEFAULT_SKILL],
      extensions: [aipA2AExtension({ trustedIssuers: ['https://www.agentscore.com'] })],
    });
    const uris = (card.capabilities.extensions ?? []).map((e: A2AAgentCardExtension) => e.uri);
    expect(uris).toContain(AIP_A2A_EXTENSION_URI);
  });
});

describe('buildA2AAgentCard (A2A v1.0 wire format)', () => {
  it('emits the minimum required spec fields', () => {
    const card = buildA2AAgentCard({
      name: 'Example Merchant',
      description: 'Buy regulated goods via agent payments.',
      url: 'https://agents.example.com',
      skills: [DEFAULT_SKILL],
    });
    expect(card.name).toBe('Example Merchant');
    expect(card.description).toBe('Buy regulated goods via agent payments.');
    expect(card.url).toBe('https://agents.example.com');
    expect(card.preferredTransport).toBe('HTTP+JSON');
    expect(card.protocolVersion).toBe('1.0');
    expect(card.version).toBe('1.0.0');
    expect(card.capabilities).toEqual({});
    expect(card.defaultInputModes).toEqual(['application/json']);
    expect(card.defaultOutputModes).toEqual(['application/json']);
    expect(card.skills).toHaveLength(1);
    expect(card.additionalInterfaces).toBeUndefined();
  });

  it('does NOT emit any snake_case keys (canonical wire format is camelCase)', () => {
    const card = buildA2AAgentCard({
      name: 'X',
      description: 'y',
      url: 'https://x.example',
      skills: [DEFAULT_SKILL],
      pushNotifications: true,
      stateTransitionHistory: false,
      documentationUrl: 'https://docs.example',
      iconUrl: 'https://x.example/icon.png',
      supportsAuthenticatedExtendedCard: true,
    });
    const serialized = JSON.stringify(card);
    expect(serialized).not.toMatch(/supported_interfaces|protocol_binding|protocol_version|default_input_modes|default_output_modes|documentation_url|icon_url|push_notifications|state_transition_history|extended_agent_card|security_schemes|security_requirements|input_modes|output_modes/);
  });

  it('skills required non-empty (per spec §4.4.1 proto field 12 [field_behavior=REQUIRED])', () => {
    expect(() =>
      buildA2AAgentCard({ name: 'X', description: 'y', url: 'https://x.example', skills: [] }),
    ).toThrow(/MUST be a non-empty list/);
  });

  it('does NOT emit invented fields (supported_interfaces, endpoints, top-level extensions, identity)', () => {
    const card = buildA2AAgentCard({
      name: 'X', description: 'y', url: 'https://x.example', skills: [DEFAULT_SKILL],
    });
    const c = card as unknown as Record<string, unknown>;
    expect(c.supported_interfaces).toBeUndefined();
    expect(c.endpoints).toBeUndefined();
    expect(c.identity).toBeUndefined();
    expect(c.extensions).toBeUndefined();
    expect(c.card_version).toBeUndefined();
  });

  it('skills serialize as top-level objects (not strings inside capabilities)', () => {
    const card = buildA2AAgentCard({
      name: 'X', description: 'y', url: 'https://x.example', skills: [DEFAULT_SKILL],
    });
    expect(card.skills).toEqual([DEFAULT_SKILL]);
    expect((card.capabilities as Record<string, unknown>).skills).toBeUndefined();
  });

  it('extensions live INSIDE capabilities, not at top level', () => {
    const card = buildA2AAgentCard({
      name: 'X',
      description: 'y',
      url: 'https://x.example',
      skills: [DEFAULT_SKILL],
      extensions: [ucpA2AExtension()],
    });
    expect((card as unknown as Record<string, unknown>).extensions).toBeUndefined();
    expect(card.capabilities.extensions).toHaveLength(1);
    expect(card.capabilities.extensions?.[0]?.uri).toBe(UCP_A2A_EXTENSION_URI);
  });

  it('extensions omitted when empty array passed', () => {
    const card = buildA2AAgentCard({
      name: 'X', description: 'y', url: 'https://x.example', skills: [DEFAULT_SKILL], extensions: [],
    });
    expect(card.capabilities.extensions).toBeUndefined();
  });

  it('capability flags emitted when set', () => {
    const card = buildA2AAgentCard({
      name: 'X',
      description: 'y',
      url: 'https://x.example',
      skills: [DEFAULT_SKILL],
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
    });
    expect(card.capabilities.streaming).toBe(true);
    expect(card.capabilities.pushNotifications).toBe(false);
    expect(card.capabilities.stateTransitionHistory).toBe(true);
  });

  it('capability flags omitted when unset', () => {
    const card = buildA2AAgentCard({
      name: 'X', description: 'y', url: 'https://x.example', skills: [DEFAULT_SKILL],
    });
    expect(card.capabilities.streaming).toBeUndefined();
    expect(card.capabilities.pushNotifications).toBeUndefined();
    expect(card.capabilities.stateTransitionHistory).toBeUndefined();
  });

  it('supportsAuthenticatedExtendedCard lives at AgentCard top level, NOT inside capabilities', () => {
    const card = buildA2AAgentCard({
      name: 'X',
      description: 'y',
      url: 'https://x.example',
      skills: [DEFAULT_SKILL],
      supportsAuthenticatedExtendedCard: true,
    });
    expect(card.supportsAuthenticatedExtendedCard).toBe(true);
    expect((card.capabilities as Record<string, unknown>).supportsAuthenticatedExtendedCard).toBeUndefined();
  });

  it('provider emitted when set', () => {
    const card = buildA2AAgentCard({
      name: 'X',
      description: 'y',
      url: 'https://x.example',
      skills: [DEFAULT_SKILL],
      provider: { organization: 'Acme', url: 'https://acme.example' },
    });
    expect(card.provider).toEqual({ organization: 'Acme', url: 'https://acme.example' });
  });

  it('documentationUrl emitted when set', () => {
    const card = buildA2AAgentCard({
      name: 'X',
      description: 'y',
      url: 'https://x.example',
      skills: [DEFAULT_SKILL],
      documentationUrl: 'https://docs.example',
    });
    expect(card.documentationUrl).toBe('https://docs.example');
  });

  it('iconUrl emitted when set', () => {
    const card = buildA2AAgentCard({
      name: 'X',
      description: 'y',
      url: 'https://x.example',
      skills: [DEFAULT_SKILL],
      iconUrl: 'https://x.example/icon.png',
    });
    expect(card.iconUrl).toBe('https://x.example/icon.png');
  });

  it('signatures emitted when set', () => {
    const sig: A2AAgentCardSignature = { protected: 'eyJhbGciOiJFZERTQSJ9', signature: 'abc' };
    const card = buildA2AAgentCard({
      name: 'X',
      description: 'y',
      url: 'https://x.example',
      skills: [DEFAULT_SKILL],
      signatures: [sig],
    });
    expect(card.signatures).toEqual([sig]);
  });

  it('signatures omitted when empty', () => {
    const card = buildA2AAgentCard({
      name: 'X',
      description: 'y',
      url: 'https://x.example',
      skills: [DEFAULT_SKILL],
      signatures: [],
    });
    expect(card.signatures).toBeUndefined();
  });

  it('default modes overridable', () => {
    const card = buildA2AAgentCard({
      name: 'X',
      description: 'y',
      url: 'https://x.example',
      skills: [DEFAULT_SKILL],
      defaultInputModes: ['text/plain', 'application/json'],
      defaultOutputModes: ['text/plain'],
    });
    expect(card.defaultInputModes).toEqual(['text/plain', 'application/json']);
    expect(card.defaultOutputModes).toEqual(['text/plain']);
  });

  it('preferredTransport overridable on the AgentCard top level', () => {
    const card = buildA2AAgentCard({
      name: 'X',
      description: 'y',
      url: 'https://x.example',
      skills: [DEFAULT_SKILL],
      preferredTransport: 'GRPC',
      protocolVersion: '1.0',
    });
    expect(card.preferredTransport).toBe('GRPC');
  });

  it('additionalInterfaces emitted when set (multi-binding agents)', () => {
    const ifaces: A2AAgentInterface[] = [
      { transport: 'GRPC', url: 'https://x.example/grpc' },
      { transport: 'JSONRPC', url: 'https://x.example/jsonrpc' },
    ];
    const card = buildA2AAgentCard({
      name: 'X',
      description: 'y',
      url: 'https://x.example',
      skills: [DEFAULT_SKILL],
      additionalInterfaces: ifaces,
    });
    expect(card.additionalInterfaces).toEqual(ifaces);
  });

  it('additionalInterfaces omitted when empty', () => {
    const card = buildA2AAgentCard({
      name: 'X',
      description: 'y',
      url: 'https://x.example',
      skills: [DEFAULT_SKILL],
      additionalInterfaces: [],
    });
    expect(card.additionalInterfaces).toBeUndefined();
  });

  it('skills carry optional inputModes / outputModes / examples / security', () => {
    const skill: A2AAgentSkill = {
      id: 'p',
      name: 'Purchase',
      description: 'd',
      tags: ['c'],
      examples: ['buy a wine'],
      inputModes: ['application/json'],
      outputModes: ['text/plain'],
      security: [{ bearer: [] }],
    };
    const card = buildA2AAgentCard({
      name: 'X', description: 'y', url: 'https://x.example', skills: [skill],
    });
    expect(card.skills[0]?.inputModes).toEqual(['application/json']);
    expect(card.skills[0]?.outputModes).toEqual(['text/plain']);
    expect(card.skills[0]?.security).toEqual([{ bearer: [] }]);
  });

  it('extras merge at top level', () => {
    const card = buildA2AAgentCard({
      name: 'X',
      description: 'y',
      url: 'https://x.example',
      skills: [DEFAULT_SKILL],
      extras: { vendorField: 42 },
    });
    expect((card as Record<string, unknown>).vendorField).toBe(42);
  });

  it('security + securitySchemes emitted when set', () => {
    const card = buildA2AAgentCard({
      name: 'X',
      description: 'y',
      url: 'https://x.example',
      skills: [DEFAULT_SKILL],
      security: [{ bearer: [] }],
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    });
    expect(card.security).toEqual([{ bearer: [] }]);
    expect(card.securitySchemes).toEqual({ bearer: { type: 'http', scheme: 'bearer' } });
  });
});

describe('A2AAgentInterface canonical shape', () => {
  it('interface has only transport + url (no protocol_version, no tenant)', () => {
    const iface: A2AAgentInterface = { transport: 'JSONRPC', url: 'https://x.example' };
    expect(Object.keys(iface).sort()).toEqual(['transport', 'url']);
  });
});

describe('A2AAgentCardExtension shape', () => {
  it('extension carries required uri + description + required fields', () => {
    const ext: A2AAgentCardExtension = {
      uri: 'https://example/ext',
      description: 'test',
      required: true,
    };
    expect(ext.uri).toBe('https://example/ext');
    expect(ext.description).toBe('test');
    expect(ext.required).toBe(true);
  });
});

describe('A2AAgentCardSignature shape', () => {
  it('signature carries required protected + signature fields', () => {
    const sig: A2AAgentCardSignature = { protected: 'eyJ...', signature: 'abc' };
    expect(sig.protected).toBe('eyJ...');
    expect(sig.signature).toBe('abc');
  });

  it('header is optional', () => {
    const sig: A2AAgentCardSignature = { protected: 'eyJ...', signature: 'abc', header: { kid: 'k1' } };
    expect(sig.header).toEqual({ kid: 'k1' });
  });
});

describe('UCP A2A extension helper', () => {
  it('exports the canonical UCP A2A extension URI pinned to 2026-04-08', () => {
    expect(UCP_A2A_EXTENSION_URI).toBe('https://ucp.dev/2026-04-08/specification/reference');
  });

  it('exports A2A protocol version + default transport', () => {
    expect(A2A_PROTOCOL_VERSION).toBe('1.0');
    expect(A2A_DEFAULT_TRANSPORT).toBe('JSONRPC');
  });

  it('ucpA2AExtension() with no args emits required fields + empty capabilities', () => {
    const ext = ucpA2AExtension();
    expect(ext.uri).toBe(UCP_A2A_EXTENSION_URI);
    expect(ext.description).toBeTruthy();
    expect(ext.required).toBe(false);
    expect(ext.params).toEqual({ capabilities: {} });
  });

  it('ucpA2AExtension(map) passes the capabilities map under params.capabilities', () => {
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

  it('ucpA2AExtension({}, { required: true }) declares UCP support as mandatory', () => {
    const ext = ucpA2AExtension({}, { required: true });
    expect(ext.required).toBe(true);
  });
});
