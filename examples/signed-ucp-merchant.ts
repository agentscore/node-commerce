/**
 * Signed UCP profile example: `/.well-known/ucp` + `/.well-known/jwks.json`.
 *
 * AgentScore's `agentscore-profile+jws` is a vendor extension on top of UCP for
 * trust-mode verifiers (regulated-commerce, AP2-aware) that opt into auditable
 * cryptographic provenance. UCP §6 itself does NOT mandate profile-body
 * signing; production UCP merchants commonly ship unsigned, and vanilla
 * UCP-aware agents read the canonical body and ignore the `signature` field.
 *
 * The 2.0 SDK ships `buildSignedUcpResponse` + `buildSignedJwksResponse` which
 * fold loading + signing + Cache-Control + CORS into one call. Pass a
 * `Checkout` instance and the helpers compose the `payment_handlers` block
 * from the configured rails automatically.
 *
 * Run: `bun examples/signed-ucp-merchant.ts` (port 3010).
 *
 * Production checklist:
 *   - Set `UCP_SIGNING_KEY_JWK_PRIVATE` to a JSON-encoded private JWK (mint via
 *     `generateUCPSigningKey()` once, persist in your secret manager).
 *   - The kid in the env JWK MUST match what verifiers will see in your
 *     published profile; pick a stable name like `merchant-2026-05`.
 *   - Rotate by minting a new key + new kid, publishing both in the JWKS,
 *     signing new profiles with the new key, then dropping the old JWK after
 *     your verifier cache TTL expires.
 *
 * Call `bootstrapUcpSigningKey()` at startup so a malformed
 * `UCP_SIGNING_KEY_JWK_PRIVATE` env value fails the deploy fast instead of
 * surfacing on the first `/.well-known/ucp` hit.
 */

import {
  Checkout,
  type AgentScoreGatePolicy,
  type PricingResult,
  UCPVerificationError,
  verifyUCPProfile,
} from '@agent-score/commerce';
import {
  bootstrapUcpSigningKey,
  defaultA2aServices,
} from '@agent-score/commerce/discovery';
import { type TempoRailSpec } from '@agent-score/commerce/payment';
import { Hono, type Context } from 'hono';

const SIGNING_KID = 'merchant-2026-05';

const checkout = new Checkout({
  rails: { tempo: { recipient: '0xfeedface', network: 'tempo-mainnet' } as TempoRailSpec },
  url: 'https://agents.example.com/purchase',
  computePricing: async (): Promise<PricingResult> => ({ amountUsd: 1.0 }),
});

const AGENTSCORE_GATE: AgentScoreGatePolicy = {
  require_kyc: true,
  min_age: 21,
  allowed_jurisdictions: ['US'],
};

// Eager-load the signing key at startup so a malformed env JWK fails the
// deploy fast (rather than surfacing on the first /.well-known/ucp hit).
await bootstrapUcpSigningKey({ defaultKid: SIGNING_KID });

const app = new Hono();

// One-call: registers GET /.well-known/ucp + GET /.well-known/jwks.json +
// OPTIONS preflights. Composes payment_handlers from checkout.rails, signs
// the profile with the env JWK at SIGNING_KID, and attaches Cache-Control +
// CORS + X-Request-ID headers per UCP §6.
checkout.mountUcpRoutesHono(app, {
  name: 'My Agent Service',
  wellKnownUcpUrl: 'https://agents.example.com/.well-known/ucp',
  services: defaultA2aServices({
    agentCardUrl: 'https://agents.example.com/.well-known/agent-card.json',
  }),
  signingKid: SIGNING_KID,
  // Optional: declare merchant gate policy as an `sh.agentscore.identity`
  // capability binding inside the public profile. Static policy declaration
  // only; per-operator identity attestation flows through the AP2
  // risk-signal endpoint.
  agentscoreGate: AGENTSCORE_GATE,
});

// Self-smoke: confirm sign + verify round-trip locally.
app.get('/_selftest/ucp', async (c: Context) => {
  const profileRes = await app.request('/.well-known/ucp');
  const jwksRes = await app.request('/.well-known/jwks.json');
  const profile = (await profileRes.json()) as Record<string, unknown>;
  const jwks = (await jwksRes.json()) as Parameters<typeof verifyUCPProfile>[1];
  try {
    await verifyUCPProfile(profile as never, jwks);
    return c.json({
      ok: true,
      kid: ((profile.signing_keys as Array<{ kid?: string }> | undefined)?.[0])?.kid,
    });
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
