export interface LlmsTxtIdentitySectionInput {
  /** When true, include the AgentScore identity-paths explanation (wallet vs operator-token). */
  agentscore?: boolean;
  /** Compliance policy to mention (KYC, age, jurisdiction). */
  compliance?: {
    require_kyc?: boolean;
    min_age?: number;
    allowed_jurisdictions?: string[];
    require_sanctions_clear?: boolean;
  };
}

/**
 * Generate the standard "Choose your identity header" section for an AgentScore-gated
 * merchant's llms.txt. Explains wallet-auth vs operator-token paths + the cross-merchant
 * memory contract so agents know how to authenticate without reading the API docs.
 */
export function llmsTxtIdentitySection(input: LlmsTxtIdentitySectionInput = {}): string {
  if (!input.agentscore) {
    return '';
  }
  const compliance = input.compliance;
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
  return `## Choose your identity header

AgentScore provides cross-merchant identity — one KYC works for every AgentScore-gated endpoint, no re-verification per site. Pick the right header based on how you plan to pay:

- **Wallet-auth** (preferred for agents with a stable crypto wallet): send \`X-Wallet-Address: 0x...\`. Only works on rails that carry a wallet signature — Tempo MPP and x402 EIP-3009. The wallet you claim MUST sign the payment; we verify that the payment signer resolves to the same operator as the claimed wallet. No TTL, no rotation.
- **Operator-token** (works for every rail): send \`X-Operator-Token: opc_...\`. Required when paying with Stripe SPT or card (those rails have no wallet signer). Reusable across every AgentScore merchant until the token expires.
- **Neither**: you'll get 403 with \`verify_url\` + \`poll_secret\` — complete the session flow once, then reuse the credential (or any wallet that pays under it) forever.

If you reach another AgentScore-gated endpoint in the future, the same credential and/or any linked wallet already works — skip the session flow.

## Memory contract

First-encounter 403 responses (and the POST /v1/sessions success body) include an \`agent_memory\` block describing how AgentScore identity works across merchants. LLM-hosted agents should persist its contents (the pattern, never secrets) so subsequent AgentScore-gated endpoints become returning-customer encounters.${complianceNote}`;
}

