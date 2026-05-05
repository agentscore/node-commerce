import { buildPaymentRequestBlob, paymentDirective } from '../payment/directive';
import { networks } from '../payment/networks';
import { USDC } from '../payment/usdc';
import { paymentRequiredHeader } from '../payment/wwwauthenticate';

/** Placeholder payTo for x402 sample accepts in the discovery probe — the probe
 *  exists for crawlers to find that we support x402, not for actual payment. The
 *  real 402 (returned on a fully-formed request body) carries real deposit
 *  addresses minted from a Stripe PaymentIntent. */
const ZERO_EVM_PAYTO = '0x0000000000000000000000000000000000000000';
const ZERO_SOLANA_PAYTO = '11111111111111111111111111111111';

/**
 * Build a sample x402 accepts entry for a CAIP-2 network. Looks up the USDC asset
 * for the network from the `USDC` registry and uses a placeholder payTo. Used by
 * the discovery probe to advertise x402 support without exposing real deposit
 * addresses.
 *
 * Returns null when the network isn't in the registry — vendors with custom
 * networks should construct accepts entries by hand and pass them via
 * `x402Sample.accepts` directly.
 */
export function sampleX402AcceptForNetwork(
  caip2: string,
  amountAtomic: string = '1000000',
): Record<string, unknown> | null {
  if (caip2 === networks.base.mainnet.caip2) {
    return {
      scheme: 'exact',
      network: caip2,
      amount: amountAtomic,
      asset: USDC.base.mainnet.address,
      payTo: ZERO_EVM_PAYTO,
      maxTimeoutSeconds: 300,
      // ``extra.name`` mirrors the on-chain USDC contract's ``name()`` because
      // EIP-712 domain hashes include this string. Wrong name → every signed
      // payload fails facilitator verify with ``invalid_exact_evm_payload_signature``.
      // Base mainnet USDC returns "USD Coin"; base sepolia USDC returns "USDC".
      extra: { name: 'USD Coin', version: '2' },
    };
  }
  if (caip2 === networks.base.sepolia.caip2) {
    return {
      scheme: 'exact',
      network: caip2,
      amount: amountAtomic,
      asset: USDC.base.sepolia.address,
      payTo: ZERO_EVM_PAYTO,
      maxTimeoutSeconds: 300,
      extra: { name: 'USDC', version: '2' },
    };
  }
  if (caip2 === networks.solana.mainnet.caip2) {
    return {
      scheme: 'exact',
      network: caip2,
      amount: amountAtomic,
      asset: USDC.solana.mainnet.mint,
      payTo: ZERO_SOLANA_PAYTO,
      maxTimeoutSeconds: 300,
    };
  }
  if (caip2 === networks.solana.devnet.caip2) {
    return {
      scheme: 'exact',
      network: caip2,
      amount: amountAtomic,
      asset: USDC.solana.devnet.mint,
      payTo: ZERO_SOLANA_PAYTO,
      maxTimeoutSeconds: 300,
    };
  }
  return null;
}

export interface DiscoveryProbeOptions {
  /** Realm — typically the host of your merchant URL (e.g., "agents.merchant.example"). */
  realm: string;
  /** Symbolic rail name to advertise in the sample challenge (e.g., 'tempo-mainnet'). */
  sampleRail: string;
  /** Sample amount in USD for the probe (e.g., 1.00). Crawlers use this as an example. */
  sampleAmountUsd: number;
  /** A recipient address to use in the sample directive (your real or zero address is fine). */
  sampleRecipient: string;
  /** MPP intent. Defaults to 'charge'. */
  intent?: string;
  /** TTL for the probe challenge in seconds. Defaults to 300 (5 minutes). */
  ttlSeconds?: number;
  /** Optional URL to include in the body for further docs (e.g., your llms.txt). */
  docsUrl?: string;
  /** Optional human-readable message in the body. */
  message?: string;
  /** Optional sample x402 accepts entries. When provided, the probe response also
   *  carries the standard x402 `payment-required` header (base64 PaymentRequired) AND
   *  an `accepts` array in the body — so x402 crawlers (e.g. Coinbase awal's
   *  `x402 details`/`x402 pay`) can discover the endpoint's x402 support without
   *  needing to send a fully-formed business request. Each entry is run through
   *  `aliasAmountFields` so v1-only parsers can read `maxAmountRequired` too.
   *
   *  Pass `networks` (shorthand) for the common case — the helper looks up USDC
   *  per network from the registry and uses placeholder payTo addresses. Or pass
   *  `accepts` directly for full control over the sample shape. */
  x402Sample?: {
    /** Spec version to declare. Defaults to 2. */
    version?: 1 | 2;
    /** Shorthand: array of CAIP-2 network strings. Each is mapped to a sample
     *  USDC accepts entry via `sampleX402AcceptForNetwork`. Networks not in the
     *  USDC registry are silently skipped. Use `accepts` for custom shapes. */
    networks?: string[];
    /** Sample accepts entries. Used when `networks` shorthand isn't enough.
     *  Supplied entries are NOT merged with `networks`-derived entries — pick
     *  one or the other. */
    accepts?: unknown[];
    /** Sample atomic amount used by the `networks` shorthand. Defaults to
     *  `'1000000'` ($1.00 USDC at 6 decimals). Ignored when `accepts` is set. */
    amountAtomic?: string;
    /** Resource URL the probe is responding for. Used in the PAYMENT-REQUIRED header. */
    resourceUrl?: string;
  };
}

