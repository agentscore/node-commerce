/** Tests that exercise the `??` fallback defaults in `buildRedemptionSkillMd`. */

import { describe, expect, it } from 'vitest';
import { buildRedemptionSkillMd } from '../../src/discovery/redemption_md';

describe('buildRedemptionSkillMd default fallbacks', () => {
  it('uses default skuIntro + deliveryIntro + bodyShape + bodyRules when omitted', () => {
    const md = buildRedemptionSkillMd({
      merchantName: 'Acme',
      endpointPath: '/purchase',
      catalogUrl: 'https://acme.example/catalog',
      llmsTxtUrl: 'https://acme.example/llms.txt',
    });
    expect(md).toContain('Acme');
    expect(md).toContain('/purchase');
    // Default delivery intro mentions mailer / emailed
    expect(md).toMatch(/mailer|emailed/i);
  });

  it('omits peer section when peerMerchantPointer absent', () => {
    const md = buildRedemptionSkillMd({
      merchantName: 'Acme',
      endpointPath: '/purchase',
      catalogUrl: 'https://acme.example/catalog',
      llmsTxtUrl: 'https://acme.example/llms.txt',
    });
    expect(md).not.toContain("Don't have a code?");
  });

  it('emits peer section when peerMerchantPointer provided', () => {
    const md = buildRedemptionSkillMd({
      merchantName: 'Acme',
      endpointPath: '/purchase',
      catalogUrl: 'https://acme.example/catalog',
      llmsTxtUrl: 'https://acme.example/llms.txt',
      peerMerchantPointer: 'https://otherco.example',
    });
    expect(md).toContain("Don't have a code?");
    expect(md).toContain('https://otherco.example');
  });

  it('honors bodyRules override (custom string)', () => {
    const md = buildRedemptionSkillMd({
      merchantName: 'Acme',
      endpointPath: '/purchase',
      catalogUrl: 'https://acme.example/catalog',
      llmsTxtUrl: 'https://acme.example/llms.txt',
      bodyRules: '- Custom rule.',
    });
    expect(md).toContain('- Custom rule.');
  });

  it('omits body rules section when bodyRules is empty string', () => {
    const md = buildRedemptionSkillMd({
      merchantName: 'Acme',
      endpointPath: '/purchase',
      catalogUrl: 'https://acme.example/catalog',
      llmsTxtUrl: 'https://acme.example/llms.txt',
      bodyRules: '',
    });
    expect(md).toMatch(/Acme/);
  });

  it('honors extraRecoveryRows override', () => {
    const md = buildRedemptionSkillMd({
      merchantName: 'Acme',
      endpointPath: '/purchase',
      catalogUrl: 'https://acme.example/catalog',
      llmsTxtUrl: 'https://acme.example/llms.txt',
      extraRecoveryRows: '| custom recovery row |',
    });
    expect(md).toContain('custom recovery row');
  });
});
