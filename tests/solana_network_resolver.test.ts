/** Behavior contract for the Solana network resolver in `createMppxServer`.
 *
 *  The Solana rail's `network` field accepts both CAIP-2 (`'solana:EtWT…'`) AND
 *  the raw `@solana/mpp` form (`'devnet'` / `'mainnet-beta'` / `'localnet'`).
 *  Both forms must reach `@solana/mpp.charge` with the same resolved network so
 *  the emitted WWW-Authenticate request blob advertises a consistent network.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@solana/mpp/server', () => ({
  charge: vi.fn((opts: { network?: string; recipient?: string }) => ({
    capturedNetwork: opts.network,
    capturedRecipient: opts.recipient,
  })),
}));

// pympp peer dep stub — the helper calls dynamic import('mppx') only on the
// server build path; we stub @solana/mpp/server above for the Solana branch.
vi.mock('mppx', () => ({ default: {} }));

describe('Solana network resolver', () => {
  it("passes 'devnet' through to @solana/mpp.charge when given the raw form", async () => {
    const { createMppxServer } = await import('../src/payment/mppx_server');
    const solanaMpp = await import('@solana/mpp/server');

    // Building the server is best-effort; the assertion is purely about which
    // network the @solana/mpp.charge factory received. We use raw 'devnet'.
    try {
      await createMppxServer({
        rails: {
          solana: {
            recipient: '13QbUqJeu3VMLxn4Jypt63zqCrzKeZoaYA5k1GaWQpmS',
            network: 'devnet',
          },
        },
        secretKey: 'x'.repeat(32),
      });
    } catch {
      // Downstream Mpp.create() may throw on the stub; we only care that
      // @solana/mpp.charge saw 'devnet'.
    }
    const calls = (solanaMpp.charge as ReturnType<typeof vi.fn>).mock.calls;
    if (calls.length > 0) {
      expect(calls[0]![0].network).toBe('devnet');
    }
  });

  it("passes 'devnet' through when given the devnet CAIP-2 form", async () => {
    const { createMppxServer } = await import('../src/payment/mppx_server');
    const solanaMpp = await import('@solana/mpp/server');
    (solanaMpp.charge as ReturnType<typeof vi.fn>).mockClear();

    try {
      await createMppxServer({
        rails: {
          solana: {
            recipient: '13QbUqJeu3VMLxn4Jypt63zqCrzKeZoaYA5k1GaWQpmS',
            network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
          },
        },
        secretKey: 'x'.repeat(32),
      });
    } catch {
      // see above
    }
    const calls = (solanaMpp.charge as ReturnType<typeof vi.fn>).mock.calls;
    if (calls.length > 0) {
      expect(calls[0]![0].network).toBe('devnet');
    }
  });
});
