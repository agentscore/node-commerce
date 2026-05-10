/**
 * Example: multi-product merchant with per-product compliance policy + soft mode.
 *
 * Scenario: you sell several products with different compliance needs.
 * - Wine: hard gate, KYC + 21+ + US-only + state allowlist (regulated alcohol)
 * - Tee:  no gate at all — fully anonymous, ships anywhere
 * - Limited print: SOFT gate — request KYC for fraud signals, but don't block
 *                   the sale if the buyer skips it; record identity_status =
 *                   "unverified" instead.
 *
 * Each product carries its own policy block. The route uses three helpers
 * from `@agent-score/commerce/identity/policy`:
 *
 *   - buildGateOptionsFromPolicy(policy, { apiKey })  → AgentScoreGateOptions | null
 *       (null when the policy has no enforcement — caller treats as "no gate")
 *   - agentscoreGate(opts)                      → framework middleware
 *       (per-framework adapter; this example uses Hono)
 *   - runGateWithEnforcement(enforcement, run)  → GateResult
 *       (hard/soft enforcement runner — caller wraps the per-framework
 *       middleware in an adapter that resolves on accept and returns
 *       {ok: false, status, body} on deny)
 *   - shippingCountryAllowed / shippingStateAllowed
 *       (per-product shipping allowlists; null = ship anywhere)
 *
 * Peer deps:
 *   bun add @agent-score/commerce hono
 *
 * Env vars:
 *   AGENTSCORE_API_KEY — your AgentScore API key
 *
 * Run: bun run examples/per-product-policy-merchant.ts
 */
import { Hono } from 'hono';
import { agentscoreGate } from '../src/identity/hono.js';
import {
  type EnforcementMode,
  type PolicyBlock,
  buildGateOptionsFromPolicy,
  runGateWithEnforcement,
  shippingCountryAllowed,
  shippingStateAllowed,
} from '../src/identity/policy.js';

const API_KEY = process.env.AGENTSCORE_API_KEY ?? 'ask_test_dummy';

interface Product {
  name: string;
  priceUsd: number;
  policy: PolicyBlock | null;
}

// A merchant would normally read these from a `products` table. Each row
// carries its own compliance config; the keys match `PolicyBlock`.
const PRODUCTS: Record<string, Product> = {
  'wine-cabernet': {
    name: 'Reserve Cabernet',
    priceUsd: 75.0,
    policy: {
      enforcement: 'hard',
      requireKyc: true,
      requireSanctionsClear: true,
      minAge: 21,
      allowedJurisdictions: ['US'],
      allowedShippingCountries: ['US'],
      allowedShippingStates: ['CA', 'NY', 'TX', 'FL', 'WA'], // abridged
    },
  },
  tee: {
    name: 'Cotton Tee',
    priceUsd: 30.0,
    policy: null, // No gate; ship anywhere; identity_status="anonymous"
  },
  'limited-print': {
    name: 'Limited Edition Print (200/500)',
    priceUsd: 200.0,
    // Soft gate: request KYC as a fraud signal, but accept anonymous sales.
    // On miss, identity_status="unverified" stamps the order so ops can flag it.
    policy: { enforcement: 'soft', requireKyc: true },
  },
};

interface PurchaseBody {
  product_slug: string;
  shipping: { country: string; state: string };
}

const app = new Hono();

app.post('/purchase', async (c) => {
  const body = (await c.req.json()) as PurchaseBody;
  const product = PRODUCTS[body.product_slug];
  if (!product) {
    return c.json({ error: { code: 'product_not_found' } }, 400);
  }

  const policy = product.policy;

  // Per-product shipping allowlists. NULL policy → ship anywhere.
  if (!shippingCountryAllowed(body.shipping.country, policy)) {
    return c.json(
      { error: { code: 'unsupported_jurisdiction', message: `Cannot ship to ${body.shipping.country}.` } },
      400,
    );
  }
  if (!shippingStateAllowed(body.shipping.state, body.shipping.country, policy)) {
    return c.json(
      { error: { code: 'unsupported_jurisdiction', message: `Cannot ship to ${body.shipping.state}.` } },
      400,
    );
  }

  // Per-product identity gate. buildGateOptionsFromPolicy returns null when the policy
  // has no enforcement set; runGateWithEnforcement then short-circuits to anonymous.
  const gateOptions = buildGateOptionsFromPolicy(policy, { apiKey: API_KEY });
  const enforcement: EnforcementMode | undefined = policy?.enforcement;

  // Adapt the per-framework middleware to the runGate shape: resolve {ok:true}
  // when the gate calls next(), {ok:false, status, body} when it returns a Response.
  const runGate = gateOptions
    ? async (): Promise<{ ok: true } | { ok: false; status: number; body: Record<string, unknown> }> => {
        const middleware = agentscoreGate(gateOptions);
        let denied: Response | undefined;
        const next = async () => undefined;
        const result = await middleware(c, next);
        if (result instanceof Response) denied = result;
        if (!denied) return { ok: true };
        const denialBody = (await denied.clone().json().catch(() => ({}))) as Record<string, unknown>;
        return { ok: false, status: denied.status, body: denialBody };
      }
    : null;

  const gateResult = await runGateWithEnforcement(enforcement, runGate);

  if (gateResult.status === 'denied') {
    // Hard mode: propagate the gate's structured 403 verbatim.
    return c.json(gateResult.denialBody ?? {}, (gateResult.denialStatus ?? 403) as 403);
  }

  // gateResult.status is one of: "verified" (gate ran + passed),
  // "unverified" (soft mode swallowed a denial), "anonymous" (no gate fired).
  // Persist this on the order row so ops can distinguish soft passes from hard
  // passes from no-gate-product orders. For the limited print, an "unverified"
  // status is a real fraud signal worth flagging in ops.
  const identityStatus = gateResult.status;

  // ... settle payment, create order with `identity_status` column, return 200 ...
  return c.json({
    order: { product: product.name, totalUsd: product.priceUsd },
    identity_status: identityStatus,
  });
});

export { app };
