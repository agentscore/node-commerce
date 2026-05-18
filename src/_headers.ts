/** Internal header helpers. Replaces hand-rolled `Object.entries(...).toLowerCase()`
 *  loops in `checkout`, `signer`, `respond_402`, and `discovery/well_known`.
 *
 *  Not part of the public API; consumed by SDK internals only.
 */

/** Lowercase every header key, preserve values. Idempotent. */
export function normalizeHeadersToLowercase(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}
