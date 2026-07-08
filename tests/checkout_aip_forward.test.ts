/**
 * Checkout × AIP — assess forwarding contract.
 *
 * After the edge fail-fast verify passes, the gate must forward BOTH the `aip_token` AND the
 * RFC 9421 signature material to `/v1/assess`, so the API (the authoritative verifier) re-checks
 * proof-of-possession itself instead of trusting the edge. This pins that the material reaches
 * `sdk.assess`. The SDK is mocked to capture the call args (and short-circuit the network).
 */
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Checkout, type CheckoutRequest } from '../src/checkout';
import type { X402BaseRailSpec } from '../src/payment/rail_spec';

const { assessCalls, assessState } = vi.hoisted(() => ({
  assessCalls: [] as Array<{ address: string | null; options: Record<string, unknown> }>,
  // Mutable per-test response from the mocked SDK assess. Defaults to allow; a test can flip it to
  // a deny decision to exercise the AIT policy-deny superset body.
  assessState: { response: { decision: 'allow', decision_reasons: ['no_policy_applied'] } as Record<string, unknown> },
}));

vi.mock('@agent-score/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-score/sdk')>();
  return {
    ...actual,
    AgentScore: class {
      async assess(address: string | null, options: Record<string, unknown>) {
        assessCalls.push({ address, options });
        return {
          explanation: [],
          identity_method: 'aip_token',
          operator_verification: { level: 'kyc_verified', operator_type: null, verified_at: null },
          ...assessState.response,
        };
      }
    },
  };
});

const ISS = 'https://issuer.example';
const KID = 'partner-key';
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

afterEach(() => {
  vi.unstubAllGlobals();
  assessCalls.length = 0;
  assessState.response = { decision: 'allow', decision_reasons: ['no_policy_applied'] };
});

async function signedReq(): Promise<CheckoutRequest> {
  const nowSec = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    aip_version: '0.1',
    sub: 'user_x',
    cnf: { jwk: agentPublicJwk },
    agent: { provider: 'anthropic' },
    trust_level: 'human_present',
    identity: { id_verified: true },
  })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'jwt', kid: KID })
    .setIssuer(ISS)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + 300)
    .sign(idpPrivate);
  const authority = 'wine.example';
  const { signMessage } = await import('../src/aip/http-signature');
  const { signatureInput, signature } = await signMessage({
    method: 'POST',
    authority,
    path: '/purchase',
    agentIdentity: token,
    privateJwk: agentPrivateJwk,
    publicJwk: agentPublicJwk,
    created: nowSec,
    // PoP verifier requires `expires` (replay-window hardening); 60s window like pay.
    expires: nowSec + 60,
  });
  // The edge verify fetches the issuer JWKS; stub it. The SDK assess is mocked (no network).
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ keys: [idpPublicJwk] }), {
    status: 200,
    headers: { 'content-type': 'application/jwk-set+json', 'cache-control': 'max-age=300' },
  })));
  return {
    method: 'POST',
    url: 'https://wine.example/purchase',
    headers: {
      host: authority,
      'x-payment': 'eyJzdHViIjogdHJ1ZX0=',
      'agent-identity': token,
      'signature-input': signatureInput,
      signature,
    },
    body: { product_id: 'p1', quantity: 1 },
  };
}

describe('Checkout × AIP — assess forwarding', () => {
  it('forwards aip_token + the RFC 9421 signature material to /v1/assess', async () => {
    const checkout = new Checkout({
      rails: { x402_base: { recipient: '0xT', network: 'eip155:8453' } as X402BaseRailSpec },
      url: 'https://wine.example/purchase',
      computePricing: () => ({ amountUsd: 50 }),
      gate: { apiKey: 'as_test_key', aip: { trustedIssuers: [ISS] } },
    });
    // assess (mocked) returns allow → checkout proceeds toward x402 settle, which throws on the
    // JWKS-only fetch stub. We only assert that assess was reached with the forwarded material.
    await checkout.handle(await signedReq()).catch(() => {});

    expect(assessCalls).toHaveLength(1);
    const opts = assessCalls[0]!.options;
    expect(typeof opts.aipToken).toBe('string');
    expect(opts.aipSignature).toMatchObject({ method: 'POST', authority: 'wine.example', path: '/purchase' });
    const sig = opts.aipSignature as { signature_input: string; signature: string };
    expect(typeof sig.signature_input).toBe('string');
    expect(typeof sig.signature).toBe('string');
  });
});

describe('Checkout × AIP — policy-deny superset body', () => {
  it('emits the RFC 9457 + AgentScore superset (problem+json) when /v1/assess denies a verified AIT', async () => {
    // A verified AIT that /v1/assess then DENIES on compliance (e.g. sanctions). The body must be
    // BOTH schemes: the AgentScore `{ error.code, agent_instructions, reasons }` AND the spec's
    // `type: urn:aip:error:insufficient_claims` / status 403 — content-negotiated as problem+json.
    assessState.response = { decision: 'deny', decision_reasons: ['sanctions_flagged'] };
    const checkout = new Checkout({
      rails: { x402_base: { recipient: '0xT', network: 'eip155:8453' } as X402BaseRailSpec },
      url: 'https://wine.example/purchase',
      computePricing: () => ({ amountUsd: 50 }),
      gate: { apiKey: 'as_test_key', requireSanctionsClear: true, minAge: 21, aip: { trustedIssuers: [ISS] } },
    });
    const res = await checkout.handle(await signedReq());

    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toBe('application/problem+json');
    // RFC 9457 + AIP-spec envelope.
    expect((res.body as { type?: string }).type).toBe('urn:aip:error:insufficient_claims');
    expect((res.body as { title?: string }).title).toBe('insufficient claims');
    expect((res.body as { status?: number }).status).toBe(403);
    expect((res.body as { detail?: string }).detail).toContain('sanctions_flagged');
    // Escalation hint derived from the gate's effective policy.
    expect((res.body as { required_claims?: string[] }).required_claims).toEqual(['sanctions_clear', 'age_over_21']);
    // Rich AgentScore scheme preserved verbatim — still the source of truth for the agent.
    expect((res.body as { error?: { code?: string } }).error?.code).toBe('wallet_not_trusted');
    expect((res.body as { reasons?: string[] }).reasons).toEqual(['sanctions_flagged']);
    expect((res.body as { agent_instructions?: string }).agent_instructions).toBeTruthy();
  });

  it('maps an expired AIT credential to expired_token (401) while keeping the AgentScore body', async () => {
    // The SDK surfaces a server-side AIT rejection; on the AIT path it becomes the spec's
    // expired_token / invalid_signature family, not insufficient_claims.
    assessState.response = { decision: 'deny', decision_reasons: ['kyc_required'] };
    const checkout = new Checkout({
      rails: { x402_base: { recipient: '0xT', network: 'eip155:8453' } as X402BaseRailSpec },
      url: 'https://wine.example/purchase',
      computePricing: () => ({ amountUsd: 50 }),
      gate: { apiKey: 'as_test_key', requireKyc: true, aip: { trustedIssuers: [ISS] } },
    });
    const res = await checkout.handle(await signedReq());
    // kyc_required is a compliance reason → insufficient_claims (403), required_claims = id_verified.
    expect(res.status).toBe(403);
    expect((res.body as { type?: string }).type).toBe('urn:aip:error:insufficient_claims');
    expect((res.body as { required_claims?: string[] }).required_claims).toEqual(['id_verified']);
    expect((res.body as { error?: { code?: string } }).error?.code).toBe('wallet_not_trusted');
  });
});
