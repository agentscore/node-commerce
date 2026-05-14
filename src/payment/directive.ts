import { lookupRail } from './rails';

/**
 * Build the base64-encoded `request` blob for an MPP Payment directive (per the
 * paymentauth.org spec). Output shape matches what link-cli `mpp decode` expects:
 *
 *   { amount: "<raw_integer>", currency: "<token>", recipient?: "<addr>",
 *     methodDetails?: { chainId?: number, networkId?: string } }
 */
export function buildPaymentRequestBlob({
  rail,
  amountUsd,
  currency,
  decimals,
  recipient,
  chainId,
  networkId,
}: {
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
}): string {
  const railDef = rail ? lookupRail(rail) : undefined;
  const decimalsResolved = decimals ?? railDef?.decimals ?? 6;
  const currencyResolved = currency ?? railDef?.currency ?? 'usd';
  const chainIdResolved = chainId ?? railDef?.chainId;

  const amountNum = typeof amountUsd === 'string' ? Number(amountUsd) : amountUsd;
  const amountRaw = BigInt(Math.round(amountNum * 10 ** decimalsResolved)).toString();
  const blob: Record<string, unknown> = { amount: amountRaw, currency: currencyResolved, decimals: decimalsResolved };
  if (recipient) blob.recipient = recipient;
  const methodDetails: Record<string, unknown> = {};
  if (chainIdResolved !== undefined) methodDetails.chainId = chainIdResolved;
  if (networkId) methodDetails.networkId = networkId;
  if (Object.keys(methodDetails).length > 0) blob.methodDetails = methodDetails;
  return Buffer.from(JSON.stringify(blob)).toString('base64url');
}

/**
 * Format an MPP Payment directive string for the WWW-Authenticate header.
 * Output shape: `Payment id="...", realm="...", method="...", intent="charge",
 *                expires="...", request="<base64>"`
 */
export function paymentDirective({
  rail,
  id,
  realm,
  method,
  intent,
  expires,
  request,
}: {
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
}): string {
  const railDef = rail ? lookupRail(rail) : undefined;
  const methodResolved = method ?? railDef?.method ?? 'unknown';
  const intentResolved = intent ?? 'charge';
  const expiresResolved = expires ?? new Date(Date.now() + 5 * 60 * 1000).toISOString();
  return `Payment id="${id}", realm="${realm}", method="${methodResolved}", intent="${intentResolved}", expires="${expiresResolved}", request="${request}"`;
}

/**
 * Convenience: build the request blob and the directive in one call. Most vendors
 * want this rather than the two-step form.
 */
export function buildPaymentDirective({
  rail,
  id,
  realm,
  amountUsd,
  currency,
  decimals,
  recipient,
  chainId,
  networkId,
  method,
  intent,
  expires,
}: {
  rail: string;
  id: string;
  realm: string;
  amountUsd: string | number;
  currency?: string;
  decimals?: number;
  recipient?: string;
  chainId?: number;
  networkId?: string;
  method?: string;
  intent?: string;
  expires?: string;
}): string {
  const request = buildPaymentRequestBlob({
    rail,
    amountUsd,
    currency,
    decimals,
    recipient,
    chainId,
    networkId,
  });
  return paymentDirective({
    rail,
    id,
    realm,
    method,
    intent,
    expires,
    request,
  });
}
