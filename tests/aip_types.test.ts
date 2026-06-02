import { describe, expect, it } from 'vitest';
import { isAitShape, validateAitPayload, type AitPayload } from '../src/aip/types';

const validPayload: AitPayload = {
  aip_version: '0.1',
  iss: 'https://issuer.example',
  sub: 'user_abc123',
  iat: 1715400000,
  exp: 1715400300,
  cnf: { jwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' } },
  agent: { provider: 'anthropic', instance: 'session-xyz' },
  trust_level: 'human_present',
};

describe('isAitShape', () => {
  it('is true when cnf + agent are present objects', () => {
    expect(isAitShape(validPayload)).toBe(true);
  });

  it('is false without cnf', () => {
    const { cnf, ...rest } = validPayload;
    void cnf;
    expect(isAitShape(rest)).toBe(false);
  });

  it('is false without agent', () => {
    const { agent, ...rest } = validPayload;
    void agent;
    expect(isAitShape(rest)).toBe(false);
  });

  it('is false for non-objects', () => {
    expect(isAitShape(null)).toBe(false);
    expect(isAitShape('x')).toBe(false);
    expect(isAitShape([])).toBe(false);
  });
});

describe('validateAitPayload — required claims', () => {
  it('accepts a well-formed payload', () => {
    const r = validateAitPayload(validPayload);
    expect(r.ok).toBe(true);
  });

  it.each([
    ['aip_version', 'missing_aip_version'],
    ['iss', 'missing_iss'],
    ['sub', 'missing_sub'],
    ['iat', 'missing_iat'],
    ['exp', 'missing_exp'],
    ['cnf', 'missing_cnf'],
    ['agent', 'missing_agent_provider'],
  ] as const)('rejects a payload missing %s', (field, reason) => {
    const clone: Record<string, unknown> = { ...validPayload };
    delete clone[field];
    const r = validateAitPayload(clone);
    expect(r).toEqual({ ok: false, reason });
  });

  it('rejects a non-object', () => {
    expect(validateAitPayload(null)).toEqual({ ok: false, reason: 'not_an_object' });
    expect(validateAitPayload('jwt')).toEqual({ ok: false, reason: 'not_an_object' });
  });

  it('rejects a cnf without a jwk', () => {
    const r = validateAitPayload({ ...validPayload, cnf: { notjwk: true } });
    expect(r).toEqual({ ok: false, reason: 'missing_cnf' });
  });

  it('rejects an agent without provider', () => {
    const r = validateAitPayload({ ...validPayload, agent: { instance: 'x' } });
    expect(r).toEqual({ ok: false, reason: 'missing_agent_provider' });
  });

  it('rejects a non-numeric iat/exp', () => {
    expect(validateAitPayload({ ...validPayload, iat: '1715400000' })).toEqual({ ok: false, reason: 'missing_iat' });
    expect(validateAitPayload({ ...validPayload, exp: null })).toEqual({ ok: false, reason: 'missing_exp' });
  });
});

describe('validateAitPayload — human_confirmed requires auth.amr', () => {
  it('rejects human_confirmed with no auth at all', () => {
    const r = validateAitPayload({ ...validPayload, trust_level: 'human_confirmed' });
    expect(r).toEqual({ ok: false, reason: 'human_confirmed_without_amr' });
  });

  it('rejects human_confirmed with an empty amr array', () => {
    const r = validateAitPayload({ ...validPayload, trust_level: 'human_confirmed', auth: { amr: [], time: 1 } });
    expect(r).toEqual({ ok: false, reason: 'human_confirmed_without_amr' });
  });

  it('accepts human_confirmed with at least one amr value', () => {
    const r = validateAitPayload({ ...validPayload, trust_level: 'human_confirmed', auth: { amr: ['face'], time: 1715399900 } });
    expect(r.ok).toBe(true);
  });

  it('does not require amr for autonomous or human_present', () => {
    expect(validateAitPayload({ ...validPayload, trust_level: 'autonomous' }).ok).toBe(true);
    expect(validateAitPayload({ ...validPayload, trust_level: 'human_present' }).ok).toBe(true);
  });
});

describe('validateAitPayload — extension claims pass through', () => {
  it('preserves identity + payment extension claims on success', () => {
    const withExtensions: AitPayload = {
      ...validPayload,
      identity: {
        email: 'b@example.com',
        email_verified: true,
        age_over_21: true,
        jurisdiction: 'US-CA',
        sanctions_clear: true,
        sanctions_providers: ['ofac_sdn', 'opensanctions'],
        linked_wallets: [{ address: '0xabc', network: 'evm' }],
        merchants_paid: 4,
      },
      payment: { signer: { address: '0xabc', network: 'evm', match: 'linked_operator' } },
    };
    const r = validateAitPayload(withExtensions);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.identity?.jurisdiction).toBe('US-CA');
      expect(r.payload.payment?.signer?.match).toBe('linked_operator');
    }
  });
});
