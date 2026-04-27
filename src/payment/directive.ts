import { lookupRail } from './rails';

export interface PaymentRequestInput {
  /** Symbolic rail name (e.g., 'tempo-mainnet', 'x402-base-mainnet') — fills in defaults */
  rail?: string;
  /** Amount in USD as a number or string. Converted to raw integer using `decimals`. */
  amountUsd: string | number;
  /** Token contract address or currency code. Defaults from rail. */
  currency?: string;
  /** Decimal precision for the amount. Defaults from rail (6 for USDC, 2 for USD). */
  decimals?: number;
  /** Recipient address (on-chain). Optional for stripe-style rails. */
  recipient?: string;
  /** EVM chain ID (goes into methodDetails.chainId). Defaults from rail. */
  chainId?: number;
  /** Stripe profile_id or similar (goes into methodDetails.networkId — note camelCase per link-cli's mpp decode validator). */
  networkId?: string;
}

/**
 * Build the base64-encoded `request` blob for an MPP Payment directive (per the
 * paymentauth.org spec). Output shape matches what link-cli `mpp decode` expects:
 *
 *   { amount: "<raw_integer>", currency: "<token>", recipient?: "<addr>",
 *     methodDetails?: { chainId?: number, networkId?: string } }
 */
export function buildPaymentRequestBlob(input: PaymentRequestInput): string {
  const railDef = input.rail ? lookupRail(input.rail) : undefined;
  const decimals = input.decimals ?? railDef?.decimals ?? 6;
  const currency = input.currency ?? railDef?.currency ?? 'usd';
  const chainId = input.chainId ?? railDef?.chainId;

  const amountNum = typeof input.amountUsd === 'string' ? Number(input.amountUsd) : input.amountUsd;
  const amountRaw = BigInt(Math.round(amountNum * 10 ** decimals)).toString();
  const blob: Record<string, unknown> = { amount: amountRaw, currency, decimals };
  if (input.recipient) blob.recipient = input.recipient;
  const methodDetails: Record<string, unknown> = {};
  if (chainId !== undefined) methodDetails.chainId = chainId;
  if (input.networkId) methodDetails.networkId = input.networkId;
  if (Object.keys(methodDetails).length > 0) blob.methodDetails = methodDetails;
  return Buffer.from(JSON.stringify(blob)).toString('base64url');
}

export interface PaymentDirectiveInput {
  /** Symbolic rail name — sets `method` automatically */
  rail?: string;
  /** Challenge id (unique per request, used to correlate retries) */
  id: string;
  /** Realm — the host of the merchant URL (e.g., "agents.merchant.example") */
  realm: string;
  /** MPP method name. Defaults from rail (e.g., 'tempo', 'stripe'). */
  method?: string;
  /** MPP intent. Defaults to 'charge'. */
  intent?: string;
  /** ISO-8601 expiry timestamp. Defaults to now + 5 minutes. */
  expires?: string;
  /** Base64-encoded request blob. Pass the result of buildPaymentRequestBlob. */
  request: string;
}

/**
 * Format an MPP Payment directive string for the WWW-Authenticate header.
 * Output shape: `Payment id="...", realm="...", method="...", intent="charge",
 *                expires="...", request="<base64>"`
 */
export function paymentDirective(input: PaymentDirectiveInput): string {
  const railDef = input.rail ? lookupRail(input.rail) : undefined;
  const method = input.method ?? railDef?.method ?? 'unknown';
  const intent = input.intent ?? 'charge';
  const expires = input.expires ?? new Date(Date.now() + 5 * 60 * 1000).toISOString();
  return `Payment id="${input.id}", realm="${input.realm}", method="${method}", intent="${intent}", expires="${expires}", request="${input.request}"`;
}

export interface BuildPaymentDirectiveInput
  extends Omit<PaymentRequestInput, 'rail'>,
    Omit<PaymentDirectiveInput, 'request'> {
  rail: string;
}

/**
 * Convenience: build the request blob and the directive in one call. Most vendors
 * want this rather than the two-step form.
 */
export function buildPaymentDirective(input: BuildPaymentDirectiveInput): string {
  const request = buildPaymentRequestBlob({
    rail: input.rail,
    amountUsd: input.amountUsd,
    currency: input.currency,
    decimals: input.decimals,
    recipient: input.recipient,
    chainId: input.chainId,
    networkId: input.networkId,
  });
  return paymentDirective({
    rail: input.rail,
    id: input.id,
    realm: input.realm,
    method: input.method,
    intent: input.intent,
    expires: input.expires,
    request,
  });
}
