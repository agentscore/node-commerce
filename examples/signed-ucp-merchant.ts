/**
 * Signed UCP profile example — `/.well-known/ucp` + `/.well-known/jwks.json`.
 *
 * AgentScore's `agentscore-profile+jws` is a vendor extension layered on top of
 * the UCP profile for trust-mode verifiers (regulated-commerce, AP2-aware) that
 * opt into auditable cryptographic provenance. UCP §6 itself does NOT mandate
 * profile-body signing; production UCP merchants commonly ship unsigned, and
 * vanilla UCP-aware agents read the canonical body and ignore the `signature`
 * field. This example wires both routes against a persistent signing key
 * (env-loaded for prod, ephemeral for dev) for verifiers that DO opt into the
 * signed envelope.
 *
 * Run: `bun examples/signed-ucp-merchant.ts` (port 3010).
 *
 * Production checklist:
 *   - Set `UCP_SIGNING_KEY_JWK_PRIVATE` to a JSON-encoded private JWK (mint via
 *     `generateUCPSigningKey()` once, persist in your secret manager).
 *   - The kid in the env JWK MUST match what verifiers will see in your published
 *     profile — pick a stable name like `merchant-2026-05`.
 *   - Configure `Cache-Control: public, max-age=300` (or longer) on /.well-known/jwks.json
 *     so verifiers don't hammer the endpoint.
 *   - Rotate by minting a new key + new kid, publishing both in the JWKS, signing
 *     new profiles with the new key, then dropping the old JWK after your verifier
 *     cache TTL expires.
 */

import {
  buildJWKSResponse,
  buildUCPProfile,
  generateUCPSigningKey,
  signUCPProfile,
  type GeneratedUCPKey,
  ucpSigningKeyFromJWK,
  UCPVerificationError,
  verifyUCPProfile,
} from '@agent-score/commerce';
import { Hono } from 'hono';
import { importJWK, type CryptoKey, type JWK } from 'jose';

const KID = process.env.UCP_SIGNING_KEY_KID ?? 'merchant-2026-05';
const ALG = (process.env.UCP_SIGNING_KEY_ALG ?? 'EdDSA') as 'EdDSA' | 'ES256';

let cached: Promise<GeneratedUCPKey> | null = null;

function loadSigningKey(): Promise<GeneratedUCPKey> {
  // Cache the in-flight Promise (not the resolved value) so two concurrent
  // first-callers can't independently generate different keys. On rejection
  // the cache clears so the next caller retries.
  if (cached) return cached;
  cached = (async () => {
    const envJwk = process.env.UCP_SIGNING_KEY_JWK_PRIVATE;
    if (envJwk) {
      let jwk: JWK;
      try {
        jwk = JSON.parse(envJwk) as JWK;
      } catch (err) {
        throw new Error(
          `Failed to parse UCP_SIGNING_KEY_JWK_PRIVATE as JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Detect alg from JWK shape (parity with python sibling); ignore env ALG if it conflicts.
      let effectiveAlg: 'EdDSA' | 'ES256';
      if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') {
        effectiveAlg = 'EdDSA';
      } else if (jwk.kty === 'EC' && jwk.crv === 'P-256') {
        effectiveAlg = 'ES256';
      } else {
        throw new Error(`Unsupported env JWK: kty=${jwk.kty} crv=${jwk.crv}`);
      }
      const privateKey = (await importJWK(jwk, effectiveAlg)) as CryptoKey;
      // Derive the public JWK from the INPUT JWK rather than re-exporting through
      // the CryptoKey: jose's `exportJWK` rejects non-extractable CryptoKeys with
      // "non-extractable CryptoKey cannot be exported as a JWK", and Node's
      // WebCrypto returns non-extractable keys from `importJWK` by default. Using
      // the input JWK is runtime-independent and avoids the footgun.
      const publicJWK = { ...jwk } as Record<string, unknown>;
      for (const k of ['d', 'p', 'q', 'dp', 'dq', 'qi']) delete publicJWK[k];
      publicJWK.kid = jwk.kid ?? KID;
      publicJWK.alg = effectiveAlg;
      publicJWK.use = 'sig';
      return { privateKey, publicJWK: publicJWK as JWK } as GeneratedUCPKey;
    }
    console.warn('[ucp] UCP_SIGNING_KEY_JWK_PRIVATE not set — generating ephemeral key. Verifier caches will break across restarts.');
    return generateUCPSigningKey({ kid: KID, alg: ALG });
  })().catch((err) => {
    cached = null;
    throw err;
  });
  return cached;
}

const app = new Hono();

app.get('/.well-known/ucp', async (c) => {
  const key = await loadSigningKey();
  const profile = buildUCPProfile({
    name: 'My Agent Service',
    services: {
      'dev.ucp.shopping': [
        {
          version: '2026-04-08',
          spec: 'https://ucp.dev/2026-04-08/specification/overview',
          transport: 'mcp',
          endpoint: 'https://agents.example.com/api/ucp/mcp',
          schema: 'https://ucp.dev/services/shopping/mcp.openrpc.json',
        },
      ],
    },
    payment_handlers: {
      'sh.agentscore.payment.tempo': [{
        id: 'tempo',
        version: '2026-04-08',
        spec: 'https://agentscore.sh/specification/payment-handlers/tempo',
        schema: 'https://agentscore.sh/schemas/payment-handlers/tempo.json',
        config: { recipient: '0xfeedface' },
      }],
    },
    signing_keys: [ucpSigningKeyFromJWK(key.publicJWK as Record<string, unknown>)],
    // Optional: declare merchant gate policy as an `sh.agentscore.identity` capability
    // binding inside the public profile. Static policy declaration only — no per-operator
    // claims. Per-operator identity attestation flows through the AP2 risk-signal endpoint.
    agentscore_gate: { require_kyc: true, min_age: 21, allowed_jurisdictions: ['US'] },
  });
  const signed = await signUCPProfile(profile, {
    signingKey: key.privateKey,
    kid: key.publicJWK.kid as string,
    alg: ALG,
  });
  c.header('Cache-Control', 'public, max-age=60');
  return c.json(signed);
});

app.get('/.well-known/jwks.json', async (c) => {
  const key = await loadSigningKey();
  c.header('Cache-Control', 'public, max-age=300');
  c.header('Content-Type', 'application/jwk-set+json');
  return c.json(buildJWKSResponse([key.publicJWK]));
});

// Self-smoke: confirm sign + verify round-trip locally.
app.get('/_selftest/ucp', async (c) => {
  const profileRes = await app.request('/.well-known/ucp');
  const jwksRes = await app.request('/.well-known/jwks.json');
  const profile = await profileRes.json() as Awaited<ReturnType<typeof signUCPProfile>>;
  const jwks = await jwksRes.json() as Parameters<typeof verifyUCPProfile>[1];
  try {
    await verifyUCPProfile(profile, jwks);
    return c.json({ ok: true, kid: (profile.signing_keys?.[0] as { kid?: string } | undefined)?.kid });
  } catch (err) {
    if (err instanceof UCPVerificationError) {
      return c.json({ ok: false, code: err.code, message: err.message }, 500);
    }
    throw err;
  }
});

const port = Number(process.env.PORT ?? 3010);
console.warn(`signed-ucp-merchant listening on :${port}`);
console.warn('  /.well-known/ucp           — signed profile');
console.warn('  /.well-known/jwks.json     — public key set');
console.warn('  /_selftest/ucp             — local verify round-trip');

Bun.serve({ port, fetch: app.fetch });
