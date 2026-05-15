import { compatibleClientsByRails } from '../challenge/agent_instructions';
import type { CompatibleClients, RailKey } from '../challenge/agent_instructions';

export type { CompatibleClients, RailKey } from '../challenge/agent_instructions';
export { compatibleClientsByRails } from '../challenge/agent_instructions';

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

/** PHYSICAL-GOODS-ONLY. Shipping-policy block for skill.md. Digital goods and
 *  API merchants skip this (the `shipping?:` field on BuildSkillMdInput is
 *  optional). */
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

interface BuildSkillMdInput {
  /** Skill manifest identifier — kebab-case per agentskills.io spec: 1-64 chars, lowercase
   *  alphanumeric + hyphens, no leading/trailing/consecutive hyphens. Validated at build
   *  time; invalid names throw. e.g. 'example-merchant-commerce'. */
  name: string;
  /** Skill description — agentskills.io spec: 1-1024 chars, non-empty. Should describe both
   *  what the skill does AND when to use it; imperative phrasing recommended ("Use when…").
   *  Validated at build time; over-length throws. */
  description: string;
  /** Merchant homepage (or domain root). Emitted as `metadata.homepage` per spec
   *  (top-level non-spec fields go under metadata). */
  homepage: string;
  /** Skill schema version — increment when the skill body materially changes. Emitted as
   *  a quoted string under `metadata.version` per agentskills.io spec (metadata values
   *  must be strings). Accepts string or number; numbers are converted. Default "1". */
  version?: string | number;

  /** Optional license name or path to a bundled license file. Emitted as top-level
   *  frontmatter `license:` per spec. */
  license?: string;
  /** Optional environment-requirements note (max 500 chars). e.g. "Requires Node 20+".
   *  Emitted as top-level frontmatter `compatibility:` per spec. */
  compatibility?: string;
  /** Optional space-separated string of pre-approved tools (experimental per spec). */
  allowedTools?: string;
  /** Additional caller-defined metadata entries — flat key/value strings nested under
   *  `metadata:`. Spec requires string values. */
  metadata?: Record<string, string | number>;

  /** Human display name (e.g. "Example Merchant"). */
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
   *  `acceptedRails` via the SDK's smoke-verified default. Override keys not in
   *  `acceptedRails` are dropped (the rail isn't accepted, so the row isn't rendered). */
  compatibleClients?: CompatibleClients;

  /** Identity requirements as agent-observable outcomes (kyc / age / jurisdiction /
   *  sanctions). Internal posture (`failOpen`, mount strategy, KYC vendor) is intentionally
   *  not part of this shape — agents act on outcomes, not implementation. */
  identity?: SkillMdIdentityRequirements;
  /** URL to the identity-bootstrap skill. Linked from the Identity Prerequisite section
   *  so an agent without a Passport can follow the bootstrap before attempting purchase. */
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
  solana_mpp: 'MPP on Solana',
  stripe: 'Stripe Shared Payment Token',
};

const RAIL_NOTES: Record<RailKey, string> = {
  tempo_mpp: 'USDC. Use `agentscore-pay pay --chain tempo` (or `tempo request`); MPP credential goes in `Authorization: Payment`.',
  x402_base: 'USDC (EIP-3009). Use `agentscore-pay pay --chain base`; X-Payment header carries the signed credential.',
  solana_mpp: 'USDC (SPL). Use `agentscore-pay pay --chain solana`; MPP credential goes in `Authorization: Payment`.',
  stripe: 'Card via Link wallet. Use `@stripe/link-cli` — `agentscore-pay` emits the handoff hint when this rail is picked.',
};

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
const COMPATIBILITY_MAX = 500;

function validateInput(input: BuildSkillMdInput): void {
  if (!input.name || input.name.length === 0 || input.name.length > NAME_MAX) {
    throw new Error(`buildSkillMd: name must be 1-${NAME_MAX} characters (got ${input.name?.length ?? 0})`);
  }
  if (!NAME_RE.test(input.name)) {
    throw new Error(
      `buildSkillMd: name "${input.name}" is invalid — must be lowercase alphanumeric and hyphens, no leading/trailing/consecutive hyphens (agentskills.io spec)`,
    );
  }
  if (!input.description || input.description.length === 0) {
    throw new Error('buildSkillMd: description is required and must be non-empty (agentskills.io spec)');
  }
  if (input.description.length > DESCRIPTION_MAX) {
    throw new Error(
      `buildSkillMd: description must be ≤${DESCRIPTION_MAX} characters (got ${input.description.length})`,
    );
  }
  if (input.compatibility && input.compatibility.length > COMPATIBILITY_MAX) {
    throw new Error(
      `buildSkillMd: compatibility must be ≤${COMPATIBILITY_MAX} characters (got ${input.compatibility.length})`,
    );
  }
}

