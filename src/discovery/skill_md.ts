import { compatibleClientsByRails } from '../challenge/agent_instructions';
import type { CompatibleClients, RailKey } from '../challenge/agent_instructions';

export interface SkillMdEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  authRequired: boolean;
  description: string;
}

export interface SkillMdIdentityRequirements {
  /** Whether KYC is required for gated routes. */
  kycRequired?: boolean;
  /** Minimum age (e.g. 21 for alcohol). */
  minAge?: number;
  /** Allowed-jurisdictions list (ISO 3166-1 alpha-2 country codes). */
  allowedJurisdictions?: string[];
  /** Whether sanctions screening is enforced. */
  sanctionsClear?: boolean;
}

export interface SkillMdShippingPolicy {
  /** Allowed shipping countries (ISO 3166-1 alpha-2). */
  allowedCountries?: string[];
  /** Blocked US states (2-letter codes). */
  blockedStates?: string[];
}

export interface SkillMdLink {
  label: string;
  url: string;
}

export interface BuildSkillMdInput {
  /** Skill manifest identifier — kebab-case, e.g. 'martin-estate-wine-commerce'. */
  name: string;
  /** One-line description of what this skill does. Surfaces in skill catalogs. */
  description: string;
  /** Merchant homepage (or domain root) — appears in frontmatter. */
  homepage: string;
  /** Skill schema version — increment when the skill body materially changes. Default 1. */
  version?: number;

  /** Human display name (e.g. "Martin Estate Winery"). */
  merchantName: string;
  /** Optional one-line tagline appearing under the title. */
  tagline?: string;
  /** Optional short prose intro describing what the merchant offers. Renders below the title. */
  intro?: string;

  /** Files / well-known URLs surfaced under the "Important Files" table. The skill.md URL
   *  itself is added automatically — list other discovery surfaces (llms.txt, mpp.json,
   *  openapi.json, agent-card.json). */
  files?: SkillMdLink[];

  /** Rails the merchant accepts. Drives the Payment + Compatible Clients sections. Order
   *  is preserved in render. Default to the rails actually declared on the merchant's
   *  `respond402` config — keep these in sync. */
  acceptedRails: RailKey[];
  /** Override the per-rail compatible-clients matrix. When omitted, derives from
   *  `acceptedRails` via the SDK's smoke-verified default. */
  compatibleClients?: CompatibleClients;

  /** Identity requirements as agent-observable outcomes (kyc / age / jurisdiction /
   *  sanctions). Internal posture (`failOpen`, mount strategy, KYC vendor) is intentionally
   *  not part of this shape — agents act on outcomes, not implementation. */
  identity?: SkillMdIdentityRequirements;
  /** URL to the identity-bootstrap skill (typically `https://agentscore.sh/skill.md`).
   *  Linked from the Identity Prerequisite section so an agent without a Passport can
   *  follow the bootstrap before attempting purchase. */
  identityBootstrapUrl?: string;

  /** Shipping policy, for physical-goods merchants. Omit for digital merchants. */
  shipping?: SkillMdShippingPolicy;

  /** Agent-facing endpoints — path, method, whether auth is required, brief purpose. */
  endpoints: SkillMdEndpoint[];

  /** When this skill should fire (skill loader uses for trigger matching). */
  triggers: string[];

  /** Optional numbered onboarding steps. Each entry renders as a numbered list item;
   *  may include shell snippets in markdown code fences. */
  onboardingSteps?: string[];

  /** Support / homepage / docs links rendered in the "Support" section. */
  supportLinks?: SkillMdLink[];

  /** When true (default), append a footer noting clients can refresh skill.md to pick
   *  up new endpoints. Set to false to suppress. */
  refreshFooter?: boolean;
}

const RAIL_LABELS: Record<RailKey, string> = {
  tempo_mpp: 'MPP on Tempo',
  x402_base: 'x402 on Base',
  x402_solana: 'x402 on Solana',
  stripe: 'Stripe Shared Payment Token',
};

const RAIL_NOTES: Record<RailKey, string> = {
  tempo_mpp: 'USDC. Use `agentscore-pay --chain tempo` (or `tempo request`); MPP credential goes in `Authorization: Payment`.',
  x402_base: 'USDC (EIP-3009). Use `agentscore-pay`; X-Payment header carries the signed credential.',
  x402_solana: 'USDC (SPL). Use `agentscore-pay`; X-Payment header carries the signed credential.',
  stripe: 'Card via Link wallet. Use `@stripe/link-cli` — `agentscore-pay` emits the handoff hint when this rail is picked.',
};

function frontmatter(input: BuildSkillMdInput): string {
  return [
    '---',
    `name: ${input.name}`,
    `description: ${input.description}`,
    `homepage: ${input.homepage}`,
    'metadata:',
    `  version: ${input.version ?? 1}`,
    '---',
  ].join('\n');
}

function importantFiles(input: BuildSkillMdInput): string {
  const skillUrl = `${input.homepage.replace(/\/$/, '')}/skill.md`;
  const rows: string[] = [
    '| File | URL |',
    '|------|-----|',
    `| **SKILL.md** (this file) | \`${skillUrl}\` |`,
  ];
  for (const f of input.files ?? []) {
    rows.push(`| ${f.label} | \`${f.url}\` |`);
  }
  return ['## Important Files', '', ...rows].join('\n');
}

