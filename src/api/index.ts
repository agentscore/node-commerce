/**
 * AgentScore API client — re-exported from `@agent-score/sdk` so vendors only need to
 * install `@agent-score/commerce` and get the API client at `/api`.
 *
 * Use this when you need to programmatically interact with the AgentScore API (mint
 * sessions in custom denial flows, fetch reputation, etc). For the common case where
 * the gate handles session minting via `createSessionOnMissing`, you don't need this.
 */
export { AgentScore, AgentScoreError } from '@agent-score/sdk';
