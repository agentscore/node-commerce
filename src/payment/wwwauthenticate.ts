/**
 * Joins multiple Payment directives into a single WWW-Authenticate header value.
 * Per RFC 7235, multiple challenges are comma-separated.
 */
export function wwwAuthenticateHeader(directives: string[]): string {
  return directives.join(', ');
}

/**
 * Add the v1↔v2 amount-field alias to each accepts entry. Idempotent.
 *
 * Opt-in helper: the 402 emitters (`paymentRequiredHeader` / `build402Body`) do NOT
 * call this. Strict x402 v2 settlement matches the agent's echoed requirement against
 * the server's rebuilt one by exact comparison, so an extra `maxAmountRequired` the
 * rebuild lacks silently fails settle — keep emitted `accepts` as `buildPaymentRequirements`
 * produced them. Call this only for a client hardcoded to read `maxAmountRequired`
 * regardless of `x402Version`.
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
export function paymentRequiredHeader({
  x402Version,
  accepts,
  resource,
  extensions,
}: {
  x402Version: 1 | 2;
  accepts: unknown[];
  /** x402 v2 ResourceInfo. Per spec the full resource (incl. serviceName / tags /
   *  iconUrl, used by Bazaar search/filtering) rides in the header, not just url. */
  resource?: {
    url: string;
    description?: string;
    mimeType?: string;
    serviceName?: string;
    tags?: string[];
    iconUrl?: string;
  };
  /** x402 v2 `extensions`. Per the v2 HTTP transport spec the PaymentRequired
   *  object, INCLUDING extensions, must travel in the base64 PAYMENT-REQUIRED
   *  header (where Bazaar validators read it), not only in the response body. */
  extensions?: Record<string, unknown>;
}): string {
  return Buffer.from(
    JSON.stringify({
      x402Version,
      accepts,
      ...(resource ? { resource } : {}),
      ...(extensions && Object.keys(extensions).length > 0 ? { extensions } : {}),
    }),
  ).toString('base64');
}
