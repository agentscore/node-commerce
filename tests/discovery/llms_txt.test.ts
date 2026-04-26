import { describe, expect, it } from 'vitest';
import { buildLlmsTxt, llmsTxtIdentitySection, llmsTxtPaymentSection } from '../../src/discovery/llms_txt';

describe('llmsTxtIdentitySection', () => {
  it('returns empty string when agentscore is not enabled', () => {
    expect(llmsTxtIdentitySection()).toBe('');
    expect(llmsTxtIdentitySection({ agentscore: false })).toBe('');
  });

  it('returns the standard wallet vs operator-token explanation when enabled', () => {
    const section = llmsTxtIdentitySection({ agentscore: true });
    expect(section).toContain('## Choose your identity header');
    expect(section).toContain('X-Wallet-Address');
    expect(section).toContain('X-Operator-Token');
    expect(section).toContain('cross-merchant');
  });

  it('appends compliance summary when provided', () => {
    const section = llmsTxtIdentitySection({
      agentscore: true,
      compliance: { require_kyc: true, min_age: 21, allowed_jurisdictions: ['US'] },
    });
    expect(section).toContain('Compliance');
    expect(section).toContain('KYC required');
    expect(section).toContain('age 21+');
    expect(section).toContain('US only');
  });
});

describe('llmsTxtPaymentSection', () => {
  it('only emits sections for the rails configured', () => {
    const section = llmsTxtPaymentSection({
      rails: ['tempo-mainnet', 'x402-base-mainnet'],
      appUrl: 'https://merchant.example',
    });
    expect(section).toContain('Tempo USDC');
    expect(section).toContain('x402 USDC on Base');
    expect(section).not.toContain('x402 USDC on Solana');
    expect(section).not.toContain('Stripe Shared Payment Token');
  });

  it('includes Stripe + link-cli when stripe-spt is configured', () => {
    const section = llmsTxtPaymentSection({ rails: ['stripe-spt'], appUrl: 'https://x' });
    expect(section).toContain('Stripe Shared Payment Token');
    expect(section).toContain('link-cli');
  });

  it('embeds the merchant URL in command examples', () => {
    const section = llmsTxtPaymentSection({ rails: ['tempo-mainnet'], appUrl: 'https://my.merchant' });
    expect(section).toContain('https://my.merchant');
  });

  describe('verbose mode', () => {
    it('emits multi-step setup + full command examples per rail', () => {
      const section = llmsTxtPaymentSection({
        rails: ['tempo-mainnet', 'x402-base-mainnet'],
        appUrl: 'https://my.merchant',
        verbose: true,
        tempoNetworkName: 'tempo-mainnet',
        tempoChainId: 4217,
      });
      expect(section).toContain('### How to pay with Tempo');
      expect(section).toContain('curl -fsSL https://tempo.xyz/install');
      expect(section).toContain('tempo wallet login');
      expect(section).toContain('tempo wallet whoami');
      expect(section).toContain('USDC.e on tempo-mainnet, chain 4217');
      expect(section).toContain('tempo request -X POST');
      expect(section).toContain('### How to pay with x402');
      expect(section).toContain('npm install -g @agent-score/pay');
      expect(section).toContain('agentscore-pay wallet create');
      expect(section).toContain('https://my.merchant');
    });

    it('omits sections for rails not configured', () => {
      const section = llmsTxtPaymentSection({
        rails: ['tempo-mainnet'],
        appUrl: 'https://x',
        verbose: true,
      });
      expect(section).toContain('Tempo USDC');
      expect(section).not.toContain('### How to pay with x402');
      expect(section).not.toContain('### How to pay with Stripe');
    });

    it('emits the exact-amount warning when x402 rails are configured', () => {
      const section = llmsTxtPaymentSection({
        rails: ['x402-base-mainnet'],
        appUrl: 'https://x',
        verbose: true,
      });
      expect(section).toContain('exact amount specified in the 402 challenge');
    });

    it('emits the Stripe SPT block when stripe-spt is configured', () => {
      const section = llmsTxtPaymentSection({
        rails: ['stripe-spt'],
        appUrl: 'https://x',
        verbose: true,
      });
      expect(section).toContain('### How to pay with Stripe SPT');
      expect(section).toContain('SharedPaymentToken');
    });

    it('handles solana-only without base', () => {
      const section = llmsTxtPaymentSection({
        rails: ['x402-solana-mainnet'],
        appUrl: 'https://x',
        verbose: true,
      });
      expect(section).toContain('### How to pay with x402 (Solana)');
      expect(section).toContain('--chain solana');
      expect(section).not.toContain('--chain base');
    });
  });
});

describe('buildLlmsTxt', () => {
  it('assembles a minimal document with title + custom sections', () => {
    const doc = buildLlmsTxt({
      merchantName: 'Acme',
      tagline: 'Best widgets',
      sections: [{ heading: 'Endpoints', content: 'GET /widgets' }],
    });
    expect(doc).toContain('# Acme');
    expect(doc).toContain('> Best widgets');
    expect(doc).toContain('## Endpoints');
    expect(doc).toContain('GET /widgets');
  });

  it('appends AgentScore identity + payment sections when configured', () => {
    const doc = buildLlmsTxt({
      merchantName: 'Acme',
      sections: [],
      agentscoreIdentity: { agentscore: true },
      payment: { rails: ['tempo-mainnet'], appUrl: 'https://acme.example' },
    });
    expect(doc).toContain('## Choose your identity header');
    expect(doc).toContain('## Payment');
  });
});
