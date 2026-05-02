import { describe, expect, it } from 'vitest';
import { buildSkillMd } from '../../src/discovery/skill_md';

describe('buildSkillMd', () => {
  const baseInput = {
    name: 'martin-estate-wine-commerce',
    description: 'Buy wine from Martin Estate via an AI agent',
    homepage: 'https://martin-estate.com',
    merchantName: 'Martin Estate',
    acceptedRails: ['tempo_mpp', 'x402_base', 'x402_solana', 'stripe'] as const,
    endpoints: [
      { method: 'GET' as const, path: '/api/v1/wines', authRequired: false, description: 'Wine catalog' },
      { method: 'POST' as const, path: '/api/v1/orders', authRequired: true, description: 'Place order' },
    ],
    triggers: ['User wants to buy wine from Martin Estate'],
  };

  it('emits valid YAML frontmatter with name, description, homepage, version', () => {
    const out = buildSkillMd(baseInput);
    expect(out.startsWith('---\n')).toBe(true);
    expect(out).toMatch(/^---\nname: martin-estate-wine-commerce\ndescription: .+\nhomepage: https:\/\/martin-estate\.com\nmetadata:\n {2}version: 1\n---/);
  });

  it('honors version override', () => {
    const out = buildSkillMd({ ...baseInput, version: 7 });
    expect(out).toContain('  version: 7');
  });

  it('renders merchant name as h1', () => {
    const out = buildSkillMd(baseInput);
    expect(out).toContain('\n# Martin Estate\n');
  });

  it('emits the SKILL.md self-reference under Important Files', () => {
    const out = buildSkillMd(baseInput);
    expect(out).toContain('## Important Files');
    expect(out).toContain('| **SKILL.md** (this file) | `https://martin-estate.com/skill.md` |');
  });

  it('appends caller-supplied files to Important Files', () => {
    const out = buildSkillMd({
      ...baseInput,
      files: [
        { label: 'llms.txt', url: 'https://martin-estate.com/llms.txt' },
        { label: 'OpenAPI', url: 'https://martin-estate.com/openapi.json' },
      ],
    });
    expect(out).toContain('| llms.txt | `https://martin-estate.com/llms.txt` |');
    expect(out).toContain('| OpenAPI | `https://martin-estate.com/openapi.json` |');
  });

  it('strips trailing slash from homepage when computing skill.md URL', () => {
    const out = buildSkillMd({ ...baseInput, homepage: 'https://martin-estate.com/' });
    expect(out).toContain('`https://martin-estate.com/skill.md`');
    expect(out).not.toContain('//skill.md');
  });

  describe('payment section', () => {
    it('renders one row per accepted rail with default smoke-verified clients', () => {
      const out = buildSkillMd(baseInput);
      expect(out).toContain('## Payment');
      expect(out).toContain('**MPP on Tempo**');
      expect(out).toContain('agentscore-pay, tempo request, x402-proxy');
      expect(out).toContain('**x402 on Base**');
      expect(out).toContain('agentscore-pay, x402-proxy, purl (omit --network flag)');
      expect(out).toContain('**x402 on Solana**');
      expect(out).toContain('**Stripe Shared Payment Token**');
      expect(out).toContain('link-cli');
    });

    it('omits rails not declared in acceptedRails (Store has no Stripe)', () => {
      const out = buildSkillMd({
        ...baseInput,
        acceptedRails: ['tempo_mpp', 'x402_base', 'x402_solana'],
      });
      expect(out).toContain('**MPP on Tempo**');
      expect(out).not.toContain('**Stripe Shared Payment Token**');
      expect(out).not.toContain('link-cli');
    });

    it('honors compatibleClients override for verified-by-merchant clients', () => {
      const out = buildSkillMd({
        ...baseInput,
        acceptedRails: ['x402_base'],
        compatibleClients: { x402_base: ['agentscore-pay', 'merchant-custom-cli'] },
      });
      expect(out).toContain('agentscore-pay, merchant-custom-cli');
      expect(out).not.toContain('purl');
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
        identityBootstrapUrl: 'https://agentscore.sh/skill.md',
      });
      expect(out).toContain('`https://agentscore.sh/skill.md`');
      expect(out).toContain('X-Operator-Token');
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

    it('renders only the populated half', () => {
      const out = buildSkillMd({
        ...baseInput,
        shipping: { allowedCountries: ['US'] },
      });
      expect(out).toContain('Ships to: US.');
      expect(out).not.toContain('Blocked US states');
    });
  });

  describe('endpoints section', () => {
    it('emits a row per endpoint with auth label', () => {
      const out = buildSkillMd(baseInput);
      expect(out).toContain('## Endpoints');
      expect(out).toContain('| GET | `/api/v1/wines` | anonymous | Wine catalog |');
      expect(out).toContain('| POST | `/api/v1/orders` | identity required | Place order |');
    });
  });

  describe('triggers section', () => {
    it('emits each trigger as a bullet under "Use this skill when the user wants to"', () => {
      const out = buildSkillMd({
        ...baseInput,
        triggers: ['Buy wine from Martin Estate', 'Check order status'],
      });
      expect(out).toContain('## Triggers');
      expect(out).toContain('- Buy wine from Martin Estate');
      expect(out).toContain('- Check order status');
    });
  });

  describe('onboarding + support', () => {
    it('emits numbered onboarding steps', () => {
      const out = buildSkillMd({
        ...baseInput,
        onboardingSteps: ['Install agentscore-pay', 'Get a Passport', 'Pay any 402'],
      });
      expect(out).toContain('## Onboarding Flow');
      expect(out).toContain('1. Install agentscore-pay');
      expect(out).toContain('2. Get a Passport');
      expect(out).toContain('3. Pay any 402');
    });

    it('emits support links as bullets', () => {
      const out = buildSkillMd({
        ...baseInput,
        supportLinks: [
          { label: 'Homepage', url: 'https://martin-estate.com' },
          { label: 'Pay CLI', url: 'https://github.com/agentscore/pay' },
        ],
      });
      expect(out).toContain('## Support');
      expect(out).toContain('- **Homepage**: https://martin-estate.com');
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

  describe('optional title elements', () => {
    it('renders tagline in italics under the title', () => {
      const out = buildSkillMd({ ...baseInput, tagline: 'A classic is forever' });
      expect(out).toContain('# Martin Estate');
      expect(out).toContain('_A classic is forever_');
    });

    it('renders intro paragraph under the title', () => {
      const out = buildSkillMd({ ...baseInput, intro: 'Napa Valley winery, family-run.' });
      expect(out).toContain('Napa Valley winery, family-run.');
    });
  });

  describe('empty-collection paths', () => {
    it('omits the triggers section when triggers is empty', () => {
      const out = buildSkillMd({ ...baseInput, triggers: [] });
      expect(out).not.toContain('## Triggers');
    });

    it('omits the endpoints section when the list is empty', () => {
      const out = buildSkillMd({ ...baseInput, endpoints: [] });
      expect(out).not.toContain('## Endpoints');
    });

    it("renders '—' when a rail's compatible-clients list is explicitly empty", () => {
      const out = buildSkillMd({
        ...baseInput,
        acceptedRails: ['x402_base'],
        compatibleClients: { x402_base: [] },
      });
      expect(out).toContain('| **x402 on Base** | ');
      expect(out).toMatch(/x402 on Base.+\| —/);
    });

    it('omits the identity section when every requirement flag is falsy', () => {
      const out = buildSkillMd({
        ...baseInput,
        identity: { kycRequired: false, sanctionsClear: false },
      });
      expect(out).not.toContain('## Identity Prerequisite');
    });

    it('renders shipping section with only blockedStates (no allowedCountries)', () => {
      const out = buildSkillMd({
        ...baseInput,
        shipping: { blockedStates: ['UT', 'AK'] },
      });
      expect(out).toContain('## Shipping');
      expect(out).toContain('Blocked US states: UT, AK.');
      expect(out).not.toContain('Ships to:');
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
