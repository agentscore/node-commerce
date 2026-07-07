import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { aipErrorCode, aipErrorStatus, buildAipErrorBody, buildAipPolicyDenyBody, verifyAitRequest } from '../src/aip/gate';
import { signMessage } from '../src/aip/http-signature';
import { JwksCache } from '../src/aip/jwks';
import { hasAgentIdentityHeader } from '../src/aip/request';
import type { VerifyAitFailure } from '../src/aip/verify';

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

const mintAit = async (iss = ISS): Promise<string> =>
  new SignJWT({
    aip_version: '0.1',
    sub: 'user_abc',
    cnf: { jwk: agentPublicJwk },
    agent: { provider: 'anthropic' },
    trust_level: 'human_present',
    identity: { email: 'b@example.com', email_verified: true, age_over_21: true },
  })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'jwt', kid: KID })
    .setIssuer(iss)
    .setIssuedAt(1715400000)
    .setExpirationTime(1715400300)
    .sign(idpPrivate);

const signedRequest = async (token: string, url = 'https://wine-merchant.com/checkout'): Promise<Request> => {
  const u = new URL(url);
  const { signatureInput, signature } = await signMessage({
    method: 'POST',
    authority: u.host,
    path: u.pathname,
    agentIdentity: token,
    privateJwk: agentPrivateJwk,
    publicJwk: agentPublicJwk,
    created: 1715400010,
    // PoP verifier requires `expires` (replay-window hardening); 60s window like pay.
    expires: 1715400070,
  });
  return new Request(url, {
    method: 'POST',
    headers: { host: u.host, 'agent-identity': token, 'signature-input': signatureInput, signature },
  });
};

const NOW = 1715400020;

describe('verifyAitRequest', () => {
  it('verifies a valid signed request and returns the claims', async () => {
    const req = await signedRequest(await mintAit());
    const r = await verifyAitRequest(req, { jwks: jwks(), now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ait.iss).toBe(ISS);
      expect(r.ait.payload.identity?.age_over_21).toBe(true);
    }
  });

  it('fails with no_token when there is no Agent-Identity header', async () => {
    const req = new Request('https://wine-merchant.com/checkout', { method: 'POST' });
    const r = await verifyAitRequest(req, { jwks: jwks(), now: NOW });
    expect(r).toEqual({ ok: false, failure: 'no_token' });
  });

  it('fails with untrusted_issuer for an unknown IdP', async () => {
    const req = await signedRequest(await mintAit('https://evil.com'));
    const r = await verifyAitRequest(req, { jwks: jwks(), now: NOW });
    expect(r).toEqual({ ok: false, failure: 'untrusted_issuer' });
  });

  it('fails with pop_signature_invalid when the path was tampered', async () => {
    // sign for /checkout but send to /admin
    const token = await mintAit();
    const signed = await signedRequest(token, 'https://wine-merchant.com/checkout');
    const tampered = new Request('https://wine-merchant.com/admin', { method: 'POST', headers: signed.headers });
    const r = await verifyAitRequest(tampered, { jwks: jwks(), now: NOW });
    expect(r).toEqual({ ok: false, failure: 'pop_signature_invalid' });
  });
});

describe('hasAgentIdentityHeader', () => {
  it('detects the header', () => {
    const req = new Request('https://m.com/x', { method: 'POST', headers: { 'agent-identity': 'a.b.c' } });
    expect(hasAgentIdentityHeader(req)).toBe(true);
  });
});

describe('aipErrorStatus', () => {
  it('returns 403 for trust/claims failures', () => {
    expect(aipErrorStatus('untrusted_issuer')).toBe(403);
    expect(aipErrorStatus('invalid_claims')).toBe(403);
  });

  it('returns 401 for presence/signature failures', () => {
    for (const f of ['no_token', 'pop_signature_missing', 'expired_token', 'malformed_token', 'idp_signature_invalid', 'pop_signature_invalid'] as VerifyAitFailure[]) {
      expect(aipErrorStatus(f)).toBe(401);
    }
  });

  it('returns 503 for key_unavailable (IdP JWKS unreachable — retryable, not a client auth failure)', () => {
    expect(aipErrorStatus('key_unavailable')).toBe(503);
  });
});

