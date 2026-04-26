import { describe, expect, it } from 'vitest';
import {
  agentscoreSecuritySchemes,
  agentscoreDenialSchemas,
  agentscorePaymentRequiredSchema,
  agentscoreOpenApiSnippets,
} from '../../src/discovery/openapi';

describe('agentscoreSecuritySchemes', () => {
  it('exports the two AgentScore identity headers as apiKey schemes', () => {
    const schemes = agentscoreSecuritySchemes();
    expect(schemes.OperatorToken).toMatchObject({ type: 'apiKey', in: 'header', name: 'X-Operator-Token' });
    expect(schemes.WalletAddress).toMatchObject({ type: 'apiKey', in: 'header', name: 'X-Wallet-Address' });
  });
});

describe('agentscoreDenialSchemas', () => {
  it('lists every denial code in the enum', () => {
    const schemas = agentscoreDenialSchemas();
    const codes = (schemas.AgentScoreDenialReason as { enum: string[] }).enum;
    expect(codes).toContain('missing_identity');
    expect(codes).toContain('token_expired');
    expect(codes).toContain('invalid_credential');
    expect(codes).toContain('wallet_signer_mismatch');
    expect(codes).toContain('wallet_auth_requires_wallet_signing');
  });

  it('exposes the AgentScoreDenialBody object schema with required fields', () => {
    const body = (agentscoreDenialSchemas() as Record<string, { required?: string[] }>).AgentScoreDenialBody;
    expect(body.required).toContain('error');
    expect(body.required).toContain('agent_instructions');
  });
});

describe('agentscorePaymentRequiredSchema', () => {
  it('exposes a 402-shape schema covering rails + identity + agent_instructions', () => {
    const schema = (agentscorePaymentRequiredSchema() as Record<string, { properties: Record<string, unknown> }>).AgentScorePaymentRequired;
    expect(schema.properties).toHaveProperty('payment_required');
    expect(schema.properties).toHaveProperty('accepted_methods');
    expect(schema.properties).toHaveProperty('identity_mode');
    expect(schema.properties).toHaveProperty('agent_instructions');
    expect(schema.properties).toHaveProperty('agent_memory');
  });
});

describe('agentscoreOpenApiSnippets', () => {
  it('returns securitySchemes + schemas by default', () => {
    const snippets = agentscoreOpenApiSnippets();
    expect(snippets.securitySchemes).toBeDefined();
    expect(snippets.schemas).toBeDefined();
  });

  it('opts can disable individual sections', () => {
    expect(agentscoreOpenApiSnippets({ security: false }).securitySchemes).toBeUndefined();
    expect(agentscoreOpenApiSnippets({ denials: false, paymentRequired: false }).schemas).toBeUndefined();
  });
});
