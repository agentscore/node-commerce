import {
  RAIL_SPEC_DEFAULTS,
  type SolanaMppRailSpec,
  type StripeRailSpec,
  type TempoRailSpec,
  type X402BaseRailSpec,
} from '../payment/rail_spec';

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

export interface HowToPayRails {
  tempo?: TempoRailSpec;
  x402_base?: X402BaseRailSpec;
  solana_mpp?: SolanaMppRailSpec;
  stripe?: StripeRailSpec;
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
export function buildHowToPay({
  url,
  retryBodyJson,
  totalUsd,
  rails,
  opTokenPlaceholder,
  maxSpend,
  decimals,
}: {
  /** The merchant's full URL (e.g., 'https://agents.merchant.example/api/buy'). */
  url: string;
  /** JSON string of the body the agent should retry with — typically the original request body. */
  retryBodyJson: string;
  /** Total amount in USD (string or number). Used to compute max-spend defaults and stripe context. */
  totalUsd: string | number;
  /** Per-rail config — each is optional. Pass only the rails you support. */
  rails: HowToPayRails;
  /** Placeholder text for the operator token in commands. Defaults to '<your_opc_token>'.
   *  Pass `null` (gateless merchants) to strip the `-H 'X-Operator-Token: ...'` line entirely
   *  from each rail command — appropriate when the merchant doesn't run an identity gate. */
  opTokenPlaceholder?: string | null;
  /** Override max-spend value used in commands. Default: `ceil(totalUsd) + 1`
   *  (for prices ≥ $1) or `totalUsd.toFixed(decimals)` (for sub-dollar prices,
   *  so the command flags reflect the real amount instead of `1.00`). */
  maxSpend?: string | number;
  /** Fractional digits when formatting the auto-derived `maxSpend` for
   *  sub-dollar / sub-cent prices. Default `2`. */
  decimals?: number;
}): HowToPayBlock {
  const totalNum = typeof totalUsd === 'string' ? Number(totalUsd) : totalUsd;
  const d = decimals ?? 2;
  const defaultMaxSpend = totalNum >= 1 ? (Math.ceil(totalNum) + 1).toFixed(d) : totalNum.toFixed(d);
  const maxSpendStr = String(maxSpend ?? defaultMaxSpend);
  // When opTokenPlaceholder is explicitly null, the merchant is gateless — strip
  // the `-H 'X-Operator-Token: ...'` snippet from every rail command. Otherwise
  // fall back to '<your_opc_token>' for back-compat.
  const gateless = opTokenPlaceholder === null;
  const opToken = opTokenPlaceholder ?? '<your_opc_token>';
  const opTokenHeaderFlag = gateless ? '' : `-H 'X-Operator-Token: ${opToken}' `;
  const block: HowToPayBlock = {};

  if (rails.tempo) {
    const networkName = rails.tempo.testnet ? 'tempo-testnet' : (rails.tempo.network ?? RAIL_SPEC_DEFAULTS.tempo.network);
    const chainId = rails.tempo.chainId ?? RAIL_SPEC_DEFAULTS.tempo.chainId;
    const recommend = rails.tempo.recommend ?? RAIL_SPEC_DEFAULTS.tempo.recommend;
    const tempoCommand = `tempo request -X POST ${opTokenHeaderFlag}-H 'Content-Type: application/json' --json '${retryBodyJson}' --max-spend ${maxSpendStr} ${url}`;
    const payCommand = `agentscore-pay pay POST ${url} --chain tempo ${opTokenHeaderFlag}-H 'Content-Type: application/json' -d '${retryBodyJson}' --max-spend ${maxSpendStr}`;
    block.tempo = {
      setup: TEMPO_SETUP,
      prerequisite: `Run \`tempo wallet whoami\` and confirm USDC.e balance on ${networkName} (chain ${chainId}) is at least $${maxSpendStr}. If the tempo CLI is not installed, run the setup commands above first.`,
      command: recommend === 'agentscore-pay' ? payCommand : tempoCommand,
      ...(recommend === 'both'
        ? { alternative_command: payCommand }
        : recommend === 'agentscore-pay'
          ? { alternative_command: tempoCommand }
          : {}),
      what_it_does: `Pays via Tempo USDC on ${networkName}.`,
    };
  }

  if (rails.x402_base) {
    const network = rails.x402_base.network ?? RAIL_SPEC_DEFAULTS.x402Base.network;
    block.x402_base = {
      setup: PAY_SETUP_BASE,
      prerequisite: `Run \`agentscore-pay balance --chain base\` and confirm USDC balance on Base (${network}) is at least $${maxSpendStr}. If the CLI is not installed, run the setup commands above first.`,
      command: `agentscore-pay pay POST ${url} --chain base ${opTokenHeaderFlag}-H 'Content-Type: application/json' -d '${retryBodyJson}' --max-spend ${maxSpendStr}`,
      what_it_does: 'Pays via USDC on Base.',
    };
  }

  if (rails.solana_mpp) {
    const network = rails.solana_mpp.network ?? RAIL_SPEC_DEFAULTS.solanaMpp.network;
    block.solana_mpp = {
      setup: PAY_SETUP_SOLANA,
      prerequisite: `Run \`agentscore-pay balance --chain solana\` and confirm USDC balance on Solana (${network}) is at least $${maxSpendStr}. If the CLI is not installed, run the setup commands above first.`,
      command: `agentscore-pay pay POST ${url} --chain solana ${opTokenHeaderFlag}-H 'Content-Type: application/json' -d '${retryBodyJson}' --max-spend ${maxSpendStr}`,
      what_it_does: 'Pays via USDC on Solana.',
    };
  }

  if (rails.stripe) {
    const stripeCfg = rails.stripe;
    const amountCents = Math.round(totalNum * 100);
    const linkCliBlocked = amountCents > 50000;
    const productName = stripeCfg.productName ?? 'this purchase';
    const sptContext = `Purchasing "${productName}" via the agentic commerce API. The user authorized this purchase through their AI agent for $${totalNum}; charge to be settled via shared payment token over the Machine Payments Protocol.`;
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
        gateless
          ? `link-cli mpp pay ${url} --spend-request-id $SPEND_ID --method POST --data '${retryBodyJson}' --output-json`
          : `link-cli mpp pay ${url} --spend-request-id $SPEND_ID --method POST --data '${retryBodyJson}' --header 'X-Operator-Token: ${opToken}' --output-json`,
      ];
      stripe.what_it_does_link_cli =
        'Mints a one-time-use SharedPaymentToken scoped to this purchase (user approves in Link wallet), then submits it as the payment credential.';
    } else if (linkCliBlocked) {
      stripe.note = `link-cli SPT path not available for this purchase: Stripe link-cli caps spend requests at $500.00 ($50000 cents); your total is $${totalNum}. Use your own Stripe account with the SharedPaymentToken API instead.`;
    }
    block.stripe = stripe;
  }

  return block;
}
