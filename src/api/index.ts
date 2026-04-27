/**
 * AgentScore SDK re-export — vendors install only `@agent-score/commerce` and reach
 * everything from the underlying `@agent-score/sdk` here. Don't add `@agent-score/sdk`
 * as a separate dep; the two can drift versions and cause subtle type mismatches.
 *
 * Use this for: programmatic API calls (sessions, credentials, reputation), webhook
 * signature verification on inbound AgentScore webhooks, and the test-mode address
 * fixtures for integration tests.
 */
export {
  AGENTSCORE_TEST_ADDRESSES,
  AgentScore,
  AgentScoreError,
  isAgentScoreTestAddress,
  verifyWebhookSignature,
  type VerifyWebhookSignatureInput,
  type VerifyWebhookSignatureResult,
} from '@agent-score/sdk';
