export type IdentityMode = 'wallet' | 'operator_token';

export interface SignerMatchResultLike {
  kind: 'pass' | 'wallet_signer_mismatch' | 'wallet_auth_requires_wallet_signing' | string;
  expectedSigner?: string;
  actualSigner?: string;
  linkedWallets?: string[];
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
export function buildIdentityMetadata({
  mode,
  wallet,
  signerMatchResult,
  linkedWallets,
  signerConstraint,
}: {
  mode: IdentityMode;
  wallet?: string;
  signerMatchResult?: SignerMatchResultLike;
  linkedWallets?: string[];
  signerConstraint?: string;
}): IdentityMetadataBlock {
  const block: IdentityMetadataBlock = { identity_mode: mode };

  if (mode !== 'wallet') return block;

  if (wallet) {
    block.required_signer = signerMatchResult?.expectedSigner ?? wallet;
  }
  if (linkedWallets && linkedWallets.length > 0) {
    block.linked_wallets = linkedWallets;
  }
  block.signer_constraint =
    signerConstraint ??
    'Payment must be signed with the claimed wallet OR any same-operator linked wallet listed in linked_wallets.';

  return block;
}
