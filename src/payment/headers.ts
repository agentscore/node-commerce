/**
 * Multi-rail payment header bundle — one call composes both `WWW-Authenticate` (the
 * `paymentauth.org` Payment directives) and the standard x402 `PAYMENT-REQUIRED` header
 * from a single rails declaration. Reduces ~10 lines of merchant boilerplate per 402
 * response.
 *
 * Layered on top of `paymentDirective` / `wwwAuthenticateHeader` / `paymentRequiredHeader`
 * — those primitives stay exposed for vendors who want full control.
 */

import { buildPaymentDirective, type BuildPaymentDirectiveInput } from './directive';
import { paymentRequiredHeader, wwwAuthenticateHeader } from './wwwauthenticate';

export interface PaymentHeadersRail {
  /** Symbolic rail name — `tempo-mainnet`, `x402-base-mainnet`, `stripe`, etc. */
  rail: string;
  /** Amount in USD as a number or string. */
  amountUsd: string | number;
  /** Recipient address (on-chain) — required for crypto rails. */
  recipient?: string;
  /** Stripe profile_id / network_id — required for `stripe` rail. */
  networkId?: string;
  /** EVM chain id override — usually inferred from rail. */
  chainId?: number;
  /** Token contract / currency override — usually inferred from rail. */
  currency?: string;
  /** Decimal precision override — usually inferred from rail (USDC=6, etc.). */
  decimals?: number;
  /** MPP method override — usually inferred from rail. */
  method?: string;
  /** MPP intent. Default `charge`. */
  intent?: string;
  /** ISO-8601 expiry. Default now + 5 min. */
  expires?: string;
}

export interface BuildPaymentHeadersInput {
  /** Rails the merchant accepts on this 402. Each becomes one `Payment` directive. */
  rails: PaymentHeadersRail[];
  /** Order id used as the directive challenge id (per-rail it becomes `${orderId}-${rail}`). */
  orderId: string;
  /** Realm — the host of the merchant URL (e.g. `agents.merchant.example`). */
  realm: string;
  /**
   * Optional x402 `accepts` array — included as the standard PAYMENT-REQUIRED header so
   * x402 clients (`@x402/fetch`, `@x402/core` HTTPClient, `agentscore-pay`) can parse the
   * binary-friendly format instead of the legacy WWW-Authenticate text. Pass `undefined`
   * (or omit) to skip the PAYMENT-REQUIRED header.
   */
  x402?: { accepts: unknown[]; version?: 1 | 2; resource?: { url: string; mimeType?: string } };
}

export interface PaymentHeadersResult {
  'www-authenticate': string;
  'PAYMENT-REQUIRED'?: string;
}

/**
 * Compose `WWW-Authenticate` (multi-directive) and `PAYMENT-REQUIRED` (x402 base64) headers
 * from a single rails declaration. Returns an object suitable for spreading into a
 * `Headers` constructor or the `headers` field of a `Response`.
 *
 * Example:
 * ```ts
 * const headers = buildPaymentHeaders({
 *   orderId: 'ord_123',
 *   realm: 'agents.merchant.example',
 *   rails: [
 *     { rail: 'tempo-mainnet', amountUsd: 25, recipient: TEMPO_ADDR },
 *     { rail: 'x402-base-mainnet', amountUsd: 25, recipient: BASE_ADDR },
 *     { rail: 'stripe', amountUsd: 25, networkId: STRIPE_PROFILE_ID },
 *   ],
 *   x402: { accepts: x402Accepts, version: 1 },
 * });
 * return new Response(JSON.stringify(body), { status: 402, headers });
 * ```
 */
export function buildPaymentHeaders(input: BuildPaymentHeadersInput): PaymentHeadersResult {
  const directives = input.rails.map((rail) => {
    const directiveInput: BuildPaymentDirectiveInput = {
      id: `${input.orderId}-${rail.rail}`,
      realm: input.realm,
      rail: rail.rail,
      amountUsd: rail.amountUsd,
    };
    if (rail.recipient !== undefined) directiveInput.recipient = rail.recipient;
    if (rail.networkId !== undefined) directiveInput.networkId = rail.networkId;
    if (rail.chainId !== undefined) directiveInput.chainId = rail.chainId;
    if (rail.currency !== undefined) directiveInput.currency = rail.currency;
    if (rail.decimals !== undefined) directiveInput.decimals = rail.decimals;
    if (rail.method !== undefined) directiveInput.method = rail.method;
    if (rail.intent !== undefined) directiveInput.intent = rail.intent;
    if (rail.expires !== undefined) directiveInput.expires = rail.expires;
    return buildPaymentDirective(directiveInput);
  });

  const result: PaymentHeadersResult = {
    'www-authenticate': wwwAuthenticateHeader(directives),
  };

  if (input.x402) {
    result['PAYMENT-REQUIRED'] = paymentRequiredHeader({
      x402Version: input.x402.version ?? 1,
      accepts: input.x402.accepts,
      ...(input.x402.resource ? { resource: input.x402.resource } : {}),
    });
  }

  return result;
}
