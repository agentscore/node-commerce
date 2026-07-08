/**
 * Checkout gate × AIP integration.
 *
 * Verifies the wiring added to `Checkout.runGate`: when `gate.aip` is configured and a settle-leg
 * request carries an `Agent-Identity` header, the gate verifies the AIT at the edge BEFORE the
 * assess call. A present-but-invalid AIT is a hard deny (RFC 9457 problem+json); a request with no
 * `Agent-Identity` header flows through the existing wallet / operator-token path unchanged.
 *
 * The full happy-path verify (issuer JWKS + RFC 9421 PoP) is covered at the `verifyAitParts`
 * level in aip_verify / aip_gate / aip_adapters; here we assert the orchestrator contract for the
 * invalid cases, which fail before any JWKS fetch (so no real crypto / network is needed).
 *
 * The gate runs only on the settle leg (a payment credential attached), so each request carries
 * an `x-payment` header — otherwise `handle` treats it as anonymous discovery and emits a 402.
 */
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Checkout, type CheckoutRequest } from '../src/checkout';
import type { X402BaseRailSpec } from '../src/payment/rail_spec';

const AIP = { trustedIssuers: ['https://issuer.example', 'https://www.agentscore.com'] };

function makeCheckout(opts: { aip?: typeof AIP } = {}) {
  return new Checkout({
    rails: { x402_base: { recipient: '0xTREASURY', network: 'eip155:8453' } as X402BaseRailSpec },
    url: 'https://wine.example/purchase',
    computePricing: () => ({ amountUsd: 50 }),
    gate: {
      apiKey: 'as_test_key',
      requireKyc: true,
      ...(opts.aip !== undefined && { aip: opts.aip }),
    },
  });
}

// Settle-leg marker: `x-payment` makes `handle` run the gate (and thus the AIP pre-step)
// instead of short-circuiting to an anonymous-discovery 402.
function req(headers: Record<string, string>): CheckoutRequest {
  return {
    method: 'POST',
    url: 'https://wine.example/purchase',
    headers: { 'x-payment': 'eyJzdHViIjogdHJ1ZX0=', ...headers },
    body: { product_id: 'p1', quantity: 1 },
  };
}

describe('Checkout gate × AIP', () => {
  it('hard-denies a present-but-unsigned AIT with problem+json (no fall-through)', async () => {
    // Agent-Identity present but NO Signature-Input/Signature → PoP missing → hard deny.
    const res = await makeCheckout({ aip: AIP }).handle(
      req({ 'agent-identity': 'eyJhbGciOiJFZERTQSJ9.e30.sig' }),
    );
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toBe('application/problem+json');
    expect((res.body as { type?: string }).type).toBe('urn:aip:error:agent_identity_required');
  });

  it('hard-denies a malformed AIT (garbage token + bogus signature headers)', async () => {
    const res = await makeCheckout({ aip: AIP }).handle(
      req({
        'agent-identity': 'not-a-jwt',
        'signature-input':
          'ait=("@method" "@authority" "@path" "agent-identity");keyid="x";tag="agent-identity"',
        signature: 'ait=:AAAA:',
      }),
    );
    // Malformed token → 401 invalid_signature class (never reaches the SDK assess call).
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toBe('application/problem+json');
    expect((res.body as { type?: string }).type).toMatch(/^urn:aip:error:/);
  });

  it('hard-denies an invalid AIT even when the gate has no apiKey (pre-step runs before the no-apiKey fallback)', async () => {
    // Regression for F2: a gate.aip merchant without apiKey must still verify + hard-deny a
    // present-but-invalid AIT, not silently skip AIP via the wallet-OFAC-only fallback.
    const checkout = new Checkout({
      rails: { x402_base: { recipient: '0xTREASURY', network: 'eip155:8453' } as X402BaseRailSpec },
      url: 'https://wine.example/purchase',
      computePricing: () => ({ amountUsd: 50 }),
      gate: { requireKyc: true, aip: AIP }, // no apiKey
    });
    const res = await checkout.handle(req({ 'agent-identity': 'eyJhbGciOiJFZERTQSJ9.e30.sig' }));
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toBe('application/problem+json');
    expect((res.body as { type?: string }).type).toBe('urn:aip:error:agent_identity_required');
  });

  it('does not engage AIP when gate.aip is unset, even if an Agent-Identity header is sent', async () => {
    // No aip config → the Agent-Identity header is ignored. The gate proceeds to the
    // normal assess path; with a fake API key the SDK call fails and surfaces as a
    // non-problem+json denial — the key assertion is that it is NOT the AIP problem body.
    const res = await makeCheckout().handle(req({ 'agent-identity': 'eyJhbGciOiJFZERTQSJ9.e30.sig' }));
    expect(res.headers['content-type']).not.toBe('application/problem+json');
  });

  it('renders the edge-deny as problem+json THROUGH a framework adapter (not only raw handle)', async () => {
    // Regression: the framework renderers used to strip the content-type + force application/json,
    // silently downgrading the AIP edge-deny problem+json. The Web/Next adapter must now surface it.
    const checkout = makeCheckout({ aip: AIP });
    const request = new Request('https://wine.example/purchase', {
      method: 'POST',
      headers: { 'x-payment': 'eyJzdHViIjogdHJ1ZX0=', 'agent-identity': 'eyJhbGciOiJFZERTQSJ9.e30.sig' },
      body: JSON.stringify({ product_id: 'p1', quantity: 1 }),
    });
    const res = await checkout.handleNextjs(request);
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = (await res.json()) as { type?: string };
    expect(body.type).toBe('urn:aip:error:agent_identity_required');
  });

  it('keeps application/json for a NON-AIP denial through a framework adapter', async () => {
    // The content-type override is AIP-only: a missing-identity (no Agent-Identity header) denial
    // through the same renderer must stay on the application/json default, untouched.
    const checkout = makeCheckout({ aip: AIP });
    const request = new Request('https://wine.example/purchase', {
      method: 'POST',
      // No identity header at all → missing_identity (the gate's no-AIP path), application/json.
      headers: { 'x-payment': 'eyJzdHViIjogdHJ1ZX0=' },
      body: JSON.stringify({ product_id: 'p1', quantity: 1 }),
    });
    const res = await checkout.handleNextjs(request);
    expect(res.headers.get('content-type')).toBe('application/json');
    const body = (await res.json()) as { type?: string };
    expect(body.type).toBeUndefined();
  });
});

