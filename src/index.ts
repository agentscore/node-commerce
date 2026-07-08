export type {
  AccountVerification,
  AgentIdentity,
  AgentMemoryHint,
  AgentScoreCore,
  AssessResult,
  CreateSessionOnMissing,
  DenialCode,
  DenialReason,
  EvaluateOutcome,
  OperatorVerification,
  PolicyCheck,
  PolicyResult,
  SignerVerdict,
  VerifyWalletSignerResult,
} from './core';
export { buildAgentMemoryHint } from './core';
export type { PaymentSigner, SignerNetwork } from './signer';
export {
  extractPaymentSigner,
  extractPaymentSignerFromAuth,
  extractSignerForPrecheck,
  readX402PaymentHeader,
} from './signer';
export {
  FIXABLE_DENIAL_REASONS,
  buildContactSupportNextSteps,
  buildSignerMismatchBody,
  denialReasonStatus,
  isFixableDenial,
  verificationAgentInstructions,
} from './_denial';
export { buildVerificationRequiredBody, denialReasonToBody } from './_response';
export {
  buildA2AAgentCard,
  aipA2AExtension,
  ucpA2AExtension,
  A2A_DEFAULT_TRANSPORT,
  A2A_PROTOCOL_VERSION,
  AIP_A2A_EXTENSION_URI,
  UCP_A2A_EXTENSION_URI,
  type A2AAgentCard,
  type A2AAgentCardCapabilities,
  type A2AAgentCardExtension,
  type A2AAgentCardSignature,
  type A2AAgentInterface,
  type A2AAgentProvider,
  type A2AAgentSkill,
} from './identity/a2a';
export {
  AGENTSCORE_UCP_CAPABILITY,
  type AgentScoreGatePolicy,
  buildUCPProfile,
  mppPaymentHandler,
  stripeSptPaymentHandler,
  type UCPCapabilityBinding,
  type UCPPaymentHandlerBinding,
  type UCPProfile,
  type UCPProfileBody,
  type UCPServiceBinding,
  UCPSigningKey,
  x402PaymentHandler,
} from './identity/ucp';
export {
  buildJWKSResponse,
  generateUCPSigningKey,
  type GeneratedUCPKey,
  type JWKSResponse,
  loadUCPSigningKeyFromEnv,
  type SignedUCPProfile,
  signUCPProfile,
  UCPVerificationError,
  verifyUCPProfile,
} from './identity/ucp-jwks';
export {
  type EnforcementMode,
  type GateResult,
  type IdentityStatus,
  type PolicyBlock,
  buildGateFromPolicy,
  runGateWithEnforcement,
  shippingCountryAllowed,
  shippingStateAllowed,
  validateShippingAgainstPolicy,
} from './identity/policy';
// Network-aware address normalization (EVM lowercased, Solana base58 preserved). Exported so
// consumers can normalize an X-Wallet-Address the SAME way extractOwnerScope + the gate + the
// AgentScore API do before keying owner-scoped DB lookups (e.g. orders.wallet_address).
export { normalizeAddress } from './address';
export { extractOwnerScope, hashOperatorToken, type OwnerScope } from './identity/tokens';
export { CheckoutValidationError } from './errors';
export {
  Checkout,
  type CheckoutContext,
  type CheckoutGateConfig,
  type CheckoutRailSpec,
  type CheckoutRequest,
  type CheckoutResult,
  type ComposeMppxFn,
  type DiscoveryProbeConfig,
  type GateDenial,
  type MountUcpRoutesOptions,
  type IsCachedAddressFn,
  type MppxComposeOutcome,
  type OnSettledFn,
  type PreValidateFn,
  type PricingFn,
  type PricingResult,
  type RecipientsFn,
  type ReferenceIdFn,
  type RunGateFn,
  type SettleOutcome,
  buildAipTrustedIssuers,
  getIdentityStatus,
  makeMppxComposeHook,
  pricingResult,
  validationEnvelope,
  validationResponseExpress,
  validationResponseFastify,
  validationResponseHono,
  validationResponseNextjs,
  validationResponseWeb,
} from './checkout';
// RailSpec types + payment helpers re-exported at top-level for convenience.
// Power users can still import from `./payment`.
export {
  buildDefaultCheckoutRails,
  buildMppxComposeRails,
  formatUsdCents,
  isEvmNetwork,
  isSolanaNetwork,
  loadSolanaFeePayer,
  type SolanaMppRailSpec,
  type StripeRailSpec,
  type TempoRailSpec,
  type TempoSessionRailSpec,
  type X402BaseRailSpec,
} from './payment';
export {
  computeFirstCheckout,
  type ComputeFirstHandler,
  type ComputeFirstMintContext,
  type ComputeFirstMppContext,
  type ComputeFirstOptions,
  type ComputeFirstRails,
  type ComputeFirstSettledContext,
  type ComputeFirstWorkContext,
  type MintedRecipients,
  type SuccessBodyArgs,
  type WorkOutcome,
} from './checkout_compute_first';
export {
  createQuoteCache,
  createResultCache,
  type CachedQuote,
  type QuoteCache,
  type QuoteCacheOptions,
  type ResultCache,
  type ResultCacheOptions,
} from './quote_cache';
export { createDefaultOnDenied, defaultReadOnlyOnDenied, type CreateDefaultOnDeniedOptions, type DefaultOnDeniedResult } from './identity/default_denied';
export {
  hasMppxHeader,
  hasPaymentHeader,
  hasX402Header,
  malformedPaymentCredential,
  type MalformedPaymentCredential,
} from './payment/payment_header';
// AIP (Agentic Identity Protocol) — AIT verification (verifier role) + RFC 9421 signing.
export {
  AGENT_IDENTITY_HEADER,
  verifyAit,
  type VerifiedAit,
  type VerifyAitFailure,
  type VerifyAitOptions,
  type VerifyAitResult,
  type VerifyRequestContext,
} from './aip/verify';
export {
  AIP_COVERED_COMPONENTS,
  AIP_SIGNATURE_TAG,
  MAX_POP_WINDOW_SECONDS,
  signMessage,
  verifyMessageSignature,
  type SignMessageInput,
  type VerifyFailureReason,
  type VerifyMessageSignatureInput,
  type VerifyMessageSignatureResult,
} from './aip/http-signature';
export {
  AGENTSCORE_CANONICAL_ISSUER,
  HARD_MAX_CACHE_SECONDS,
  JWKS_WELL_KNOWN_PATH,
  JwksCache,
  canonicalizeIssuer,
  type JwksCacheOptions,
  type JwksLookupResult,
} from './aip/jwks';
export {
  isAitShape,
  validateAitPayload,
  type AitHeader,
  type AitPayload,
  type AitValidationResult,
  type AmrValue,
  type IdentityClaim,
  type IntentClaim,
  type TrustLevel,
} from './aip/types';
export { buildVerifyContextFromRequest, hasAgentIdentityHeader } from './aip/request';
export {
  aipErrorCode,
  aipErrorStatus,
  buildAipErrorBody,
  buildAipWeakAuthBody,
  checkTrustRequirements,
  evaluateAipParts,
  evaluateAipRequest,
  verifyAitRequest,
  type AipErrorRequirements,
  type AipGateEvaluation,
  type AipGateOptions,
  type AipGateResult,
} from './aip/gate';
