/**
 * Generate the standard "## Identity" section for an AgentScore-gated merchant's
 * llms.txt. Explains the wallet-auth vs operator-token paths so agents know how to
 * authenticate without reading the API docs.
 */
export function llmsTxtIdentitySection({
  agentscore,
  compliance,
}: {
  /** When true, include the AgentScore identity-paths explanation (wallet vs operator-token). */
  agentscore?: boolean;
  /** Compliance policy to mention (KYC, age, jurisdiction). */
  compliance?: {
    require_kyc?: boolean;
    min_age?: number;
    allowed_jurisdictions?: string[];
    require_sanctions_clear?: boolean;
  };
} = {}): string {
  if (!agentscore) {
    return '';
  }
  const complianceNote = compliance
    ? `\n\nCompliance: ${[
        compliance.require_kyc ? 'KYC required' : null,
        compliance.min_age ? `age ${compliance.min_age}+` : null,
        compliance.allowed_jurisdictions?.length
          ? `${compliance.allowed_jurisdictions.join('/')} only`
          : null,
        compliance.require_sanctions_clear ? 'sanctions clear' : null,
      ]
        .filter(Boolean)
        .join(', ')}.`
    : '';
  return `## Identity

AgentScore identity is reusable across every AgentScore-gated merchant — one KYC, no re-verification per site. Pick a header:

- **\`X-Wallet-Address: 0x...\` or base58** — works on signing rails (Tempo, x402, Solana MPP). The wallet you claim must sign the payment.
- **\`X-Operator-Token: opc_...\`** — works on every rail, including Stripe SPT. Reusable across AgentScore merchants until expiry.
- **Neither** — you get a 403 with \`verify_url\`. Complete the session flow once and reuse the resulting \`opc_...\` everywhere.${complianceNote}`;
}

interface LlmsTxtPaymentSectionConfig {
  /** Symbolic rail names supported. */
  rails: ('tempo-mainnet' | 'tempo-testnet' | 'x402-base-mainnet' | 'x402-base-sepolia' | 'mpp-solana-mainnet' | 'mpp-solana-devnet' | 'stripe-spt' | string)[];
  /** Merchant URL — used in the example commands. */
  appUrl: string;
  /**
   * When true, emit the verbose multi-step variant: setup commands per rail, full per-rail
   * payment-command examples, and warnings about footguns. Default false (one-line bullet per rail).
   * Use this when llms.txt is the primary integration doc the agent reads.
   */
  verbose?: boolean;
  /** When verbose, the Tempo network name to mention in the prerequisites. Default 'tempo-mainnet'. */
  tempoNetworkName?: string;
  /** When verbose, the Tempo chain id to mention in the prerequisites. Default 4217. */
  tempoChainId?: number;
}

/**
 * Generate the standard "## Payment" section for a merchant's llms.txt. Documents the
 * supported rails with concrete CLI examples (tempo request, agentscore-pay, link-cli)
 * per the configured rail set.
 *
 * Pass `verbose: true` for the rich variant — multi-step setup + multi-line command examples +
 * exact-amount warnings. Default is the compact one-bullet-per-rail form.
 */
export function llmsTxtPaymentSection(input: LlmsTxtPaymentSectionConfig): string {
  return input.verbose ? llmsTxtPaymentSectionVerbose(input) : llmsTxtPaymentSectionCompact(input);
}

function hasRailFamily(rails: string[], prefix: string): boolean {
  return rails.some(r => r.startsWith(prefix));
}

function isTestnetRail(rails: string[], prefix: string): boolean {
  return rails.some(r => r.startsWith(prefix) && /(sepolia|devnet|moderato|testnet)/.test(r));
}

function llmsTxtPaymentSectionCompact(input: LlmsTxtPaymentSectionConfig): string {
  const lines: string[] = ['## Payment', ''];
  const rails = input.rails;
  if (hasRailFamily(rails, 'tempo-')) {
    lines.push('- **Tempo USDC via MPP** — `tempo request -X POST -H "X-Operator-Token: opc_..." --json \'{...}\' --max-spend N ' + input.appUrl + '`');
  }
  if (hasRailFamily(rails, 'x402-base-')) {
    lines.push('- **x402 USDC on Base** (EIP-3009) — `agentscore-pay pay POST ' + input.appUrl + ' --chain base -H "X-Operator-Token: opc_..." -d \'{...}\'`');
  }
  if (hasRailFamily(rails, 'mpp-solana-')) {
    lines.push('- **USDC on Solana** — `agentscore-pay pay POST ' + input.appUrl + ' --chain solana -H "X-Operator-Token: opc_..." -d \'{...}\'`');
  }
  if (rails.includes('stripe-spt')) {
    lines.push('- **Stripe Shared Payment Token** — agent mints SPT (own Stripe account scoped to networkId, OR `link-cli spend-request create --credential-type shared_payment_token --network-id <profileId> ...`)');
  }
  lines.push('');
  lines.push('IMPORTANT: Do NOT use raw on-chain transfers. Use the CLI commands above so the payment credential is signed and submitted via the protocol handshake.');
  lines.push('');
  return lines.join('\n');
}

