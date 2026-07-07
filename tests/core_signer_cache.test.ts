/**
 * Cache-poisoning bypass of wallet-signer binding + signer-OFAC (src/core.ts).
 *
 * The assess response cache was keyed by IDENTITY only (claimed wallet / operator_token / aip
 * hash); the payment SIGNER was not part of the key. So a 2nd request inside `cacheSeconds` that
 * claimed the same wallet but signed with a DIFFERENT wallet hit the cached decision and returned
 * the first signer's stale `signer_match: pass` / `signer_sanctions: clear` — the API never
 * re-screened the new signer. Variant: a sanctioned 2nd signer would settle on the cached `clear`.
 *
 * Fix: fold the normalized signer (address + network) into the response cache key whenever a
 * signer is present, so a different signer is a cache MISS and gets re-screened. These tests pin
 * that contract by stubbing `global.fetch` (the real SDK + real core run on top) and driving two
 * different signers for one claimed identity. The verdict is read off each `evaluate` call's
 * RETURN VALUE (`outcome.signerVerdict`) — request-scoped, so one request can't read another's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentScoreCore } from '../src/core';
import type { PaymentSigner } from '../src/signer';

const API_KEY = 'test-api-key';
const CLAIMED = '0xAAAaaAAaaAAAaaAAAaaAAAaaAAAaaAAAaaAAAaaA';

// Two distinct EVM signers for the same claimed wallet.
const SIGNER_OK: PaymentSigner = { address: '0xB111111111111111111111111111111111111111', network: 'evm' };
const SIGNER_MISMATCH: PaymentSigner = { address: '0xC222222222222222222222222222222222222222', network: 'evm' };
// The repo's canonical OFAC test SDN shape (ofac_label 'ETH', sdn_uid 19011) — see hono.test.ts.
const SIGNER_SDN: PaymentSigner = { address: '0xD333333333333333333333333333333333333333', network: 'evm' };

interface AssessBody {
  address?: string;
  signer?: { address: string; network: string };
}

/**
 * Stub `global.fetch` to answer `/v1/assess` based on the OUTGOING request body's signer. Records
 * one entry per call so tests can assert cache-hit (no new fetch) vs cache-miss (re-screen).
 */
