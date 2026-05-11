import { describe, expect, it } from 'vitest';
import {
  UCP_A2A_EXTENSION_URI,
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

describe('buildA2AAgentCard (A2A v1.0 spec compliance)', () => {
  it('emits the minimum required spec fields', () => {
    const card = buildA2AAgentCard({
      name: 'Example Merchant',
      description: 'Buy regulated goods via agent payments.',
      url: 'https://agents.example.com',
      skills: [DEFAULT_SKILL],
    });
    // Per spec §4.4.1 (proto): name, description, supported_interfaces, version,
    // capabilities, default_input_modes, default_output_modes, skills are REQUIRED.
    expect(card.name).toBe('Example Merchant');
    expect(card.description).toBe('Buy regulated goods via agent payments.');
    expect(card.supported_interfaces).toHaveLength(1);
    expect(card.supported_interfaces[0]?.url).toBe('https://agents.example.com');
    expect(card.supported_interfaces[0]?.protocol_binding).toBe('HTTP+JSON');
    expect(card.supported_interfaces[0]?.protocol_version).toBe('1.0');
    expect(card.version).toBe('1.0.0');
    expect(card.capabilities).toEqual({});
    expect(card.default_input_modes).toEqual(['application/json']);
    expect(card.default_output_modes).toEqual(['application/json']);
    expect(card.skills).toHaveLength(1);
  });

  it('skills required non-empty (per spec §4.4.1 proto field 12 [field_behavior=REQUIRED])', () => {
    expect(() =>
      buildA2AAgentCard({ name: 'X', description: 'y', url: 'https://x.example', skills: [] }),
    ).toThrow(/MUST be a non-empty list/);
  });

  it('does NOT emit invented fields (protocol_version, card_version, endpoints, identity, top-level extensions)', () => {
    const card = buildA2AAgentCard({
      name: 'X', description: 'y', url: 'https://x.example', skills: [DEFAULT_SKILL],
    });
    const c = card as unknown as Record<string, unknown>;
    expect(c.protocol_version).toBeUndefined();
    expect(c.card_version).toBeUndefined();
    expect(c.endpoints).toBeUndefined();
    expect(c.identity).toBeUndefined();
    expect(c.extensions).toBeUndefined();
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
      push_notifications: false,
      extended_agent_card: true,
    });
    expect(card.capabilities.streaming).toBe(true);
    expect(card.capabilities.push_notifications).toBe(false);
    expect(card.capabilities.extended_agent_card).toBe(true);
  });

  it('capability flags omitted when unset', () => {
    const card = buildA2AAgentCard({
      name: 'X', description: 'y', url: 'https://x.example', skills: [DEFAULT_SKILL],
    });
    expect(card.capabilities.streaming).toBeUndefined();
    expect(card.capabilities.push_notifications).toBeUndefined();
    expect(card.capabilities.extended_agent_card).toBeUndefined();
  });

  it('provider emitted when set', () => {
    const card = buildA2AAgentCard({
      name: 'X',
      description: 'y',
      url: 'https://x.example',
      skills: [DEFAULT_SKILL],
      provider: { url: 'https://acme.example', organization: 'Acme' },
    });
    expect(card.provider).toEqual({ url: 'https://acme.example', organization: 'Acme' });
  });

  it('documentation_url emitted when set', () => {
    const card = buildA2AAgentCard({
      name: 'X',
      description: 'y',
      url: 'https://x.example',
      skills: [DEFAULT_SKILL],
      documentation_url: 'https://docs.example',
    });
    expect(card.documentation_url).toBe('https://docs.example');
  });

  it('icon_url emitted when set (per spec §4.4.1 proto field 14)', () => {
    const card = buildA2AAgentCard({
      name: 'X',
      description: 'y',
      url: 'https://x.example',
      skills: [DEFAULT_SKILL],
      icon_url: 'https://x.example/icon.png',
    });
    expect(card.icon_url).toBe('https://x.example/icon.png');
  });

  it('signatures emitted when set (per spec §4.4.7)', () => {
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
      default_input_modes: ['text/plain', 'application/json'],
      default_output_modes: ['text/plain'],
    });
    expect(card.default_input_modes).toEqual(['text/plain', 'application/json']);
    expect(card.default_output_modes).toEqual(['text/plain']);
  });

  it('protocol_binding overridable on the auto-built primary interface', () => {
    const card = buildA2AAgentCard({
      name: 'X',
      description: 'y',
      url: 'https://x.example',
      skills: [DEFAULT_SKILL],
      protocol_binding: 'GRPC',
      a2a_protocol_version: '1.0',
    });
    expect(card.supported_interfaces[0]?.protocol_binding).toBe('GRPC');
  });

  it('extras merge at top level', () => {
    const card = buildA2AAgentCard({
      name: 'X',
      description: 'y',
      url: 'https://x.example',
      skills: [DEFAULT_SKILL],
      extras: { vendor_field: 42 },
    });
    expect((card as Record<string, unknown>).vendor_field).toBe(42);
  });

  it('security_schemes emitted when set', () => {
    const card = buildA2AAgentCard({
      name: 'X',
      description: 'y',
      url: 'https://x.example',
      skills: [DEFAULT_SKILL],
      security_schemes: { bearer: { type: 'http', scheme: 'bearer' } },
    });
    expect(card.security_schemes).toEqual({ bearer: { type: 'http', scheme: 'bearer' } });
  });

  it('multiple supported_interfaces (build via direct construction for non-default cases)', () => {
    const ifaces: A2AAgentInterface[] = [
      { url: 'https://x.example/jsonrpc', protocol_binding: 'JSONRPC', protocol_version: '1.0' },
      { url: 'https://x.example/grpc', protocol_binding: 'GRPC', protocol_version: '1.0' },
    ];
    expect(ifaces).toHaveLength(2);
    expect(ifaces[0]?.protocol_binding).toBe('JSONRPC');
  });
});

describe('A2AAgentCardExtension shape (spec §4.4.4)', () => {
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

describe('A2AAgentCardSignature shape (spec §4.4.7)', () => {
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
