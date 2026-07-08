/**
 * Repriced-to-zero settle flows against the REAL mppx server (no fakes on the
 * MPP layer). Reproduces the production no-match pattern: the merchant quotes
 * a nonzero price on the discovery leg, the agent signs a hash/transaction
 * credential against it, and the merchant re-prices to $0 at settle when the
 * work finds nothing. The credential can never settle upstream at $0 (mppx
 * requires a proof credential for zero-amount challenges), so Checkout's
 * carve-out must absorb it: 200, nothing charged, signer recovered for
 * attribution only.
 *
 * Also pins the delegation half with the real server: a $0 PROOF credential
 * reaches mppx's zero-amount path (and a forged one is rejected there, not
 * accepted parse-only).
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Checkout, type CheckoutContext, type MppxComposeOutcome } from '../src/checkout';
import { composeMppxRequest, createMppxServer } from '../src/payment/mppx_server';

const RECIPIENT = '0xc3128D86669e842573306CA82f60A005A41C44D4';
const SIGNER = '0xeb2Ca790F72787c7e61bC6c861353a1e4ACDFCa5';
const TEMPO_TESTNET_USDC = '0x20c0000000000000000000000000000000000000';

function credHeader(payload: Record<string, unknown>, source?: string): string {
  return 'Payment ' + Buffer.from(JSON.stringify({
    challenge: { id: 'ch_repriced_1', realm: 'api.example' },
    payload,
    ...(source !== undefined && { source }),
  })).toString('base64');
}

async function buildRealMppxCheckout(): Promise<{
  checkout: Checkout;
  outcomes: Array<{ railKey?: string; signerAddress?: string | null; txHash?: string | null }>;
}> {
  const server = await createMppxServer({
    rails: { tempo: { recipient: RECIPIENT, testnet: true } },
    secretKey: 'test-secret-not-real-000000000000000000000',
  });
  const outcomes: Array<{ railKey?: string; signerAddress?: string | null; txHash?: string | null }> = [];
  const checkout = new Checkout({
    rails: { tempo: { recipient: RECIPIENT, testnet: true } },
    url: 'https://api.example/enrich',
    // No-match repricing: the settle leg computes $0 when the query misses.
    computePricing: (ctx: CheckoutContext) =>
      ({ amountUsd: (ctx.request.body as { miss?: boolean }).miss ? 0 : 0.01 }),
    composeMppx: async (ctx: CheckoutContext): Promise<MppxComposeOutcome> => {
      const result = await composeMppxRequest(
        server,
        [['tempo/charge', {
          amount: ctx.pricing!.amountUsd.toFixed(2),
          currency: TEMPO_TESTNET_USDC,
          decimals: 6,
        }]],
        new Request(ctx.request.url, { method: 'POST', headers: ctx.request.headers }),
      );
      if (result.status === 402) {
        return { status: 402, headers: Object.fromEntries(result.challenge.headers) };
      }
      return { status: 200, raw: result };
    },
    onSettled: async (_ctx, outcome) => {
      outcomes.push({
        railKey: outcome.railKey,
        signerAddress: outcome.signerAddress,
        txHash: outcome.txHash,
      });
      return { ok: true };
    },
    zeroSettleCarveOut: true,
  });
  return { checkout, outcomes };
}

describe('repriced-to-zero settles against real mppx', () => {
  beforeEach(() => { vi.stubEnv('AGENTSCORE_API_KEY', ''); });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('hash credential signed against a nonzero quote settles FREE when repriced to $0 (no upstream call, no charge)', async () => {
    const { checkout, outcomes } = await buildRealMppxCheckout();
    const result = await checkout.handle({
      method: 'POST',
      url: 'https://api.example/enrich',
      headers: {
        authorization: credHeader(
          { type: 'hash', hash: '0x' + 'ab'.repeat(32) },
          `did:pkh:eip155:42431:${SIGNER}`,
        ),
      },
      body: { miss: true },
    });
    expect(result.status).toBe(200);
    expect(result.settled).toBe(true);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.txHash).toBeNull();
    expect(outcomes[0]!.railKey).toBe('tempo');
    expect(outcomes[0]!.signerAddress).toBe(SIGNER.toLowerCase());
  });

  it('a FORGED $0 proof credential is rejected by the real mppx server (delegation, not parse-only acceptance)', async () => {
    const { checkout, outcomes } = await buildRealMppxCheckout();
    const result = await checkout.handle({
      method: 'POST',
      url: 'https://api.example/enrich',
      headers: {
        authorization: credHeader(
          { type: 'proof', signature: '0x' + 'ab'.repeat(65) },
          `did:pkh:eip155:42431:${SIGNER}`,
        ),
      },
      body: { miss: true },
    });
    expect(result.status).toBe(400);
    expect(result.settled).toBe(false);
    expect(outcomes).toHaveLength(0);
  });

  it('a NONZERO settle with an invalid hash credential still fails through the real server (repricing guard does not leak)', async () => {
    const { checkout, outcomes } = await buildRealMppxCheckout();
    const result = await checkout.handle({
      method: 'POST',
      url: 'https://api.example/enrich',
      headers: {
        authorization: credHeader(
          { type: 'hash', hash: '0x' + 'ab'.repeat(32) },
          `did:pkh:eip155:42431:${SIGNER}`,
        ),
      },
      body: { miss: false },
    });
    // $0.01 challenge → real settle path → the fabricated hash fails
    // verification upstream. The carve-out must NOT absorb nonzero orders.
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.settled).toBe(false);
    expect(outcomes).toHaveLength(0);
  });
});
