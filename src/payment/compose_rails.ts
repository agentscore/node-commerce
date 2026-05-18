/** Builder for the `compose(...intents)` array passed to mppx in a merchant's
 *  custom `composeMppx` hook. Replaces the hand-rolled `composeRails`
 *  assembly that recurs verbatim across every multi-rail merchant (sayer,
 *  martin, sandbox).
 *
 *  The intent shape is mppx-protocol-shaped; this helper just spares callers
 *  from re-typing the same atomic-conversion + per-rail object literal.
 */

import { usdToAtomic } from './amounts';
import { USDC } from './usdc';

export interface BuildMppxComposeRailsOptions {
  /** USD price string (e.g. `'1.50'`). Tempo + Stripe consume it verbatim;
   *  Solana converts to atomic units (`bigint`) per its scheme. */
  amountUsd: string;
  /** Tempo recipient address. When omitted, the `tempo/charge` intent is
   *  not emitted (e.g., merchant with no Tempo rail configured). */
  tempoRecipient?: string;
  /** Tempo USDC contract address. Defaults to USDC.tempo.mainnet.address. */
  tempoTokenAddress?: string;
  /** Solana recipient address. When omitted, the `solana/charge` intent is
   *  not emitted (e.g., per-order Stripe-multichain merchant that didn't
   *  mint a Solana deposit address). */
  solanaRecipient?: string;
  /** Solana USDC mint. Defaults to USDC.solana.mainnet.mint. */
  solanaTokenMint?: string;
  /** Solana CAIP-2 network. Defaults to mainnet-beta. */
  solanaNetwork?: string;
  /** Include the `stripe/charge` intent (Stripe SPT rail). Default `true`. */
  includeStripe?: boolean;
}

/** Build the `compose(...intents)` argument array. Order matches mppx's
 *  preferred ordering: tempo first (cheapest), then solana, then stripe.
 *
 *  Throws when Solana is requested but `amountUsd` can't convert to atomic
 *  (e.g., empty string, NaN); merchants should catch and return `{status: 402}`
 *  to drop the rail rather than crash the request.
 */
export function buildMppxComposeRails(opts: BuildMppxComposeRailsOptions): unknown[] {
  const rails: unknown[] = [];
  if (opts.tempoRecipient) {
    rails.push(['tempo/charge', {
      amount: opts.amountUsd,
      currency: opts.tempoTokenAddress ?? USDC.tempo.mainnet.address,
      decimals: 6,
      recipient: opts.tempoRecipient,
    }]);
  }
  if (opts.solanaRecipient) {
    const atomic = usdToAtomic(opts.amountUsd, { decimals: 6 });
    rails.push(['solana/charge', {
      amount: atomic.toString(),
      currency: opts.solanaTokenMint ?? USDC.solana.mainnet.mint,
      decimals: 6,
      recipient: opts.solanaRecipient,
      network: opts.solanaNetwork ?? 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    }]);
  }
  if (opts.includeStripe !== false) {
    rails.push(['stripe/charge', { amount: opts.amountUsd, currency: 'usd', decimals: 2 }]);
  }
  return rails;
}
