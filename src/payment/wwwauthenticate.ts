/**
 * Joins multiple Payment directives into a single WWW-Authenticate header value.
 * Per RFC 7235, multiple challenges are comma-separated.
 */
export function wwwAuthenticateHeader(directives: string[]): string {
  return directives.join(', ');
}

export interface PaymentRequiredHeaderInput {
  x402Version: 1 | 2;
  accepts: unknown[];
  resource?: { url: string; mimeType?: string };
}

/**
 * Add the v1↔v2 amount-field alias to each accepts entry. Idempotent. Used by both
 * `paymentRequiredHeader` (header emit) and `build402Body` (body emit) so every
 * x402 entry on the wire carries BOTH `amount` (v2 spec) AND `maxAmountRequired`
 * (v1 spec) — strict v1-only parsers (e.g. Coinbase awal at `payments-mcp.coinbase.com`,
 * which is hardcoded to read `maxAmountRequired`) work alongside strict v2 parsers,
 * which ignore the alias.
 */
export function aliasAmountFields(accepts: unknown[]): unknown[] {
  return accepts.map((entry) => {
    if (entry === null || typeof entry !== 'object') return entry;
    const e = entry as Record<string, unknown>;
    const hasAmount = e.amount !== undefined;
    const hasMaxAmount = e.maxAmountRequired !== undefined;
    if (hasAmount && !hasMaxAmount) return { ...e, maxAmountRequired: e.amount };
    if (hasMaxAmount && !hasAmount) return { ...e, amount: e.maxAmountRequired };
    return e;
  });
}

/**
 * Encode the standard x402 PAYMENT-REQUIRED header (base64-encoded JSON of the
 * PaymentRequired object). Clients that recognize the header (`@x402/fetch`,
 * `@x402/core` HTTPClient, `agentscore-pay`) prefer it over body fields.
 *
 * Note: do NOT add a v1↔v2 amount-field alias here. `@x402/core`'s
 * `findMatchingRequirements` uses `deepEqual` against the agent's signed
 * `accepted` payload — any field present on one side and missing on the other
 * (e.g. `maxAmountRequired` on the wire body but not in `buildPaymentRequirements`'s
 * output) makes the match silently fail at settle time. Keep `accepts` shape
 * identical to whatever `buildPaymentRequirements` produces server-side.
 */
export function paymentRequiredHeader(input: PaymentRequiredHeaderInput): string {
  return Buffer.from(JSON.stringify(input)).toString('base64');
}
