import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, type JWK } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { signMessage } from '../src/aip/http-signature';
import { JwksCache } from '../src/aip/jwks';
import { verifyAit, type VerifyRequestContext } from '../src/aip/verify';

const ISS = 'https://issuer.example';
const KID = 'partner-key-2026-05';

// IdP signing keypair
let idpPrivate: CryptoKey;
let idpPublicJwk: JWK;
// Agent (cnf) keypair
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

interface MintOpts {
  iss?: string;
  kid?: string;
  iat?: number;
  exp?: number;
  trustLevel?: string;
  amr?: string[];
  cnfJwk?: JWK;
  omitAgent?: boolean;
}

const mintAit = async (o: MintOpts = {}): Promise<string> => {
  const payload: Record<string, unknown> = {
    aip_version: '0.1',
    sub: 'user_abc123',
    cnf: { jwk: o.cnfJwk ?? agentPublicJwk },
    trust_level: o.trustLevel ?? 'human_present',
    identity: { email: 'b@example.com', email_verified: true },
  };
  if (!o.omitAgent) { payload.agent = { provider: 'anthropic', instance: 'sess-1' }; }
  if (o.amr) { payload.auth = { amr: o.amr, time: 1715399900 }; }

  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'EdDSA', typ: 'jwt', kid: o.kid ?? KID })
    .setIssuer(o.iss ?? ISS)
    .setIssuedAt(o.iat ?? 1715400000)
    .setExpirationTime(o.exp ?? 1715400300)
    .sign(idpPrivate);
};

const jwksFor = (publicJwk: JWK) =>
  new JwksCache({
    trustedIssuers: [ISS],
    fetchImpl: vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'max-age=300' },
      json: async () => ({ keys: [publicJwk] }),
    })),
  });

const REQ = { method: 'POST', authority: 'wine-merchant.com', path: '/checkout' };

const signedCtx = async (token: string, signWith = agentPrivateJwk, signPub = agentPublicJwk, created = 1715400010): Promise<VerifyRequestContext> => {
  const { signatureInput, signature } = await signMessage({
    ...REQ,
    agentIdentity: token,
    privateJwk: signWith,
    publicJwk: signPub,
    created,
  });
  return { ...REQ, agentIdentityHeaders: [token], signatureInput, signature };
};

const NOW = 1715400020;

describe('verifyAit — happy path', () => {
  it('verifies a well-formed, signed AIT end to end', async () => {
    const token = await mintAit();
    const ctx = await signedCtx(token);
    const r = await verifyAit(ctx, { jwks: jwksFor(idpPublicJwk), now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ait.iss).toBe(ISS);
      expect(r.ait.payload.identity?.email).toBe('b@example.com');
    }
  });

  it('verifies a human_confirmed AIT that carries auth.amr', async () => {
    const token = await mintAit({ trustLevel: 'human_confirmed', amr: ['face'] });
    const ctx = await signedCtx(token);
    const r = await verifyAit(ctx, { jwks: jwksFor(idpPublicJwk), now: NOW });
    expect(r.ok).toBe(true);
  });
});

describe('verifyAit — token presence', () => {
  it('returns no_token when no Agent-Identity header', async () => {
    const r = await verifyAit(
      { ...REQ, agentIdentityHeaders: [], signatureInput: 'x', signature: 'y' },
      { jwks: jwksFor(idpPublicJwk), now: NOW },
    );
    expect(r).toEqual({ ok: false, reason: 'no_token' });
  });

  it('returns pop_signature_missing when the RFC 9421 headers are absent', async () => {
    const token = await mintAit();
    const r = await verifyAit(
      { ...REQ, agentIdentityHeaders: [token], signatureInput: null, signature: null },
      { jwks: jwksFor(idpPublicJwk), now: NOW },
    );
    expect(r).toEqual({ ok: false, reason: 'pop_signature_missing' });
  });

  it('strips a Bearer prefix on the Agent-Identity header', async () => {
    const token = await mintAit();
    const { signatureInput, signature } = await signMessage({ ...REQ, agentIdentity: `Bearer ${token}`, privateJwk: agentPrivateJwk, publicJwk: agentPublicJwk, created: 1715400010 });
    const r = await verifyAit({ ...REQ, agentIdentityHeaders: [`Bearer ${token}`], signatureInput, signature }, { jwks: jwksFor(idpPublicJwk), now: NOW });
    expect(r.ok).toBe(true);
  });
});