function llmsTxtPaymentSectionVerbose(input: LlmsTxtPaymentSectionConfig): string {
  const rails = input.rails;
  const tempoNetwork = input.tempoNetworkName ?? 'tempo-mainnet';
  const tempoChain = input.tempoChainId ?? 4217;
  const hasTempo = hasRailFamily(rails, 'tempo-');
  const hasBase = hasRailFamily(rails, 'x402-base-');
  const hasSolana = hasRailFamily(rails, 'mpp-solana-');
  const hasStripe = rails.includes('stripe-spt');
  const baseNetworkName = isTestnetRail(rails, 'x402-base-') ? 'Base Sepolia' : 'Base';
  const solanaNetworkName = isTestnetRail(rails, 'mpp-solana-') ? 'Solana devnet' : 'Solana';

  const lines: string[] = ['## Payment', ''];
  lines.push('Accepted rails:');
  lines.push('');
  if (hasTempo) lines.push('- **USDC on Tempo**');
  if (hasBase) lines.push(`- **USDC on ${baseNetworkName}**`);
  if (hasSolana) lines.push(`- **USDC on ${solanaNetworkName}**`);
  if (hasStripe) lines.push('- **Stripe Shared Payment Token**');
  lines.push('');

  if (hasTempo) {
    lines.push('### Pay with Tempo');
    lines.push('');
    lines.push('```bash');
    lines.push('curl -fsSL https://tempo.xyz/install | bash');
    lines.push('tempo wallet login');
    lines.push(`tempo wallet whoami     # need USDC.e on ${tempoNetwork} (chain ${tempoChain})`);
    lines.push('tempo wallet fund       # if zero');
    lines.push('');
    lines.push('tempo request -X POST \\');
    lines.push('  -H "X-Operator-Token: opc_..." \\');
    lines.push("  --json '{...}' \\");
    lines.push('  --max-spend N \\');
    lines.push(`  ${input.appUrl}`);
    lines.push('```');
    lines.push('');
  }

  if (hasBase || hasSolana) {
    const chainsLabel = [hasBase && baseNetworkName, hasSolana && solanaNetworkName].filter(Boolean).join(' or ');
    const flags = [hasBase && '`--chain base`', hasSolana && '`--chain solana`'].filter(Boolean).join(' or ');
    lines.push(`### Pay with ${chainsLabel}`);
    lines.push('');
    lines.push('```bash');
    lines.push('npm install -g @agent-score/pay');
    lines.push(`agentscore-pay wallet create ${flags}`);
    lines.push(`agentscore-pay balance ${flags}   # fund the printed address with USDC`);
    lines.push('');
    lines.push(`agentscore-pay pay POST ${input.appUrl} \\`);
    lines.push(`  ${hasBase ? '--chain base' : '--chain solana'} \\`);
    lines.push('  -H "X-Operator-Token: opc_..." \\');
    lines.push("  -d '{...}' \\");
    lines.push('  --max-spend N');
    lines.push('```');
    lines.push('');
  }

  if (hasStripe) {
    lines.push('### Pay with Stripe SPT');
    lines.push('');
    lines.push('Mint a SharedPaymentToken scoped to the `profile_id` from the 402 body, then submit via `Authorization: Payment` with `method=stripe/charge`. Either your own Stripe account or `link-cli spend-request create --credential-type shared_payment_token --network-id <profileId> ...` for Stripe Link wallets.');
    lines.push('');
  }

  lines.push('IMPORTANT: Use the CLIs above. Raw on-chain transfers (e.g. `tempo wallet transfer`, sending USDC manually to deposit addresses) bypass the protocol handshake and the request will not complete.');
  if (hasBase || hasSolana) {
    lines.push('IMPORTANT: Pay the exact amount in the 402 challenge. Overpayments and underpayments cannot be matched.');
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Assemble a complete llms.txt document. Vendor passes their merchant-specific sections
 * (intro, catalog, endpoints, gift orders, shipping, etc.); the helper adds the AgentScore
 * identity + payment boilerplate at the end. Returns the full markdown string.
 */
export function buildLlmsTxt({
  merchantName,
  tagline,
  sections,
  agentscoreIdentity,
  payment,
}: {
  merchantName: string;
  /** Optional 1-line summary under the title. */
  tagline?: string;
  /** Custom merchant-written sections (intro, endpoints, terms, etc.). */
  sections: { heading: string; content: string }[];
  /** Append the AgentScore identity section. */
  agentscoreIdentity?: Parameters<typeof llmsTxtIdentitySection>[0];
  /** Append the standard payment section. */
  payment?: Parameters<typeof llmsTxtPaymentSection>[0];
}): string {
  const parts: string[] = [`# ${merchantName}`];
  if (tagline) {
    parts.push(`> ${tagline}`);
  }
  parts.push('');
  for (const s of sections) {
    parts.push(`## ${s.heading}`);
    parts.push('');
    parts.push(s.content);
    parts.push('');
  }
  if (agentscoreIdentity) {
    parts.push(llmsTxtIdentitySection(agentscoreIdentity));
    parts.push('');
  }
  if (payment) {
    parts.push(llmsTxtPaymentSection(payment));
  }
  return parts.join('\n');
}
