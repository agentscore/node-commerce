/**
 * USD ↔ atomic-unit conversion for token amounts.
 *
 * `usdToAtomic(usd, { decimals: 6 })` returns the bigint atomic value of a USD
 * amount for a token with `decimals` places of precision (USDC is 6). String
 * parsing + bigint arithmetic so the result is exact; ROUND_HALF_UP at the
 * rounding boundary matches the cross-language Python sibling.
 *
 * Rejects negative, NaN, infinite, and unparseable inputs. Fixed-notation only;
 * scientific notation (e.g. `"1e6"`) is not parsed (mirrors the locked cross-
 * language fixture corpus, which uses fixed notation exclusively).
 */

/**
 * Convert a USD amount to atomic units for a token with `decimals` places.
 *
 * @param usd USD amount. Strings (`"1.23"`) and `number`s (`1.23`) are accepted.
 *   `number` is converted via `String(usd)` before parsing, so JS float precision
 *   limits apply when the float can't represent the value exactly.
 * @param opts.decimals Number of decimal places in the atomic unit (6 for USDC,
 *   18 for ETH, etc.). Must be a non-negative integer.
 *
 * @returns Integer atomic units as a `bigint`. `"1.23"` with `decimals: 6`
 *   returns `1_230_000n`.
 *
 * @throws RangeError when `usd` is negative, NaN, infinite, or `decimals` is
 *   not a non-negative integer.
 * @throws SyntaxError when `usd` cannot be parsed as a fixed-notation decimal.
 */
export function usdToAtomic(usd: string | number, opts: { decimals: number }): bigint {
  const { decimals } = opts;
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError(`decimals must be a non-negative integer, got ${decimals}`);
  }

  // Reject NaN / Infinity / negative on the typed-number path before stringifying,
  // so the error names the original numeric value rather than the stringified form.
  if (typeof usd === 'number') {
    if (!Number.isFinite(usd)) {
      throw new RangeError(`usd must be finite, got ${usd}`);
    }
    if (usd < 0) {
      throw new RangeError(`usd must be non-negative, got ${usd}`);
    }
  }

  const s = (typeof usd === 'number' ? usd.toString() : usd).trim();

  if (s.startsWith('-')) {
    throw new RangeError(`usd must be non-negative, got ${s}`);
  }
  if (s === 'NaN' || s === 'Infinity') {
    throw new RangeError(`usd must be finite, got ${s}`);
  }

  // Fixed notation only: optional digits, optional `.`, optional digits.
  // Reject empty, lone `.`, and anything containing non-digit/non-dot characters.
  const match = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!match || (match[1] === '' && (match[2] === undefined || match[2] === ''))) {
    throw new SyntaxError(`invalid usd value: ${JSON.stringify(usd)}`);
  }

  const intPart = match[1] || '0';
  const fracPart = match[2] ?? '';

  // Fractional shorter than (or equal to) decimals: pad with trailing zeros, return exact.
  if (fracPart.length <= decimals) {
    return BigInt(intPart + fracPart.padEnd(decimals, '0'));
  }

  // Fractional longer than decimals: truncate to `decimals` digits, then round-half-up
  // via the next-position digit. A digit ≥ '5' rounds the combined value up by 1;
  // matches Python's Decimal ROUND_HALF_UP semantics for non-negative inputs.
  const kept = fracPart.slice(0, decimals);
  const roundDigit = fracPart[decimals];
  let result = BigInt(intPart + kept);
  if (roundDigit >= '5') {
    result += 1n;
  }
  return result;
}

/**
 * Format an integer cent amount as a fixed-2-decimal USD string.
 *
 * `formatUsdCents(500)` returns `"5.00"`. Negative values are formatted with a
 * leading minus. Use everywhere a merchant emits `(cents / 100).toFixed(2)`;
 * consistent formatting across catalog rows, order responses, and 402 bodies
 * prevents agent-side string-comparison flakiness.
 *
 * `decimals` controls the dollar-precision of the output and defaults to `2`
 * (canonical USD cents). Raise it for sub-cent unit pricing — e.g.
 * `formatUsdCents(0.05, 4)` returns `"0.0005"` for a half-of-one-millicent
 * amount. The `cents` input is allowed to be fractional so per-token /
 * per-byte pricing models can compute `priceCents = unitPriceCents × n`
 * without rounding before reaching the formatter.
 */
export function formatUsdCents(cents: number, decimals = 2): string {
  return (cents / 100).toFixed(decimals);
}
