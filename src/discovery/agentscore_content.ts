/**
 * Standard agent-facing prose for AgentScore-gated merchants.
 *
 * Every AgentScore merchant emits roughly the same skill.md onboarding steps,
 * catalog purchase-mode notes, and endpoint descriptions. These helpers ship
 * those canonical strings so merchants supply only the merchant-specific parts
 * (name, URL, accepted rails) and get consistent agent-facing content back.
 *
 * Rationale: agents that hit one AgentScore merchant should see the same
 * pattern hints at every other one. Custom prose per merchant adds noise
 * without adding information; the SDK owns the cross-merchant boilerplate so
 * it stays consistent.
 */

/**
 * Whether a paid surface accepts redemption codes. Applies to any merchant
 * that bills per-purchase or per-call — goods (catalog rows) and API
 * (per-endpoint or per-tier billing) both use this enum.
 */
export type PurchaseMode = 'redemption_only' | 'coupon_applicable' | 'paid_only';

/**
 * Canonical agent-facing notes for each `purchase_mode`. Surface this in
 * /catalog rows (goods) or in `x-service-info` / `/llms.txt` (API) so agents
 * know whether to expect a `redemption_code` field in the request body.
 */
export const PURCHASE_MODE_NOTES: Readonly<Record<string, string>> = Object.freeze({
  redemption_only:
    'Requires a single-use redemption code (printed on a mailer or other ' +
    'out-of-band delivery). Submit the code in the request body as ' +
    '`redemption_code`. Without a valid code the order is rejected.',
  coupon_applicable:
    'Codes are optional. Without one, settle at list price. With a valid ' +
    'code the discount is applied automatically (percent_off, fixed_off, ' +
    'or fixed_settle).',
  paid_only:
    'Codes are NOT accepted. Settle at the listed price. Submitting a ' +
    '`redemption_code` field returns 400 codes_not_accepted.',
});

/**
 * Canonical agent-facing note for a `purchase_mode`. Falls back to an empty
 * string for unknown modes so responses don't leak `undefined` when the
 * merchant introduces a non-standard mode.
 */
export function purchaseModeNote(mode: string): string {
  return PURCHASE_MODE_NOTES[mode] ?? '';
}

/**
 * Build the canonical skill.md `onboarding_steps` for an AgentScore merchant.
 *
 * Returns a list of imperative step strings the agent follows to bootstrap
 * wallet + Passport, then either browse + buy (goods) or make the paid call
 * (api). Generic across every AgentScore-gated merchant; only the
 * merchantName + appUrl + rails list are substituted in.
 *
 * Rails accepted today: `"tempo"`, `"x402-base"`, `"solana-mpp"`, `"stripe-spt"`.
 * Unknown rail names are passed through verbatim so future rails work without
 * an SDK bump.
 *
 * Pass `vendorType: 'api'` for per-call API providers — the catalog step is
 * dropped and the final step becomes "Make the paid call" instead of "Place
 * the order".
 */
