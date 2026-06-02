/**
 * AIP gate wiring across the non-Hono adapters: express, fastify, web, nextjs, plus the
 * `verifyAitParts` (Node header-map) entry point and `buildVerifyContextFromParts`.
 *
 * Hono has its own dedicated suite (aip_hono_gate.test.ts); this covers the rest so every
 * framework adapter is exercised end-to-end with a real signed AIT.
 */
import Fastify from 'fastify';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyAitParts } from '../src/aip/gate';
import { signMessage } from '../src/aip/http-signature';
import { JwksCache } from '../src/aip/jwks';
import { buildVerifyContextFromParts } from '../src/aip/request';
import type { NextFunction, Request as ExpressRequest, Response as ExpressResponse } from 'express';

const ISS = 'https://issuer.example';
const KID = 'partner-key-2026-05';

let idpPrivate: CryptoKey;
let idpPublicJwk: JWK;
let agentPrivateJwk: JWK;
let agentPublicJwk: JWK;

beforeAll(async () => {
  const idp = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  idpPrivate = idp.privateKey;
  idpPublicJwk = { ...(await exportJWK(idp.publicKey)), kid: KID, use: 'sig', alg: 'EdDSA' };
  const agent = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  agentPrivateJwk = await exportJWK(agent.privateKey);
  agentPublicJwk = await exportJWK(agent.publicKey);
});

const jwks = () =>
  new JwksCache({
    trustedIssuers: [ISS],
    fetchImpl: vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'max-age=300' },
      json: async () => ({ keys: [idpPublicJwk] }),
    })),
  });

const mintAit = async (): Promise<string> =>
  new SignJWT({
    aip_version: '0.1',
    sub: 'user_abc',
    cnf: { jwk: agentPublicJwk },
    agent: { provider: 'anthropic' },
    trust_level: 'human_present',
    identity: { email: 'b@example.com', email_verified: true },
  })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'jwt', kid: KID })
    .setIssuer(ISS)
    .setIssuedAt(1715400000)
    .setExpirationTime(1715400300)
    .sign(idpPrivate);

const AUTHORITY = 'wine-merchant.com';
const PATH = '/checkout';
const NOW = 1715400020;

const sigHeaders = async (token: string): Promise<Record<string, string>> => {
  const { signatureInput, signature } = await signMessage({
    method: 'POST',
    authority: AUTHORITY,
    path: PATH,
    agentIdentity: token,
    privateJwk: agentPrivateJwk,
    publicJwk: agentPublicJwk,
    created: 1715400010,
  });
  return { host: AUTHORITY, 'agent-identity': token, 'signature-input': signatureInput, signature };
};

describe('buildVerifyContextFromParts', () => {
  it('derives path + authority from a bare url and host header', async () => {
    const headers = await sigHeaders(await mintAit());
    const ctx = buildVerifyContextFromParts({ method: 'POST', url: '/checkout?x=1', headers });
    expect(ctx.method).toBe('POST');
    expect(ctx.path).toBe('/checkout');
    expect(ctx.authority).toBe(AUTHORITY);
    expect(ctx.agentIdentityHeaders).toHaveLength(1);
  });

  it('handles a header value array (Node can fold repeats)', () => {
    const ctx = buildVerifyContextFromParts({
      method: 'POST',
      url: '/x',
      headers: { 'agent-identity': ['aaa.bbb.ccc', 'ddd.eee.fff'], host: AUTHORITY },
    });
    expect(ctx.agentIdentityHeaders).toEqual(['aaa.bbb.ccc', 'ddd.eee.fff']);
  });
});

describe('verifyAitParts', () => {
  it('verifies a valid signed AIT from a Node header map', async () => {
    const headers = await sigHeaders(await mintAit());
    const r = await verifyAitParts({ method: 'POST', url: PATH, headers }, { jwks: jwks(), now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.ait.payload.identity?.email).toBe('b@example.com'); }
  });

  it('fails with no_token when the header is absent', async () => {
    const r = await verifyAitParts({ method: 'POST', url: PATH, headers: { host: AUTHORITY } }, { jwks: jwks(), now: NOW });
    expect(r).toEqual({ ok: false, failure: 'no_token' });
  });
});

// Express middleware tested by direct invocation with mock req/res/next — deterministic,
// no HTTP stack (supertest isn't a dep). Express is referenced only for its types here.
interface MockRes {
  statusCode: number;
  contentType: string;
  body: unknown;
  status(s: number): MockRes;
  type(t: string): MockRes;
  json(b: unknown): MockRes;
}

const mockRes = (): MockRes => ({
  statusCode: 0,
  contentType: '',
  body: undefined,
  status(s) { this.statusCode = s; return this; },
  type(t) { this.contentType = t; return this; },
  json(b) { this.body = b; return this; },
});

