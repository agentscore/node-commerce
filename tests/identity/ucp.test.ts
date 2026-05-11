import { describe, expect, it } from 'vitest';
import {
  AGENTSCORE_UCP_CAPABILITY,
  buildUCPProfile,
  type AgentScoreGatePolicy,
  type UCPCapabilityBinding,
  type UCPPaymentHandlerBinding,
  type UCPServiceBinding,
} from '../../src/identity/ucp';

const sampleServiceBinding: UCPServiceBinding = {
  version: '2026-04-08',
  spec: 'https://ucp.dev/2026-04-08/specification/overview',
  transport: 'mcp',
  endpoint: 'https://agents.example/api/ucp/mcp',
  schema: 'https://ucp.dev/services/shopping/mcp.openrpc.json',
};

const baseInput = {
  services: { 'dev.ucp.shopping': [sampleServiceBinding] },
  signing_keys: [{ kid: 'me-2026', kty: 'EC', alg: 'ES256', crv: 'P-256', x: 'x', y: 'y' }],
};

const agentscoreCap = (profile: ReturnType<typeof buildUCPProfile>): UCPCapabilityBinding | undefined => {
  return profile.ucp.capabilities[AGENTSCORE_UCP_CAPABILITY]?.[0];
};

describe('buildUCPProfile (spec-compliant shape)', () => {
  it('emits the spec envelope with `ucp` body + outer `signing_keys`', () => {
    const profile = buildUCPProfile(baseInput);
    expect(profile.ucp).toBeDefined();
    expect(profile.signing_keys).toEqual(baseInput.signing_keys);
    expect(profile.ucp.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(profile.ucp.services).toEqual(baseInput.services);
    expect(profile.ucp.capabilities).toEqual({});
    expect(profile.ucp.payment_handlers).toEqual({});
    // No top-level `spec` field per UCP spec — spec lives per-binding.
    expect((profile as Record<string, unknown>).spec).toBeUndefined();
    // No `version` at top level either; lives under `ucp`.
    expect((profile as Record<string, unknown>).version).toBeUndefined();
  });

  it('skips agentscore capability when agentscore_gate is not provided (default)', () => {
    const profile = buildUCPProfile(baseInput);
    expect(agentscoreCap(profile)).toBeUndefined();
    expect(AGENTSCORE_UCP_CAPABILITY in profile.ucp.capabilities).toBe(false);
  });

  it('appends sh.agentscore.identity capability when agentscore_gate is provided', () => {
    const gate: AgentScoreGatePolicy = {
      require_kyc: true,
      require_sanctions_clear: true,
      min_age: 21,
      allowed_jurisdictions: ['US'],
    };
    const profile = buildUCPProfile({ ...baseInput, agentscore_gate: gate });
    const cap = agentscoreCap(profile);
    expect(cap).toBeDefined();
    // Date-format version (UCP convention; matches every other binding's version field).
    expect(cap?.version).toBe('2026-04-08');
    expect(cap?.spec).toContain('agentscore.sh');
    expect(cap?.schema).toContain('sh-agentscore-identity-v1.json');
    // Multi-parent extends — matches Shopify's dev.shopify.catalog.storefront pattern
    // and UCP-canonical dev.ucp.shopping.discount (extends [checkout, cart]).
    expect(cap?.extends).toEqual(['dev.ucp.shopping.checkout', 'dev.ucp.shopping.cart']);
    // Config is the merchant's policy declaration, NOT per-operator data. Public
    // /.well-known/ucp profiles must never carry per-operator KYC claims.
    const config = (cap as Record<string, unknown>).config as Record<string, unknown>;
    expect(config).toEqual({
      require_kyc: true,
      require_sanctions_clear: true,
      min_age: 21,
      allowed_jurisdictions: ['US'],
    });
  });

  it('capability present with omitted config when caller passes empty policy', () => {
    // When the caller passes {} with no fields set, the binding is still injected
    // (signals that the merchant is AgentScore-gated), but the `config` field is
    // omitted from serialization for cross-lang parity (python's
    // UCPCapabilityBinding.to_dict drops empty config consistently with how
    // UCPPaymentHandlerBinding drops empty config).
    const profile = buildUCPProfile({ ...baseInput, agentscore_gate: {} });
    const cap = agentscoreCap(profile);
    expect(cap).toBeDefined();
    expect(cap?.version).toBe('2026-04-08');
    expect((cap as Record<string, unknown>).config).toBeUndefined();
  });

  it('emits only the policy fields the caller set (omits unset min_age, etc.)', () => {
    const profile = buildUCPProfile({ ...baseInput, agentscore_gate: { require_kyc: true } });
    const config = (agentscoreCap(profile) as Record<string, unknown>).config as Record<string, unknown>;
    expect(config).toEqual({ require_kyc: true });
    expect('min_age' in config).toBe(false);
    expect('allowed_jurisdictions' in config).toBe(false);
  });

  it('preserves caller-supplied capabilities and merges agentscore in alongside', () => {
    const checkoutBinding: UCPCapabilityBinding = {
      version: '2026-04-08',
      spec: 'https://ucp.dev/2026-04-08/specification/checkout',
      schema: 'https://ucp.dev/2026-04-08/schemas/shopping/checkout.json',
    };
    const profile = buildUCPProfile({
      ...baseInput,
      capabilities: { 'dev.ucp.shopping.checkout': [checkoutBinding] },
      agentscore_gate: { require_kyc: true },
    });
    expect(profile.ucp.capabilities['dev.ucp.shopping.checkout']?.[0]?.version).toBe('2026-04-08');
    expect(agentscoreCap(profile)?.version).toBe('2026-04-08');
  });

  it('passes through name + payment_handlers + extras + ucp_extras', () => {
    const tempoHandler: UCPPaymentHandlerBinding = {
      id: 'tempo',
      version: '2026-04-08',
      spec: 'https://agentscore.sh/specification/payment-handlers/tempo',
      schema: 'https://agentscore.sh/schemas/payment-handlers/tempo.json',
      config: { recipient: '0xtempo' },
    };
    const profile = buildUCPProfile({
      ...baseInput,
      name: 'Example Merchant',
      payment_handlers: { 'sh.agentscore.payment.tempo': [tempoHandler] },
      extras: { custom_top_level: 'top_value' },
      ucp_extras: { custom_ucp_field: 'ucp_value' },
    });
    expect(profile.ucp.name).toBe('Example Merchant');
    expect(profile.ucp.payment_handlers['sh.agentscore.payment.tempo']?.[0]?.id).toBe('tempo');
    expect((profile as Record<string, unknown>).custom_top_level).toBe('top_value');
    expect((profile.ucp as Record<string, unknown>).custom_ucp_field).toBe('ucp_value');
  });

  it('payment_handler binding omits config when caller does not set it (cross-lang parity)', () => {
    const tempoHandlerNoConfig: UCPPaymentHandlerBinding = {
      id: 'tempo',
      version: '2026-04-08',
      spec: 'https://agentscore.sh/specification/payment-handlers/tempo',
      schema: 'https://agentscore.sh/schemas/payment-handlers/tempo.json',
    };
    const profile = buildUCPProfile({
      ...baseInput,
      payment_handlers: { 'sh.agentscore.payment.tempo': [tempoHandlerNoConfig] },
    });
    const handler = profile.ucp.payment_handlers['sh.agentscore.payment.tempo']?.[0];
    expect(handler).toBeDefined();
    expect('config' in (handler as object)).toBe(false);
  });

  it('respects custom version override under ucp.version', () => {
    const profile = buildUCPProfile({ ...baseInput, version: '2026-12-31' });
    expect(profile.ucp.version).toBe('2026-12-31');
  });

  it('respects agentscore_schema_url override on the auto-injected capability', () => {
    const profile = buildUCPProfile({
      ...baseInput,
      agentscore_gate: {},
      agentscore_schema_url: 'https://custom.example/schema.json',
    });
    expect(agentscoreCap(profile)?.schema).toBe('https://custom.example/schema.json');
  });

  it('respects agentscore_spec_url override on the auto-injected capability', () => {
    const profile = buildUCPProfile({
      ...baseInput,
      agentscore_gate: {},
      agentscore_spec_url: 'https://custom.example/spec',
    });
    expect(agentscoreCap(profile)?.spec).toBe('https://custom.example/spec');
  });

  it('emits supported_versions map under ucp body when supplied', () => {
    const profile = buildUCPProfile({
      ...baseInput,
      supported_versions: {
        '2026-04-08': 'https://merchant.example/.well-known/ucp/2026-04-08',
        '2026-01-23': 'https://merchant.example/.well-known/ucp/2026-01-23',
      },
    });
    expect(profile.ucp.supported_versions?.['2026-04-08']).toContain('/2026-04-08');
  });

  it.each([['ucp'], ['signing_keys'], ['signature'], ['__proto__'], ['constructor'], ['prototype']])(
    'rejects extras key "%s" as a reserved top-level collision',
    (k) => {
      expect(() => buildUCPProfile({ ...baseInput, extras: { [k]: 'attacker' } })).toThrow(
        /collides with a reserved profile field/,
      );
    },
  );

  it.each([
    ['version'],
    ['name'],
    ['services'],
    ['capabilities'],
    ['payment_handlers'],
    ['supported_versions'],
    ['__proto__'],
    ['constructor'],
    ['prototype'],
  ])('rejects ucp_extras key "%s" as a reserved ucp-field collision', (k) => {
    expect(() => buildUCPProfile({ ...baseInput, ucp_extras: { [k]: 'attacker' } })).toThrow(
      /collides with a reserved `ucp` field/,
    );
  });

  it.each([['rest'], ['mcp'], ['a2a']])(
    'rejects %s service binding when endpoint is missing (UCP spec service.json)',
    (transport) => {
      expect(() =>
        buildUCPProfile({
          ...baseInput,
          services: {
            'dev.ucp.shopping': [
              {
                version: '2026-04-08',
                spec: 'https://ucp.dev/spec',
                transport: transport as 'rest' | 'mcp' | 'a2a',
              },
            ],
          },
        }),
      ).toThrow(/requires `endpoint`/);
    },
  );

  it('accepts embedded service binding without endpoint', () => {
    expect(() =>
      buildUCPProfile({
        ...baseInput,
        services: {
          'dev.ucp.shopping': [
            {
              version: '2026-04-08',
              spec: 'https://ucp.dev/spec',
              transport: 'embedded',
              schema: 'https://ucp.dev/schemas/embedded.json',
            },
          ],
        },
      }),
    ).not.toThrow();
  });

  it('drops empty available_instruments from payment handler binding (UCP spec minItems:1)', () => {
    const profile = buildUCPProfile({
      ...baseInput,
      payment_handlers: {
        'sh.agentscore.payment.tempo': [{
          id: 'tempo',
          version: '2026-04-08',
          spec: 'https://x',
          schema: 'https://x',
          available_instruments: [],
        }],
      },
    });
    const handler = profile.ucp.payment_handlers['sh.agentscore.payment.tempo']?.[0];
    expect(handler).toBeDefined();
    expect('available_instruments' in (handler as object)).toBe(false);
  });
});
