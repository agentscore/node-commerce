import { describe, expect, it } from 'vitest';
import { buildMppxComposeRails } from '../../src/payment/compose_rails';

describe('buildMppxComposeRails', () => {
  it('emits a single tempo intent when only tempoRecipient is set', () => {
    const out = buildMppxComposeRails({ amountUsd: '1.50', tempoRecipient: '0x1234' });
    expect(out).toEqual([
      ['tempo/charge', expect.objectContaining({ amount: '1.50', decimals: 6, recipient: '0x1234' })],
      ['stripe/charge', { amount: '1.50', currency: 'usd', decimals: 2 }],
    ]);
  });

  it('adds the solana intent with atomic conversion when solanaRecipient is set', () => {
    const out = buildMppxComposeRails({
      amountUsd: '2.00',
      tempoRecipient: '0xabc',
      solanaRecipient: 'SolAddr',
    });
    const solana = (out as unknown[][])[1] as [string, Record<string, unknown>];
    expect(solana[0]).toBe('solana/charge');
    expect(solana[1].amount).toBe('2000000');
    expect(solana[1].recipient).toBe('SolAddr');
    expect(solana[1].decimals).toBe(6);
  });

  it('omits stripe when includeStripe: false', () => {
    const out = buildMppxComposeRails({
      amountUsd: '0.10',
      tempoRecipient: '0xabc',
      includeStripe: false,
    });
    expect(out).toHaveLength(1);
    expect((out[0] as [string, unknown])[0]).toBe('tempo/charge');
  });

  it('throws (rather than emitting a bad solana intent) when amountUsd is unparseable', () => {
    expect(() =>
      buildMppxComposeRails({
        amountUsd: 'nope',
        tempoRecipient: '0xabc',
        solanaRecipient: 'SolAddr',
      }),
    ).toThrow();
  });

  it('caller-provided solanaNetwork wins over the default mainnet CAIP-2', () => {
    const out = buildMppxComposeRails({
      amountUsd: '1',
      tempoRecipient: '0xabc',
      solanaRecipient: 'SolAddr',
      solanaNetwork: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    });
    const solana = (out as unknown[][])[1] as [string, Record<string, unknown>];
    expect(solana[1].network).toBe('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1');
  });
});
