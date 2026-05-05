/**
 * Payment-signer extraction.
 *
 * Shared between merchants and the gate. Three paths recover a wallet signer:
 *
 *   - **Tempo MPP** — `Authorization: Payment <base64>`; credential `source` is a DID of the
 *     form `did:pkh:eip155:<chain>:<address>`.
 *   - **Solana MPP `solana/charge`** — `Authorization: Payment <base64>`; recovery via either
 *     a `did:pkh:solana:<genesis>:<address>` source (when set by the client) or by decoding
 *     the credential's signed-tx payload and reading the SPL `TransferChecked` authority
 *     (pull mode only — `payload.type === 'transaction'`).
 *   - **x402 EIP-3009 (EVM, e.g. Base/Sepolia)** — `payment-signature` / `x-payment`;
 *     decoded payload carries `payload.authorization.from`.
 *
 * Optional peer deps: `mppx` for MPP credentials, `@solana/kit` for the Solana tx-decode
 * fallback. Both dynamic-imported; merchants who don't accept that rail don't need them.
 */

export type SignerNetwork = 'evm' | 'solana';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const TRANSFER_CHECKED_DISCRIMINATOR = 12;

interface SolanaKitMinimal {
  getBase64Codec: () => { encode: (s: string) => Uint8Array };
  getTransactionDecoder: () => { decode: (b: Uint8Array) => { messageBytes: Uint8Array } };
  getCompiledTransactionMessageDecoder: () => {
    decode: (b: Uint8Array) => {
      staticAccounts: ReadonlyArray<string>;
      instructions: ReadonlyArray<{
        programAddressIndex: number;
        accountIndices?: number[];
        data?: Uint8Array;
      }>;
    };
  };
}

/**
 * Decode a Solana MPP `solana/charge` credential's `payload.transaction` (base64-encoded
 * signed Solana tx) and return the SPL `TransferChecked` authority — the source-ATA owner,
 * which is the buyer's wallet. Pull mode only (`payload.type === 'transaction'`); push mode
 * (`payload.type === 'signature'`) returns null because recovery would require an RPC fetch.
 */
async function extractSolanaSignerFromCredential(credential: unknown): Promise<string | null> {
  const payload = (credential as { payload?: { transaction?: string; type?: string } }).payload;
  if (!payload?.transaction || payload.type !== 'transaction') return null;

  const moduleName = '@solana/kit';
  const kit = (await import(moduleName).catch(() => null)) as SolanaKitMinimal | null;
  if (!kit?.getBase64Codec || !kit.getTransactionDecoder || !kit.getCompiledTransactionMessageDecoder) {
    return null;
  }

  try {
    const txBytes = kit.getBase64Codec().encode(payload.transaction);
    const decoded = kit.getTransactionDecoder().decode(txBytes);
    const message = kit.getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);

    for (const ix of message.instructions) {
      const programId = message.staticAccounts[ix.programAddressIndex];
      if (programId !== TOKEN_PROGRAM && programId !== TOKEN_2022_PROGRAM) continue;
      const data = ix.data;
      if (!data || data.length === 0 || data[0] !== TRANSFER_CHECKED_DISCRIMINATOR) continue;
      // SPL TransferChecked accounts: [source ATA, mint, destination ATA, authority, ...signers]
      const accountIndices = ix.accountIndices ?? [];
      const authorityIndex = accountIndices[3];
      if (authorityIndex === undefined) continue;
      const authority = message.staticAccounts[authorityIndex];
      if (authority) return authority;
    }
    return null;
  } catch (err) {
    console.warn('[gate] Solana credential decode failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

export interface PaymentSigner {
  /** Recovered wallet address (EVM lowercased; Solana base58 preserved verbatim). */
  address: string;
  /** Network family — used by `captureWallet` and downstream cross-chain attribution. */
  network: SignerNetwork;
}

/**
 * Recover the signer wallet from the incoming payment credential, including the network
 * family. Returns `null` when no wallet signature is present (e.g. Stripe SPT, card-only
 * payments, or no credential yet).
 *
 * @param request - the inbound `Request`
 * @param x402PaymentHeader - the value of `payment-signature` or `x-payment` header, if any.
 *   Extracted separately because some frameworks (Express) don't expose a web `Request` object.
 */
export async function extractPaymentSigner(
  request: Request,
  x402PaymentHeader?: string,
): Promise<PaymentSigner | null> {
  // MPP — Authorization: Payment <base64>
  const authHeader = request.headers.get('authorization');
  if (authHeader) {
    try {
      const moduleName = 'mppx';
      const mppx = (await import(moduleName).catch(() => null)) as {
        Credential?: {
          extractPaymentScheme: (h: string) => unknown;
          fromRequest: (r: Request) => unknown;
        };
      } | null;
      if (mppx?.Credential?.extractPaymentScheme(authHeader)) {
        const credential = mppx.Credential.fromRequest(request);
        const source = (credential as { source?: string }).source;
        const evmMatch = source?.match(/^did:pkh:eip155:\d+:(0x[0-9a-fA-F]{40})$/);
        if (evmMatch) return { address: evmMatch[1]!.toLowerCase(), network: 'evm' };
        // Solana CAIP-10: did:pkh:solana:<genesis-base58>:<address-base58>
        const solMatch = source?.match(/^did:pkh:solana:[1-9A-HJ-NP-Za-km-z]{32,44}:([1-9A-HJ-NP-Za-km-z]{32,44})$/);
        if (solMatch) return { address: solMatch[1]!, network: 'solana' };
        // Fallback: source not set by upstream client. Decode the credential's signed-tx
        // payload to find the SPL TransferChecked authority (= source-ATA owner = buyer
        // wallet). Pull mode only.
        const solanaFromTx = await extractSolanaSignerFromCredential(credential);
        if (solanaFromTx) return { address: solanaFromTx, network: 'solana' };
      }
    } catch (err) {
      console.warn('[gate] MPP signer extraction failed:', err instanceof Error ? err.message : err);
    }
  }

  // x402 — base64 JSON, EIP-3009 only. EVM `payload.authorization.from` is the signer.
  if (x402PaymentHeader) {
    try {
      const decoded = atob(x402PaymentHeader);
      const parsed = JSON.parse(decoded) as {
        payload?: { authorization?: { from?: string } };
      };
      const from = parsed?.payload?.authorization?.from;
      if (typeof from === 'string' && /^0x[0-9a-fA-F]{40}$/.test(from)) {
        return { address: from.toLowerCase(), network: 'evm' };
      }
    } catch (err) {
      console.warn('[gate] x402 signer extraction failed:', err instanceof Error ? err.message : err);
    }
  }

  return null;
}

/**
 * Address-only convenience over {@link extractPaymentSigner}. Used by the gate adapters
 * (verifyWalletSignerMatch) where only the address matters for operator comparison.
 */
export async function extractPaymentSignerAddress(
  request: Request,
  x402PaymentHeader?: string,
): Promise<string | null> {
  const result = await extractPaymentSigner(request, x402PaymentHeader);
  return result?.address ?? null;
}

/**
 * Read the x402 payment header from a `Request`, matching the alternate names merchants might
 * use. Falls back to reading either header directly.
 */
export function readX402PaymentHeader(request: Request): string | undefined {
  return (
    request.headers.get('payment-signature') ??
    request.headers.get('x-payment') ??
    undefined
  );
}