describe('aipErrorCode', () => {
  it('maps presence failures to agent_identity_required', () => {
    expect(aipErrorCode('no_token')).toBe('agent_identity_required');
    expect(aipErrorCode('pop_signature_missing')).toBe('agent_identity_required');
  });

  it('maps signature/malformed failures to invalid_signature', () => {
    expect(aipErrorCode('idp_signature_invalid')).toBe('invalid_signature');
    expect(aipErrorCode('pop_signature_invalid')).toBe('invalid_signature');
    expect(aipErrorCode('malformed_token')).toBe('invalid_signature');
  });

  it('maps key_unavailable to idp_unavailable (infra failure, distinct from a bad signature)', () => {
    expect(aipErrorCode('key_unavailable')).toBe('idp_unavailable');
  });

  it('passes through untrusted_issuer and expired_token', () => {
    expect(aipErrorCode('untrusted_issuer')).toBe('untrusted_issuer');
    expect(aipErrorCode('expired_token')).toBe('expired_token');
  });

  it('maps invalid_claims to insufficient_claims', () => {
    expect(aipErrorCode('invalid_claims')).toBe('insufficient_claims');
  });
});

describe('buildAipErrorBody', () => {
  it('produces an RFC 9457 problem-details body with a urn:aip:error type', () => {
    const body = buildAipErrorBody('untrusted_issuer');
    expect(body).toEqual({
      type: 'urn:aip:error:untrusted_issuer',
      title: 'untrusted issuer',
      status: 403,
      detail: expect.stringContaining('trusted-issuer'),
    });
  });

  it('status field matches aipErrorStatus', () => {
    expect(buildAipErrorBody('no_token').status).toBe(401);
    expect(buildAipErrorBody('invalid_claims').status).toBe(403);
  });
});

describe('buildAipPolicyDenyBody', () => {
  it('keeps the canonical AgentScore body fields on top of the RFC 9457 envelope', () => {
    const body = buildAipPolicyDenyBody('wallet_not_trusted', ['sanctions_flagged'], {
      error: { code: 'wallet_not_trusted', message: 'denied' },
      reasons: ['sanctions_flagged'],
      agent_instructions: '{"action":"contact_support"}',
    });
    expect(body.type).toBe('urn:aip:error:insufficient_claims');
    expect(body.status).toBe(403);
    expect(body.error).toEqual({ code: 'wallet_not_trusted', message: 'denied' });
    expect(body.agent_instructions).toBe('{"action":"contact_support"}');
  });

  it('reserves the problem+json envelope: merchant extra cannot clobber type/title/status/detail', () => {
    // A merchant onBeforeSession `extra` rides through denialReasonToBody unfiltered; a smuggled
    // `status` would otherwise rewrite both the envelope AND the HTTP status Checkout derives
    // from it. The canonical envelope must always win.
    const body = buildAipPolicyDenyBody('wallet_not_trusted', ['kyc_required'], {
      error: { code: 'wallet_not_trusted', message: 'denied' },
      status: 200,
      type: 'https://evil.example/ok',
      title: 'all good',
      detail: 'nothing to see',
      order_id: 'ord_1',
    });
    expect(body.status).toBe(403);
    expect(body.type).toBe('urn:aip:error:insufficient_claims');
    expect(body.title).toBe('insufficient claims');
    expect(body.detail).toContain('kyc_required');
    // Non-reserved merchant fields still ride through.
    expect(body.order_id).toBe('ord_1');
    expect(body.error).toEqual({ code: 'wallet_not_trusted', message: 'denied' });
  });
});
