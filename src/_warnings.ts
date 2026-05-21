/**
 * Shared one-shot warning helpers for the SDK. Module-level state ensures the
 * warning fires at most once per process, regardless of how many Checkout /
 * computeFirstCheckout instances trigger it.
 */

let warnedNoApiKey = false;

/**
 * Emit a one-time warning when AGENTSCORE_API_KEY is unset on a settle path
 * that would otherwise enforce wallet OFAC SDN sanctions. Both `Checkout` and
 * `computeFirstCheckout` route through this so a single multi-surface app
 * sees the warning ONCE, not once per surface.
 *
 * `label` is the caller's identifier for the log message; e.g. `'checkout'`
 * or the compute-first handler's `name`.
 */
export function warnMissingApiKeyOnce(label: string): void {
  if (warnedNoApiKey) return;
  warnedNoApiKey = true;
  console.warn(
    `[${label}] AGENTSCORE_API_KEY is not set — wallet OFAC SDN sanctions are NOT being enforced. ` +
    'Set the env var to enable strict-liability protection on settle.',
  );
}

/** Test-only: reset the warn-once flag. NOT exported from the package surface. */
export function _resetWarnedNoApiKey(): void {
  warnedNoApiKey = false;
}
