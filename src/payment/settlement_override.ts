/**
 * x402 Settlement-Overrides header helpers — used with the `upto` scheme to specify the
 * actual amount to charge after the work is done. The header is JSON-encoded and lives
 * on the merchant's response; the facilitator settles for that amount instead of the
 * advertised maximum.
 *
 * Per the x402 docs (https://docs.x402.org/getting-started/quickstart-for-sellers), the
 * amount field accepts three formats:
 *   - raw atomic units, e.g., '1000' for $0.001 USDC at 6 decimals
 *   - percentage, e.g., '50%' of the authorized maximum
 *   - dollar price, e.g., '$0.05' (converted to atomic via the network's default token)
 */

export const SETTLEMENT_OVERRIDES_HEADER = 'Settlement-Overrides';

export interface SettlementOverrides {
  /** Raw atomic units, '<n>%' percentage, or '$X.YZ' dollar price. */
  amount: string;
}

/**
 * Build a `{ name, value }` pair for the x402 Settlement-Overrides header. Vendors
 * set this on their response to direct the facilitator to settle for the actual amount
 * (used in the upto scheme flow):
 *
 *   const { name, value } = settlementOverrideHeader({ amount: '1500' });
 *   res.setHeader(name, value);  // Express
 *   c.header(name, value);       // Hono
 */
export function settlementOverrideHeader(overrides: SettlementOverrides): { name: string; value: string } {
  return { name: SETTLEMENT_OVERRIDES_HEADER, value: JSON.stringify(overrides) };
}
