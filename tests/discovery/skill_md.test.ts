import { describe, expect, it } from 'vitest';
import { buildSkillMd } from '../../src/discovery/skill_md';

describe('buildSkillMd', () => {
  const baseInput = {
    name: 'example-merchant-commerce',
    description: 'Buy from Example Merchant via an AI agent',
    homepage: 'https://example-merchant.com',
    merchantName: 'Example Merchant',
    acceptedRails: ['tempo_mpp', 'x402_base', 'solana_mpp', 'stripe'] as const,
    endpoints: [
      { method: 'GET' as const, path: '/api/v1/wines', authRequired: false, description: 'Wine catalog' },
      { method: 'POST' as const, path: '/api/v1/orders', authRequired: true, description: 'Place order' },
    ],
    triggers: ['User wants to buy from Example Merchant'],
  };

  describe('frontmatter (agentskills.io spec)', () => {
    it('emits valid YAML frontmatter with name + quoted description + metadata', () => {
      const out = buildSkillMd(baseInput);
      expect(out.startsWith('---\n')).toBe(true);
      expect(out).toContain('name: example-merchant-commerce');
      expect(out).toContain('description: "Buy from Example Merchant via an AI agent"');
      expect(out).toContain('metadata:');
      expect(out).toContain('  version: "1"');
      expect(out).toContain('  homepage: "https://example-merchant.com"');
    });

    it('emits version as a quoted string per spec (string keys to string values)', () => {
      const out = buildSkillMd({ ...baseInput, version: 7 });
      expect(out).toContain('  version: "7"');
      const out2 = buildSkillMd({ ...baseInput, version: '2.0.1' });
      expect(out2).toContain('  version: "2.0.1"');
    });

    it('passes version: 0 through unchanged (nullish-coalescing default, not falsy)', () => {
      const out = buildSkillMd({ ...baseInput, version: 0 });
      expect(out).toContain('  version: "0"');
    });

    it("quotes description containing colons (the spec's primary YAML pitfall)", () => {
      const out = buildSkillMd({ ...baseInput, description: 'Use when: buying premium wine' });
      expect(out).toContain('description: "Use when: buying premium wine"');
    });

    it('escapes embedded double-quotes in description', () => {
      const out = buildSkillMd({ ...baseInput, description: 'Buy "Estate" wine' });
      expect(out).toContain('description: "Buy \\"Estate\\" wine"');
    });

    it('escapes embedded newlines in description', () => {
      const out = buildSkillMd({ ...baseInput, description: 'line one\nline two' });
      expect(out).toContain('description: "line one\\nline two"');
    });

    it('emits optional license / compatibility / allowed-tools when set', () => {
      const out = buildSkillMd({
        ...baseInput,
        license: 'Apache-2.0',
        compatibility: 'Requires Node 20+',
        allowedTools: 'Bash(curl:*)',
      });
      expect(out).toContain('license: "Apache-2.0"');
      expect(out).toContain('compatibility: "Requires Node 20+"');
      expect(out).toContain('allowed-tools: "Bash(curl:*)"');
    });

    it('omits license / compatibility / allowed-tools by default', () => {
      const out = buildSkillMd(baseInput);
      expect(out).not.toMatch(/^license:/m);
      expect(out).not.toMatch(/^compatibility:/m);
      expect(out).not.toMatch(/^allowed-tools:/m);
    });

    it('merges caller-supplied metadata entries (string values, version/homepage protected)', () => {
      const out = buildSkillMd({
        ...baseInput,
        metadata: { author: 'agentscore', vendor_id: 'me-001', version: 'IGNORED', homepage: 'IGNORED' },
      });
      expect(out).toContain('  author: "agentscore"');
      expect(out).toContain('  vendor_id: "me-001"');
      expect(out).toContain('  version: "1"');
      expect(out).toContain('  homepage: "https://example-merchant.com"');
      expect(out).not.toContain('IGNORED');
    });
  });

  describe('name + description validation (spec)', () => {
    it('rejects empty name', () => {
      expect(() => buildSkillMd({ ...baseInput, name: '' })).toThrow(/1-64/);
    });

    it('rejects an undefined name and reports length 0 (nullish-coalesced length)', () => {
      expect(() => buildSkillMd({ ...baseInput, name: undefined as unknown as string })).toThrow(/got 0/);
    });

    it('rejects name exceeding 64 characters', () => {
      expect(() => buildSkillMd({ ...baseInput, name: 'a'.repeat(65) })).toThrow(/1-64/);
    });

    it('rejects name with uppercase characters', () => {
      expect(() => buildSkillMd({ ...baseInput, name: 'Example-Merchant' })).toThrow(/lowercase/);
    });

    it('rejects name with leading hyphen', () => {
      expect(() => buildSkillMd({ ...baseInput, name: '-foo' })).toThrow(/hyphens/);
    });

    it('rejects name with trailing hyphen', () => {
      expect(() => buildSkillMd({ ...baseInput, name: 'foo-' })).toThrow(/hyphens/);
    });

    it('rejects name with consecutive hyphens', () => {
      expect(() => buildSkillMd({ ...baseInput, name: 'foo--bar' })).toThrow(/hyphens/);
    });

    it('rejects empty description', () => {
      expect(() => buildSkillMd({ ...baseInput, description: '' })).toThrow(/non-empty/);
    });

    it('rejects description exceeding 1024 characters', () => {
      expect(() => buildSkillMd({ ...baseInput, description: 'a'.repeat(1025) })).toThrow(/1024/);
    });

    it('rejects compatibility exceeding 500 characters', () => {
      expect(() => buildSkillMd({ ...baseInput, compatibility: 'a'.repeat(501) })).toThrow(/500/);
    });
  });

  describe('title block', () => {
    it('renders merchant name as h1', () => {
      const out = buildSkillMd(baseInput);
      expect(out).toContain('\n# Example Merchant\n');
    });

    it('renders title + tagline + intro with single blank line between each', () => {
      const out = buildSkillMd({
        ...baseInput,
        tagline: 'A classic is forever',
        intro: 'Napa Valley winery, family-run.',
      });
      expect(out).toContain('# Example Merchant\n\n_A classic is forever_\n\nNapa Valley winery, family-run.');
    });

    it('renders tagline only when provided', () => {
      const out = buildSkillMd({ ...baseInput, tagline: 'A classic is forever' });
      expect(out).toContain('# Example Merchant\n\n_A classic is forever_');
    });

    it('renders intro only when provided', () => {
      const out = buildSkillMd({ ...baseInput, intro: 'Napa Valley winery.' });
      expect(out).toContain('# Example Merchant\n\nNapa Valley winery.');
    });
  });

  describe('Important Files section', () => {
    it('emits the SKILL.md self-reference', () => {
      const out = buildSkillMd(baseInput);
      expect(out).toContain('## Important Files');
      expect(out).toContain('| **SKILL.md** (this file) | `https://example-merchant.com/skill.md` |');
    });

    it('appends caller-supplied files', () => {
      const out = buildSkillMd({
        ...baseInput,
        files: [
          { label: 'llms.txt', url: 'https://example-merchant.com/llms.txt' },
          { label: 'OpenAPI', url: 'https://example-merchant.com/openapi.json' },
        ],
      });
      expect(out).toContain('| llms.txt | `https://example-merchant.com/llms.txt` |');
      expect(out).toContain('| OpenAPI | `https://example-merchant.com/openapi.json` |');
    });

    it('strips trailing slash from homepage when computing skill.md URL', () => {
      const out = buildSkillMd({ ...baseInput, homepage: 'https://example-merchant.com/' });
      expect(out).toContain('`https://example-merchant.com/skill.md`');
      expect(out).not.toContain('//skill.md');
    });

    it('escapes pipe characters in file labels and URLs to keep tables intact', () => {
      const out = buildSkillMd({
        ...baseInput,
        files: [{ label: 'a|b', url: 'https://x.example/foo|bar' }],
      });
      expect(out).toContain('| a\\|b | `https://x.example/foo\\|bar` |');
    });

    it('escapes backslashes before pipes (so existing `\\` are not consumed as escapes)', () => {
      const out = buildSkillMd({
        ...baseInput,
        files: [{ label: 'a\\|b', url: 'https://x.example/c\\d' }],
      });
      // Backslash escaped first → `\\`, then pipe → `\|`. Combined: `a\\\|b`.
      expect(out).toContain('| a\\\\\\|b | `https://x.example/c\\\\d` |');
    });
  });

  describe('payment section', () => {
    it('renders one row per accepted rail with default smoke-verified clients', () => {
      const out = buildSkillMd(baseInput);
      expect(out).toContain('## Payment');
      expect(out).toContain('**MPP on Tempo**');
      expect(out).toContain('agentscore-pay, tempo request, x402-proxy');
      expect(out).toContain('**x402 on Base**');
      expect(out).toContain('agentscore-pay, x402-proxy, purl (omit --network flag)');
      expect(out).toContain('**MPP on Solana**');
      expect(out).toContain('**Stripe Shared Payment Token**');
      expect(out).toContain('link-cli');
    });

    it('omits rails not declared in acceptedRails', () => {
      const out = buildSkillMd({
        ...baseInput,
        acceptedRails: ['tempo_mpp', 'x402_base', 'solana_mpp'],
      });
      expect(out).toContain('**MPP on Tempo**');
      expect(out).not.toContain('**Stripe Shared Payment Token**');
      expect(out).not.toContain('link-cli');
    });

    it('handles an empty acceptedRails list (no default client map → empty defaults)', () => {
      // acceptedRails: [] makes compatibleClientsByRails return undefined, exercising
      // the `?? {}` fallback; the payment table renders with no rail rows.
      const out = buildSkillMd({ ...baseInput, acceptedRails: [] });
      expect(out).toContain('## Payment');
      expect(out).not.toContain('**MPP on Tempo**');
      expect(out).not.toContain('**x402 on Base**');
    });

    it('honors compatibleClients override per rail', () => {
      const out = buildSkillMd({
        ...baseInput,
        acceptedRails: ['x402_base'],
        compatibleClients: { x402_base: ['agentscore-pay', 'merchant-custom-cli'] },
      });
      expect(out).toContain('agentscore-pay, merchant-custom-cli');
      expect(out).not.toContain('purl');
    });

    it('drops compatibleClients overrides for rails not in acceptedRails', () => {
      const out = buildSkillMd({
        ...baseInput,
        acceptedRails: ['x402_base'],
        compatibleClients: {
          x402_base: ['agentscore-pay'],
          stripe: ['rogue-cli'],
        },
      });
      expect(out).not.toContain('rogue-cli');
      expect(out).not.toContain('Stripe Shared Payment Token');
    });

    it("renders 'none' when a rail's compatible-clients list is explicitly empty", () => {
      const out = buildSkillMd({
        ...baseInput,
        acceptedRails: ['x402_base'],
        compatibleClients: { x402_base: [] },
      });
      // 'none' rather than an em-dash: this table is served on every store's
      // skill.md, and the org rule bars em-dashes on external surfaces.
      expect(out).toMatch(/x402 on Base.+\| none/);
      expect(out).not.toContain('—');
    });
  });

  describe('identity section', () => {
    it('omits the section when identity is not declared', () => {
      const out = buildSkillMd(baseInput);
      expect(out).not.toContain('## Identity Prerequisite');
    });

    it('renders KYC + age + jurisdictions + sanctions when declared', () => {
      const out = buildSkillMd({
        ...baseInput,
        identity: { kycRequired: true, minAge: 21, allowedJurisdictions: ['US'], sanctionsClear: true },
      });
      expect(out).toContain('## Identity Prerequisite');
      expect(out).toContain('KYC verified Passport');
      expect(out).toContain('age 21+');
      expect(out).toContain('US only');
      expect(out).toContain('sanctions clear');
    });

    it('renders bootstrap pointer when identityBootstrapUrl is set', () => {
      const out = buildSkillMd({
        ...baseInput,
        identity: { kycRequired: true },
        identityBootstrapUrl: 'https://identity.example.com/skill.md',
      });
      expect(out).toContain('`https://identity.example.com/skill.md`');
      expect(out).toContain('X-Operator-Token');
    });

    it('omits the section when every requirement flag is falsy', () => {
      const out = buildSkillMd({
        ...baseInput,
        identity: { kycRequired: false, sanctionsClear: false },
      });
      expect(out).not.toContain('## Identity Prerequisite');
    });

    it('does not leak failOpen, mount-posture, or KYC vendor names', () => {
      const out = buildSkillMd({
        ...baseInput,
        identity: { kycRequired: true, minAge: 21, allowedJurisdictions: ['US'], sanctionsClear: true },
      });
      expect(out).not.toContain('failOpen');
      expect(out).not.toContain('fail-open');
      expect(out).not.toContain('gate-conditional');
      expect(out).not.toContain('gate-first');
      expect(out).not.toContain('Persona');
      expect(out).not.toContain('Stripe Identity');
    });
  });

  describe('shipping section', () => {
    it('omits the section for digital merchants (no shipping)', () => {
      const out = buildSkillMd(baseInput);
      expect(out).not.toContain('## Shipping');
    });

    it('renders allowed countries and blocked states', () => {
      const out = buildSkillMd({
        ...baseInput,
        shipping: { allowedCountries: ['US'], blockedStates: ['AK', 'HI', 'MS'] },
      });
      expect(out).toContain('## Shipping');
      expect(out).toContain('Ships to: US.');
      expect(out).toContain('Blocked US states: AK, HI, MS.');
    });

    it('renders only allowed countries when blocked is omitted', () => {
      const out = buildSkillMd({
        ...baseInput,
        shipping: { allowedCountries: ['US'] },
      });
      expect(out).toContain('Ships to: US.');
      expect(out).not.toContain('Blocked US states');
    });

    it('renders only blocked states when allowed is omitted', () => {
      const out = buildSkillMd({
        ...baseInput,
        shipping: { blockedStates: ['UT', 'AK'] },
      });
      expect(out).toContain('## Shipping');
      expect(out).toContain('Blocked US states: UT, AK.');
      expect(out).not.toContain('Ships to:');
    });
  });

  describe('endpoints section', () => {
    it('emits a row per endpoint with auth label', () => {
      const out = buildSkillMd(baseInput);
      expect(out).toContain('## Endpoints');
      expect(out).toContain('| GET | `/api/v1/wines` | anonymous | Wine catalog |');
      expect(out).toContain('| POST | `/api/v1/orders` | identity required | Place order |');
    });

    it('omits the endpoints section when the list is empty', () => {
      const out = buildSkillMd({ ...baseInput, endpoints: [] });
      expect(out).not.toContain('## Endpoints');
    });

    it('escapes pipes in endpoint paths and descriptions', () => {
      const out = buildSkillMd({
        ...baseInput,
        endpoints: [
          { method: 'GET', path: '/foo|bar', authRequired: false, description: 'a|b' },
        ],
      });
      expect(out).toContain('| GET | `/foo\\|bar` | anonymous | a\\|b |');
    });
  });

  describe('triggers section', () => {
    it('emits each trigger as a bullet', () => {
      const out = buildSkillMd({
        ...baseInput,
        triggers: ['Buy from Example Merchant', 'Check order status'],
      });
      expect(out).toContain('## Triggers');
      expect(out).toContain('- Buy from Example Merchant');
      expect(out).toContain('- Check order status');
    });

    it('omits the triggers section when triggers is empty', () => {
      const out = buildSkillMd({ ...baseInput, triggers: [] });
      expect(out).not.toContain('## Triggers');
    });
  });

  describe('onboarding + support', () => {
    it('emits numbered onboarding steps', () => {
      const out = buildSkillMd({
        ...baseInput,
        onboardingSteps: ['Install agentscore-pay', 'Get a Passport', 'Pay any x402'],
      });
      expect(out).toContain('## Onboarding Flow');
      expect(out).toContain('1. Install agentscore-pay');
      expect(out).toContain('2. Get a Passport');
      expect(out).toContain('3. Pay any x402');
    });

    it('emits support links as bullets', () => {
      const out = buildSkillMd({
        ...baseInput,
        supportLinks: [
          { label: 'Homepage', url: 'https://example-merchant.com' },
          { label: 'Pay CLI', url: 'https://github.com/agentscore/pay' },
        ],
      });
      expect(out).toContain('## Support');
      expect(out).toContain('- **Homepage**: https://example-merchant.com');
      expect(out).toContain('- **Pay CLI**: https://github.com/agentscore/pay');
    });
  });

  describe('refresh footer', () => {
    it('appends the refresh footer by default', () => {
      const out = buildSkillMd(baseInput);
      expect(out).toContain('Re-fetch this file');
    });

    it('suppresses the refresh footer when set to false', () => {
      const out = buildSkillMd({ ...baseInput, refreshFooter: false });
      expect(out).not.toContain('Re-fetch this file');
    });
  });

  describe('output hygiene', () => {
    it('ends with a single trailing newline', () => {
      const out = buildSkillMd(baseInput);
      expect(out.endsWith('\n')).toBe(true);
      expect(out.endsWith('\n\n')).toBe(false);
    });

    it('collapses runs of more than two consecutive newlines', () => {
      const out = buildSkillMd(baseInput);
      expect(out).not.toMatch(/\n{3,}/);
    });
  });
});
