import { buildPaymentRequestBlob, paymentDirective } from '../payment/directive';

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

  const body = JSON.stringify({
    error: {
      code: 'payment_required',
      message: opts.message ?? 'This endpoint requires payment. Send a valid request body to receive a full challenge.',
    },
    discovery: true,
    ...(opts.docsUrl ? { docs: opts.docsUrl } : {}),
  });

  return {
    status: 402,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': directive,
    },
    body,
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
