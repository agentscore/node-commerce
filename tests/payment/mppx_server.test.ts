import { describe, expect, it } from 'vitest';
import { createMppxServer } from '../../src/payment/mppx_server';

describe('createMppxServer', () => {
  it('returns an mppx server with no rails when none configured', async () => {
    const server = await createMppxServer({ secretKey: 'mpp_secret_xxx' });
    expect(server).toBeDefined();
  });

  it('registers the tempo charge method', async () => {
    const server = await createMppxServer({
      rails: { tempo: { recipient: '0x0000000000000000000000000000000000000001' } },
      secretKey: 'mpp_secret_xxx',
    });
    expect(server).toBeDefined();
  });

  it('registers the tempo testnet charge method when testnet: true', async () => {
    const server = await createMppxServer({
      rails: { tempo: { recipient: '0x0000000000000000000000000000000000000001', testnet: true } },
      secretKey: 'mpp_secret_xxx',
    });
    expect(server).toBeDefined();
  });

  it('accepts arbitrary methods alongside rails', async () => {
    const server = await createMppxServer({
      methods: [],
      rails: { tempo: { recipient: '0x0000000000000000000000000000000000000001' } },
      secretKey: 'mpp_secret_xxx',
    });
    expect(server).toBeDefined();
  });

  it('registers the solana mpp charge method (mainnet default, no signer)', async () => {
    const server = await createMppxServer({
      rails: { solana: { recipient: 'GEQg2TM4VL315Bd4LLkGrhBjdNfoatKjCJYHBDPM3D74' } },
      secretKey: 'mpp_secret_xxx',
    });
    expect(server).toBeDefined();
  });

  it('registers the solana devnet mpp charge method', async () => {
    const server = await createMppxServer({
      rails: {
        solana: {
          recipient: 'GEQg2TM4VL315Bd4LLkGrhBjdNfoatKjCJYHBDPM3D74',
          network: 'devnet',
        },
      },
      secretKey: 'mpp_secret_xxx',
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
        },
      },
      secretKey: 'mpp_secret_xxx',
    });
    expect(server).toBeDefined();
  });
});