export interface DiscoveryProbeResponse {
  status: 402;
  headers: Record<string, string>;
  body: string;
}

/**
 * Build a 402 response advertising a sample Payment challenge. MPP crawlers
 * (mppscan, link-cli mpp decode) probe with empty bodies; merchants need to answer
 * with a properly-formatted Payment directive so the realm can be indexed.
 *
 * Returns a framework-agnostic response shape. Wrap in your framework's response:
 *
 *   const probe = buildDiscoveryProbeResponse({...});
 *   return new Response(probe.body, { status: probe.status, headers: probe.headers });
 */
export function buildDiscoveryProbeResponse(opts: DiscoveryProbeOptions): DiscoveryProbeResponse {
  const probeId = `probe_${Date.now()}`;
  const expires = new Date(Date.now() + (opts.ttlSeconds ?? 300) * 1000).toISOString();
  const request = buildPaymentRequestBlob({
    rail: opts.sampleRail,
    amountUsd: opts.sampleAmountUsd,
    recipient: opts.sampleRecipient,
  });
  const directive = paymentDirective({
    rail: opts.sampleRail,
    id: probeId,
    realm: opts.realm,
    intent: opts.intent,
    expires,
    request,
  });

  const bodyObj: Record<string, unknown> = {
    error: {
      code: 'payment_required',
      message: opts.message ?? 'This endpoint requires payment. Send a valid request body to receive a full challenge.',
    },
    discovery: true,
    ...(opts.docsUrl ? { docs: opts.docsUrl } : {}),
  };
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'www-authenticate': directive,
  };

  if (opts.x402Sample) {
    const x402Version = opts.x402Sample.version ?? 2;
    const sampleAccepts = opts.x402Sample.accepts
      ?? (opts.x402Sample.networks ?? [])
        .map((n) => sampleX402AcceptForNetwork(n, opts.x402Sample!.amountAtomic ?? '1000000'))
        .filter((e): e is Record<string, unknown> => e !== null);
    // paymentRequiredHeader applies aliasAmountFields internally; do the same for
    // the body's `accepts` so v1-only parsers (Coinbase awal at payments-mcp.coinbase.com)
    // and v2-strict parsers can both read either field name.
    headers['payment-required'] = paymentRequiredHeader({
      x402Version,
      accepts: sampleAccepts,
      ...(opts.x402Sample.resourceUrl
        ? { resource: { url: opts.x402Sample.resourceUrl, mimeType: 'application/json' } }
        : {}),
    });
    // Also embed in body for clients that read body-level accepts (e.g. awal x402 details
    // falls back from header → body when the header isn't present).
    bodyObj.x402Version = x402Version;
    // Reuse the header's already-aliased accepts so the body matches.
    const headerJson = JSON.parse(Buffer.from(headers['payment-required'], 'base64').toString('utf-8'));
    bodyObj.accepts = headerJson.accepts;
  }

  return {
    status: 402,
    headers,
    body: JSON.stringify(bodyObj),
  };
}

export interface RequestLike {
  method: string;
  headers: { get(name: string): string | null };
  clone(): { text(): Promise<string> };
}

/**
 * Returns true when the request is an empty-body POST without a payment credential —
 * the canonical MPP discovery probe pattern. Vendors compose this with
 * buildDiscoveryProbeResponse to short-circuit crawler requests before any business
 * logic runs.
 */
export async function isDiscoveryProbeRequest(req: RequestLike): Promise<boolean> {
  if (req.method !== 'POST') return false;
  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Payment ')) return false;
  const body = await req.clone().text();
  return !body || body === '{}';
}