function stubAssessFetch(): { calls: AssessBody[] } {
  const calls: AssessBody[] = [];
  global.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as AssessBody;
    calls.push(body);
    const signerAddr = body.signer?.address?.toLowerCase();

    // Base allow envelope.
    const res: Record<string, unknown> = {
      decision: 'allow',
      decision_reasons: ['no_policy_applied'],
      identity_method: 'wallet',
    };

    if (signerAddr === SIGNER_SDN.address.toLowerCase()) {
      // OFAC SDN signer: the unconditional wallet screen flips the decision to deny and the
      // signer_sanctions verdict is flagged regardless of policy.
      res.decision = 'deny';
      res.decision_reasons = ['signer_sanctioned'];
      res.signer_match = {
        kind: 'wallet_signer_mismatch',
        claimed_operator: 'op_claimed',
        signer_operator: null,
        expected_signer: CLAIMED.toLowerCase(),
        actual_signer: SIGNER_SDN.address.toLowerCase(),
        linked_wallets: [],
      };
      res.signer_sanctions = { sanctioned: true, ofac_label: 'ETH', sdn_uid: '19011', listed_at: '2019-09-13' };
    } else if (signerAddr === SIGNER_MISMATCH.address.toLowerCase()) {
      res.signer_match = {
        kind: 'wallet_signer_mismatch',
        claimed_operator: 'op_claimed',
        signer_operator: 'op_other',
        expected_signer: CLAIMED.toLowerCase(),
        actual_signer: SIGNER_MISMATCH.address.toLowerCase(),
        linked_wallets: [CLAIMED.toLowerCase()],
      };
      res.signer_sanctions = { status: 'clear' };
    } else if (signerAddr !== undefined) {
      // Matching / linked signer.
      res.signer_match = { kind: 'pass', claimed_operator: 'op_claimed', signer_operator: 'op_claimed' };
      res.signer_sanctions = { status: 'clear' };
    }

    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => res,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('core — signer is part of the assess cache key (anti cache-poisoning)', () => {
  it('re-screens a DIFFERENT signer within the cache window (does NOT return the first signer’s verdict)', async () => {
    const { calls } = stubAssessFetch();
    const core = createAgentScoreCore({ apiKey: API_KEY, cacheSeconds: 300 });

    // 1st request: same claimed wallet, signed by SIGNER_OK → passes, verdict rides on the outcome.
    const r1 = await core.evaluate({ address: CLAIMED }, undefined, SIGNER_OK);
    expect(r1.kind).toBe('allow');
    expect(r1.signerVerdict?.signer_match?.kind).toBe('pass');
    expect(calls).toHaveLength(1);

    // 2nd request WITHIN the cache window: SAME claimed wallet but a DIFFERENT signer.
    // Pre-fix this hit the cache and returned SIGNER_OK's stale `pass`. It must now MISS and
    // re-screen, surfacing the mismatch verdict for SIGNER_MISMATCH on the 2nd request's OWN outcome.
    const r2 = await core.evaluate({ address: CLAIMED }, undefined, SIGNER_MISMATCH);
    expect(calls).toHaveLength(2); // cache MISS → the new signer was actually re-screened
    // The gate forwards signer.address verbatim on the wire (it only normalizes for the cache key).
    expect(calls[1]?.signer?.address).toBe(SIGNER_MISMATCH.address);

    const v2 = r2.signerVerdict;
    expect(v2?.signer_match?.kind).toBe('wallet_signer_mismatch'); // NOT the stale `pass`
    if (v2?.signer_match?.kind === 'wallet_signer_mismatch') {
      expect(v2.signer_match.actualSigner).toBe(SIGNER_MISMATCH.address.toLowerCase());
    }
    // The FIRST request's outcome still independently holds SIGNER_OK's `pass` — verdicts are
    // per-request (ride the return value), so r2's re-screen can't retroactively mutate r1.
    expect(r1.signerVerdict?.signer_match?.kind).toBe('pass');
    // The decision still surfaces as an allow from /v1/assess here (mismatch is enforced by the
    // adapter via the verdict, not by flipping the decision) — the load-bearing assertion is that
    // the verdict is the new signer's, not the cached one.
    expect(r2.kind).toBe('allow');
  });

  it('flags an OFAC-SDN second signer instead of returning the cached clear (decision flips to deny)', async () => {
    const { calls } = stubAssessFetch();
    const core = createAgentScoreCore({ apiKey: API_KEY, cacheSeconds: 300 });

    // 1st: clean signer → allow + signer_sanctions clear on the outcome.
    const r1 = await core.evaluate({ address: CLAIMED }, undefined, SIGNER_OK);
    expect(r1.kind).toBe('allow');
    expect(r1.signerVerdict?.signer_sanctions).toEqual({ status: 'clear' });

    // 2nd within the window: the SDN wallet signs. Must re-screen (miss) and surface the SDN hit;
    // the unconditional wallet screen flips the decision to deny. The verdict rides on the DENY
    // outcome too (so the gate can shape a wallet_not_trusted body from it).
    const r2 = await core.evaluate({ address: CLAIMED }, undefined, SIGNER_SDN);
    expect(calls).toHaveLength(2);
    expect(r2.kind).toBe('deny');
    if (r2.kind === 'deny') {
      expect(r2.reason.reasons).toContain('signer_sanctioned');
    }
    expect(r2.signerVerdict?.signer_sanctions).toMatchObject({ sanctioned: true, ofac_label: 'ETH', sdn_uid: '19011' });
  });

  it('same identity + same signer twice → cache HIT (one fetch; legitimate caching preserved)', async () => {
    const { calls } = stubAssessFetch();
    const core = createAgentScoreCore({ apiKey: API_KEY, cacheSeconds: 300 });
    await core.evaluate({ address: CLAIMED }, undefined, SIGNER_OK);
    await core.evaluate({ address: CLAIMED }, undefined, SIGNER_OK);
    expect(calls).toHaveLength(1); // identical signer is a hit — no spurious re-screen
  });

  it('same identity, NO signer, twice → cache HIT (identity-only key unchanged)', async () => {
    const { calls } = stubAssessFetch();
    const core = createAgentScoreCore({ apiKey: API_KEY, cacheSeconds: 300 });
    await core.evaluate({ address: CLAIMED }, undefined, null);
    await core.evaluate({ address: CLAIMED }, undefined, null);
    expect(calls).toHaveLength(1); // no-signer path keeps the identity-only key
  });

  it('a no-signer cached allow is NOT reused for a later signed request (different key → re-screen)', async () => {
    const { calls } = stubAssessFetch();
    const core = createAgentScoreCore({ apiKey: API_KEY, cacheSeconds: 300 });
    // Warm the identity-only key with a no-signer allow.
    await core.evaluate({ address: CLAIMED }, undefined, null);
    expect(calls).toHaveLength(1);
    // A subsequent SIGNED request must not borrow the no-signer entry; it gets its own screen.
    const r2 = await core.evaluate({ address: CLAIMED }, undefined, SIGNER_MISMATCH);
    expect(calls).toHaveLength(2);
    expect(r2.signerVerdict?.signer_match?.kind).toBe('wallet_signer_mismatch');
  });

  it('a delimiter-bearing claimed address cannot collide with a real (identity, signer) key', async () => {
    // The wallet-path identityKey passes invalid claimed addresses through lowercased, so with
    // naive string concatenation an attacker could claim "<wallet>|signer:evm:<addr>" (no signer)
    // and poison the cache slot a legitimate (wallet, signer) request would later read. The
    // JSON-parts key makes the crafted pair a distinct entry: the signed request must MISS and
    // be screened on its own fetch.
    const { calls } = stubAssessFetch();
    const core = createAgentScoreCore({ apiKey: API_KEY, cacheSeconds: 300 });
    const crafted = `${CLAIMED.toLowerCase()}|signer:evm:${SIGNER_OK.address.toLowerCase()}`;
    await core.evaluate({ address: crafted }, undefined, null);
    expect(calls).toHaveLength(1);
    const r2 = await core.evaluate({ address: CLAIMED }, undefined, SIGNER_OK);
    expect(calls).toHaveLength(2); // distinct keys → the signed request was actually screened
    expect(r2.signerVerdict?.signer_match?.kind).toBe('pass');
  });
});
