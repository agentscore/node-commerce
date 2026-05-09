import { describe, expect, it } from 'vitest';
import {
  agentscoreSecuritySchemes,
  agentscoreDenialSchemas,
  agentscorePaymentRequiredSchema,
  agentscoreOpenApiSnippets,
  siwxSecurityScheme,
  xPaymentInfoExtension,
  xGuidanceExtension,
} from '../../src/discovery/openapi';

describe('agentscoreSecuritySchemes', () => {
  it('exports the two AgentScore identity headers as apiKey schemes', () => {
    const schemes = agentscoreSecuritySchemes();
    expect(schemes.OperatorToken).toMatchObject({ type: 'apiKey', in: 'header', name: 'X-Operator-Token' });
    expect(schemes.WalletAddress).toMatchObject({ type: 'apiKey', in: 'header', name: 'X-Wallet-Address' });
  });

  it('includes the x402scan-spec siwx scheme', () => {
    const schemes = agentscoreSecuritySchemes();
    expect(schemes.siwx).toMatchObject({ type: 'http', scheme: 'bearer', bearerFormat: 'SIWX' });
  });
});

describe('siwxSecurityScheme', () => {
  it('returns an http bearer scheme with bearerFormat=SIWX', () => {
    const scheme = siwxSecurityScheme();
    expect(scheme).toMatchObject({ type: 'http', scheme: 'bearer', bearerFormat: 'SIWX' });
  });
});

describe('xPaymentInfoExtension', () => {
  it('emits fixed-mode price wrapped under x-payment-info', () => {
    const ext = xPaymentInfoExtension({
      price: { mode: 'fixed', currency: 'USD', amount: '0.10' },
      protocols: [{ x402: {} }],
    });
    expect(ext['x-payment-info'].price).toEqual({ mode: 'fixed', currency: 'USD', amount: '0.10' });
    expect(ext['x-payment-info'].protocols).toEqual([{ x402: {} }]);
  });

  it('emits dynamic-mode price + multi-protocol entries', () => {
    const ext = xPaymentInfoExtension({
      price: { mode: 'dynamic', currency: 'USD', min: '0.01', max: '5.00' },
      protocols: [
        { x402: {} },
        { mpp: { method: 'tempo/charge', intent: 'pay', currency: 'USD' } },
      ],
    });
    expect(ext['x-payment-info'].price).toMatchObject({ mode: 'dynamic', min: '0.01', max: '5.00' });
    expect(ext['x-payment-info'].protocols).toHaveLength(2);
  });
});

describe('xGuidanceExtension', () => {
  it('wraps a string under x-guidance', () => {
    expect(xGuidanceExtension('Use POST /purchase with X-Operator-Token...')).toEqual({
      'x-guidance': 'Use POST /purchase with X-Operator-Token...',
    });
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

  it('emits only paymentRequired schema when denials=false', () => {
    // Drives the falsey side of `opts.denials !== false ? agentscoreDenialSchemas() : {}`.
    const snippets = agentscoreOpenApiSnippets({ denials: false });
    expect(snippets.schemas).toBeDefined();
    expect(snippets.schemas).toHaveProperty('AgentScorePaymentRequired');
    expect(snippets.schemas).not.toHaveProperty('AgentScoreDenialReason');
    expect(snippets.schemas).not.toHaveProperty('AgentScoreDenialBody');
  });

  it('emits only denial schemas when paymentRequired=false', () => {
    // Drives the falsey side of `opts.paymentRequired !== false ? agentscorePaymentRequiredSchema() : {}`.
    const snippets = agentscoreOpenApiSnippets({ paymentRequired: false });
    expect(snippets.schemas).toBeDefined();
    expect(snippets.schemas).toHaveProperty('AgentScoreDenialReason');
    expect(snippets.schemas).toHaveProperty('AgentScoreDenialBody');
    expect(snippets.schemas).not.toHaveProperty('AgentScorePaymentRequired');
  });
});
