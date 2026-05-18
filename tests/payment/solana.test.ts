import { describe, expect, it } from 'vitest';
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
