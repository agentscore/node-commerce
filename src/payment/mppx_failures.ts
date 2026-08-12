/** Classifier for known mppx verification-failure patterns.
 *
 *  mppx's `payment.failed` event fires when an mppx rail's verify() throws.
 *  Some failures carry actionable signals — the agent's wallet isn't
 *  enrolled with Tempo's keychain, for example — that we want to surface
 *  to the client as typed error codes instead of the generic
 *  `payment_proof_invalid: regenerate`.
 *
 *  The classifier takes the failure reason string (extracted from mppx's
 *  swallowed error) and matches it against known patterns. When it
 *  matches, the merchant SDK returns the typed envelope so a CLI like
 *  `tempo request` or `agentscore-pay` can route the user to the right
 *  recovery action.
 */

export interface ClassifiedMppxFailure {
  /** Stable error code agents pattern-match on. */
  code: string;
  /** HTTP status the merchant should respond with. */
  status: number;
  /** Human-readable message. */
  message: string;
  /** Recovery hint for the agent. */
  nextSteps: { action: string; user_message: string };
  /** Optional structured passthrough (e.g., the original upstream error name). */
  extra?: Record<string, unknown>;
}

const TEMPO_KEY_NOT_REGISTERED: ClassifiedMppxFailure = {
  code: 'tempo_key_not_registered',
  status: 401,
  message:
    "Tempo rejected the transaction: signer wallet is not registered with Tempo's keychain.",
  nextSteps: {
    action: 'register_tempo_key',
    user_message:
      'Your wallet is not enrolled with Tempo. Run `tempo wallet login` to complete the one-time WebAuthn enrollment (or use `tempo request` directly), then retry. To skip enrollment, switch to the Base or Solana rail on this 402.',
  },
  extra: { upstream_error: 'KeyNotFound', chain: 'tempo' },
};

/**
 * The DANGEROUS one, and why this classifier is not just a nicety.
 *
 * `@solana/mpp` verifies a `transaction`-payload credential by BROADCASTING it
 * (`sendTransaction`, so funds move and a signature is minted) and THEN
 * awaiting confirmation in the same synchronous verify() call. When
 * confirmation times out (routine under load, since Solana status propagation
 * can lag the library's fixed 30s window even on a production RPC), verify()
 * throws `Transaction confirmation timeout` on a transaction that MAY HAVE
 * ALREADY LANDED. Left unclassified, that maps to the generic
 * `payment_proof_invalid` + `regenerate_payment_credential`: the merchant
 * tells the agent its payment was rejected and to pay AGAIN, for money that
 * already left the wallet. Observed live 2026-08-12 (an on-chain balance delta
 * with no service delivered and a "regenerate" 402 in hand).
 *
 * A confirmation timeout cannot be reliably told apart from "never landed"
 * (the recovery `getSignatureStatuses` with searchTransactionHistory lags
 * too), so the honest response is neither "success" nor "invalid, repay". It
 * is 504 with an explicit do-not-blindly-resubmit instruction: the payment was
 * submitted, its on-chain state is unconfirmed, and the buyer must check
 * whether it settled before paying a second time. x402/MPP clients version-
 * route on status; 504 (unlike 402) does not trigger an automatic
 * re-pay-with-new-credential retry, which is the whole point.
 */
const SOLANA_CONFIRMATION_TIMEOUT: ClassifiedMppxFailure = {
  code: 'payment_pending_confirmation',
  status: 504,
  message:
    'Payment was submitted on-chain but its confirmation timed out. It may have settled. Do NOT resubmit without checking first, or you risk paying twice.',
  nextSteps: {
    action: 'check_settlement_before_retry',
    user_message:
      'Your payment was broadcast to the network but confirmation timed out, so it is unconfirmed rather than failed. Check your wallet balance and the recipient before retrying: if the balance decreased, the payment likely landed and you should NOT pay again — wait for the merchant to reconcile or contact support. Only resubmit if the funds are still in your wallet.',
  },
  extra: { chain: 'solana', broadcast: true },
};

/** Classify a failure reason against known patterns.
 *
 *  Returns `null` when the reason is unrecognized — callers fall back to
 *  the generic `payment_proof_invalid` envelope. The reason argument may
 *  be the raw `Error.message`, `error.shortMessage` (viem), or any
 *  string carrying the upstream description; we substring-match.
 */
export function classifyMppxFailure(reason: string | null | undefined): ClassifiedMppxFailure | null {
  if (!reason) return null;
  const lower = reason.toLowerCase();
  if (lower.includes('keychain validation failed') || lower.includes('keynotfound')) {
    return TEMPO_KEY_NOT_REGISTERED;
  }
  // A broadcast Solana transfer whose confirmation timed out: money may have
  // moved, so this must never fall through to `regenerate_payment_credential`.
  if (lower.includes('confirmation timeout') || lower.includes('confirmation timed out')) {
    return SOLANA_CONFIRMATION_TIMEOUT;
  }
  return null;
}
