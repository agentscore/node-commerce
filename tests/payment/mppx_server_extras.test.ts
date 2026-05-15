import { describe, expect, it } from 'vitest';
import {
  composeMppxRequest,
  createMppxServer,
  mppxChallengeHeaders,
} from '../../src/payment/mppx_server';
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

describe('composeMppxRequest', () => {
  it('typed-narrows a 200 response with withReceipt', async () => {
    const fakeMppx = {
      compose: (..._intents: readonly unknown[]) => async (_req: Request) => ({
        status: 200 as const,
        withReceipt: (response: Response) => response,
      }),
    };
    const result = await composeMppxRequest(fakeMppx, [['tempo/charge', { amount: '1.00' }]], new Request('https://x/y'));
    expect(result.status).toBe(200);
    if (result.status === 200) {
      expect(typeof result.withReceipt).toBe('function');
    }
  });

  it('typed-narrows a 402 challenge response', async () => {
    const fakeMppx = {
      compose: (..._intents: readonly unknown[]) => async (_req: Request) => ({
        status: 402 as const,
        challenge: new Response(null, { status: 402, headers: { 'www-authenticate': 'Payment realm="r"' } }),
      }),
    };
    const result = await composeMppxRequest(fakeMppx, [], new Request('https://x/y'));
    expect(result.status).toBe(402);
    if (result.status === 402) {
      expect(result.challenge).toBeInstanceOf(Response);
    }
  });

  it('rejects when mppx argument lacks compose', async () => {
    await expect(
      composeMppxRequest({} as unknown, [], new Request('https://x/y')),
    ).rejects.toThrow(/not an mppx server instance/);
  });

  it('rejects when compose is not a function', async () => {
    await expect(
      composeMppxRequest({ compose: 'not-a-fn' } as unknown, [], new Request('https://x/y')),
    ).rejects.toThrow(/not a function/);
  });
});

describe('mppxChallengeHeaders', () => {
  it('converts the challenge Response headers to a Record', () => {
    const result = {
      challenge: new Response(null, {
        status: 402,
        headers: {
          'www-authenticate': 'Payment realm="r"',
          'x-extra': 'kept',
        },
      }),
    };
    const out = mppxChallengeHeaders(result);
    expect(out['www-authenticate']).toBe('Payment realm="r"');
    expect(out['x-extra']).toBe('kept');
  });
});
