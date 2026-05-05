export interface HowToPayRailEntry {
  setup?: string[];
  prerequisite?: string;
  command: string;
  alternative_command?: string;
  what_it_does: string;
}

export interface HowToPayStripeEntry {
  prerequisite: string;
  instructions: string;
  setup_link_cli?: string[];
  command_link_cli?: string[];
  what_it_does_link_cli?: string;
  note?: string;
}

export interface HowToPayBlock {
  tempo?: HowToPayRailEntry;
  x402_base?: HowToPayRailEntry;
  solana_mpp?: HowToPayRailEntry;
  stripe?: HowToPayStripeEntry;
}

export interface BuildHowToPayInput {
  /** The merchant's full URL (e.g., 'https://agents.merchant.example/api/buy'). */
  url: string;
  /** JSON string of the body the agent should retry with — typically the original request body. */
  retryBodyJson: string;
  /** Total amount in USD (string or number). Used to compute max-spend defaults and stripe context. */
  totalUsd: string | number;
  /** Per-rail config — each is optional. Pass only the rails you support. */
  rails: {
    tempo?: { recipient: string; networkName?: string; chainId?: number; recommend?: 'tempo' | 'agentscore-pay' | 'both' };
    x402_base?: { recipient: string; network?: string };
    solana_mpp?: { recipient: string; network?: string };
    stripe?: { profileId?: string | null; productName?: string };
  };
  /** Placeholder text for the operator token in commands. Defaults to '<your_opc_token>'. */
  opTokenPlaceholder?: string;
  /** Override max-spend value used in commands. Default: ceil(totalUsd) + 1. */
  maxSpend?: string | number;
}

const TEMPO_SETUP = [
  'curl -fsSL https://tempo.xyz/install | bash',
  'tempo wallet login',
  'tempo wallet whoami',
  'tempo wallet fund   # if balance is zero',
];

const PAY_SETUP_BASE = [
  'npm install -g @agent-score/pay   # or: brew install agentscore/tap/agentscore-pay',
  'agentscore-pay wallet create --chain base',
  'agentscore-pay balance --chain base   # fund the printed address with USDC on Base',
];

const PAY_SETUP_SOLANA = [
  'npm install -g @agent-score/pay   # or: brew install agentscore/tap/agentscore-pay',
  'agentscore-pay wallet create --chain solana',
  'agentscore-pay balance --chain solana   # fund the printed address with USDC on Solana',
];

/**
 * Build the agent_instructions.how_to_pay block. Generates per-rail setup/command/what_it_does
 * boilerplate so agents see concrete commands per rail in the 402 body. Vendors pass the rails
 * they support; the helper produces the right command for each.
 *
 * Tool recommendations (tempo CLI vs agentscore-pay vs link-cli) are configurable per rail.
 */
