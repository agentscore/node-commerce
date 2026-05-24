import { describe, expect, it } from 'vitest';
import { buildLlmsTxt, llmsTxtIdentitySection, llmsTxtPaymentSection } from '../../src/discovery/llms_txt';

describe('llmsTxtIdentitySection', () => {
  it('returns empty string when agentscore is not enabled', () => {
    expect(llmsTxtIdentitySection()).toBe('');
    expect(llmsTxtIdentitySection({ agentscore: false })).toBe('');
  });

  it('returns the standard wallet vs operator-token explanation when enabled', () => {
    const section = llmsTxtIdentitySection({ agentscore: true });
    expect(section).toContain('## Identity');
    expect(section).toContain('X-Wallet-Address');
    expect(section).toContain('X-Operator-Token');
    expect(section).toContain('AgentScore');
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

  it('emits only sanctions-clear when that is the only compliance flag (other flags absent)', () => {
    // Exercises the false side of require_kyc / min_age / allowed_jurisdictions
    // and the true side of require_sanctions_clear.
    const section = llmsTxtIdentitySection({
      agentscore: true,
      compliance: { require_sanctions_clear: true },
    });
    expect(section).toContain('Compliance');
    expect(section).toContain('sanctions clear');
    expect(section).not.toContain('KYC required');
    expect(section).not.toContain('age ');
    expect(section).not.toContain(' only.');
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
    expect(section).not.toContain('USDC on Solana');
    expect(section).not.toContain('Stripe Shared Payment Token');
  });

  it('emits the Solana MPP rail line when mpp-solana-mainnet is configured', () => {
    const section = llmsTxtPaymentSection({
      rails: ['mpp-solana-mainnet'],
      appUrl: 'https://merchant.example',
    });
    expect(section).toContain('USDC on Solana');
    expect(section).toContain('--chain solana');
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
      expect(section).toContain('### Pay with Tempo');
      expect(section).toContain('curl -fsSL https://tempo.xyz/install');
      expect(section).toContain('tempo wallet login');
      expect(section).toContain('tempo wallet whoami');
      expect(section).toContain('USDC.e on tempo-mainnet (chain 4217)');
      expect(section).toContain('tempo request -X POST');
      expect(section).toContain('### Pay with Base');
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
      expect(section).toContain('USDC on Tempo');
      expect(section).not.toContain('### Pay with Base');
      expect(section).not.toContain('### Pay with Solana');
      expect(section).not.toContain('### Pay with Stripe');
    });

    it('emits the exact-amount warning when x402 rails are configured', () => {
      const section = llmsTxtPaymentSection({
        rails: ['x402-base-mainnet'],
        appUrl: 'https://x',
        verbose: true,
      });
      expect(section).toContain('exact amount in the 402 challenge');
    });

    it('labels testnet rails as Base Sepolia / Solana devnet (verbose)', () => {
      const section = llmsTxtPaymentSection({
        rails: ['x402-base-sepolia', 'mpp-solana-devnet'],
        appUrl: 'https://x',
        verbose: true,
      });
      expect(section).toContain('Base Sepolia');
      expect(section).toContain('Solana devnet');
    });

    it('emits the Stripe SPT block when stripe-spt is configured', () => {
      const section = llmsTxtPaymentSection({
        rails: ['stripe-spt'],
        appUrl: 'https://x',
        verbose: true,
      });
      expect(section).toContain('### Pay with Stripe SPT');
      expect(section).toContain('SharedPaymentToken');
    });

    it('handles solana-only via mpp-solana-mainnet', () => {
      const section = llmsTxtPaymentSection({
        rails: ['mpp-solana-mainnet'],
        appUrl: 'https://x',
        verbose: true,
      });
      expect(section).toContain('### Pay with Solana');
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
    expect(doc).toContain('## Identity');
    expect(doc).toContain('## Payment');
  });
});
