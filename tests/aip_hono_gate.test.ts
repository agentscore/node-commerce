/**
 * AIP gate wiring for the Hono adapter — the context-getter sibling of express/fastify.
 *
 * `aip_adapters.test.ts` covers express/fastify/web/nextjs; this is Hono's dedicated suite,
 * exercising `aipGate` / `conditionalAipGate` / `getVerifiedAit` end-to-end with a real
 * signed AIT (IdP JWT + RFC 9421 proof-of-possession).
 */
import { Hono } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { signMessage } from '../src/aip/http-signature';
import { JwksCache } from '../src/aip/jwks';
import { aipGate, conditionalAipGate, getVerifiedAit } from '../src/identity/hono';

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

const AUTHORITY = 'wine-merchant.com';
const PATH = '/checkout';
const URL = `https://${AUTHORITY}${PATH}`;
const NOW = 1715400020;

const mintAit = async (opts: { iss?: string; trustLevel?: string; auth?: Record<string, unknown> } = {}): Promise<string> =>
  new SignJWT({
    aip_version: '0.1',
    sub: 'user_abc',
    cnf: { jwk: agentPublicJwk },
    agent: { provider: 'anthropic' },
    trust_level: opts.trustLevel ?? 'human_present',
    ...(opts.auth ? { auth: opts.auth } : {}),
    identity: { email: 'b@example.com', email_verified: true },
  })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'jwt', kid: KID })
    .setIssuer(opts.iss ?? ISS)
    .setIssuedAt(1715400000)
    .setExpirationTime(1715400300)
    .sign(idpPrivate);

const sigHeaders = async (token: string): Promise<Record<string, string>> => {
  const { signatureInput, signature } = await signMessage({
    method: 'POST',
    authority: AUTHORITY,
    path: PATH,
    agentIdentity: token,
    privateJwk: agentPrivateJwk,
    publicJwk: agentPublicJwk,
    created: 1715400010,
    // PoP verifier requires `expires` (replay-window hardening); 60s window like pay.
    expires: 1715400070,
  });
  return { host: AUTHORITY, 'agent-identity': token, 'signature-input': signatureInput, signature };
};

describe('hono aipGate', () => {
  const app = () => {
    const a = new Hono();
    a.post('/checkout', aipGate({ jwks: jwks(), now: NOW }), (c) =>
      c.json({ email: getVerifiedAit(c)?.payload.identity?.email ?? null }),
    );
    return a;
  };

  it('allows a valid AIT and exposes the claims via getVerifiedAit', async () => {
    const res = await app().request(URL, { method: 'POST', headers: await sigHeaders(await mintAit()) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: 'b@example.com' });
  });

  it('denies with 401 problem+json when no AIT is presented', async () => {
    const res = await app().request(URL, { method: 'POST', headers: { host: AUTHORITY } });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect((await res.json()).type).toBe('urn:aip:error:agent_identity_required');
  });

  it('denies with 403 for an untrusted issuer', async () => {
    const res = await app().request(URL, { method: 'POST', headers: await sigHeaders(await mintAit({ iss: 'https://evil.com' })) });
    expect(res.status).toBe(403);
    expect((await res.json()).type).toBe('urn:aip:error:untrusted_issuer');
  });
});

describe('hono conditionalAipGate', () => {
  const app = () => {
    const a = new Hono();
    a.post('/checkout', conditionalAipGate({ jwks: jwks(), now: NOW }), (c) =>
      c.json({ hasAit: getVerifiedAit(c) !== undefined }),
    );
    return a;
  };

  it('flows through unauthenticated when no Agent-Identity header is present', async () => {
    const res = await app().request(URL, { method: 'POST', headers: { host: AUTHORITY } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasAit: false });
  });

  it('enforces the gate when an Agent-Identity header is present', async () => {
    const res = await app().request(URL, { method: 'POST', headers: await sigHeaders(await mintAit()) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasAit: true });
  });

  it('denies a present-but-invalid AIT (untrusted issuer) rather than flowing through', async () => {
    const res = await app().request(URL, { method: 'POST', headers: await sigHeaders(await mintAit({ iss: 'https://evil.com' })) });
    expect(res.status).toBe(403);
  });
});

describe('hono aipGate — trust_level / auth.amr enforcement (standalone gate)', () => {
  const trustApp = (aipOpts: Record<string, unknown>) => {
    const a = new Hono();
    a.post('/checkout', aipGate({ jwks: jwks(), now: NOW, ...aipOpts }), (c) => c.json({ ok: true }));
    return a;
  };

  it('denies weak_auth (403 + required_trust_level) when trust_level is below the requirement', async () => {
    const res = await trustApp({ requireTrustLevel: 'human_confirmed' })
      .request(URL, { method: 'POST', headers: await sigHeaders(await mintAit({ trustLevel: 'human_present' })) });
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = await res.json();
    expect(body.type).toBe('urn:aip:error:weak_auth');
    expect(body.required_trust_level).toBe('human_confirmed');
  });

  it('denies weak_auth (403 + required_amr) when no auth.amr matches', async () => {
    const res = await trustApp({ requireAmr: ['face', 'hwk'] })
      .request(URL, { method: 'POST', headers: await sigHeaders(await mintAit({ trustLevel: 'human_confirmed', auth: { amr: ['pwd'] } })) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.type).toBe('urn:aip:error:weak_auth');
    expect(body.required_amr).toEqual(['face', 'hwk']);
  });

  it('allows when trust_level + auth.amr satisfy the requirement', async () => {
    const res = await trustApp({ requireTrustLevel: 'human_confirmed', requireAmr: ['face'] })
      .request(URL, { method: 'POST', headers: await sigHeaders(await mintAit({ trustLevel: 'human_confirmed', auth: { amr: ['face'] } })) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('attaches trusted_issuers on an untrusted_issuer denial when configured (self-correction)', async () => {
    const res = await trustApp({ trustedIssuers: [ISS] })
      .request(URL, { method: 'POST', headers: await sigHeaders(await mintAit({ iss: 'https://evil.com' })) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.type).toBe('urn:aip:error:untrusted_issuer');
    expect(body.trusted_issuers).toEqual([ISS]);
  });
});
