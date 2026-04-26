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
 * Encode the standard x402 PAYMENT-REQUIRED header (base64-encoded JSON of the
 * PaymentRequired object). Clients that recognize the header (`@x402/fetch`,
 * `@x402/core` HTTPClient, `agentscore-pay`) prefer it over body fields.
 */
export function paymentRequiredHeader(input: PaymentRequiredHeaderInput): string {
  return Buffer.from(JSON.stringify(input)).toString('base64');
}
