/**
 * Cross-module typed errors.
 *
 * Lives in its own module so `payment/` and `stripe-multichain/` helpers can
 * throw `CheckoutValidationError` without importing from `checkout.ts` — this
 * also sidesteps tsup's per-entry class duplication.
 *
 * Re-exported from `checkout.ts` and the top-level entry to preserve the
 * public import path.
 */

/**
 * Raised to short-circuit a Checkout flow with a 4xx/5xx envelope. The
 * framework catches this at request-flow boundaries (`preValidate`, recipient
 * minting, settlement dispatch) and emits `{ error, next_steps }` via
 * `buildValidationError` so merchants don't construct response bodies
 * themselves.
 */
export class CheckoutValidationError extends Error {
  readonly code: string;
  readonly action: string;
  readonly status: number;
  readonly extra: Record<string, unknown> | undefined;
  constructor(opts: {
    code: string;
    message: string;
    action?: string;
    status?: number;
    extra?: Record<string, unknown>;
  }) {
    super(opts.message);
    this.name = 'CheckoutValidationError';
    this.code = opts.code;
    this.action = opts.action ?? 'fix_request';
    this.status = opts.status ?? 400;
    this.extra = opts.extra;
  }
}
