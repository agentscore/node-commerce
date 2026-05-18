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
  /** List-price subtotal as a dollar-string (e.g. `"250.00"`), pre-tax, pre-shipping, pre-discount. */
  subtotal: string;
  /** Tax amount as a dollar-string. Always present even if `"0.00"`. */
  tax: string;
  /** Shipping cost as a dollar-string. Always present even if `"0.00"`. */
  shipping?: string;
  /** Discount deducted from subtotal (redemption code, coupon, promo) as a dollar-string. Omit when no discount applied; agents reading the 402 see `subtotal`/`discount`/`total` and can render the savings line. */
  discount?: string;
  /** Final total = subtotal + tax + shipping - discount, dollar-string. Floored at 0. */
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
 * `subtotalCents` is the list price, pre-discount; `discountCents` is the deduction applied
 * (redemption code, coupon).
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
 *
 * // Redemption-code applied:
 * buildPricingBlock({ subtotalCents: 7500, discountCents: 7500 });
 * // → { subtotal: '75.00', discount: '75.00', tax: '0.00', total: '0.00' }
 * ```
 *
 * Pass `shippingCents: 0` for digital goods if you want the field present (it's then `"0.00"`);
 * omit entirely if you don't want shipping in the response shape at all. Total floors at 0
 * when discount exceeds subtotal + tax + shipping.
 */
export function buildPricingBlock({
  subtotalCents,
  taxCents = 0,
  shippingCents,
  discountCents,
  totalCents,
  taxRate,
  taxState,
  currency,
  decimals,
}: {
  subtotalCents: number;
  taxCents?: number;
  shippingCents?: number;
  discountCents?: number;
  totalCents?: number;
  taxRate?: number;
  taxState?: string;
  currency?: string;
  /** Dollar-precision for every emitted money field (default `2`). Raise for
   *  sub-cent unit pricing so `subtotal` / `total` show the real amount
   *  instead of rounding to two decimals. Subtotal/tax/total inputs become
   *  fractional cents under this mode. */
  decimals?: number;
}): PricingBlock {
  const shipping = shippingCents ?? 0;
  const discount = discountCents ?? 0;
  const total = totalCents ?? Math.max(0, subtotalCents + taxCents + shipping - discount);
  const d = decimals ?? 2;
  const fmt = (cents: number): string => (cents / 100).toFixed(d);

  const block: PricingBlock = {
    subtotal: fmt(subtotalCents),
    tax: fmt(taxCents),
    total: fmt(total),
  };

  if (shippingCents !== undefined) block.shipping = fmt(shipping);
  if (discountCents !== undefined) block.discount = fmt(discount);
  if (taxRate !== undefined) block.tax_rate = taxRate;
  if (taxState !== undefined) block.tax_state = taxState;
  if (currency !== undefined) block.currency = currency;

  return block;
}
