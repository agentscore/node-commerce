import { VERIFICATION_SESSION_HEADER, VERIFICATION_SESSION_VALUE } from '../payment/payment_header';

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

export interface IdentityBootstrapBlock {
  header: string;
  value: string;
  instructions: string;
}

/**
 * Build the `identity_bootstrap` block an identity-gated 402 carries when the request has no
 * identity header: it names the `X-Verification-Session: create` request that returns the gate's
 * session-bearing 403 (verify_url + poll data) without a payment credential. `Checkout` attaches it
 * automatically; merchants building their own 402 with `build402Body` spread it into `extra`.
 */
export function buildIdentityBootstrap(): IdentityBootstrapBlock {
  return {
    header: VERIFICATION_SESSION_HEADER,
    value: VERIFICATION_SESSION_VALUE,
    instructions:
      `This purchase requires a verified identity. Without an operator token, repeat this same request with the header ${VERIFICATION_SESSION_HEADER}: ${VERIFICATION_SESSION_VALUE} and no payment credential. ` +
      'The response is a 403 carrying verify_url, session_id, poll_secret and poll_url: give verify_url to the buyer, poll poll_url for an operator_token, then pay with X-Operator-Token set.',
  };
}
