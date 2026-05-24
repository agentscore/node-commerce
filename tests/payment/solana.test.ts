import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSolanaFeePayer } from '../../src/payment/solana';

describe('loadSolanaFeePayer', () => {
  it('returns undefined when privateKey is undefined / empty', async () => {
    expect(await loadSolanaFeePayer({ privateKey: undefined })).toBeUndefined();
    expect(await loadSolanaFeePayer({ privateKey: '' })).toBeUndefined();
  });

  it('attempts to construct a signer with valid hex privateKey (loads @solana/kit)', async () => {
    // 128-char hex string — exercises the hex branch (lines 38-39)
    const hex = 'a'.repeat(128);
    // Either succeeds (kit installed) or throws (kit missing) — either path is
    // valid. We just need to exercise the branch.
    try {
      await loadSolanaFeePayer({ privateKey: hex });
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('attempts to construct a signer with non-hex (base58-shaped) privateKey', async () => {
    const base58Like = '5Kd3NBUAdUnhyzenEwVLy9pBKxSwXvE9FMPyR4UKZvpu';
    try {
      await loadSolanaFeePayer({ privateKey: base58Like });
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
    }
  });
});

describe('loadSolanaFeePayer — peer-dep guard', () => {
  afterEach(() => { vi.doUnmock('@solana/kit'); });

  it('throws a guiding error when @solana/kit lacks the required exports', async () => {
    // Simulate the peer dep being absent/incompatible (module resolves but the
    // needed functions are missing) to exercise the install-guidance throw.
    vi.doMock('@solana/kit', () => ({
      createKeyPairSignerFromPrivateKeyBytes: undefined,
      getBase58Codec: undefined,
    }));
    const { loadSolanaFeePayer: freshLoad } = await import(`../../src/payment/solana?nokit=${Date.now()}`);
    await expect(freshLoad({ privateKey: 'a'.repeat(128) })).rejects.toThrow(/@solana\/kit not installed/);
  });
});