export function buildAgentscoreOnboardingSteps(opts: {
  merchantName: string;
  appUrl: string;
  acceptedRails: string[];
  requiresKyc?: boolean;
  vendorType?: 'goods' | 'api';
}): string[] {
  const { merchantName, appUrl, acceptedRails, requiresKyc = false, vendorType = 'goods' } = opts;
  const railWordMap: Record<string, string> = {
    tempo: 'Tempo USDC',
    'x402-base': 'x402 USDC on Base',
    'solana-mpp': 'Solana SPL USDC',
    'stripe-spt': 'Stripe Shared Payment Token',
  };
  const railsHuman = acceptedRails.map((r) => railWordMap[r] ?? r).join(', ');

  const chainPairs: ReadonlyArray<readonly [string, string]> = [
    ['tempo', 'tempo'],
    ['x402-base', 'base'],
    ['solana-mpp', 'solana'],
  ];
  const flags = chainPairs.filter(([rail]) => acceptedRails.includes(rail)).map(([, flag]) => flag);
  const chainFlags = flags.length > 0 ? flags.join(' | ') : 'tempo|base';

  // Per-rail compatible-client hints; mirrors what `compatibleClientsByRails`
  // emits on the 402 body so the skill.md and the runtime challenge stay in sync.
  const compatibleHints: ReadonlyArray<readonly [string, string]> = [
    ['tempo', '`tempo request` works for tempo USDC.e'],
    ['x402-base', '`x402-proxy` / `purl` work for Base x402'],
    ['stripe-spt', '`@stripe/link-cli` works for Stripe SPT'],
  ];
  const compatibleFragment = compatibleHints
    .filter(([rail]) => acceptedRails.includes(rail))
    .map(([, hint]) => hint)
    .join(', ');

  const installStep =
    'Install agentscore-pay if you don\'t already have a compatible client for your funded chain: ' +
    '`npm i -g @agent-score/pay` (or `brew install agentscore/tap/agentscore-pay`). ' +
    `${merchantName} accepts: ${railsHuman}. agentscore-pay speaks every supported rail; ` +
    (compatibleFragment ? `the rails table also lists per-rail \`compatible_clients\` — ${compatibleFragment}. ` : '') +
    'Any spec-compliant client for an individual rail works too.';
  const bootstrapStep =
    'First-run only: bootstrap wallet + Passport. Run `agentscore-pay agent-guide --json` ' +
    'for the canonical cold-start path — it walks `agentscore-pay init` ' +
    '(creates keystore + per-chain wallet), `agentscore-pay passport login` ' +
    `(one-time KYC${requiresKyc ? '; required for this merchant' : ''}; the human completes a verify URL once and pay caches the operator_token), ` +
    'and `agentscore-pay balance` to see which chain has USDC. Skip if your wallet+Passport are already provisioned.';
  const stripeFallbackStep =
    'If your only payment method is a Stripe / Link card (no crypto), install `@stripe/link-cli` ' +
    'instead of agentscore-pay and use it on the SPT rail. Identity gating still applies — the ' +
    'merchant\'s 403 with `verify_url` lets you bootstrap a Passport even with no crypto wallet involved.';
  const returningUserStep =
    'Returning user note: if you\'ve paid an AgentScore-gated merchant before from this wallet, ' +
    'the wallet is already in your Passport\'s `linked_wallets[]` and identity flows through ' +
    'automatically with no re-KYC prompt. Paying from a NEW wallet while you already hold an ' +
    '`opc_...` token returns 403 `wallet_signer_mismatch`; the body lists `linked_wallets[]` and ' +
    '`agent_instructions.action: resign_or_switch_to_operator_token` with three deterministic ' +
    'recoveries (switch to a linked wallet, drop the operator_token to re-KYC the new wallet, ' +
    'or pre-claim the new wallet via SIWE on agentscore.sh/verify).';
  const pickRailStep =
    `Pick the rail your wallet is funded for. The 402 advertises ${acceptedRails.length} rail${acceptedRails.length === 1 ? '' : 's'}. ` +
    '`agentscore-pay balance` (without `--chain`) lists every chain\'s USDC; pay rejects with ' +
    '`multi_rail_ambiguity` if you don\'t pass `--chain` on a multi-rail challenge.';
  const placeOrderStep =
    `Place the order: \`agentscore-pay pay POST ${appUrl}/purchase --chain <${chainFlags}> ` +
    '-d \'<body>\' --max-spend <amount>` for crypto rails. For Stripe SPT, follow the handoff ' +
    'hint pay emits and use `@stripe/link-cli` instead. Either way pay handles the 402 retry, ' +
    'signing, and Passport attachment; branch on the structured CliError `code` on non-zero ' +
    'exit (insufficient_balance, multi_rail_ambiguity, config_error for missing wallet/Passport, etc.).';
  const makeCallStep =
    `Make the paid call: \`agentscore-pay pay POST ${appUrl}/<endpoint> --chain <${chainFlags}> ` +
    '--max-spend <amount>`; pay handles 402 retry, rail selection, signing, and Passport ' +
    'attachment. Branch on the structured CliError `code` on non-zero exit (insufficient_balance, ' +
    'multi_rail_ambiguity, config_error for missing wallet/Passport, etc.).';

  const acceptsStripe = acceptedRails.includes('stripe-spt');
  if (vendorType === 'api') {
    return [
      installStep,
      bootstrapStep,
      ...(acceptsStripe ? [stripeFallbackStep] : []),
      returningUserStep,
      pickRailStep,
      makeCallStep,
    ];
  }
  return [
    installStep,
    bootstrapStep,
    ...(acceptsStripe ? [stripeFallbackStep] : []),
    returningUserStep,
    `Browse the catalog: \`curl ${appUrl}/catalog\`.`,
    "Read each product's `purchase_mode` and `purchase_note` to decide " +
      'whether a redemption code is required, optional, or rejected.',
    pickRailStep,
    placeOrderStep,
  ];
}

