import { describe, expect, it } from 'vitest';
import {
  AGENTSCORE_UCP_CAPABILITY,
  buildUCPProfile,
  type UCPCapabilityBinding,
  type UCPPaymentHandlerBinding,
  type UCPServiceBinding,
} from '../../src/identity/ucp';
import type { AgentScoreData } from '../../src/core';

const fullData: AgentScoreData = {
  decision: 'allow',
  decision_reasons: [],
  resolved_operator: 'op_abc',
  verify_url: 'https://agentscore.sh/verify',
  account_verification: {
    kyc_level: 'enhanced',
    sanctions_clear: true,
    age_bracket: '21+',
    jurisdiction: 'US',
    verified_at: '2026-04-01T00:00:00Z',
  },
};

const sampleServiceBinding: UCPServiceBinding = {
  version: '2026-04-08',
  spec: 'https://ucp.dev/2026-04-08/specification/overview',
  transport: 'mcp',
  endpoint: 'https://agents.example/api/ucp/mcp',
  schema: 'https://ucp.dev/services/shopping/openrpc.json',
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

  it('appends sh.agentscore.identity capability when data carries a resolved operator', () => {
    const profile = buildUCPProfile({ ...baseInput, data: fullData });
    const cap = agentscoreCap(profile);
    expect(cap).toBeDefined();
    expect(cap?.version).toBe('1');
    expect(cap?.spec).toContain('agentscore.sh');
    expect(cap?.schema).toContain('sh-agentscore-identity-v1.json');
    // Multi-parent extends — matches Shopify's dev.shopify.catalog.storefront pattern
    // and UCP-canonical dev.ucp.shopping.discount (extends [checkout, cart]).
    expect(cap?.extends).toEqual(['dev.ucp.shopping.checkout', 'dev.ucp.shopping.cart']);
    const claims = (cap as Record<string, unknown>).claims as Record<string, unknown>;
    expect(claims.operator_id).toBe('op_abc');
    expect(claims.kyc_level).toBe('enhanced');
    expect(claims.sanctions_clear).toBe(true);
    expect(claims.age_bracket).toBe('21+');
    expect(claims.jurisdiction).toBe('US');
    expect(claims.verify_url).toBe('https://agentscore.sh/verify');
    expect(claims.issuer).toBe('https://agentscore.sh');
  });

  it('skips agentscore capability when data has no resolved_operator', () => {
    const profile = buildUCPProfile({
      ...baseInput,
      data: { decision: null, decision_reasons: [] },
    });
    expect(agentscoreCap(profile)).toBeUndefined();
    expect(AGENTSCORE_UCP_CAPABILITY in profile.ucp.capabilities).toBe(false);
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
      data: fullData,
    });
    expect(profile.ucp.capabilities['dev.ucp.shopping.checkout']?.[0]?.version).toBe('2026-04-08');
    expect(agentscoreCap(profile)?.version).toBe('1');
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
      data: fullData,
      agentscore_schema_url: 'https://custom.example/schema.json',
    });
    expect(agentscoreCap(profile)?.schema).toBe('https://custom.example/schema.json');
  });

  it('respects agentscore_spec_url override on the auto-injected capability', () => {
    const profile = buildUCPProfile({
      ...baseInput,
      data: fullData,
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

  // Empty-string and null normalization: the API can emit `account_verification` with
  // either null or `""` for un-set fields, and the node + python siblings must produce
  // the SAME canonical claims block for either shape so a profile signed in one
  // language verifies in the other.
  describe('account_verification missing-value normalization (cross-lang parity)', () => {
    const baseDataWithOp = {
      decision: 'allow',
      decision_reasons: [],
      resolved_operator: 'op_abc',
    };

    const claimsOf = (av: AgentScoreData['account_verification']): Record<string, unknown> => {
      const profile = buildUCPProfile({
        ...baseInput,
        data: { ...baseDataWithOp, account_verification: av } as AgentScoreData,
      });
      return (agentscoreCap(profile) as Record<string, unknown>).claims as Record<string, unknown>;
    };

    it('coerces empty-string kyc_level to "none"', () => {
      expect(claimsOf({ kyc_level: '' }).kyc_level).toBe('none');
    });

    it('coerces null age_bracket to "unknown"', () => {
      expect(claimsOf({ age_bracket: null as unknown as string }).age_bracket).toBe('unknown');
    });

    it('coerces empty-string age_bracket to "unknown"', () => {
      expect(claimsOf({ age_bracket: '' }).age_bracket).toBe('unknown');
    });

    it('coerces null jurisdiction to ""', () => {
      expect(claimsOf({ jurisdiction: null as unknown as string }).jurisdiction).toBe('');
    });

    it('coerces empty-string jurisdiction to ""', () => {
      expect(claimsOf({ jurisdiction: '' }).jurisdiction).toBe('');
    });

    it('coerces null verified_at to null', () => {
      expect(claimsOf({ verified_at: null }).verified_at).toBeNull();
    });

    it('coerces empty-string verified_at to null', () => {
      expect(claimsOf({ verified_at: '' }).verified_at).toBeNull();
    });
  });
});
