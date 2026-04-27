import * as sdk from '@agent-score/sdk';
import { describe, expect, it } from 'vitest';
import * as commerceApi from '../../src/api';

describe('@agent-score/commerce/api re-export', () => {
  it('re-exports the AgentScore client class', () => {
    expect(commerceApi.AgentScore).toBeDefined();
    expect(typeof commerceApi.AgentScore).toBe('function');
    const client = new commerceApi.AgentScore({ apiKey: 'as_test_xxx' });
    expect(client).toBeDefined();
  });

  it('re-exports the AgentScoreError class', () => {
    expect(commerceApi.AgentScoreError).toBeDefined();
    expect(typeof commerceApi.AgentScoreError).toBe('function');
  });

  it('re-exports the webhook signature verifier as the same function', () => {
    expect(commerceApi.verifyWebhookSignature).toBe(sdk.verifyWebhookSignature);
  });

  it('re-exports the test-mode address helpers as the same references', () => {
    expect(commerceApi.AGENTSCORE_TEST_ADDRESSES).toBe(sdk.AGENTSCORE_TEST_ADDRESSES);
    expect(commerceApi.isAgentScoreTestAddress).toBe(sdk.isAgentScoreTestAddress);
  });
});
