/**
 * Canonical order-receipt shape returned to agents on the 200 after a successful settlement.
 *
 * Merchants own their order schema, but converging on this shape across every AgentScore-gated
 * merchant (Martin Estate today; Commerce7 / WooCommerce / Shopify plugins tomorrow) means
 * agents can render and post-process orders consistently. Lift this type, fill the fields you
 * care about, and ignore (or extend via `extras`) what you don't.
 *
 * All money fields are dollar-strings (e.g. `"250.00"`). Use `buildPricingBlock` from
 * `@agent-score/commerce/challenge` to compose the pricing fields from cents.
 */

import type { PricingBlock } from './pricing';

export interface OrderReceipt {
  /** Stable order id — UUID, slug, or platform-native (Commerce7 order id, etc.). */
  id: string;
  /** ISO-8601 timestamp of order creation. */
  created_at: string;
  /** Quantity purchased. */
  quantity?: number;
  /** Product info — the agent confirmed they were buying this in the 402, surface again on receipt. */
  product?: {
    id?: string;
    name?: string;
    slug?: string;
  };
  /** Pricing block — same shape as the 402 advertised. Use `buildPricingBlock` to compose. */
  pricing?: PricingBlock;
  /** Buyer email if provided. */
  email?: string;
  /** Payment status — typically `"completed"`, `"pending"`, `"failed"`. */
  payment_status?: string;
  /** Fulfillment status — typically `"pending"`, `"shipped"`, `"delivered"`, `"cancelled"`. */
  fulfillment_status?: string;
  /** Carrier tracking number when fulfillment_status >= shipped. */
  tracking_number?: string | null;
  /** Shipping address — physical-goods merchants. Omit for digital goods. */
  shipping?: {
    name?: string;
    address_1?: string;
    address_2?: string | null;
    city?: string;
    state?: string;
    zip?: string;
    country?: string;
  };
  /** Optional gift note / order memo. */
  gift_note?: string | null;
  /** Vendor-specific extras merged at the top level (loyalty points, warranty, etc.). */
  extras?: Record<string, unknown>;
  /** Next-steps block guiding the agent on what to do post-purchase. */
  next_steps?: {
    user_message?: string;
    order_status_url?: string;
    fulfillment_eta?: string;
    [key: string]: unknown;
  };
}
