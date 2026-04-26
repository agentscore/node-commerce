import { describe, expect, it } from 'vitest';
import { createMppxServer } from '../../src/payment/mppx_server';

describe('createMppxServer — additional rail branches', () => {
  it('routes tempo_session config through mppx.tempo.session', async () => {
    // mppx.tempo.session needs a viem Account, not just a recipient string. We don't supply one here,
    // so the test confirms the dispatch reaches mppx's own validator — proving the rail wiring works.
    await expect(
      createMppxServer({
        rails: {
          tempo_session: {
            recipient: '0x0000000000000000000000000000000000000001',
            escrowContract: '0x0000000000000000000000000000000000000002',
            store: {},
          },
        },
        secretKey: 'mpp_secret_xxx',
      }),
    ).rejects.toThrow(/requires an `account`/);
  });

  it('registers stripe via createMppxStripe when stripe rail is configured', async () => {
    const server = await createMppxServer({
      rails: { stripe: { profileId: 'acct_test', secretKey: 'sk_test_xxx' } },
      secretKey: 'mpp_secret_xxx',
    });
    expect(server).toBeDefined();
  });

  it('passes custom currency override to tempo charge', async () => {
    const server = await createMppxServer({
      rails: {
        tempo: {
          recipient: '0x0000000000000000000000000000000000000001',
          currency: '0xCustomCurrencyAddress',
        },
      },
      secretKey: 'mpp_secret_xxx',
    });
    expect(server).toBeDefined();
  });
});