describe('verifyAit — issuer + key', () => {
  it('rejects an untrusted issuer', async () => {
    const token = await mintAit({ iss: 'https://evil.com' });
    const ctx = await signedCtx(token);
    const r = await verifyAit(ctx, { jwks: jwksFor(idpPublicJwk), now: NOW });
    expect(r).toEqual({ ok: false, reason: 'untrusted_issuer' });
  });

  it('reports key_unavailable when JWKS lacks the kid', async () => {
    const token = await mintAit({ kid: 'unknown-kid' });
    const ctx = await signedCtx(token);
    const r = await verifyAit(ctx, { jwks: jwksFor(idpPublicJwk), now: NOW });
    expect(r).toEqual({ ok: false, reason: 'key_unavailable' });
  });
});

describe('verifyAit — signature + expiry', () => {
  it('rejects an AIT signed by a different IdP key (idp_signature_invalid)', async () => {
    // JWKS serves an unrelated key under the same kid → IdP sig fails.
    const other = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const otherPub = { ...(await exportJWK(other.publicKey)), kid: KID, use: 'sig', alg: 'EdDSA' };
    const token = await mintAit();
    const ctx = await signedCtx(token);
    const r = await verifyAit(ctx, { jwks: jwksFor(otherPub), now: NOW });
    expect(r).toEqual({ ok: false, reason: 'idp_signature_invalid' });
  });

  it('rejects an expired AIT', async () => {
    const token = await mintAit({ iat: 1715300000, exp: 1715300300 });
    const ctx = await signedCtx(token, agentPrivateJwk, agentPublicJwk, 1715300010);
    const r = await verifyAit(ctx, { jwks: jwksFor(idpPublicJwk), now: NOW });
    expect(r).toEqual({ ok: false, reason: 'expired_token' });
  });

  it('rejects an AIT whose iat is in the future (spec step 5)', async () => {
    // Not expired (exp ahead of now) and the PoP is fresh, but iat is well beyond now+skew.
    const token = await mintAit({ iat: NOW + 1000, exp: NOW + 1300 });
    const ctx = await signedCtx(token);
    const r = await verifyAit(ctx, { jwks: jwksFor(idpPublicJwk), now: NOW });
    expect(r).toEqual({ ok: false, reason: 'expired_token' });
  });

  it('rejects an RS256-signed AIT even when the trusted IdP publishes the matching RSA key (alg allowlist, RFC 8725 §3.1)', async () => {
    // Threat: a trusted IdP that publishes a non-Ed25519 `use:sig` key must NOT let an attacker
    // present an RS256 token that verifies. The alg allowlist on jwtVerify pins EdDSA/ES256
    // regardless of what the token header claims or the resolved JWK supports.
    const rsa = await generateKeyPair('RS256', { extractable: true });
    const rsaPub = { ...(await exportJWK(rsa.publicKey)), kid: KID, use: 'sig', alg: 'RS256' };
    const token = await new SignJWT({
      aip_version: '0.1', sub: 'user_abc123', cnf: { jwk: agentPublicJwk },
      agent: { provider: 'anthropic', instance: 'sess-1' }, trust_level: 'human_present',
      identity: { email: 'b@example.com', email_verified: true },
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'jwt', kid: KID })
      .setIssuer(ISS).setIssuedAt(1715400000).setExpirationTime(1715400300)
      .sign(rsa.privateKey);
    const ctx = await signedCtx(token);
    const r = await verifyAit(ctx, { jwks: jwksFor(rsaPub), now: NOW });
    expect(r).toEqual({ ok: false, reason: 'idp_signature_invalid' });
  });
});

describe('verifyAit — claim contract', () => {
  it('rejects a token that is not AIT-shaped (no agent claim)', async () => {
    const token = await mintAit({ omitAgent: true });
    const ctx = await signedCtx(token);
    const r = await verifyAit(ctx, { jwks: jwksFor(idpPublicJwk), now: NOW });
    expect(r).toEqual({ ok: false, reason: 'malformed_token' });
  });

  it('rejects human_confirmed without auth.amr (invalid_claims)', async () => {
    const token = await mintAit({ trustLevel: 'human_confirmed' });
    const ctx = await signedCtx(token);
    const r = await verifyAit(ctx, { jwks: jwksFor(idpPublicJwk), now: NOW });
    expect(r).toEqual({ ok: false, reason: 'invalid_claims' });
  });
});