/**
 * Canonical descriptions for the standard AgentScore **goods-merchant**
 * endpoints (`/catalog`, `/catalog/{slug}`, `/purchase`, `/orders/{id}`).
 *
 * Use in `/` discovery JSON, OpenAPI summaries, or anywhere a goods merchant
 * needs to describe what each endpoint does in agent-readable language.
 * Descriptions are merchant-agnostic across goods merchants — they describe
 * response semantics (402 on discovery, 400 on validation, 403 on identity,
 * 200 on success), not the body schema (which varies per merchant; surface
 * that in OpenAPI).
 *
 * Pass `includeOrderStatusRoute: true` for merchants that ship the lightweight
 * `/orders/{id}/status` PII-free variant alongside `/orders/{id}`.
 *
 * **API merchants** (per-call paid endpoints, no catalog/orders concept) do
 * not need this helper — write your own endpoints map and pass it to
 * {@link buildMerchantIndexJson} via the `endpoints` field.
 */
export function standardEndpointDescriptions(opts?: {
  includeOrderStatusRoute?: boolean;
}): Record<string, string> {
  const out: Record<string, string> = {
    'GET /catalog': 'List purchasable products.',
    'GET /catalog/{slug}': 'Single product detail.',
    'POST /purchase':
      'Place an order. Returns 402 on the discovery leg with payment rails; 400 on body rejection; 403 + recovery payload when identity is required; 200 with order confirmation on success.',
    'GET /orders/{id}': 'Order detail (PII). Identity-scoped.',
  };
  if (opts?.includeOrderStatusRoute) {
    out['GET /orders/{id}/status'] = 'Payment status only (no PII).';
  }
  return out;
}

/**
 * Build the canonical AgentScore commerce `/` root discovery body. Works for
 * both goods merchants (catalog + purchase + orders) and API merchants (per-
 * call paid endpoints) — `endpoints` and any merchant-specific fields are
 * passed through `extra`.
 *
 * Common fields surfaced: `name`, `description`, `docs`, `endpoints`,
 * `audience: 'agents'`, `supported_rails`. Pass `extra` for merchant-specific
 * additions: `compliance` for goods merchants, `pricing` for API merchants,
 * `website` for branded fronts.
 *
 * `docs` keys map to absolute URLs; pass whichever discovery surfaces this
 * merchant ships (`llms`, `openapi`, `skill_md`, `mpp`, `agent_card`, `ucp`,
 * `jwks`, `redemption`, ...).
 */
export function buildMerchantIndexJson(opts: {
  name: string;
  description: string;
  docs: Record<string, string>;
  endpoints: Record<string, string>;
  supportedRails: string[];
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    name: opts.name,
    description: opts.description,
    docs: opts.docs,
    endpoints: opts.endpoints,
    audience: 'agents',
    supported_rails: opts.supportedRails,
    ...(opts.extra ?? {}),
  };
}

/**
 * Standard `next_steps` block emitted in a 200 success body. Works for both
 * goods-merchant order-success and API-merchant per-call-success — the
 * `user_message` reinforces the cross-merchant Passport pattern (universal),
 * with merchant-specific copy overridable via `userMessage`.
 *
 * `orderStatusUrl` is emitted as `order_status_url`. API merchants that don't
 * have an order-detail endpoint can either pass a usage/dashboard URL or omit
 * the field by passing an empty string (filtered out before emit).
 *
 * `fulfillmentEta` is goods-specific (shipping window) — omit for API or
 * digital-goods merchants.
 */
export function buildSuccessNextSteps(opts: {
  orderStatusUrl?: string;
  fulfillmentEta?: string;
  userMessage?: string;
}): Record<string, string> {
  const out: Record<string, string> = {
    action: 'done',
    user_message:
      opts.userMessage ??
      'Order complete. Your AgentScore Passport is now active across ' +
        'every AgentScore-gated merchant.',
  };
  if (opts.orderStatusUrl) out.order_status_url = opts.orderStatusUrl;
  if (opts.fulfillmentEta !== undefined) out.fulfillment_eta = opts.fulfillmentEta;
  return out;
}
