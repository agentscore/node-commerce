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
  return null;
}