function paymentSection(input: BuildSkillMdInput): string {
  const clients = input.compatibleClients ?? compatibleClientsByRails(input.acceptedRails) ?? {};
  const rows: string[] = ['| Rail | Notes | Compatible clients |', '|---|---|---|'];
  for (const r of input.acceptedRails) {
    const list = (clients[r] ?? []).join(', ') || '—';
    rows.push(`| **${RAIL_LABELS[r]}** | ${RAIL_NOTES[r]} | ${list} |`);
  }
  return [
    '## Payment',
    '',
    'Each gated route returns a 402 with `WWW-Authenticate` + `PAYMENT-REQUIRED` body listing the rails below with current pricing. Pick whichever your wallet is funded for.',
    '',
    ...rows,
  ].join('\n');
}

function identitySection(input: BuildSkillMdInput): string {
  const id = input.identity;
  if (!id) return '';
  const reqs: string[] = [];
  if (id.kycRequired) reqs.push('KYC verified Passport');
  if (id.minAge) reqs.push(`age ${id.minAge}+`);
  if (id.allowedJurisdictions?.length) reqs.push(`${id.allowedJurisdictions.join('/')} only`);
  if (id.sanctionsClear) reqs.push('sanctions clear');
  if (reqs.length === 0) return '';
  const bootstrap = input.identityBootstrapUrl
    ? `\n\nIf you don't have a Passport, fetch \`${input.identityBootstrapUrl}\` and follow the onboarding there first. Bring back the \`opc_...\` operator token in \`X-Operator-Token\` on every gated request.`
    : '';
  return [
    '## Identity Prerequisite',
    '',
    `This merchant uses AgentScore identity. Required: ${reqs.join(', ')}.${bootstrap}`,
    '',
    'Denial bodies carry an `agent_instructions` block describing the recovery action — read the `action` field and follow it. See the identity-bootstrap skill for the canonical denial-code → action table.',
  ].join('\n');
}

function shippingSection(input: BuildSkillMdInput): string {
  const s = input.shipping;
  if (!s || (!s.allowedCountries?.length && !s.blockedStates?.length)) return '';
  const lines: string[] = ['## Shipping', ''];
  if (s.allowedCountries?.length) {
    lines.push(`Ships to: ${s.allowedCountries.join(', ')}.`);
  }
  if (s.blockedStates?.length) {
    if (lines.length > 2) lines.push('');
    lines.push(`Blocked US states: ${s.blockedStates.join(', ')}.`);
  }
  return lines.join('\n');
}

function endpointsSection(input: BuildSkillMdInput): string {
  if (input.endpoints.length === 0) return '';
  const rows = ['| Method | Path | Auth | Purpose |', '|---|---|---|---|'];
  for (const e of input.endpoints) {
    rows.push(`| ${e.method} | \`${e.path}\` | ${e.authRequired ? 'identity required' : 'anonymous'} | ${e.description} |`);
  }
  return ['## Endpoints', '', ...rows].join('\n');
}

function onboardingSection(input: BuildSkillMdInput): string {
  if (!input.onboardingSteps?.length) return '';
  const rows = input.onboardingSteps.map((step, i) => `${i + 1}. ${step}`);
  return ['## Onboarding Flow', '', ...rows].join('\n');
}

function triggersSection(input: BuildSkillMdInput): string {
  if (input.triggers.length === 0) return '';
  const rows = input.triggers.map((t) => `- ${t}`);
  return ['## Triggers', '', 'Use this skill when the user wants to:', '', ...rows].join('\n');
}

function supportSection(input: BuildSkillMdInput): string {
  if (!input.supportLinks?.length) return '';
  const rows = input.supportLinks.map((l) => `- **${l.label}**: ${l.url}`);
  return ['## Support', '', ...rows].join('\n');
}

function refreshFooter(input: BuildSkillMdInput): string {
  if (input.refreshFooter === false) return '';
  return '_Re-fetch this file periodically to pick up new endpoints, rails, or policies._';
}

/**
 * Render a Claude-Skill-compatible `skill.md` for an agent-commerce merchant. The output
 * is YAML frontmatter (`name` / `description` / `homepage` / `metadata.version`) followed
 * by markdown sections describing payment rails, identity requirements, endpoints,
 * triggers, and support links — exactly the agent-facing contract, with no internal
 * posture (no `failOpen`, no mount-strategy names, no KYC vendor, no defense parameters).
 *
 * The compatible-clients-per-rail table sources from the same SDK constant
 * (`compatibleClientsByRails`) that drives the live 402 body's `compatible_clients`
 * field, so updating a smoke-verified client in one place propagates to every surface.
 */
export function buildSkillMd(input: BuildSkillMdInput): string {
  const sections = [
    frontmatter(input),
    '',
    `# ${input.merchantName}`,
    input.tagline ? `\n_${input.tagline}_` : '',
    input.intro ? `\n${input.intro}` : '',
    '',
    importantFiles(input),
    '',
    identitySection(input),
    paymentSection(input),
    shippingSection(input),
    onboardingSection(input),
    endpointsSection(input),
    triggersSection(input),
    supportSection(input),
    refreshFooter(input),
  ].filter((s) => s !== '');
  return sections.join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
