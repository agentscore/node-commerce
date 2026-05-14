/**
 * Multi-rail payment header bundle — one call composes both `WWW-Authenticate` (the
 * `paymentauth.org` Payment directives) and the standard x402 `PAYMENT-REQUIRED` header
 * from a single rails declaration. Reduces ~10 lines of merchant boilerplate per 402
 * response.
 *
 * Layered on top of `paymentDirective` / `wwwAuthenticateHeader` / `paymentRequiredHeader`
 * — those primitives stay exposed for vendors who want full control.
 */

import { buildPaymentDirective } from './directive';
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
export function buildPaymentHeaders({
  rails,
  orderId,
  realm,
  x402,
}: {
  /** Rails the merchant accepts on this 402. Each becomes one `Payment` directive. */
  rails: PaymentHeadersRail[];
  /** Order id used as the directive challenge id (per-rail it becomes `${orderId}-${rail}`). */
  orderId: string;
  /** Realm — the host of the merchant URL (e.g. `agents.merchant.example`). */
  realm: string;
  /**
   * Optional x402 `accepts` array — included as the standard PAYMENT-REQUIRED header so
   * x402 clients (`@x402/fetch`, `@x402/core` HTTPClient, `agentscore-pay`) can parse the
   * base64-encoded JSON form instead of the WWW-Authenticate text directives. Pass
   * `undefined` (or omit) to skip the PAYMENT-REQUIRED header.
   */
  x402?: { accepts: unknown[]; version?: 1 | 2; resource?: { url: string; mimeType?: string } };
}): PaymentHeadersResult {
  const directives = rails.map((rail) =>
    buildPaymentDirective({
      id: `${orderId}-${rail.rail}`,
      realm,
      rail: rail.rail,
      amountUsd: rail.amountUsd,
      ...(rail.recipient !== undefined ? { recipient: rail.recipient } : {}),
      ...(rail.networkId !== undefined ? { networkId: rail.networkId } : {}),
      ...(rail.chainId !== undefined ? { chainId: rail.chainId } : {}),
      ...(rail.currency !== undefined ? { currency: rail.currency } : {}),
      ...(rail.decimals !== undefined ? { decimals: rail.decimals } : {}),
      ...(rail.method !== undefined ? { method: rail.method } : {}),
      ...(rail.intent !== undefined ? { intent: rail.intent } : {}),
      ...(rail.expires !== undefined ? { expires: rail.expires } : {}),
    }),
  );

  const result: PaymentHeadersResult = {
    'www-authenticate': wwwAuthenticateHeader(directives),
  };

  if (x402) {
    result['PAYMENT-REQUIRED'] = paymentRequiredHeader({
      x402Version: x402.version ?? 2,
      accepts: x402.accepts,
      ...(x402.resource ? { resource: x402.resource } : {}),
    });
  }

  return result;
}
