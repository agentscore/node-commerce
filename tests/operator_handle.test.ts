/**
 * The operator handle: the identity durable merchant state keys on.
 *
 * The whole reason it exists is that an `opc_` token is the WRONG key. It lives 24h and
 * rotates silently off a 90-day refresh, so anything keyed on the token instance is
 * stranded daily, and revoking a leaked token would forfeit a prepaid balance. The handle
 * derives from the account behind the token instead.
 *
 * It rides the gate's existing `/v1/assess` response rather than a lookup of its own, so
 * these tests pin the two properties that follow from that choice and would be easy to lose
 * in a refactor: the gate makes NO second call to get it, and it survives on the deny path
 * where the handler never runs.
 */

import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentscoreGate, getOperatorHandle } from '../src/identity/hono';

const HANDLE = `oph_${'a'.repeat(40)}`;

/** Minimal /v1/assess double. Returns the real platform shape and counts calls, because
 *  "no extra round trip" is the claim most worth holding still. */
function mockAssess(body: Record<string, unknown>, status = 200) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }));
  return calls;
}

const gatedApp = () => {
  const app = new Hono();
  app.use('/buy', agentscoreGate({ apiKey: 'as_test_key' }));
  app.post('/buy', (c) => c.json({ handle: getOperatorHandle(c) ?? null }));
  return app;
};

const post = (app: Hono, headers: Record<string, string> = {}) =>
  app.request('/buy', { method: 'POST', headers });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getOperatorHandle', () => {
  it('surfaces the handle from the assess response with NO second API call', async () => {
    const calls = mockAssess({
      decision: 'allow',
      decision_reasons: [],
      identity_method: 'operator_token',
      operator_handle: HANDLE,
    });

    const res = await post(gatedApp(), { 'x-operator-token': 'opc_live_token' });
    expect(await res.json()).toEqual({ handle: HANDLE });

    // The point of folding the handle into assess: exactly one call, and it is assess.
    // A second entry here means someone reintroduced a resolve round trip, which is both
    // latency on a hot path and an unmetered call the merchant never asked for.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/v1/assess');
  });

  it('is available on the DENY path, where the handler never runs', async () => {
    // A merchant recording a denial against a buyer needs the key on exactly this path.
    mockAssess({
      decision: 'deny',
      decision_reasons: ['sanctions_flagged'],
      identity_method: 'operator_token',
      operator_handle: HANDLE,
    });

    const app = new Hono();
    let seen: string | undefined | null = 'unset';
    app.use('/buy', agentscoreGate({
      apiKey: 'as_test_key',
      requireSanctionsClear: true,
      onDenied: (c) => {
        seen = getOperatorHandle(c);
        return c.json({ denied: true }, 403);
      },
    }));
    app.post('/buy', (c) => c.json({ ok: true }));

    const res = await post(app, { 'x-operator-token': 'opc_live_token' });
    expect(res.status).toBe(403);
    expect(seen).toBe(HANDLE);
  });

  it('survives the gate cache, so a second request still keys state correctly', async () => {
    // The cached branch recomputes projections from the stored raw response. Forgetting the
    // handle there would strand every request after the first with no key, which reads as
    // an anonymous buyer rather than as a bug.
    const calls = mockAssess({
      decision: 'allow',
      decision_reasons: [],
      identity_method: 'operator_token',
      operator_handle: HANDLE,
    });
    const app = gatedApp();
    const headers = { 'x-operator-token': 'opc_live_token' };

    expect(await (await post(app, headers)).json()).toEqual({ handle: HANDLE });
    expect(await (await post(app, headers)).json()).toEqual({ handle: HANDLE });
    expect(calls).toHaveLength(1); // second request served from cache
  });

  it('is undefined on the wallet path and when the API omits it', async () => {
    // Wallet-authenticated requests have no operator token, so there is no account handle
    // to mint. Undefined must mean "no handle", never an empty-ish key a merchant could
    // accidentally write rows against.
    mockAssess({ decision: 'allow', decision_reasons: [], identity_method: 'wallet' });
    const res = await post(gatedApp(), { 'x-wallet-address': '0x' + '1'.repeat(40) });
    expect(await res.json()).toEqual({ handle: null });
  });

  it('ignores a malformed handle rather than keying state on it', async () => {
    // An unsalted or half-configured API must not be able to hand a merchant a value that
    // looks usable. Anything that is not an `oph_` string reads as absent.
    mockAssess({
      decision: 'allow',
      decision_reasons: [],
      identity_method: 'operator_token',
      operator_handle: '',
    });
    const res = await post(gatedApp(), { 'x-operator-token': 'opc_live_token' });
    expect(await res.json()).toEqual({ handle: null });
  });

  it('returns undefined when the gate never ran on the route', async () => {
    const app = new Hono();
    app.post('/ungated', (c) => c.json({ handle: getOperatorHandle(c) ?? null }));
    const res = await app.request('/ungated', { method: 'POST' });
    expect(await res.json()).toEqual({ handle: null });
  });
});
