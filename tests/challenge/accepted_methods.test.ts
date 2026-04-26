import { describe, expect, it } from 'vitest';
import { buildAcceptedMethods } from '../../src/challenge/accepted_methods';

describe('buildAcceptedMethods', () => {
  it('builds tempo entry from minimal input (recipient only)', () => {
    const methods = buildAcceptedMethods({ tempo: { recipient: '0xabc' } });
    expect(methods).toHaveLength(1);
    expect(methods[0]).toMatchObject({ method: 'tempo/charge', pay_to: '0xabc', chain_id: 4217 });
  });

  it('builds all four rails when all are passed', () => {
    const methods = buildAcceptedMethods({
      tempo: { recipient: '0xt' },
      x402_base: { recipient: '0xb' },
      x402_solana: { recipient: 'sol1' },
      stripe: { profileId: 'acct_test' },
    });
    expect(methods.map((m) => m.method)).toEqual([
      'tempo/charge',
      'x402/exact',
      'x402/exact',
      'stripe/charge',
    ]);
  });

  it('omits rails the vendor did not pass', () => {
    const methods = buildAcceptedMethods({ tempo: { recipient: '0xt' } });
    expect(methods).toHaveLength(1);
    expect(methods[0]!.method).toBe('tempo/charge');
  });

  it('stripe entry defaults to all rails when not specified', () => {
    const methods = buildAcceptedMethods({ stripe: { profileId: 'acct_test' } });
    expect(methods[0]).toMatchObject({
      method: 'stripe/charge',
      rails: ['card', 'link', 'shared_payment_token'],
      profile_id: 'acct_test',
    });
  });

  it('respects custom symbol/decimals overrides', () => {
    const methods = buildAcceptedMethods({
      tempo: { recipient: '0xt', symbol: 'CUSTOM', decimals: 18 },
    });
    expect(methods[0]).toMatchObject({ symbol: 'CUSTOM', decimals: 18 });
  });
});