// A *valid* signed AIT (real issuer sig + RFC 9421 PoP) requires minting + a live JWKS, so this
// block stubs global fetch to serve the issuer's JWKS. It exercises the no-apiKey offline path:
// a verified AIT through a gate that declares compliance policy but has no apiKey cannot be
// policy-evaluated (no /v1/assess), so it must FAIL CLOSED rather than allow a non-compliant id.
describe('Checkout gate × AIP — offline (no apiKey) policy enforcement', () => {
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

  afterEach(() => vi.unstubAllGlobals());

  // Mint a real AIT + sign the request, real timestamps (Checkout's verify uses the live clock).
  async function signedReq(
    identity: Record<string, unknown>,
    opts: { trustLevel?: string; auth?: Record<string, unknown> } = {},
  ): Promise<CheckoutRequest> {
    const nowSec = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      aip_version: '0.1', sub: 'user_x', cnf: { jwk: agentPublicJwk },
      agent: { provider: 'anthropic' }, trust_level: opts.trustLevel ?? 'human_present',
      ...(opts.auth ? { auth: opts.auth } : {}), identity,
    })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'jwt', kid: KID })
      .setIssuer(ISS).setIssuedAt(nowSec).setExpirationTime(nowSec + 300).sign(idpPrivate);
    const authority = 'wine.example';
    // Lazy import sidesteps an ESM load-order quirk when both http-signature and Checkout
    // (which transitively imports it) are pulled into one test module.
    const { signMessage } = await import('../src/aip/http-signature');
    const { signatureInput, signature } = await signMessage({
      method: 'POST', authority, path: '/purchase', agentIdentity: token,
      // PoP verifier requires `expires` (replay-window hardening); 60s window like pay.
      privateJwk: agentPrivateJwk, publicJwk: agentPublicJwk, created: nowSec, expires: nowSec + 60,
    });
    // Stub the JWKS fetch the Checkout-internal JwksCache will make for ISS.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ keys: [idpPublicJwk] }), {
      status: 200, headers: { 'content-type': 'application/jwk-set+json', 'cache-control': 'max-age=300' },
    })));
    return {
      method: 'POST', url: 'https://wine.example/purchase',
      headers: { host: authority, 'x-payment': 'eyJzdHViIjogdHJ1ZX0=', 'agent-identity': token, 'signature-input': signatureInput, signature },
      body: { product_id: 'p1', quantity: 1 },
    };
  }

  const offlineGate = (extra: Record<string, unknown>) => new Checkout({
    rails: { x402_base: { recipient: '0xT', network: 'eip155:8453' } as X402BaseRailSpec },
    url: 'https://wine.example/purchase',
    computePricing: () => ({ amountUsd: 50 }),
    gate: { aip: { trustedIssuers: [ISS] }, ...extra }, // NO apiKey
  });

  it('FAILS CLOSED when a policy-bearing gate has no apiKey, even for a valid AIT', async () => {
    const res = await offlineGate({ minAge: 21 }).handle(await signedReq({ age_over_18: true }));
    expect(res.status).toBe(403);
    expect((res.body as { error?: { code?: string } }).error?.code).toBe('aip_policy_requires_api_key');
  });

  it('allows a valid AIT on an identity-only gate (reaches settle, not blocked by gate)', async () => {
    // Identity-only gate (no policy fields) + verified AIT + no apiKey -> the gate returns null
    // (allow) and Checkout proceeds to x402 settle. The fetch stub only serves JWKS, so the
    // downstream facilitator init throws -- but reaching settle at all proves the gate did NOT
    // block with aip_policy_requires_api_key. (The fail-closed counterpart returns from the gate
    // before settle, so it asserts on the body directly.)
    await expect(offlineGate({}).handle(await signedReq({ id_verified: true })))
      .rejects.toThrow(/facilitator|payment kinds/i);
  });

  const trustGate = (aipExtra: Record<string, unknown>) => new Checkout({
    rails: { x402_base: { recipient: '0xT', network: 'eip155:8453' } as X402BaseRailSpec },
    url: 'https://wine.example/purchase',
    computePricing: () => ({ amountUsd: 50 }),
    gate: { aip: { trustedIssuers: [ISS], ...aipExtra } }, // NO apiKey — trust check runs pre-policy
  });

  it('denies weak_auth (403 + required_trust_level) when trust_level is below the gate requirement', async () => {
    const res = await trustGate({ requireTrustLevel: 'human_confirmed' })
      .handle(await signedReq({ id_verified: true }, { trustLevel: 'human_present' }));
    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toBe('application/problem+json');
    expect((res.body as { type?: string }).type).toBe('urn:aip:error:weak_auth');
    expect((res.body as { required_trust_level?: string }).required_trust_level).toBe('human_confirmed');
  });

  it('denies weak_auth (403 + required_amr) when no auth.amr matches the gate requirement', async () => {
    const res = await trustGate({ requireAmr: ['face', 'fpt', 'hwk'] })
      .handle(await signedReq({ id_verified: true }, { trustLevel: 'human_confirmed', auth: { amr: ['pwd'] } }));
    expect(res.status).toBe(403);
    expect((res.body as { type?: string }).type).toBe('urn:aip:error:weak_auth');
    expect((res.body as { required_amr?: string[] }).required_amr).toEqual(['face', 'fpt', 'hwk']);
  });

  it('passes the trust gate when trust_level + amr satisfy it (reaches settle)', async () => {
    await expect(
      trustGate({ requireTrustLevel: 'human_confirmed', requireAmr: ['face'] })
        .handle(await signedReq({ id_verified: true }, { trustLevel: 'human_confirmed', auth: { amr: ['face'] } })),
    ).rejects.toThrow(/facilitator|payment kinds/i);
  });
});

