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

import { normalizeHeadersToLowercase } from './_headers';

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

    // SPL TransferChecked accounts: [source ATA, mint, destination ATA, authority, ...signers].
    // Returns the FIRST matched authority. For multi-recipient `splits` txs, the buyer
    // signs ONE tx with N TransferChecked instructions all sharing the same authority,
    // so first-match is correct; if a tx ever surfaces with mismatched authorities the
    // first one wins (acceptable since both belong to whoever signed the tx).
    for (const ix of message.instructions) {
      const programId = message.staticAccounts[ix.programAddressIndex];
      if (programId !== TOKEN_PROGRAM && programId !== TOKEN_2022_PROGRAM) continue;
      const data = ix.data;
      if (!data || data.length === 0 || data[0] !== TRANSFER_CHECKED_DISCRIMINATOR) continue;
      const accountIndices = ix.accountIndices ?? [];
      const authorityIndex = accountIndices[3];
      if (authorityIndex === undefined) continue;
      // v0 transactions can carry account indices that resolve via address lookup tables;
      // staticAccounts only holds the static set. If the index is out of range, the
      // authority sits in a lookup table we'd need RPC to resolve. Skip cleanly with a
      // warning rather than returning the wrong address.
      if (authorityIndex >= message.staticAccounts.length) {
        console.warn(
          '[gate] Solana TransferChecked authority resolves through an address lookup table; ' +
            'signer-match recovery requires the static-account form. Skipping.',
        );
        continue;
      }
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
  // x402 — base64 JSON, EIP-3009 only. EVM `payload.authorization.from` is the signer.
  // Tried before the MPP path so a request carrying both header families resolves the
  // x402 signer first, consistent with `extractSignerForPrecheck`.
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

  return null;
}

/**
 * Headers-only variant for adapters that don't natively expose a Web Fetch `Request`
 * (Express, Fastify, ASGI-bridged frameworks). Constructs a synthetic Request carrying
 * only the `authorization` header and delegates to {@link extractPaymentSigner}. Works
 * because the MPP and x402 paths only read `request.headers.get('authorization')` and
 * the explicit `x402PaymentHeader` arg — no body, query, or method semantics needed.
 */
export async function extractPaymentSignerFromAuth(
  authHeader: string | null | undefined,
  x402PaymentHeader?: string,
): Promise<PaymentSigner | null> {
  const request = new Request('http://internal.gate/', {
    headers: authHeader ? { authorization: authHeader } : {},
  });
  return extractPaymentSigner(request, x402PaymentHeader);
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

/**
 * One-call signer extraction across both supported credential formats.
 *
 * Tries the x402 `payment-signature` / `x-payment` header first (EIP-3009
 * `payload.authorization.from`), then falls back to the MPP
 * `Authorization: Payment` header DID. Returns the first one that resolves,
 * or `null`.
 *
 * Use this for wallet-cap prechecks and other "did the agent claim to sign as
 * X?" checks where you need the signer BEFORE invoking Checkout. Checkout's
 * own settle path runs verification separately and surfaces the verified
 * signer on `SettleOutcome.signerAddress`.
 *
 * Accepts a plain headers dict so it works regardless of which framework the
 * merchant uses (the gate adapters all serialize headers down to a dict by
 * the time they reach the merchant's hooks).
 */
export async function extractSignerForPrecheck(
  headers: Record<string, string>,
): Promise<PaymentSigner | null> {
  const lower = normalizeHeadersToLowercase(headers);
  const x402 = lower['payment-signature'] ?? lower['x-payment'];
  if (x402) {
    const signer = await extractPaymentSignerFromAuth(undefined, x402);
    if (signer !== null) return signer;
  }
  const authorization = lower['authorization'];
  if (authorization && authorization.toLowerCase().startsWith('payment ')) {
    return await extractPaymentSignerFromAuth(authorization);
  }
  return null;
}
