/**
 * Payment-signer extraction.
 *
 * Shared between merchants and the gate — both need to recover the on-chain signer from
 * a payment credential without duplicating code. Two paths carry a recoverable wallet
 * signer here:
 *
 *   - **Tempo MPP** — `Authorization: Payment <base64>` header; credential `source` is a DID
 *     of the form `did:pkh:eip155:<chain>:<address>`.
 *   - **x402 EIP-3009** (EVM, e.g. Base/Sepolia) — `payment-signature` / `x-payment` header;
 *     decoded payload carries `payload.authorization.from`.
 *
 * `mppx` is an optional peer dependency — we import it dynamically so merchants who don't
 * use MPP don't need to install it. The EVM x402 path is pure JSON parsing with no external dep.
 */

export type SignerNetwork = 'evm' | 'solana';

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
        const match = source?.match(/^did:pkh:eip155:\d+:(0x[0-9a-fA-F]{40})$/);
        if (match) return { address: match[1]!.toLowerCase(), network: 'evm' };
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
