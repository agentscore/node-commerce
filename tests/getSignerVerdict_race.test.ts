/**
 * Concurrent wallet-binding bypass via the signer-verdict slot race (src/core.ts + adapters).
 *
 * The gate adapters share ONE `core` (and thus one assess client) across all requests. The signer
 * verdict used to live on a shared map keyed by claimed-ADDRESS only. Two concurrent requests that
 * claim the SAME wallet but sign with DIFFERENT signers both wrote that one slot; whichever assess
 * resolved last won, so the other request's `getSignerVerdict()` read a sibling's verdict — e.g. a
 * mismatched signer could read the honest signer's `pass`, defeating wallet-signer binding.
 *
 * Fix: the verdict is request-scoped — it rides the `evaluate` return value and the adapter stashes
 * it on the PER-REQUEST context (`c`), which `getSignerVerdict(c)` reads back. This test interleaves
 * two same-wallet/different-signer requests through one shared Hono gate and asserts each handler
 * reads its OWN verdict. A barrier holds both handlers until BOTH assess calls have resolved (so a
 * shared last-writer slot would be observable), making a regression fail deterministically.
 */
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentscoreGate, getSignerVerdict } from '../src/identity/hono';

const API_KEY = 'test-api-key';
const CLAIMED = '0xAAAaaAAaaAAAaaAAAaaAAAaaAAAaaAAAaaAAAaaA';

// Two distinct EVM signers for the SAME claimed wallet.
const SIGNER_OK = '0xB111111111111111111111111111111111111111'; // matches → pass
const SIGNER_BAD = '0xC222222222222222222222222222222222222222'; // mismatch

/** Build an x402 payment header whose recovered signer (`payload.authorization.from`) is `from`. */
function x402Header(from: string): string {
  const payload = {
    x402Version: 2,
    scheme: 'exact',
    network: 'eip155:8453',
    accepted: { network: 'eip155:8453', payTo: '0xdead000000000000000000000000000000000000', scheme: 'exact' },
    payload: { authorization: { from } },
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

interface AssessBody {
  signer?: { address: string };
}

/**
 * Stub `global.fetch` for `/v1/assess`: the verdict is derived from the OUTGOING request's signer,
 * so each concurrent request gets the verdict for ITS OWN signer. `gate` (a promise) lets the test
 * hold both assess responses until both calls are in-flight, forcing a real interleave.
 */
function stubInterleavedAssess(gate: Promise<void>): void {
  global.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as AssessBody;
    const signerAddr = body.signer?.address?.toLowerCase();
    await gate; // hold until both requests have issued their assess call

    const res: Record<string, unknown> = {
      decision: 'allow',
      decision_reasons: ['no_policy_applied'],
      identity_method: 'wallet',
    };
    if (signerAddr === SIGNER_BAD.toLowerCase()) {
      res.signer_match = {
        kind: 'wallet_signer_mismatch',
        claimed_operator: 'op_claimed',
        signer_operator: 'op_other',
        expected_signer: CLAIMED.toLowerCase(),
        actual_signer: SIGNER_BAD.toLowerCase(),
        linked_wallets: [CLAIMED.toLowerCase()],
      };
      res.signer_sanctions = { status: 'clear' };
    } else {
      res.signer_match = { kind: 'pass', claimed_operator: 'op_claimed', signer_operator: 'op_claimed' };
      res.signer_sanctions = { status: 'clear' };
    }
    return { ok: true, status: 200, headers: new Headers(), json: async () => res } as unknown as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('signer-verdict slot race — concurrent same-wallet/different-signer requests', () => {
  it('each interleaved request reads its OWN signer verdict (not a sibling’s)', async () => {
    let releaseAssess: (() => void) | undefined;
    const assessGate = new Promise<void>((res) => { releaseAssess = res; });
    stubInterleavedAssess(assessGate);

    // Barrier: both handlers park here until BOTH have entered. Since a handler runs only AFTER its
    // gate evaluate (and thus its verdict stash) completes, the barrier guarantees both stashes have
    // happened before either reads — exactly the window where a shared last-writer slot would leak.
    let entered = 0;
    let releaseBarrier: (() => void) | undefined;
    const barrier = new Promise<void>((res) => { releaseBarrier = res; });
    const reachBarrier = (): Promise<void> => {
      entered += 1;
      if (entered === 2) { releaseBarrier?.(); }
      return barrier;
    };

    // ONE gate (one shared core) mounted on the app — the production sharing model.
    const app = new Hono();
    app.use('*', agentscoreGate({ apiKey: API_KEY }));
    app.get('/buy', async (c) => {
      await reachBarrier();
      const verdict = getSignerVerdict(c);
      return c.json({ kind: verdict?.signer_match?.kind ?? 'none', actual: (verdict?.signer_match as { actualSigner?: string } | undefined)?.actualSigner ?? null });
    });

    const reqOk = app.request('/buy', { headers: { 'x-wallet-address': CLAIMED, 'x-payment': x402Header(SIGNER_OK) } });
    const reqBad = app.request('/buy', { headers: { 'x-wallet-address': CLAIMED, 'x-payment': x402Header(SIGNER_BAD) } });

    // Let both requests issue their assess call, then release the responses together so the two
    // evaluate()s resolve interleaved.
    await Promise.resolve();
    releaseAssess?.();

    const [okRes, badRes] = await Promise.all([reqOk, reqBad]);
    const okBody = await okRes.json() as { kind: string; actual: string | null };
    const badBody = await badRes.json() as { kind: string; actual: string | null };

    // The honest-signer request must read `pass`; the mismatched-signer request must read its OWN
    // mismatch verdict (with ITS signer baked in) — never the sibling's.
    expect(okBody.kind).toBe('pass');
    expect(badBody.kind).toBe('wallet_signer_mismatch');
    expect(badBody.actual).toBe(SIGNER_BAD.toLowerCase());
  });
});