describe('express aipGate', () => {
  const runMiddleware = async (headers: Record<string, string>) => {
    const { aipGate, getVerifiedAit } = await import('../src/identity/express');
    const mw = aipGate({ jwks: jwks(), now: NOW });
    const req = { method: 'POST', url: PATH, headers } as unknown as ExpressRequest;
    const res = mockRes();
    let nextCalled = false;
    await mw(req, res as unknown as ExpressResponse, (() => { nextCalled = true; }) as NextFunction);
    return { req, res, nextCalled, getVerifiedAit };
  };

  it('allows a valid AIT, calls next, and exposes claims', async () => {
    const { req, nextCalled, getVerifiedAit } = await runMiddleware(await sigHeaders(await mintAit()));
    expect(nextCalled).toBe(true);
    expect(getVerifiedAit(req)?.payload.identity?.email).toBe('b@example.com');
  });

  it('denies with 401 problem+json when no AIT (no next)', async () => {
    const { res, nextCalled } = await runMiddleware({ host: AUTHORITY });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.contentType).toBe('application/problem+json');
    expect((res.body as { type: string }).type).toBe('urn:aip:error:agent_identity_required');
  });

  it('denies with 403 for an untrusted issuer', async () => {
    // mint from an issuer not on the trust list
    const evil = await new SignJWT({ aip_version: '0.1', sub: 'u', cnf: { jwk: agentPublicJwk }, agent: { provider: 'x' } })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'jwt', kid: KID })
      .setIssuer('https://evil.com')
      .setIssuedAt(1715400000)
      .setExpirationTime(1715400300)
      .sign(idpPrivate);
    const { res, nextCalled } = await runMiddleware(await sigHeaders(evil));
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
    expect((res.body as { type: string }).type).toBe('urn:aip:error:untrusted_issuer');
  });
});

describe('fastify aipGate', () => {
  it('allows a valid AIT and denies a missing one', async () => {
    const { aipGate, getVerifiedAit } = await import('../src/identity/fastify');
    const app = Fastify();
    await app.register(aipGate, { jwks: jwks(), now: NOW });
    app.post('/checkout', async (req) => ({ email: getVerifiedAit(req)?.payload.identity?.email ?? null }));

    const ok = await app.inject({ method: 'POST', url: '/checkout', headers: await sigHeaders(await mintAit()) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ email: 'b@example.com' });

    const denied = await app.inject({ method: 'POST', url: '/checkout', headers: { host: AUTHORITY } });
    expect(denied.statusCode).toBe(401);
    expect(denied.json().type).toBe('urn:aip:error:agent_identity_required');
    await app.close();
  });
});

describe('web createAipGate / withAipGate', () => {
  it('createAipGate allows + denies', async () => {
    const { createAipGate } = await import('../src/identity/web');
    const guard = createAipGate({ jwks: jwks(), now: NOW });

    const okReq = new Request(`https://${AUTHORITY}${PATH}`, { method: 'POST', headers: await sigHeaders(await mintAit()) });
    const ok = await guard(okReq);
    expect(ok.allowed).toBe(true);

    const badReq = new Request(`https://${AUTHORITY}${PATH}`, { method: 'POST' });
    const bad = await guard(badReq);
    expect(bad.allowed).toBe(false);
    if (!bad.allowed) { expect(bad.response.status).toBe(401); }
  });

  it('withAipGate passes the verified ait to the handler', async () => {
    const { withAipGate } = await import('../src/identity/web');
    const handler = withAipGate({ jwks: jwks(), now: NOW }, (_req, { ait }) =>
      Response.json({ email: ait.payload.identity?.email ?? null }),
    );
    const res = await handler(new Request(`https://${AUTHORITY}${PATH}`, { method: 'POST', headers: await sigHeaders(await mintAit()) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: 'b@example.com' });
  });

  it('withConditionalAipGate flows through when no Agent-Identity header', async () => {
    const { withConditionalAipGate } = await import('../src/identity/web');
    const handler = withConditionalAipGate({ jwks: jwks(), now: NOW }, (_req, { ait }) =>
      Response.json({ hasAit: ait !== undefined }),
    );
    const res = await handler(new Request(`https://${AUTHORITY}${PATH}`, { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasAit: false });
  });
});

describe('nextjs AIP re-exports', () => {
  it('re-exports the web AIP gate', async () => {
    const next = await import('../src/identity/nextjs');
    const web = await import('../src/identity/web');
    expect(next.createAipGate).toBe(web.createAipGate);
    expect(next.withAipGate).toBe(web.withAipGate);
    expect(next.withConditionalAipGate).toBe(web.withConditionalAipGate);
  });
});