// Issuer-conditional policy: a gate keeps its full default compliance policy for its own AITs,
// but applies a relaxed per-issuer override for a named partner issuer (e.g. an external IdP). Uses the
// no-apiKey path as a deterministic probe: a policy-bearing request that can't be evaluated
// FAILS CLOSED (`aip_policy_requires_api_key`); a request whose effective policy is EMPTY passes
// the gate (returns null → reaches x402 settle → facilitator-init throws on the JWKS-only stub).
// So "fails closed" = policy was applied to this issuer; "throws at settle" = policy was empty.
describe('Checkout gate × AIP — issuer-conditional policy', () => {
  const PARTNER = 'https://issuer.example';
  const OURS = 'https://www.agentscore.com';
  const keys: Record<string, { priv: CryptoKey; pubJwk: JWK; kid: string }> = {};
  let agentPriv: JWK;
  let agentPub: JWK;

  beforeAll(async () => {
    for (const [iss, kid] of [[PARTNER, 'partner-key'], [OURS, 'as-key']] as const) {
      const kp = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
      keys[iss] = { priv: kp.privateKey, pubJwk: { ...(await exportJWK(kp.publicKey)), kid, use: 'sig', alg: 'EdDSA' }, kid };
    }
    const a = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    agentPriv = await exportJWK(a.privateKey);
    agentPub = await exportJWK(a.publicKey);
  });

  afterEach(() => vi.unstubAllGlobals());

  async function signedReqFrom(iss: string, identity: Record<string, unknown>): Promise<CheckoutRequest> {
    const k = keys[iss]!;
    const nowSec = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      aip_version: '0.1', sub: 'user_x', cnf: { jwk: agentPub },
      agent: { provider: 'anthropic' }, trust_level: 'human_present', identity,
    })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'jwt', kid: k.kid })
      .setIssuer(iss).setIssuedAt(nowSec).setExpirationTime(nowSec + 300).sign(k.priv);
    const authority = 'wine.example';
    const { signMessage } = await import('../src/aip/http-signature');
    const { signatureInput, signature } = await signMessage({
      method: 'POST', authority, path: '/purchase', agentIdentity: token,
      // PoP verifier requires `expires` (replay-window hardening); 60s window like pay.
      privateJwk: agentPriv, publicJwk: agentPub, created: nowSec, expires: nowSec + 60,
    });
    // Serve whichever issuer's JWKS is being fetched (keyed by request URL host).
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      const which = u.includes('issuer.example') ? PARTNER : OURS;
      return new Response(JSON.stringify({ keys: [keys[which]!.pubJwk] }), {
        status: 200, headers: { 'content-type': 'application/jwk-set+json', 'cache-control': 'max-age=300' },
      });
    }));
    return {
      method: 'POST', url: 'https://wine.example/purchase',
      headers: { host: authority, 'x-payment': 'eyJzdHViIjogdHJ1ZX0=', 'agent-identity': token, 'signature-input': signatureInput, signature },
      body: { product_id: 'p1', quantity: 1 },
    };
  }

  // Wine-style gate: full default policy, with the partner relaxed to KYC + 21 only (no sanctions/jurisdiction).
  const gate = () => new Checkout({
    rails: { x402_base: { recipient: '0xT', network: 'eip155:8453' } as X402BaseRailSpec },
    url: 'https://wine.example/purchase',
    computePricing: () => ({ amountUsd: 50 }),
    gate: {
      requireKyc: true, requireSanctionsClear: true, minAge: 21, allowedJurisdictions: ['US'],
      aip: { trustedIssuers: [PARTNER, OURS], issuerPolicies: { [PARTNER]: { requireKyc: true, minAge: 21 } } },
    }, // NO apiKey → policy-presence probe
  });

  it('applies the full default policy to the merchant’s own (non-overridden) issuer → fails closed', async () => {
    const res = await gate().handle(await signedReqFrom(OURS, { id_verified: true, age_over_21: true }));
    expect(res.status).toBe(403);
    expect((res.body as { error?: { code?: string } }).error?.code).toBe('aip_policy_requires_api_key');
  });

  it('applies the relaxed override to the named partner issuer — still policy-bearing → fails closed (not silently allowed)', async () => {
    // Relaxed ≠ empty: The partner still requires KYC + 21, so a no-apiKey gate still can't evaluate it
    // and fails closed. This proves the override is policy-BEARING, not a bypass.
    const res = await gate().handle(await signedReqFrom(PARTNER, { id_verified: true, age_over_21: true }));
    expect(res.status).toBe(403);
    expect((res.body as { error?: { code?: string } }).error?.code).toBe('aip_policy_requires_api_key');
  });

  it('an EMPTY issuer override drops all policy for that issuer → gate allows (reaches settle)', async () => {
    // A merchant can relax an issuer all the way to identity-only with `{}`. Then the effective
    // policy is empty → the no-apiKey gate returns null (allow) → settle → facilitator throws.
    const emptyOverrideGate = new Checkout({
      rails: { x402_base: { recipient: '0xT', network: 'eip155:8453' } as X402BaseRailSpec },
      url: 'https://wine.example/purchase',
      computePricing: () => ({ amountUsd: 50 }),
      gate: {
        requireKyc: true, requireSanctionsClear: true, minAge: 21,
        aip: { trustedIssuers: [PARTNER, OURS], issuerPolicies: { [PARTNER]: {} } },
      },
    });
    await expect(emptyOverrideGate.handle(await signedReqFrom(PARTNER, { email_verified: true })))
      .rejects.toThrow(/facilitator|payment kinds/i);
  });

  it('matches issuer overrides after canonicalization (trailing-slash key still applies)', async () => {
    const trailingSlashGate = new Checkout({
      rails: { x402_base: { recipient: '0xT', network: 'eip155:8453' } as X402BaseRailSpec },
      url: 'https://wine.example/purchase',
      computePricing: () => ({ amountUsd: 50 }),
      gate: {
        requireKyc: true, requireSanctionsClear: true, minAge: 21,
        // key has a trailing slash; verified iss is 'https://issuer.example' — must still match.
        aip: { trustedIssuers: [PARTNER, OURS], issuerPolicies: { 'https://issuer.example/': {} } },
      },
    });
    await expect(trailingSlashGate.handle(await signedReqFrom(PARTNER, { email_verified: true })))
      .rejects.toThrow(/facilitator|payment kinds/i);
  });
});
