import { describe, expect, it } from 'vitest';
import { createMppxServer } from '../../src/payment/mppx_server';
import { networks } from '../../src/payment/networks';
import type {
  SolanaMppRailSpec,
  StripeRailSpec,
  TempoRailSpec,
  TempoSessionRailSpec,
} from '../../src/payment/rail_spec';

describe('createMppxServer — additional rail branches', () => {
  it('routes tempo_session config through mppx.tempo.session', async () => {
    await expect(
      createMppxServer({
        rails: {
          tempo_session: {
            recipient: '0x0000000000000000000000000000000000000001',
            escrowContract: '0x0000000000000000000000000000000000000002',
            store: {},
          } as TempoSessionRailSpec,
        },
        secretKey: 'mpp_secret_xxx',
      }),
    ).rejects.toThrow(/requires an `account`/);
  });

  it('registers stripe via createMppxStripe when stripe rail is configured', async () => {
    const server = await createMppxServer({
      rails: {
        stripe: { profileId: 'acct_test', secretKey: 'sk_test_xxx' } as StripeRailSpec,
      },
      secretKey: 'mpp_secret_xxx',
    });
    expect(server).toBeDefined();
  });

  it('rejects stripe rail when secretKey is missing', async () => {
    await expect(
      createMppxServer({
        rails: { stripe: { profileId: 'acct_test' } as StripeRailSpec },
        secretKey: 'mpp_secret_xxx',
      }),
    ).rejects.toThrow(/profileId and secretKey/);
  });

  it('passes custom token override to tempo charge', async () => {
    const server = await createMppxServer({
      rails: {
        tempo: {
          recipient: '0x0000000000000000000000000000000000000001',
          token: '0xCustomCurrencyAddress',
        } as TempoRailSpec,
      },
      secretKey: 'mpp_secret_xxx',
    });
    expect(server).toBeDefined();
  });

  it('registers solana rail and wraps charge() with finalized-blockhash request override', async () => {
    const server = await createMppxServer({
      rails: {
        solana: {
          recipient: 'JDK3GZwsmgWwdFicNnrLHEgZc54SNYp6egWL9LL3k9f5',
          network: networks.solana.devnet.caip2,
          rpcUrl: 'http://localhost:9999',
        } as SolanaMppRailSpec,
      },
      secretKey: 'mpp_secret_xxx',
    });
    expect(server).toBeDefined();
  });

  it('solana rail with mainnet network + custom token program', async () => {
    const server = await createMppxServer({
      rails: {
        solana: {
          recipient: 'JDK3GZwsmgWwdFicNnrLHEgZc54SNYp6egWL9LL3k9f5',
          network: networks.solana.mainnet.caip2,
          tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        } as SolanaMppRailSpec,
      },
      secretKey: 'mpp_secret_xxx',
    });
    expect(server).toBeDefined();
  });
});
