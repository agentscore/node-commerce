/**
 * Per-adapter coverage for `getSignerVerdict`: the verdict is REQUEST-SCOPED — it's stashed on
 * the per-request gate state (Hono `c`, Express `req`, Fastify `request`), NOT on the shared core.
 * `getSignerVerdict(ctx)` reads `state.signerVerdict` back. Returns `undefined` when the gate didn't
 * run (no state) or when the request carried no verdict (operator-token / discovery legs). The
 * request-scoping is what defeats the concurrent same-wallet/different-signer slot race; see
 * `getSignerVerdict_race.test.ts` for the interleaving proof.
 */
import Fastify from 'fastify';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SignerVerdict } from '../src/core';

const SENTINEL: SignerVerdict = {
  signer_match: { kind: 'pass', claimedOperator: 'op_a', signerOperator: 'op_a' },
  signer_sanctions: { status: 'clear' },
};

// ---------------------------------------------------------------------------
// Hono
// ---------------------------------------------------------------------------

describe('hono getSignerVerdict', () => {
  it('returns undefined when no gate state', async () => {
    const { getSignerVerdict } = await import('../src/identity/hono');
    const c = { get: (_k: string) => undefined } as unknown as import('hono').Context;
    expect(getSignerVerdict(c)).toBeUndefined();
  });

  it('returns undefined when the request carried no verdict (operator-token / discovery leg)', async () => {
    const { getSignerVerdict } = await import('../src/identity/hono');
    const c = {
      get: (k: string) => (k === '__agentscoreGate' ? { core: {}, signerVerdict: undefined } : undefined),
    } as unknown as import('hono').Context;
    expect(getSignerVerdict(c)).toBeUndefined();
  });

  it('reads the verdict stashed on the per-request state', async () => {
    const { getSignerVerdict } = await import('../src/identity/hono');
    const c = {
      get: (k: string) => (k === '__agentscoreGate' ? { core: {}, signerVerdict: SENTINEL } : undefined),
    } as unknown as import('hono').Context;
    expect(getSignerVerdict(c)).toBe(SENTINEL);
  });
});

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------

describe('express getSignerVerdict', () => {
  it('returns undefined when no gate state', async () => {
    const { getSignerVerdict } = await import('../src/identity/express');
    const req = {} as unknown as Parameters<typeof getSignerVerdict>[0];
    expect(getSignerVerdict(req)).toBeUndefined();
  });

  it('returns undefined when the request carried no verdict', async () => {
    const { getSignerVerdict } = await import('../src/identity/express');
    const req = {
      __agentscoreGate: { core: {}, signerVerdict: undefined },
    } as unknown as Parameters<typeof getSignerVerdict>[0];
    expect(getSignerVerdict(req)).toBeUndefined();
  });

  it('reads the verdict stashed on the per-request state', async () => {
    const { getSignerVerdict } = await import('../src/identity/express');
    const req = {
      __agentscoreGate: { core: {}, signerVerdict: SENTINEL },
    } as unknown as Parameters<typeof getSignerVerdict>[0];
    expect(getSignerVerdict(req)).toBe(SENTINEL);
  });
});

// ---------------------------------------------------------------------------
// Fastify
// ---------------------------------------------------------------------------

describe('fastify getSignerVerdict', () => {
  it('returns undefined when no gate state', async () => {
    const { getSignerVerdict } = await import('../src/identity/fastify');
    const request = {} as unknown as Parameters<typeof getSignerVerdict>[0];
    expect(getSignerVerdict(request)).toBeUndefined();
  });

  it('returns undefined when the request carried no verdict', async () => {
    const { getSignerVerdict } = await import('../src/identity/fastify');
    const request = {
      __agentscoreGate: { core: {}, signerVerdict: undefined },
    } as unknown as Parameters<typeof getSignerVerdict>[0];
    expect(getSignerVerdict(request)).toBeUndefined();
  });

  it('reads the verdict stashed on the per-request state', async () => {
    const { getSignerVerdict } = await import('../src/identity/fastify');
    const request = {
      __agentscoreGate: { core: {}, signerVerdict: SENTINEL },
    } as unknown as Parameters<typeof getSignerVerdict>[0];
    expect(getSignerVerdict(request)).toBe(SENTINEL);
  });
});

