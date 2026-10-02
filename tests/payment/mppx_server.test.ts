import { describe, expect, it } from 'vitest';
import { buildMppxComposeRails } from '../../src/payment/compose_rails';
import { composeMppxRequest, createMppxServer } from '../../src/payment/mppx_server';
import { networks } from '../../src/payment/networks';
import { USDC } from '../../src/payment/usdc';
import type {
  SolanaMppRailSpec,
  TempoRailSpec,
} from '../../src/payment/rail_spec';

function decodeChallengeRequests(header: string): Record<string, unknown>[] {
  return [...header.matchAll(/request="([^"]+)"/g)].map(
    ([, encoded]) => JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>,
  );
}

describe('createMppxServer', () => {
  // mppx defaults an unconfigured Tempo offer to OUSD first; the rail must advertise only the USDC we settle in.
  it('issues a single Tempo challenge priced in USDC', async () => {
    const recipient = '0x0000000000000000000000000000000000000001';
    const server = await createMppxServer({
      rails: { tempo: { recipient } as TempoRailSpec },
      secretKey: 'mpp_test_secret_key_padded_to_32_bytes',
    });
    const result = await composeMppxRequest(
      server,
      buildMppxComposeRails({ amountUsd: '1.00', tempoRecipient: recipient, includeStripe: false }),
      new Request('https://merchant.example/buy', { method: 'POST' }),
    );
    expect(result.status).toBe(402);
    const header = (result as { challenge: Response }).challenge.headers.get('www-authenticate') ?? '';
    const requests = decodeChallengeRequests(header);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ amount: '1000000', currency: USDC.tempo.mainnet.address, recipient });
  });

  it('returns an mppx server with no rails when none configured', async () => {
    const server = await createMppxServer({ secretKey: 'mpp_test_secret_key_padded_to_32_bytes' });
    expect(server).toBeDefined();
  });

  it('registers the tempo charge method', async () => {
    const server = await createMppxServer({
      rails: {
        tempo: { recipient: '0x0000000000000000000000000000000000000001' } as TempoRailSpec,
      },
      secretKey: 'mpp_test_secret_key_padded_to_32_bytes',
    });
    expect(server).toBeDefined();
  });

  it('registers the tempo testnet charge method when testnet: true', async () => {
    const server = await createMppxServer({
      rails: {
        tempo: {
          recipient: '0x0000000000000000000000000000000000000001',
          testnet: true,
        } as TempoRailSpec,
      },
      secretKey: 'mpp_test_secret_key_padded_to_32_bytes',
    });
    expect(server).toBeDefined();
  });

  it('accepts arbitrary methods alongside rails', async () => {
    const server = await createMppxServer({
      methods: [],
      rails: {
        tempo: { recipient: '0x0000000000000000000000000000000000000001' } as TempoRailSpec,
      },
      secretKey: 'mpp_test_secret_key_padded_to_32_bytes',
    });
    expect(server).toBeDefined();
  });

  it('registers the solana mpp charge method (mainnet default)', async () => {
    const server = await createMppxServer({
      rails: {
        solana: {
          recipient: 'GEQg2TM4VL315Bd4LLkGrhBjdNfoatKjCJYHBDPM3D74',
          network: networks.solana.mainnet.caip2,
        } as SolanaMppRailSpec,
      },
      secretKey: 'mpp_test_secret_key_padded_to_32_bytes',
    });
    expect(server).toBeDefined();
  });

  it('registers the solana devnet mpp charge method', async () => {
    const server = await createMppxServer({
      rails: {
        solana: {
          recipient: 'GEQg2TM4VL315Bd4LLkGrhBjdNfoatKjCJYHBDPM3D74',
          network: networks.solana.devnet.caip2,
        } as SolanaMppRailSpec,
      },
      secretKey: 'mpp_test_secret_key_padded_to_32_bytes',
    });
    expect(server).toBeDefined();
  });

  it('forwards optional rpcUrl and tokenProgram fields when provided', async () => {
    const server = await createMppxServer({
      rails: {
        solana: {
          recipient: 'GEQg2TM4VL315Bd4LLkGrhBjdNfoatKjCJYHBDPM3D74',
          rpcUrl: 'https://api.mainnet-beta.solana.com',
          tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        } as SolanaMppRailSpec,
      },
      secretKey: 'mpp_test_secret_key_padded_to_32_bytes',
    });
    expect(server).toBeDefined();
  });
});
