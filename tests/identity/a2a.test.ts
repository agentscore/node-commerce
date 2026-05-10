import { describe, expect, it } from 'vitest';
import {
  UCP_A2A_EXTENSION_URI,
  buildA2AAgentCard,
  ucpA2AExtension,
  type A2AAgentCardExtension,
  type A2AAgentInterface,
  type A2AAgentSkill,
} from '../../src/identity/a2a';

describe('buildA2AAgentCard (A2A v1.0 spec compliance)', () => {
  it('emits the minimum required spec fields', () => {
    const card = buildA2AAgentCard({
      name: 'Example Merchant',
      description: 'Buy regulated goods via agent payments.',
      url: 'https://agents.example.com',
    });
    // Per spec §4.4.1 (proto): name, description, supported_interfaces, version,
    // capabilities, default_input_modes, default_output_modes are REQUIRED.
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
  });

  it('does NOT emit invented fields (protocol_version, card_version, endpoints, identity, top-level extensions)', () => {
    // Confirms the post-refactor spec compliance: these fields are not in the A2A proto.
    const card = buildA2AAgentCard({ name: 'X', description: 'y', url: 'https://x.example' });
    const c = card as unknown as Record<string, unknown>;
    expect(c.protocol_version).toBeUndefined();
    expect(c.card_version).toBeUndefined();
    expect(c.endpoints).toBeUndefined();
    expect(c.identity).toBeUndefined();
    expect(c.extensions).toBeUndefined();
  });

  it('skills serialize as top-level objects (not strings inside capabilities)', () => {
    const skill: A2AAgentSkill = {
      id: 'purchase',
      name: 'Purchase',
      description: 'Buy products via agent payments.',
      tags: ['commerce', 'payment'],
    };
    const card = buildA2AAgentCard({
      name: 'X',
      description: 'y',
      url: 'https://x.example',
      skills: [skill],
    });
    expect(card.skills).toEqual([skill]);
    // skills are NOT inside capabilities
    expect((card.capabilities as Record<string, unknown>).skills).toBeUndefined();
  });

  it('skills omitted when empty', () => {
    const card = buildA2AAgentCard({ name: 'X', description: 'y', url: 'https://x.example' });
    expect(card.skills).toBeUndefined();
  });

  it('extensions live INSIDE capabilities, not at top level', () => {
    const card = buildA2AAgentCard({
      name: 'X',
      description: 'y',
      url: 'https://x.example',
      extensions: [ucpA2AExtension()],
    });
    expect((card as unknown as Record<string, unknown>).extensions).toBeUndefined();
    expect(card.capabilities.extensions).toHaveLength(1);
    expect(card.capabilities.extensions?.[0]?.uri).toBe(UCP_A2A_EXTENSION_URI);
  });

  it('extensions omitted when empty array passed (parity with python)', () => {
    const card = buildA2AAgentCard({
      name: 'X', description: 'y', url: 'https://x.example', extensions: [],
    });
    expect(card.capabilities.extensions).toBeUndefined();
  });

  it('capability flags emitted when set', () => {
    const card = buildA2AAgentCard({
      name: 'X',
      description: 'y',
      url: 'https://x.example',
      streaming: true,
      push_notifications: false,
      extended_agent_card: true,
    });
    expect(card.capabilities.streaming).toBe(true);
    expect(card.capabilities.push_notifications).toBe(false);
    expect(card.capabilities.extended_agent_card).toBe(true);
  });

  it('capability flags omitted when unset', () => {
    const card = buildA2AAgentCard({ name: 'X', description: 'y', url: 'https://x.example' });
    expect(card.capabilities.streaming).toBeUndefined();
    expect(card.capabilities.push_notifications).toBeUndefined();
    expect(card.capabilities.extended_agent_card).toBeUndefined();
  });

  it('provider emitted when set', () => {
    const card = buildA2AAgentCard({
      name: 'X',
      description: 'y',
      url: 'https://x.example',
      provider: { url: 'https://acme.example', organization: 'Acme' },
    });
    expect(card.provider).toEqual({ url: 'https://acme.example', organization: 'Acme' });
  });

  it('documentation_url emitted when set', () => {
    const card = buildA2AAgentCard({
      name: 'X',
      description: 'y',
      url: 'https://x.example',
      documentation_url: 'https://docs.example',
    });
    expect(card.documentation_url).toBe('https://docs.example');
  });

  it('default modes overridable', () => {
    const card = buildA2AAgentCard({
      name: 'X',
      description: 'y',
      url: 'https://x.example',
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
      extras: { vendor_field: 42 },
    });
    expect((card as Record<string, unknown>).vendor_field).toBe(42);
  });

  it('security_schemes emitted when set', () => {
    const card = buildA2AAgentCard({
      name: 'X',
      description: 'y',
      url: 'https://x.example',
      security_schemes: { bearer: { type: 'http', scheme: 'bearer' } },
    });
    expect(card.security_schemes).toEqual({ bearer: { type: 'http', scheme: 'bearer' } });
  });

  it('multiple supported_interfaces (build via direct construction for non-default cases)', () => {
    // For multi-binding agents, callers should construct A2AAgentCard directly.
    // The convenience builder always emits exactly one auto-built primary interface.
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

describe('UCP A2A extension helper', () => {
  it('exports the canonical UCP A2A extension URI pinned to 2026-04-08', () => {
    expect(UCP_A2A_EXTENSION_URI).toBe('https://ucp.dev/2026-04-08/specification/reference');
  });

  it('ucpA2AExtension() with no args emits required fields + empty capabilities', () => {
    const ext = ucpA2AExtension();
    expect(ext.uri).toBe(UCP_A2A_EXTENSION_URI);
    expect(ext.description).toBeTruthy(); // non-empty per spec
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
