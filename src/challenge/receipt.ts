/**
 * Canonical receipt shape returned to agents on the 200 after settlement.
 *
 * Universal across vendor types: goods merchants populate the shipping +
 * fulfillment slots, API merchants populate only the core fields (id,
 * created_at, pricing, payment_status, next_steps). All goods-only fields are
 * optional.
 *
 * Merchants own their order schema, but converging on this shape across
 * AgentScore-gated merchants means agents can render and post-process receipts
 * consistently regardless of whether the seller ships product or returns API
 * output. Lift this type, fill the fields you care about, and ignore (or
 * extend via `extras`) what you don't.
 *
 * All money fields are dollar-strings (e.g. `"250.00"`). Use
 * `buildPricingBlock` from `@agent-score/commerce/challenge` to compose the
 * pricing fields from cents.
 */

import type { PricingBlock } from './pricing';

export interface Receipt {
  /** Stable receipt id; order UUID for goods, request id for API merchants. */
  id: string;
  /** ISO-8601 timestamp of settlement. */
  created_at: string;
  /** Goods: units purchased. API: usage count (calls, tokens, requests). */
  quantity?: number;
  /** Goods-shaped product info. Omit for API merchants (per-call billing has no product concept). */
  product?: {
    id?: string;
    name?: string;
    slug?: string;
  };
  /** Pricing block; same shape as the 402 advertised. Use `buildPricingBlock` to compose. */
  pricing?: PricingBlock;
  /** Buyer email if provided. */
  email?: string;
  /** Payment status; typically `"completed"`, `"pending"`, `"failed"`. */
  payment_status?: string;
  /** Goods-only. Typically `"pending"`, `"shipped"`, `"delivered"`, `"cancelled"`. */
  fulfillment_status?: string;
  /** Goods-only. Carrier tracking number when fulfillment_status >= shipped. */
  tracking_number?: string | null;
  /** Goods-only. Omit for digital goods, services, or API receipts. */
  shipping?: {
    name?: string;
    address_1?: string;
    address_2?: string | null;
    city?: string;
    state?: string;
    zip?: string;
    country?: string;
  };
  /** Goods-only. Omit for API receipts. */
  gift_note?: string | null;
  /** Vendor-specific extras merged at the top level (loyalty points, warranty, per-call usage breakdown, etc.). */
  extras?: Record<string, unknown>;
  /** Next-steps block guiding the agent post-settlement. `order_status_url` works for both: goods → order detail route, API → usage / billing dashboard. `fulfillment_eta` is goods-only. */
  next_steps?: {
    user_message?: string;
    order_status_url?: string;
    fulfillment_eta?: string;
    [key: string]: unknown;
  };
}
