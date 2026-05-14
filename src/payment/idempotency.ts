/**
 * Idempotency-key composition.
 *
 * Stable per-payment keys that retries of the same logical payment can reuse, so AgentScore's
 * `/v1/credentials/wallets` capture endpoint dedupes correctly and the operator's
 * `transaction_count` doesn't inflate.
 *
 * Convention:
 *   1. Prefer the upstream payment-rail's stable identifier (Stripe PaymentIntent id, x402
 *      tx hash) when one exists — those are already idempotent on their side.
 *   2. Fall back to a synthesized `pi-{orderId}-{amountCents}` key when no upstream id is
 *      available (e.g. pre-creation, or rails without a PI concept).
 *   3. Server caps idempotency keys at 200 chars; this helper warns when that boundary is
 *      crossed so a future caller doesn't silently get truncation collisions.
 */

const SERVER_IDEMPOTENCY_KEY_MAX = 200;

/**
 * Compose a stable idempotency key for AgentScore wallet capture and other retry-safe POSTs.
 *
 * Returns `undefined` when no inputs are present (caller should treat as "no idempotency
 * key — first attempt only", same shape as omitting the field entirely).
 *
 * Examples:
 * ```ts
 * buildIdempotencyKey({ paymentIntentId: 'pi_abc' });            // → 'pi_abc'
 * buildIdempotencyKey({ orderId: 'ord_x', amountCents: 25000 }); // → 'pi-ord_x-25000'
 * buildIdempotencyKey({ orderId: 'ord_x' });                     // → 'pi-ord_x'
 * buildIdempotencyKey({ paymentIntentId: 'pi_abc', prefix: 'refund' }); // → 'refund-pi_abc'
 * buildIdempotencyKey({});                                       // → undefined
 * ```
 */
export function buildIdempotencyKey({
  paymentIntentId,
  orderId,
  amountCents,
  prefix,
}: {
  /** Upstream rail's stable payment id — Stripe PaymentIntent id, x402 tx hash, etc. Wins when present. */
  paymentIntentId?: string | null;
  /** Order id — used to compose a fallback key when no paymentIntentId exists. */
  orderId?: string | null;
  /** Amount in cents (or smallest currency unit) — added to the fallback for extra collision resistance. */
  amountCents?: number;
  /** Optional extra prefix to namespace the key (e.g. `"refund"`, `"void"`). */
  prefix?: string;
}): string | undefined {
  const prefixPart = prefix ? `${prefix}-` : '';

  if (paymentIntentId) {
    const key = `${prefixPart}${paymentIntentId}`;
    return clampKey(key);
  }

  if (orderId) {
    const amountSuffix = amountCents !== undefined ? `-${amountCents}` : '';
    const key = `${prefixPart}pi-${orderId}${amountSuffix}`;
    return clampKey(key);
  }

  return undefined;
}

function clampKey(key: string): string {
  if (key.length <= SERVER_IDEMPOTENCY_KEY_MAX) return key;
  // Server truncates anyway; surfacing the warning here gives callers a chance to design
  // shorter inputs. We still return the original key (server-side truncation is the source
  // of truth) — clamping client-side would change semantics for any caller already
  // depending on the full string for their own dedup.
  console.warn(
    `[agentscore-commerce] idempotency key longer than ${SERVER_IDEMPOTENCY_KEY_MAX} chars — server will truncate, may cause silent collisions if multiple keys share the first ${SERVER_IDEMPOTENCY_KEY_MAX} chars.`,
  );
  return key;
}
