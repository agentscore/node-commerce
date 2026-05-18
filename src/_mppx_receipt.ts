/** Internal helpers for extracting + interpreting the `Payment-Receipt` header
 *  out of an mppx compose-success result. Shared by `Checkout.handleMppx` and
 *  `computeFirstCheckout`'s MPP settle path so the rail-label / signer
 *  derivation stays one source of truth.
 *
 *  Not part of the public API; consumed via top-level `Checkout` and
 *  `computeFirstCheckout` only.
 */

/** Pull the `Payment-Receipt` header from a successful mppx compose result.
 *  mppx attaches a `withReceipt: (Response) => Response` wrapper to the raw
 *  result; we invoke it with an empty Response to read the header off the
 *  returned wrapped object. */
export function extractMppxReceiptHeaderFromRaw(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || !('withReceipt' in raw)) return null;
  const fn = (raw as { withReceipt: unknown }).withReceipt;
  if (typeof fn !== 'function') return null;
  try {
    const wrapped = (fn as (r: Response) => Response).call(raw, new Response());
    return wrapped.headers.get('Payment-Receipt');
  } catch {
    return null;
  }
}

/** Deserialize the receipt header via mppx's `Receipt.deserialize` and pluck
 *  the `method` field (`'tempo/charge'` / `'solana/charge'` / `'stripe/charge'`).
 *  Returns `undefined` when the header is malformed or mppx isn't importable. */
export async function extractMppxReceiptMethod(header: string): Promise<string | undefined> {
  try {
    const { Receipt } = (await import('mppx')) as {
      Receipt: { deserialize: (s: string) => { method?: string } };
    };
    return Receipt.deserialize(header).method;
  } catch {
    return undefined;
  }
}

/** Resolve the receipt method from a compose-success raw result in one call.
 *  Tries the direct `raw.receipt.method` path first, then falls back to
 *  the `withReceipt`-extracted header. */
export async function deriveMppxReceiptMethod(raw: unknown): Promise<string | undefined> {
  const direct = (raw as { receipt?: { method?: string } } | undefined)?.receipt?.method;
  if (direct) return direct;
  const header = extractMppxReceiptHeaderFromRaw(raw);
  if (!header) return undefined;
  return extractMppxReceiptMethod(header);
}