/** Quote a value as a YAML double-quoted scalar — escape `\\`, `"`, and newlines. The
 *  agentskills.io spec calls out unquoted colons in `description` as the most common
 *  parse failure across clients; emit every user-supplied scalar quoted to be safe. */
function quoteYaml(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/** Sanitize a string for inclusion in a markdown table cell — escape backslashes first
 *  (so existing `\` aren't treated as escapes), then escape pipes (which would otherwise
 *  terminate the cell). */
function tableCell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

function frontmatter(input: BuildSkillMdInput): string {
  const lines: string[] = ['---'];
  lines.push(`name: ${input.name}`);
  lines.push(`description: ${quoteYaml(input.description)}`);
  if (input.license) lines.push(`license: ${quoteYaml(input.license)}`);
  if (input.compatibility) lines.push(`compatibility: ${quoteYaml(input.compatibility)}`);
  if (input.allowedTools) lines.push(`allowed-tools: ${quoteYaml(input.allowedTools)}`);

  const meta: Array<[string, string]> = [];
  meta.push(['version', String(input.version ?? '1')]);
  meta.push(['homepage', input.homepage]);
  for (const [k, v] of Object.entries(input.metadata ?? {})) {
    if (k === 'version' || k === 'homepage') continue;
    meta.push([k, String(v)]);
  }
  lines.push('metadata:');
  for (const [k, v] of meta) {
    lines.push(`  ${k}: ${quoteYaml(v)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

function importantFiles(input: BuildSkillMdInput): string {
  const skillUrl = `${input.homepage.replace(/\/$/, '')}/skill.md`;
  const rows: string[] = [
    '| File | URL |',
    '|------|-----|',
    `| **SKILL.md** (this file) | \`${skillUrl}\` |`,
  ];
  for (const f of input.files ?? []) {
    rows.push(`| ${tableCell(f.label)} | \`${tableCell(f.url)}\` |`);
  }
  return ['## Important Files', '', ...rows].join('\n');
}

function paymentSection(input: BuildSkillMdInput): string {
  const override = input.compatibleClients;
  const defaults = compatibleClientsByRails(input.acceptedRails) ?? {};
  // Override entries only apply to rails actually accepted; ignore stragglers.
  const clients: CompatibleClients = {};
  for (const r of input.acceptedRails) {
    clients[r] = override?.[r] ?? defaults[r] ?? [];
  }
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
    rows.push(
      `| ${e.method} | \`${tableCell(e.path)}\` | ${e.authRequired ? 'identity required' : 'anonymous'} | ${tableCell(e.description)} |`,
    );
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

function titleBlock(input: BuildSkillMdInput): string {
  const parts: string[] = [`# ${input.merchantName}`];
  if (input.tagline) parts.push(`_${input.tagline}_`);
  if (input.intro) parts.push(input.intro);
  return parts.join('\n\n');
}

/**
 * Render an agentskills.io-compatible `skill.md` for an agent-commerce merchant.
 *
 * Output is YAML frontmatter (`name` / `description` / optional `license` /
 * `compatibility` / `allowed-tools` / `metadata`) followed by markdown sections
 * describing payment rails, identity requirements, endpoints, triggers, and support
 * links — strictly the agent-facing contract, with no internal posture (no `failOpen`,
 * no mount-strategy names, no KYC vendor, no defense parameters).
 *
 * Spec compliance:
 *   - `name` validated against the agentskills.io regex (lowercase alphanumeric + hyphens,
 *     no leading/trailing/consecutive hyphens, ≤64 chars).
 *   - `description` length capped at 1024.
 *   - `metadata` values always emitted as quoted strings.
 *   - `description` (and other user scalars) double-quoted to defuse the colon /
 *     newline / quote pitfall the spec explicitly warns about.
 *
 * The compatible-clients-per-rail table sources from the same SDK constant
 * (`compatibleClientsByRails`) that drives the live 402 body's `compatible_clients`
 * field, so updating a smoke-verified client in one place propagates to every surface.
 */
export function buildSkillMd(input: BuildSkillMdInput): string {
  validateInput(input);
  // Helpers downstream receive the typed input object; the type is internal-only so the
  // public surface is destructured-kwargs from the caller's perspective (vendors pass object
  // literals, identical to the rest of the SDK's builders).
  const sections = [
    frontmatter(input),
    titleBlock(input),
    importantFiles(input),
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
