/**
 * Example: identity gate without payment
 *
 * Scenario: you have an existing checkout / payment flow you don't want to change,
 * but you want to verify the agent is KYC'd before letting them transact. Use the
 * commerce/identity middleware as a thin wrapper over your existing endpoints.
 *
 * Common cases:
 *   - Compliance-required content (age-gated, sanctioned-restricted)
 *   - High-value transactions where you want extra identity assurance
 *   - Adding agent KYC to an existing human-only Stripe checkout
 *
 * Peer deps to install:
 *   bun add @agent-score/commerce hono
 *
 * Env vars:
 *   AGENTSCORE_API_KEY — your AgentScore API key
 *
 * Run: bun run examples/identity-only.ts
 */
import {
  agentscoreGate,
  captureWallet,
  getAgentScoreData,
} from '@agent-score/commerce/identity/hono';
import { Hono } from 'hono';

const app = new Hono();

// ── Apply identity gate to specific routes ──────────────────────────────────
app.use(
  '/restricted',
  agentscoreGate({
    apiKey: process.env.AGENTSCORE_API_KEY!,
    requireKyc: true,
    minAge: 21,
    allowedJurisdictions: ['US'],
    requireSanctionsClear: true,
    // When the agent has no identity header, auto-create a verification session
    // so the 403 body carries verify_url + poll_secret + agent_instructions.
    createSessionOnMissing: {
      apiKey: process.env.AGENTSCORE_API_KEY!,
      context: 'restricted-access',
    },
  }),
);

app.post('/restricted', async (c) => {
  const assess = getAgentScoreData(c);
  // assess includes: { decision, operator, kyc_verified, age_bracket, jurisdiction, ... }

  // Run your own business logic here — buy something via your existing Stripe flow,
  // grant access to gated content, write to your DB, whatever. AgentScore's job ends
  // at "this agent is verified, here's their operator id."

  return c.json({
    ok: true,
    operator: assess?.resolved_operator,
  });
});

// ── Optional: capture an agent's wallet after payment lands ────────────────
// (only relevant if your downstream payment flow exposes the signer wallet)
app.post('/restricted/capture-wallet-example', async (c) => {
  const body = await c.req.json();
  await captureWallet(c, {
    walletAddress: body.signer_address,
    network: 'evm',
    idempotencyKey: body.payment_intent_id,
  });
  return c.json({ ok: true });
});

// ── Public routes (no gate) ────────────────────────────────────────────────
app.get('/public-info', (c) => c.json({ message: 'open access — no identity required' }));

export default app;
