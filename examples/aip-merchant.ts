/**
 * Example: accepting AIP Agent Identity Tokens (AITs)
 *
 * Scenario: an agent (Claude, ChatGPT, …) arrives carrying an AIT — a short-lived JWT
 * signed by an Identity Provider (an external IdP, AgentScore, …) and bound to the agent's
 * own key. The merchant verifies it cryptographically (no API round-trip needed) and reads
 * the IdP-attested identity claims (email, age, etc.) straight off the token.
 *
 * This is the AIP sibling of `identity-only.ts`. Where that gate verifies an opaque
 * AgentScore operator token via `/v1/assess`, `aipGate` verifies a key-bound AIT offline
 * against the issuer's published JWKS. The two compose: a merchant can run `aipGate` for AIT
 * traffic and `agentscoreGate` for opaque-token traffic on different routes (or fall back
 * from one to the other).
 *
 * Compliance enrichment: `aipGate` does identity verification only. For sanctions /
 * jurisdiction / cross-merchant graph, call `/v1/assess` from the handler with the AIT's
 * claims (e.g. via the `@agent-score/sdk`) — see the note at the bottom.
 *
 * Peer deps to install:
 *   bun add @agent-score/commerce hono jose
 *
 * Env vars:
 *   (none required — the trusted-issuer list is configured in code below)
 *
 * Run: bun run examples/aip-merchant.ts
 */
import { JwksCache } from '@agent-score/commerce';
import { aipGate, conditionalAipGate, getVerifiedAit } from '@agent-score/commerce/identity/hono';
import { rateLimitHono } from '@agent-score/commerce/middleware/hono';
import { Hono } from 'hono';

// ── Configure which IdPs this merchant trusts ───────────────────────────────
// Only AITs whose `iss` matches one of these (after URL canonicalization) are accepted.
// Add a partner IdP.s production issuer here once you have it; AgentScore's own issuer is included
// so AITs we mint as a compliance IdP verify too.
const jwks = new JwksCache({
  trustedIssuers: ['https://issuer.example'],
});

const app = new Hono();
app.use('*', rateLimitHono());

// ── Hard gate: every request to /checkout MUST carry a valid AIT ────────────
app.use('/checkout', aipGate({ jwks }));

app.post('/checkout', async (c) => {
  // The AIT is verified (IdP signature + RFC 9421 proof-of-possession + expiry + trust).
  const ait = getVerifiedAit(c)!;
  const { identity, trust_level, intent } = ait.payload;

  // Merchant policy reads attested claims directly off the token.
  if (!identity?.email_verified) {
    return c.json({ error: 'verified email required' }, 403);
  }
  if (identity.age_over_21 !== true) {
    return c.json({ error: 'must be 21+' }, 403);
  }

  return c.json({
    ok: true,
    issuer: ait.iss,
    buyer: identity.email,
    trustLevel: trust_level,
    declaredIntent: intent?.description,
  });
});

// ── Conditional gate: AIT enforced only when presented ──────────────────────
// Requests without an Agent-Identity header flow through unauthenticated (e.g. so the
// handler can fall back to the opaque-token gate or emit its own challenge). Requests
// that DO carry an Agent-Identity header must pass full verification.
app.use('/browse', conditionalAipGate({ jwks }));

app.get('/browse', (c) => {
  const ait = getVerifiedAit(c);
  return c.json({
    ok: true,
    // Personalize when we know who's asking; anonymous browsing still works.
    greeting: ait ? `welcome back, ${ait.payload.identity?.email ?? 'verified agent'}` : 'browsing anonymously',
  });
});

// ── Compliance enrichment (optional) ────────────────────────────────────────
// `aipGate` proves WHO the agent is. To layer AgentScore's compliance signals
// (sanctions, jurisdiction, cross-merchant wallet graph) on top, call /v1/assess from
// your handler with the verified claims:
//
//   import { AgentScore } from '@agent-score/commerce/api';
//   const sdk = new AgentScore({ apiKey: process.env.AGENTSCORE_API_KEY! });
//   const decision = await sdk.assess(null, { /* aip_token or operator_token */ });
//
// The AIT and the opaque operator token are alternative identity *inputs* to the same
// decision engine — pick whichever the agent presented.

export default app;