export function buildHowToPay(input: BuildHowToPayInput): HowToPayBlock {
  const totalNum = typeof input.totalUsd === 'string' ? Number(input.totalUsd) : input.totalUsd;
  const maxSpend = String(input.maxSpend ?? (Math.ceil(totalNum) + 1).toFixed(2));
  const opToken = input.opTokenPlaceholder ?? '<your_opc_token>';
  const block: HowToPayBlock = {};

  if (input.rails.tempo) {
    const networkName = input.rails.tempo.networkName ?? 'tempo-mainnet';
    const chainId = input.rails.tempo.chainId ?? 4217;
    const recommend = input.rails.tempo.recommend ?? 'both';
    const tempoCommand = `tempo request -X POST -H 'X-Operator-Token: ${opToken}' -H 'Content-Type: application/json' --json '${input.retryBodyJson}' --max-spend ${maxSpend} ${input.url}`;
    const payCommand = `agentscore-pay pay POST ${input.url} --chain tempo -H 'X-Operator-Token: ${opToken}' -H 'Content-Type: application/json' -d '${input.retryBodyJson}' --max-spend ${maxSpend}`;
    block.tempo = {
      setup: TEMPO_SETUP,
      prerequisite: `Run \`tempo wallet whoami\` and confirm USDC.e balance on ${networkName} (chain ${chainId}) is at least $${maxSpend}. If the tempo CLI is not installed, run the setup commands above first.`,
      command: recommend === 'agentscore-pay' ? payCommand : tempoCommand,
      ...(recommend === 'both'
        ? { alternative_command: payCommand }
        : recommend === 'agentscore-pay'
          ? { alternative_command: tempoCommand }
          : {}),
      what_it_does: `Pays via Tempo USDC on ${networkName}.`,
    };
  }

  if (input.rails.x402_base) {
    const network = input.rails.x402_base.network ?? 'eip155:8453';
    block.x402_base = {
      setup: PAY_SETUP_BASE,
      prerequisite: `Run \`agentscore-pay balance --chain base\` and confirm USDC balance on Base (${network}) is at least $${maxSpend}. If the CLI is not installed, run the setup commands above first.`,
      command: `agentscore-pay pay POST ${input.url} --chain base -H 'X-Operator-Token: ${opToken}' -H 'Content-Type: application/json' -d '${input.retryBodyJson}' --max-spend ${maxSpend}`,
      what_it_does: 'Pays via USDC on Base.',
    };
  }

  if (input.rails.solana_mpp) {
    const network = input.rails.solana_mpp.network ?? 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
    block.solana_mpp = {
      setup: PAY_SETUP_SOLANA,
      prerequisite: `Run \`agentscore-pay balance --chain solana\` and confirm USDC balance on Solana (${network}) is at least $${maxSpend}. If the CLI is not installed, run the setup commands above first.`,
      command: `agentscore-pay pay POST ${input.url} --chain solana -H 'X-Operator-Token: ${opToken}' -H 'Content-Type: application/json' -d '${input.retryBodyJson}' --max-spend ${maxSpend}`,
      what_it_does: 'Pays via USDC on Solana.',
    };
  }

  if (input.rails.stripe) {
    const stripeCfg = input.rails.stripe;
    const amountCents = Math.round(totalNum * 100);
    const linkCliBlocked = amountCents > 50000;
    const productName = stripeCfg.productName ?? 'this purchase';
    const sptContext = `Purchasing "${productName}" via the agent commerce API. The user authorized this purchase through their AI agent for $${totalNum}; charge to be settled via shared payment token over the Machine Payments Protocol.`;
    const stripe: HowToPayStripeEntry = {
      prerequisite:
        'Either your own Stripe account with Shared Payment Token acceptance, OR a Stripe Link wallet (any user with link.com).',
      instructions:
        'Mint a SharedPaymentToken scoped to the profile_id advertised in accepted_methods, then submit via Authorization: Payment MPP header with method=stripe/charge.',
    };
    if (stripeCfg.profileId && !linkCliBlocked) {
      stripe.setup_link_cli = [
        'npm install -g @stripe/link-cli   # or use npx -y @stripe/link-cli for one-shot',
        'link-cli auth login   # one-time, opens your Link wallet',
        'link-cli payment-methods list --output-json   # copy a csmrpd_... id',
      ];
      stripe.command_link_cli = [
        `SPEND_ID=$(link-cli spend-request create --payment-method-id <csmrpd_id_from_payment_methods_list> --credential-type shared_payment_token --network-id ${stripeCfg.profileId} --amount ${amountCents} --context "${sptContext}" --request-approval --output-json | jq -r .id)`,
        `link-cli mpp pay ${input.url} --spend-request-id $SPEND_ID --method POST --data '${input.retryBodyJson}' --header 'X-Operator-Token: ${opToken}' --output-json`,
      ];
      stripe.what_it_does_link_cli =
        'Mints a one-time-use SharedPaymentToken scoped to this purchase (user approves in Link wallet), then submits it as the payment credential.';
    } else if (linkCliBlocked) {
      stripe.note = `link-cli SPT path not available for this purchase — Stripe link-cli caps spend requests at $500.00 ($50000 cents); your total is $${totalNum}. Use your own Stripe account with the SharedPaymentToken API instead.`;
    }
    block.stripe = stripe;
  }

  return block;
}
