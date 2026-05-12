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

export interface BuildPricingBlockInput {
  /** Pre-tax, pre-shipping subtotal in the smallest currency unit (cents, satoshi, etc.). */
  subtotalCents: number;
  /** Tax amount in the smallest currency unit. Default `0`. */
  taxCents?: number;
  /** Shipping cost in the smallest currency unit. Default `0`. */
  shippingCents?: number;
  /** Override the computed total. By default `subtotalCents + taxCents + shippingCents`. */
  totalCents?: number;
  /** Tax rate as a decimal fraction (e.g. `0.0775`). */
  taxRate?: number;
  /** Tax jurisdiction (state code, country, etc.). */
  taxState?: string;
  /** ISO-4217 currency. Default `"USD"`. */
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
export function buildPricingBlock(input: BuildPricingBlockInput): PricingBlock {
  const tax = input.taxCents ?? 0;
  const shipping = input.shippingCents ?? 0;
  const total = input.totalCents ?? input.subtotalCents + tax + shipping;

  const block: PricingBlock = {
    subtotal: formatCents(input.subtotalCents),
    tax: formatCents(tax),
    total: formatCents(total),
  };

  if (input.shippingCents !== undefined) block.shipping = formatCents(shipping);
  if (input.taxRate !== undefined) block.tax_rate = input.taxRate;
  if (input.taxState !== undefined) block.tax_state = input.taxState;
  if (input.currency !== undefined) block.currency = input.currency;

  return block;
}

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}