// ---------------------------------------------------------------------------
// Deny path — the verdict must be stashed BEFORE onDenied so a custom denial
// handler can read it via getSignerVerdict (e.g. to render the mismatch body).
// ---------------------------------------------------------------------------

const CLAIMED = '0xAAAaaAAaaAAAaaAAAaaAAAaaAAAaaAAAaaAAAaaA';
const SIGNER = '0xC222222222222222222222222222222222222222';

/** x402 payment header whose recovered signer (`payload.authorization.from`) is `from`. */
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

/** Stub `/v1/assess` with an UNFIXABLE compliance deny that carries both signer blocks. */
function stubDenyAssess(): void {
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      decision: 'deny',
      decision_reasons: ['sanctions_flagged'],
      identity_method: 'wallet',
      signer_match: {
        kind: 'wallet_signer_mismatch',
        claimed_operator: 'op_claimed',
        signer_operator: 'op_other',
        expected_signer: CLAIMED.toLowerCase(),
        actual_signer: SIGNER.toLowerCase(),
        linked_wallets: [CLAIMED.toLowerCase()],
      },
      signer_sanctions: { sanctioned: true, ofac_label: 'ETH', sdn_uid: '19011', listed_at: '2019-09-13' },
    }),
  })) as unknown as typeof fetch;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('getSignerVerdict on a DENIED request (custom onDenied)', () => {
  it('hono: the verdict is readable inside onDenied', async () => {
    stubDenyAssess();
    const { agentscoreGate, getSignerVerdict } = await import('../src/identity/hono');
    let seen: SignerVerdict | undefined;
    const app = new Hono();
    app.use('*', agentscoreGate({
      apiKey: 'test-api-key',
      onDenied: (c, reason) => {
        seen = getSignerVerdict(c);
        return c.json({ code: reason.code }, 403);
      },
    }));
    app.get('/buy', (c) => c.json({ ok: true }));
    const res = await app.request('/buy', { headers: { 'x-wallet-address': CLAIMED, 'x-payment': x402Header(SIGNER) } });
    expect(res.status).toBe(403);
    expect(seen?.signer_match?.kind).toBe('wallet_signer_mismatch');
    expect(seen?.signer_sanctions).toMatchObject({ sanctioned: true });
  });

  it('express: the verdict is readable inside onDenied', async () => {
    stubDenyAssess();
    const { agentscoreGate, getSignerVerdict } = await import('../src/identity/express');
    let seen: SignerVerdict | undefined;
    const mw = agentscoreGate({
      apiKey: 'test-api-key',
      onDenied: (req, res, reason) => {
        seen = getSignerVerdict(req);
        res.status(403).json({ code: reason.code });
      },
    });
    const req = {
      method: 'GET',
      url: '/buy',
      headers: { 'x-wallet-address': CLAIMED, 'x-payment': x402Header(SIGNER) },
    } as unknown as Parameters<typeof mw>[0];
    const res = {
      status() { return this; },
      json() { return this; },
    } as unknown as Parameters<typeof mw>[1];
    let nextCalled = false;
    await mw(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(seen?.signer_match?.kind).toBe('wallet_signer_mismatch');
    expect(seen?.signer_sanctions).toMatchObject({ sanctioned: true });
  });

  it('fastify: the verdict is readable inside onDenied', async () => {
    stubDenyAssess();
    const { agentscoreGate, getSignerVerdict } = await import('../src/identity/fastify');
    let seen: SignerVerdict | undefined;
    const app = Fastify();
    await app.register(agentscoreGate, {
      apiKey: 'test-api-key',
      onDenied: (req, reply, reason) => {
        seen = getSignerVerdict(req);
        reply.code(403).send({ code: reason.code });
      },
    });
    app.get('/buy', async () => ({ ok: true }));
    const res = await app.inject({
      method: 'GET',
      url: '/buy',
      headers: { 'x-wallet-address': CLAIMED, 'x-payment': x402Header(SIGNER) },
    });
    expect(res.statusCode).toBe(403);
    expect(seen?.signer_match?.kind).toBe('wallet_signer_mismatch');
    expect(seen?.signer_sanctions).toMatchObject({ sanctioned: true });
    await app.close();
  });
});
