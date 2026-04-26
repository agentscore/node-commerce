export type IdentityMode = 'wallet' | 'operator_token';

export interface SignerMatchResultLike {
  kind: 'pass' | 'wallet_signer_mismatch' | 'wallet_auth_requires_wallet_signing' | string;
  expectedSigner?: string;
  actualSigner?: string;
  linkedWallets?: string[];
}

export interface IdentityMetadataInput {
  /** Current request's identity mode. */
  mode: IdentityMode;
  /** Claimed wallet address (when mode === 'wallet'). */
  wallet?: string;
  /** Result of a prior verifyWalletSignerMatch call. */
  signerMatchResult?: SignerMatchResultLike;
  /** Same-operator linked wallets (from assess response). */
  linkedWallets?: string[];
  /** Optional explicit constraint description (overrides the auto-generated one). */
  signerConstraint?: string;
}

export interface IdentityMetadataBlock {
  identity_mode: IdentityMode;
  required_signer?: string;
  linked_wallets?: string[];
  signer_constraint?: string;
}

/**
 * Build the identity-metadata block for an enriched 402 body. Echoes the agent's
 * identity context (wallet vs. operator-token mode) so the agent can self-correct
 * before signing — specifically, on wallet-auth rails the agent MUST sign with one
 * of the wallets in linked_wallets (all resolve to the same operator).
 */
export function buildIdentityMetadata(input: IdentityMetadataInput): IdentityMetadataBlock {
  const block: IdentityMetadataBlock = { identity_mode: input.mode };

  if (input.mode !== 'wallet') return block;

  if (input.wallet) {
    block.required_signer = input.signerMatchResult?.expectedSigner ?? input.wallet;
  }
  if (input.linkedWallets && input.linkedWallets.length > 0) {
    block.linked_wallets = input.linkedWallets;
  }
  block.signer_constraint =
    input.signerConstraint ??
    'Payment must be signed with the claimed wallet OR any same-operator linked wallet listed in linked_wallets.';

  return block;
}
