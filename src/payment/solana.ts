/**
 * Solana MPP fee-payer signer loader.
 *
 * Buyers paying via Solana MPP USDC don't typically carry SOL for transaction
 * fees, so merchants commonly co-sign the buyer's `solana/charge` tx as the
 * fee payer (~5000 lamports per tx; negligible vs the USDC value moved).
 *
 * `loadSolanaFeePayer({ privateKey })` accepts a Solana keypair in any of the
 * three forms agents commonly export it as:
 *
 *   - **base58** (Phantom export format) — 64-byte secret+public, or 32-byte
 *     secret-only
 *   - **hex** — 128-char string (64 bytes hex: 32-byte secret + 32-byte public)
 *
 * Returns a `KeyPairSigner` from `@solana/kit` ready to pass as the `signer`
 * field on a `SolanaMppRailSpec`. Returns `undefined` when `privateKey` is
 * empty / absent (so consumers can use `process.env.X` directly without
 * null-checks).
 *
 * Requires the `@solana/kit` peer dependency.
 */
export async function loadSolanaFeePayer(opts: {
  privateKey: string | undefined;
}): Promise<unknown | undefined> {
  const raw = opts.privateKey;
  if (!raw) return undefined;
  const moduleName = '@solana/kit';
  const kit = (await import(moduleName).catch(() => null)) as {
    createKeyPairSignerFromPrivateKeyBytes?: (bytes: Uint8Array) => Promise<unknown>;
    getBase58Codec?: () => { encode: (s: string) => Uint8Array };
  } | null;
  if (!kit?.createKeyPairSignerFromPrivateKeyBytes || !kit.getBase58Codec) {
    throw new Error(
      '@solana/kit not installed — `npm install @solana/kit` for loadSolanaFeePayer.',
    );
  }
  let bytes: Uint8Array;
  if (/^[0-9a-fA-F]{128}$/.test(raw)) {
    bytes = new Uint8Array(raw.match(/.{2}/g)!.map((h) => parseInt(h, 16))).slice(0, 32);
  } else {
    const decoded = new Uint8Array(kit.getBase58Codec().encode(raw));
    bytes = decoded.length === 64 ? decoded.slice(0, 32) : decoded;
  }
  return kit.createKeyPairSignerFromPrivateKeyBytes(bytes);
}