describe('verifyAit — proof of possession', () => {
  it('rejects when the request is signed by a key other than cnf.jwk (pop_signature_invalid)', async () => {
    // AIT binds agentPublicJwk, but we sign the request with a different key.
    const other = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const otherPriv = await exportJWK(other.privateKey);
    const otherPub = await exportJWK(other.publicKey);
    const token = await mintAit();
    const ctx = await signedCtx(token, otherPriv, otherPub);
    const r = await verifyAit(ctx, { jwks: jwksFor(idpPublicJwk), now: NOW });
    expect(r).toEqual({ ok: false, reason: 'pop_signature_invalid' });
  });

  it('rejects a request whose path was tampered after signing', async () => {
    const token = await mintAit();
    const ctx = await signedCtx(token);
    const tampered = { ...ctx, path: '/admin' };
    const r = await verifyAit(tampered, { jwks: jwksFor(idpPublicJwk), now: NOW });
    expect(r).toEqual({ ok: false, reason: 'pop_signature_invalid' });
  });

  it('rejects (does not throw on) an AIT bound to a P-256 cnf key', async () => {
    // The PoP verifier is Ed25519-only. A structurally-valid, JWT-valid AIT whose cnf is a P-256
    // EC key must return a typed failure (caught by the cnf-key-type guard), NOT crash the gate
    // with an uncaught importJWK throw. Sign the request with the normal Ed25519 agent key — the
    // request signature is irrelevant because the verifier rejects on the cnf key type first.
    const ec = await generateKeyPair('ES256', { extractable: true });
    const ecPub = await exportJWK(ec.publicKey);
    const token = await new SignJWT({
      aip_version: '0.1', sub: 'user_abc123', cnf: { jwk: ecPub },
      agent: { provider: 'anthropic', instance: 'sess-1' }, trust_level: 'human_present',
      identity: { email: 'b@example.com', email_verified: true },
    })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'jwt', kid: KID })
      .setIssuer(ISS).setIssuedAt(1715400000).setExpirationTime(1715400300)
      .sign(idpPrivate);
    const ctx = await signedCtx(token); // signed with the Ed25519 agent key
    const r = await verifyAit(ctx, { jwks: jwksFor(idpPublicJwk), now: NOW });
    // Must be a typed failure, not a throw.
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.reason).toBe('pop_signature_invalid'); }
  });
});

describe('verifyAit — multiple AITs', () => {
  it('verifies when one of several Agent-Identity headers is valid and matches the request signature', async () => {
    const good = await mintAit();
    const badIssuer = await mintAit({ iss: 'https://evil.com' });
    // request signed by the agent key (which `good` binds via cnf)
    const { signatureInput, signature } = await signMessage({ ...REQ, agentIdentity: good, privateJwk: agentPrivateJwk, publicJwk: agentPublicJwk, created: 1715400010 });
    // present the bad-issuer one first, then the good one
    const ctx: VerifyRequestContext = { ...REQ, agentIdentityHeaders: [badIssuer, good], signatureInput, signature };
    const r = await verifyAit(ctx, { jwks: jwksFor(idpPublicJwk), now: NOW });
    // NB: the PoP signature covers `agentIdentity` = the specific header value, so only the
    // header whose value was signed will pass. `good` was signed, so it wins.
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.ait.iss).toBe(ISS); }
  });
});

describe('verifyAit — defense sanity (importJWK round-trip)', () => {
  it('the cnf key returned can be imported (well-formed JWK)', async () => {
    const token = await mintAit();
    const ctx = await signedCtx(token);
    const r = await verifyAit(ctx, { jwks: jwksFor(idpPublicJwk), now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const key = await importJWK(r.ait.cnfJwk, 'EdDSA');
      expect(key).toBeDefined();
      // thumbprint is stable
      const tp = await calculateJwkThumbprint(r.ait.cnfJwk, 'sha256');
      expect(typeof tp).toBe('string');
    }
  });
});
