import { describe, expect, it } from 'vitest';
import { AGENTSCORE_UCP_CAPABILITY, buildUCPProfile } from '../../src/identity/ucp';
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

const baseInput = {
  services: [{ type: 'rest', url: 'https://agents.example' }],
  signing_keys: [{ kid: 'me-2026', kty: 'EC', alg: 'ES256', crv: 'P-256', x: 'x', y: 'y' }],
};

describe('buildUCPProfile', () => {
  it('emits a base profile with required fields when no AgentScore data', () => {
    const profile = buildUCPProfile(baseInput);
    expect(profile.spec).toBe('https://ucp.dev/');
    expect(profile.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(profile.services).toEqual(baseInput.services);
    expect(profile.signing_keys).toEqual(baseInput.signing_keys);
    expect(profile.capabilities).toEqual([]);
    expect(profile.payment_handlers).toEqual([]);
  });

  it('appends sh.agentscore.identity capability when data carries a resolved operator', () => {
    const profile = buildUCPProfile({ ...baseInput, data: fullData });
    const cap = profile.capabilities.find((c) => c.name === AGENTSCORE_UCP_CAPABILITY);
    expect(cap).toBeDefined();
    expect(cap?.version).toBe('1');
    expect(cap?.name).toBe('sh.agentscore.identity');
    expect(cap?.schema).toContain('sh-agentscore-identity-v1.json');
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
    expect(profile.capabilities.find((c) => c.name === AGENTSCORE_UCP_CAPABILITY)).toBeUndefined();
  });

  it('preserves caller-supplied capabilities and appends agentscore at end', () => {
    const profile = buildUCPProfile({
      ...baseInput,
      capabilities: [{ name: 'checkout', version: '2' }],
      data: fullData,
    });
    expect(profile.capabilities[0]?.name).toBe('checkout');
    expect(profile.capabilities[1]?.name).toBe(AGENTSCORE_UCP_CAPABILITY);
  });

  it('passes through name + payment_handlers + extras', () => {
    const profile = buildUCPProfile({
      ...baseInput,
      name: 'Example Merchant',
      payment_handlers: [
        { name: 'tempo', config: { recipient: '0xtempo' } },
        { name: 'stripe', config: { profile_id: 'prof_x' } },
      ],
      extras: { custom_field: 'custom_value' },
    });
    expect(profile.name).toBe('Example Merchant');
    expect(profile.payment_handlers).toHaveLength(2);
    expect((profile as Record<string, unknown>).custom_field).toBe('custom_value');
  });

  // payment_handler.config is an optional TypeScript property: when the caller
  // omits it the wire profile ships without the `config` key. Python's
  // `UCPPaymentHandler.to_dict` omits empty configs to match this convention,
  // so the same logical input produces the same canonical bytes across SDKs.
  it('payment_handler omits config key when caller does not set it (cross-lang parity)', () => {
    const profile = buildUCPProfile({
      ...baseInput,
      payment_handlers: [{ name: 'tempo' }],
    });
    expect(profile.payment_handlers).toEqual([{ name: 'tempo' }]);
    expect('config' in (profile.payment_handlers[0] as object)).toBe(false);
  });

  it('respects custom version override', () => {
    const profile = buildUCPProfile({ ...baseInput, version: '2026-12-31' });
    expect(profile.version).toBe('2026-12-31');
  });

  it('respects agentscore_schema_url override', () => {
    const profile = buildUCPProfile({
      ...baseInput,
      data: fullData,
      agentscore_schema_url: 'https://custom.example/schema.json',
    });
    const cap = profile.capabilities.find((c) => c.name === AGENTSCORE_UCP_CAPABILITY);
    expect(cap?.schema).toBe('https://custom.example/schema.json');
  });

  it.each([
    ['version'],
    ['spec'],
    ['services'],
    ['capabilities'],
    ['payment_handlers'],
    ['signing_keys'],
    ['name'],
    ['signature'],
    ['__proto__'],
    ['constructor'],
    ['prototype'],
  ])('rejects extras key "%s" as a reserved-field collision', (k) => {
    expect(() =>
      buildUCPProfile({
        ...baseInput,
        extras: { [k]: 'attacker' },
      }),
    ).toThrow(/collides with a reserved profile field/);
  });

  // Empty-string and null normalization: the API can emit
  // `account_verification` with either null or `""` for un-set fields, and the
  // node + python siblings must produce the SAME canonical claims block for
  // either shape so a profile signed in one language verifies in the other.
  describe('account_verification missing-value normalization (cross-lang parity)', () => {
    const baseDataWithOp = {
      decision: 'allow',
      decision_reasons: [],
      resolved_operator: 'op_abc',
    };

    const claimsOf = (av: AgentScoreData['account_verification']) => {
      const profile = buildUCPProfile({
        ...baseInput,
        data: { ...baseDataWithOp, account_verification: av } as AgentScoreData,
      });
      const cap = profile.capabilities.find((c) => c.name === AGENTSCORE_UCP_CAPABILITY) as Record<
        string,
        unknown
      >;
      return cap.claims as Record<string, unknown>;
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