export interface LlmsTxtPaymentSectionInput {
  /** Symbolic rail names supported. */
  rails: ('tempo-mainnet' | 'tempo-testnet' | 'x402-base-mainnet' | 'x402-base-sepolia' | 'x402-solana-mainnet' | 'x402-solana-devnet' | 'stripe-spt' | string)[];
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
export function llmsTxtPaymentSection(input: LlmsTxtPaymentSectionInput): string {
  return input.verbose ? llmsTxtPaymentSectionVerbose(input) : llmsTxtPaymentSectionCompact(input);
}

function hasRailFamily(rails: string[], prefix: string): boolean {
  return rails.some(r => r.startsWith(prefix));
}

function isTestnetRail(rails: string[], prefix: string): boolean {
  return rails.some(r => r.startsWith(prefix) && /(sepolia|devnet|moderato|testnet)/.test(r));
}

function llmsTxtPaymentSectionCompact(input: LlmsTxtPaymentSectionInput): string {
  const lines: string[] = ['## Payment', ''];
  const rails = input.rails;
  if (hasRailFamily(rails, 'tempo-')) {
    lines.push('- **Tempo USDC via MPP** — `tempo request -X POST -H "X-Operator-Token: opc_..." --json \'{...}\' --max-spend N ' + input.appUrl + '`');
  }
  if (hasRailFamily(rails, 'x402-base-')) {
    lines.push('- **x402 USDC on Base** (EIP-3009) — `agentscore-pay pay POST ' + input.appUrl + ' --chain base -H "X-Operator-Token: opc_..." -d \'{...}\'`');
  }
  if (hasRailFamily(rails, 'x402-solana-')) {
    lines.push('- **x402 USDC on Solana** (SPL Token) — `agentscore-pay pay POST ' + input.appUrl + ' --chain solana -H "X-Operator-Token: opc_..." -d \'{...}\'`');
  }
  if (rails.includes('stripe-spt')) {
    lines.push('- **Stripe Shared Payment Token** — agent mints SPT (own Stripe account scoped to networkId, OR `link-cli spend-request create --credential-type shared_payment_token --network-id <profileId> ...`)');
  }
  lines.push('');
  lines.push('IMPORTANT: Do NOT use raw on-chain transfers. Use the CLI commands above so the payment credential is signed and submitted via the protocol handshake.');
  lines.push('');
  return lines.join('\n');
}

function llmsTxtPaymentSectionVerbose(input: LlmsTxtPaymentSectionInput): string {
  const rails = input.rails;
  const tempoNetwork = input.tempoNetworkName ?? 'tempo-mainnet';
  const tempoChain = input.tempoChainId ?? 4217;
  const hasTempo = hasRailFamily(rails, 'tempo-');
  const hasBase = hasRailFamily(rails, 'x402-base-');
  const hasSolana = hasRailFamily(rails, 'x402-solana-');
  const hasStripe = rails.includes('stripe-spt');
  const baseNetworkName = isTestnetRail(rails, 'x402-base-') ? 'Base Sepolia' : 'Base';
  const solanaNetworkName = isTestnetRail(rails, 'x402-solana-') ? 'Solana devnet' : 'Solana';

  const lines: string[] = ['## Payment', ''];
  lines.push('This is an agent-first API. All payments are initiated and completed by agents. The 402 challenge advertises:');
  lines.push('');
  if (hasTempo) lines.push('- **Tempo USDC via MPP** (on-chain stablecoin)');
  if (hasBase || hasSolana) {
    const chains = [hasBase && `${baseNetworkName} (EIP-3009)`, hasSolana && `${solanaNetworkName} (SPL Token)`].filter(Boolean).join(' and ');
    lines.push(`- **x402 USDC** on ${chains}, via the Coinbase facilitator`);
  }
  if (hasStripe) lines.push('- **Stripe Shared Payment Token** (agent mints SPT on their Stripe account scoped to our networkId in the challenge, submits it in the credential)');
  lines.push('');

  if (hasTempo) {
    lines.push('### How to pay with Tempo');
    lines.push('');
    lines.push('1. Install the Tempo CLI: curl -fsSL https://tempo.xyz/install | bash');
    lines.push('2. Log in to your Tempo Wallet: tempo wallet login (passkey auth in browser)');
    lines.push(`3. Confirm your balance: tempo wallet whoami (need USDC.e on ${tempoNetwork}, chain ${tempoChain})`);
    lines.push('4. If balance is zero, fund it: tempo wallet fund');
    lines.push('');
    lines.push('Then use `tempo request` to make the paid purchase:');
    lines.push('');
    lines.push('tempo request -X POST \\');
    lines.push('  -H "X-Operator-Token: opc_your_credential" \\');
    lines.push('  -H "Content-Type: application/json" \\');
    lines.push("  --json '{...}' \\");
    lines.push('  --max-spend N \\');
    lines.push(`  ${input.appUrl}`);
    lines.push('');
    lines.push(`\`tempo request\` handles the full MPP handshake: sends the POST, receives the 402 challenge, signs the payment on ${tempoNetwork}, submits the credential, and returns the completed order.`);
    lines.push('');
  }

  if (hasBase || hasSolana) {
    const chainsLabel = [hasBase && baseNetworkName, hasSolana && solanaNetworkName].filter(Boolean).join(' or ');
    const flags = [hasBase && '`--chain base`', hasSolana && '`--chain solana`'].filter(Boolean).join(' or ');
    lines.push(`### How to pay with x402 (${chainsLabel})`);
    lines.push('');
    lines.push('1. Install the agentscore-pay CLI: npm install -g @agent-score/pay  (or: brew install agentscore/tap/agentscore-pay)');
    lines.push(`2. Create a wallet on your chain of choice: agentscore-pay wallet create ${flags}`);
    lines.push(`3. Fund the printed address with USDC on ${chainsLabel}`);
    lines.push(`4. Confirm balance: agentscore-pay balance ${flags}`);
    lines.push('');
    lines.push('Then submit the paid purchase:');
    lines.push('');
    lines.push(`agentscore-pay pay POST ${input.appUrl} \\`);
    lines.push(`  ${hasBase ? '--chain base' : '--chain solana'} \\`);
    lines.push('  -H "X-Operator-Token: opc_your_credential" \\');
    lines.push('  -H "Content-Type: application/json" \\');
    lines.push("  -d '{...}' \\");
    lines.push('  --max-spend N');
    lines.push('');
    const handshakeChains = [hasBase && 'EIP-3009 (Base)', hasSolana && 'SPL Token (Solana)'].filter(Boolean).join(' or ');
    lines.push(`The CLI handles the full x402 handshake: hits the URL, parses the 402 challenge, signs the ${handshakeChains} transaction, submits via X-Payment header, and returns the completed order.`);
    lines.push('');
  }

  if (hasStripe) {
    lines.push('### How to pay with Stripe SPT');
    lines.push('');
    lines.push('Mint a SharedPaymentToken scoped to the profile_id advertised in `accepted_methods.stripe.profile_id`, then submit via `Authorization: Payment` MPP header with `method=stripe/charge`. Either bring your own Stripe account or use `link-cli spend-request create --credential-type shared_payment_token --network-id <profileId> ...` for users with Stripe Link wallets.');
    lines.push('');
  }

  lines.push('IMPORTANT: Do NOT use `tempo wallet transfer` or send USDC manually to the x402 deposit addresses — those bypass the payment handshake and your order will stay in pending_identity.');
  if (hasBase || hasSolana) {
    lines.push('IMPORTANT: x402 payments must be the exact amount specified in the 402 challenge. Overpayments and underpayments cannot be matched and funds may be unrecoverable.');
  }
  lines.push('');
  return lines.join('\n');
}

export interface BuildLlmsTxtInput {
  merchantName: string;
  /** Optional 1-line summary under the title. */
  tagline?: string;
  /** Custom merchant-written sections (intro, endpoints, terms, etc.). */
  sections: { heading: string; content: string }[];
  /** Append the AgentScore identity section. */
  agentscoreIdentity?: LlmsTxtIdentitySectionInput;
  /** Append the standard payment section. */
  payment?: LlmsTxtPaymentSectionInput;
}

/**
 * Assemble a complete llms.txt document. Vendor passes their merchant-specific sections
 * (intro, catalog, endpoints, gift orders, shipping, etc.); the helper adds the AgentScore
 * identity + payment boilerplate at the end. Returns the full markdown string.
 */
export function buildLlmsTxt(input: BuildLlmsTxtInput): string {
  const parts: string[] = [`# ${input.merchantName}`];
  if (input.tagline) {
    parts.push(`> ${input.tagline}`);
  }
  parts.push('');
  for (const s of input.sections) {
    parts.push(`## ${s.heading}`);
    parts.push('');
    parts.push(s.content);
    parts.push('');
  }
  if (input.agentscoreIdentity) {
    parts.push(llmsTxtIdentitySection(input.agentscoreIdentity));
    parts.push('');
  }
  if (input.payment) {
    parts.push(llmsTxtPaymentSection(input.payment));
  }
  return parts.join('\n');
}
