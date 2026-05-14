/**
 * Pricing block builder + canonical type.
 *
 * Composes the cents-denominated price components into the dollar-string shape that
 * 402 challenge bodies advertise. Standardizes the pricing block so every merchant
 * — current and future commerce-platform plugins (Commerce7, WooCommerce, Shopify) —
 * surfaces the same shape to agents.
 *
 * Shipping is included by default because most physical-goods merchants carry it; pass
 * `shippingCents: 0` (or omit) for digital goods / services. Tax is optional for
 * merchants outside taxable jurisdictions.
 */

export interface PricingBlock {
  /** Pre-tax, pre-shipping subtotal as a dollar-string (e.g. `"250.00"`). */
  subtotal: string;
  /** Tax amount as a dollar-string. Always present even if `"0.00"`. */
  tax: string;
  /** Shipping cost as a dollar-string. Always present even if `"0.00"`. */
  shipping?: string;
  /** Final total = subtotal + tax + shipping, dollar-string. */
  total: string;
  /** Tax rate as a decimal fraction (e.g. `0.0775` for 7.75%). Optional — omit for tax-free merchants. */
  tax_rate?: number;
  /** ISO-3166-2 state code or jurisdiction name used for tax calc. Optional. */
  tax_state?: string;
  /** ISO-4217 currency code. Default `"USD"`. */
  currency?: string;
}

/**
 * Compose a `PricingBlock` from cents-denominated inputs. Handles the cents → dollar-string
 * conversion (always 2 decimals) and computes the total when not explicitly provided.
 *
 * Example:
 * ```ts
 * const pricing = buildPricingBlock({
 *   subtotalCents: 25000,
 *   taxCents: 1875,
 *   shippingCents: 999,
 *   taxRate: 0.075,
 *   taxState: 'CA',
 * });
 * // → { subtotal: '250.00', tax: '18.75', shipping: '9.99', total: '278.74', tax_rate: 0.075, tax_state: 'CA' }
 * ```
 *
 * Pass `shippingCents: 0` for digital goods if you want the field present (it's then `"0.00"`);
 * omit entirely if you don't want shipping in the response shape at all.
 */
export function buildPricingBlock({
  subtotalCents,
  taxCents = 0,
  shippingCents,
  totalCents,
  taxRate,
  taxState,
  currency,
}: {
  subtotalCents: number;
  taxCents?: number;
  shippingCents?: number;
  totalCents?: number;
  taxRate?: number;
  taxState?: string;
  currency?: string;
}): PricingBlock {
  const shipping = shippingCents ?? 0;
  const total = totalCents ?? subtotalCents + taxCents + shipping;

  const block: PricingBlock = {
    subtotal: formatCents(subtotalCents),
    tax: formatCents(taxCents),
    total: formatCents(total),
  };

  if (shippingCents !== undefined) block.shipping = formatCents(shipping);
  if (taxRate !== undefined) block.tax_rate = taxRate;
  if (taxState !== undefined) block.tax_state = taxState;
  if (currency !== undefined) block.currency = currency;

  return block;
}

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}
