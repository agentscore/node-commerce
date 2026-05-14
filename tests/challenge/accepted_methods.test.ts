import { describe, expect, it } from 'vitest';
import { buildAcceptedMethods } from '../../src/challenge/accepted_methods';

describe('buildAcceptedMethods', () => {
  it('builds tempo entry from minimal input (recipient only)', async () => {
    const methods = await buildAcceptedMethods({ tempo: { recipient: '0xabc' } });
    expect(methods).toHaveLength(1);
    expect(methods[0]).toMatchObject({ method: 'tempo/charge', pay_to: '0xabc', chain_id: 4217 });
  });

  it('builds all four rails when all are passed', async () => {
    const methods = await buildAcceptedMethods({
      tempo: { recipient: '0xt' },
      x402_base: { recipient: '0xb' },
      solana_mpp: { recipient: 'sol1' },
      stripe: { profileId: 'acct_test' },
    });
    expect(methods.map((m) => m.method)).toEqual([
      'tempo/charge',
      'x402/exact',
      'solana/charge',
      'stripe/charge',
    ]);
    expect(methods[2]).toMatchObject({ pay_to: 'sol1' });
  });

  it('omits rails the vendor did not pass', async () => {
    const methods = await buildAcceptedMethods({ tempo: { recipient: '0xt' } });
    expect(methods).toHaveLength(1);
    expect(methods[0]!.method).toBe('tempo/charge');
  });

  it('stripe entry defaults to all rails when not specified', async () => {
    const methods = await buildAcceptedMethods({ stripe: { profileId: 'acct_test' } });
    expect(methods[0]).toMatchObject({
      method: 'stripe/charge',
      rails: ['card', 'link', 'shared_payment_token'],
      profile_id: 'acct_test',
    });
  });

  it('respects custom symbol/decimals overrides', async () => {
    const methods = await buildAcceptedMethods({
      tempo: { recipient: '0xt', symbol: 'CUSTOM', decimals: 18 },
    });
    expect(methods[0]).toMatchObject({ symbol: 'CUSTOM', decimals: 18 });
  });

  it('resolves async recipient factories per invocation', async () => {
    let calls = 0;
    const factory = async () => {
      calls += 1;
      return `0xfresh-${calls}`;
    };
    const first = await buildAcceptedMethods({ tempo: { recipient: factory } });
    const second = await buildAcceptedMethods({ tempo: { recipient: factory } });
    expect(first[0]).toMatchObject({ pay_to: '0xfresh-1' });
    expect(second[0]).toMatchObject({ pay_to: '0xfresh-2' });
  });
});
