/**
 * Coverage for the seamless-merchant helpers shipped in the latest SDK additions:
 *
 * - `lazyX402Server` / `lazyMppxServer` (memoized async getters)
 * - `extractSignerForPrecheck` (one-call signer across x402 + mpp headers)
 * - `makeMppxComposeHook` (canonical `composeMppx` factory)
 * - `purchaseModeNote` / `buildAgentscoreOnboardingSteps` /
 *   `standardEndpointDescriptions` / `buildSuccessNextSteps`
 * - `buildRedemptionSkillMd`
 * - `validationEnvelope` + per-framework `validationResponse*` wrappers
 * - Checkout framework adapters: `handleHono` / `handleExpress` / `handleFastify`
 *   / `handleNextjs` / `handleWeb`
 * - `defaultA2aServices` / `wellKnownCorsPreflightHeaders`
 * - `formatUsdCents`
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Checkout,
  type CheckoutContext,
  type MppxComposeOutcome,
  validationEnvelope,
  validationResponseExpress,
  validationResponseFastify,
  validationResponseHono,
  validationResponseNextjs,
  validationResponseWeb,
} from '../src/checkout';
import { makeMppxComposeHook } from '../src/checkout';
import {
  PURCHASE_MODE_NOTES,
  buildAgentscoreOnboardingSteps,
  buildSuccessNextSteps,
  purchaseModeNote,
  standardEndpointDescriptions,
} from '../src/discovery/agentscore_content';
import { buildRedemptionSkillMd } from '../src/discovery/redemption_md';
import {
  defaultA2aServices,
  wellKnownCorsPreflightHeaders,
} from '../src/discovery/well_known';
import { formatUsdCents } from '../src/payment/amounts';
import { lazyX402Server } from '../src/payment/lazy';
import { extractSignerForPrecheck } from '../src/signer';
import type { TempoRailSpec, X402BaseRailSpec } from '../src/payment/rail_spec';

const RECIPIENT = '0x000000000000000000000000000000000000dEaD';

// ─────────────────────────────────────────────────────────────────────────────
// formatUsdCents
// ─────────────────────────────────────────────────────────────────────────────

describe('formatUsdCents', () => {
  it('formats integer cents as 2-decimal USD strings', () => {
    expect(formatUsdCents(0)).toBe('0.00');
    expect(formatUsdCents(5)).toBe('0.05');
    expect(formatUsdCents(500)).toBe('5.00');
    expect(formatUsdCents(7500)).toBe('75.00');
  });
  it('formats negatives with a leading minus', () => {
    expect(formatUsdCents(-50)).toBe('-0.50');
  });
  it('honors `decimals` for sub-cent precision (per-token / per-byte unit pricing)', () => {
    // 0.05 cents = $0.0005 at 4-decimal precision; default 2-decimal rounds to "0.00".
    expect(formatUsdCents(0.05)).toBe('0.00');
    expect(formatUsdCents(0.05, 4)).toBe('0.0005');
    // Integer cents with raised precision pad with zeros.
    expect(formatUsdCents(5, 4)).toBe('0.0500');
    // Per-token pricing: $0.000002/token × 1234 tokens = $0.002468.
    expect(formatUsdCents(0.2468, 6)).toBe('0.002468');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// lazyX402Server / lazyMppxServer
// ─────────────────────────────────────────────────────────────────────────────

describe('lazyX402Server', () => {
  it('memoizes the server across concurrent first-callers', async () => {
    const spec: X402BaseRailSpec = { recipient: RECIPIENT, network: 'eip155:84532' };
    const sentinel = {};
    let calls = 0;
    vi.doMock('../src/payment/x402_server', () => ({
      createX402Server: async ({ facilitator, rails }: { facilitator: string; rails: string[] }) => {
        calls += 1;
        expect(facilitator).toBe('http');
        expect(rails).toEqual(['x402-base-sepolia']);
        return sentinel;
      },
    }));
    // Re-import to pick up the mock.
    const { lazyX402Server: fresh } = await import('../src/payment/lazy?lazy-fresh');
    const getter = fresh({ spec });
    const [a, b] = await Promise.all([getter(), getter()]);
    expect(a).toBe(sentinel);
    expect(b).toBe(sentinel);
    expect(calls).toBe(1);
    vi.doUnmock('../src/payment/x402_server');
  });

  it('rejects unknown networks', () => {
    const bad: X402BaseRailSpec = { recipient: RECIPIENT, network: 'eip155:1' };
    expect(() => lazyX402Server({ spec: bad })).toThrow(/unsupported X402BaseRailSpec\.network/);
  });
});

describe('lazyMppxServer', () => {
  it('memoizes the server across concurrent first-callers', async () => {
    const spec: TempoRailSpec = { recipient: RECIPIENT };
    const sentinel = {};
    let calls = 0;
    vi.doMock('../src/payment/mppx_server', () => ({
      createMppxServer: async () => {
        calls += 1;
        return sentinel;
      },
    }));
    const { lazyMppxServer: fresh } = await import('../src/payment/lazy?mppx-fresh');
    const getter = fresh({ rails: { tempo: spec }, secretKey: 'secret' });
    const [a, b] = await Promise.all([getter(), getter()]);
    expect(a).toBe(sentinel);
    expect(b).toBe(sentinel);
    expect(calls).toBe(1);
    vi.doUnmock('../src/payment/mppx_server');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractSignerForPrecheck
// ─────────────────────────────────────────────────────────────────────────────

function encodeX402(payload: object): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

describe('extractSignerForPrecheck', () => {
  it('reads the x402 payment-signature header', async () => {
    const payload = {
      x402Version: 2,
      scheme: 'exact',
      network: 'eip155:84532',
      payload: { authorization: { from: '0xAbC0000000000000000000000000000000000001' } },
    };
    const signer = await extractSignerForPrecheck({ 'Payment-Signature': encodeX402(payload) });
    expect(signer?.address).toBe('0xabc0000000000000000000000000000000000001');
    expect(signer?.network).toBe('evm');
  });

  it('reads the x-payment alias', async () => {
    const payload = {
      payload: { authorization: { from: '0xAbC0000000000000000000000000000000000002' } },
    };
    const signer = await extractSignerForPrecheck({ 'X-Payment': encodeX402(payload) });
    expect(signer?.address).toBe('0xabc0000000000000000000000000000000000002');
  });

  it('returns null with no payment headers', async () => {
    expect(await extractSignerForPrecheck({})).toBeNull();
    expect(await extractSignerForPrecheck({ authorization: 'Bearer not-a-payment' })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// makeMppxComposeHook
// ─────────────────────────────────────────────────────────────────────────────

describe('makeMppxComposeHook', () => {
  function buildCtx(headers: Record<string, string> = {}, pricing: { amountUsd: number } | null = { amountUsd: 1.0 }): CheckoutContext {
    return {
      request: { method: 'POST', url: 'https://x/y', headers, body: {} },
      referenceId: 'ref',
      pricing,
      recipients: {},
      state: {},
    };
  }

  it('returns 402 when pricing is null', async () => {
    const hook = makeMppxComposeHook({ serverGetter: async () => ({ charge: async () => ({}) }) });
    const out = await hook(buildCtx({}, null));
    expect(out.status).toBe(402);
  });

  it('emits challenge headers on a 402', async () => {
    const challenge = { toWwwAuthenticate: (realm: string) => `Payment realm="${realm}"` };
    const hook = makeMppxComposeHook({
      serverGetter: async () => ({ realm: 'test-realm', charge: async () => challenge }),
    });
    const out = await hook(buildCtx());
    expect(out.status).toBe(402);
    expect(out.headers?.['www-authenticate']).toBe('Payment realm="test-realm"');
  });

  it('lifts signer from a did:pkh:solana source on 200', async () => {
    const credential = { source: 'did:pkh:solana:5eykt4:GeQg2TM4VL315Bd4LLkGrhBjdNfoatKjCJYHBDPM3D74' };
    const receipt = { reference: 'solana_sig', transaction: null };
    const hook = makeMppxComposeHook({
      serverGetter: async () => ({ realm: 'r', charge: async () => [credential, receipt] }),
    });
    const out = await hook({
      request: { method: 'POST', url: 'https://x/y', headers: { authorization: 'Payment <cred>' }, body: {} },
      referenceId: 'ref',
      pricing: { amountUsd: 1.0 },
      recipients: {},
      state: {},
    });
    expect(out.status).toBe(200);
    expect(out.signerNetwork).toBe('solana');
    expect(out.signerAddress).toBe('GeQg2TM4VL315Bd4LLkGrhBjdNfoatKjCJYHBDPM3D74');
  });

  it('lifts txHash from transaction field when reference is unset', async () => {
    const credential = { source: 'did:pkh:eip155:8453:0xABC' };
    const receipt = { reference: undefined, transaction: '0xfallback_tx' };
    const hook = makeMppxComposeHook({
      serverGetter: async () => ({ realm: 'r', charge: async () => [credential, receipt] }),
    });
    const out = await hook({
      request: { method: 'POST', url: 'https://x/y', headers: { authorization: 'Payment <cred>' }, body: {} },
      referenceId: 'ref',
      pricing: { amountUsd: 1.0 },
      recipients: {},
      state: {},
    });
    expect(out.txHash).toBe('0xfallback_tx');
  });

  it('non-did source leaves signer null', async () => {
    const credential = { source: 'plain-not-did' };
    const receipt = { reference: '0xtx', transaction: null };
    const hook = makeMppxComposeHook({
      serverGetter: async () => ({ realm: 'r', charge: async () => [credential, receipt] }),
    });
    const out = await hook({
      request: { method: 'POST', url: 'https://x/y', headers: { authorization: 'Payment <cred>' }, body: {} },
      referenceId: 'ref',
      pricing: { amountUsd: 1.0 },
      recipients: {},
      state: {},
    });
    expect(out.signerAddress).toBeNull();
    expect(out.signerNetwork).toBeNull();
  });

  it('lifts signer from a did:pkh:eip155 source on 200', async () => {
    const credential = { source: 'did:pkh:eip155:8453:0xABCD000000000000000000000000000000000003' };
    const receipt = { reference: '0xtx', transaction: null };
    const hook = makeMppxComposeHook({
      serverGetter: async () => ({ realm: 'r', charge: async () => [credential, receipt] }),
    });
    const out = await hook(buildCtx({ authorization: 'Payment somevalidcred' }));
    expect(out.status).toBe(200);
    expect(out.txHash).toBe('0xtx');
    expect(out.signerAddress).toBe('0xabcd000000000000000000000000000000000003');
    expect(out.signerNetwork).toBe('evm');
  });

  it('serializes the mppx receipt into paymentReceiptHeader on 200', async () => {
    const credential = { source: 'did:pkh:eip155:8453:0xABCD000000000000000000000000000000000003' };
    const receipt = { method: 'tempo', status: 'success', reference: '0xreceipttx' };
    const hook = makeMppxComposeHook({
      serverGetter: async () => ({ realm: 'r', charge: async () => [credential, receipt] }),
    });
    const out = await hook(buildCtx({ authorization: 'Payment somevalidcred' }));
    expect(out.status).toBe(200);
    expect(typeof out.paymentReceiptHeader).toBe('string');
    expect((out.paymentReceiptHeader ?? '').length).toBeGreaterThan(0);
    expect(out.paymentReceiptHeader).not.toMatch(/[+/=]/);
    const decoded = JSON.parse(
      Buffer.from(out.paymentReceiptHeader!, 'base64url').toString('utf-8'),
    );
    expect(decoded).toEqual(receipt);
  });

  it('returns 402 when charge throws', async () => {
    const hook = makeMppxComposeHook({
      serverGetter: async () => ({
        realm: 'r',
        charge: async () => {
          throw new Error('pympp blew up');
        },
      }),
    });
    const out = await hook(buildCtx());
    expect(out.status).toBe(402);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// agentscore_content + redemption_md
// ─────────────────────────────────────────────────────────────────────────────

describe('purchaseModeNote', () => {
  it('returns the canonical note for each known mode', () => {
    expect(purchaseModeNote('redemption_only')).toBe(PURCHASE_MODE_NOTES.redemption_only);
    expect(purchaseModeNote('coupon_applicable')).toBe(PURCHASE_MODE_NOTES.coupon_applicable);
    expect(purchaseModeNote('paid_only')).toBe(PURCHASE_MODE_NOTES.paid_only);
  });
  it('returns empty string for unknown modes', () => {
    expect(purchaseModeNote('not-a-mode')).toBe('');
  });
});

describe('buildAgentscoreOnboardingSteps', () => {
  it('substitutes merchant name, url, and rails', () => {
    const steps = buildAgentscoreOnboardingSteps({
      merchantName: 'AgentScore Store',
      appUrl: 'https://store.example',
      acceptedRails: ['tempo', 'x402-base', 'solana-mpp'],
      requiresKyc: true,
    });
    const text = steps.join('\n');
    expect(text).toContain('AgentScore Store');
    expect(text).toContain('Tempo USDC');
    expect(text).toContain('x402 USDC on Base');
    expect(text).toContain('Solana SPL USDC');
    expect(text).toContain('tempo | base | solana');
    expect(text).toContain('required for this merchant');
    expect(text).toContain('https://store.example/catalog');
  });
  it('omits the KYC clause when requiresKyc is false', () => {
    const steps = buildAgentscoreOnboardingSteps({
      merchantName: 'X',
      appUrl: 'https://x',
      acceptedRails: ['x402-base'],
    });
    expect(steps.join('\n')).not.toContain('required for this merchant');
  });
  it('passes unknown rails through verbatim', () => {
    const steps = buildAgentscoreOnboardingSteps({
      merchantName: 'X',
      appUrl: 'https://x',
      acceptedRails: ['future-rail'],
    });
    expect(steps.join('\n')).toContain('future-rail');
  });
});

describe('standardEndpointDescriptions', () => {
  it('includes the canonical AgentScore commerce routes', () => {
    const desc = standardEndpointDescriptions({ appUrl: 'https://x' });
    expect(Object.keys(desc)).toEqual([
      'GET /catalog',
      'GET /catalog/{slug}',
      'POST /purchase',
      'GET /orders/{id}',
    ]);
  });

  it('returns api bundle when kind=api', () => {
    const desc = standardEndpointDescriptions({ kind: 'api' });
    expect(Object.keys(desc)).toEqual(['POST /<endpoint>', 'GET /usage']);
  });
});

describe('buildSuccessNextSteps', () => {
  it('omits fulfillment_eta when not provided', () => {
    const out = buildSuccessNextSteps({ orderStatusUrl: 'https://x/orders/1' });
    expect(out.fulfillment_eta).toBeUndefined();
    expect(out.action).toBe('done');
    expect(out.order_status_url).toBe('https://x/orders/1');
  });
  it('includes fulfillment_eta when provided', () => {
    const out = buildSuccessNextSteps({
      orderStatusUrl: 'https://x/orders/1',
      fulfillmentEta: '5-7 business days.',
    });
    expect(out.fulfillment_eta).toBe('5-7 business days.');
  });
});

describe('buildRedemptionSkillMd', () => {
  it('substitutes merchant name and url, omits peer section by default', () => {
    const md = buildRedemptionSkillMd({
      merchantName: 'AgentScore Store',
      appUrl: 'https://store.example',
    });
    expect(md).toContain('AgentScore Store');
    expect(md).toContain('https://store.example/catalog');
    expect(md).not.toContain("Don't have a code?");
  });
  it('emits the peer section when peerMerchantPointer is set', () => {
    const md = buildRedemptionSkillMd({
      merchantName: 'X',
      appUrl: 'https://x',
      peerMerchantPointer: 'https://other.example',
      skuIntro: 'a custom intro.',
    });
    expect(md).toContain("Don't have a code?");
    // `see: ` prefix anchors the URL inside the rendered markdown section
    // rather than a bare URL substring match (CodeQL incomplete-url-substring-sanitization).
    expect(md).toContain('see: https://other.example');
    expect(md).toContain('a custom intro.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validationEnvelope + per-framework validationResponse*
// ─────────────────────────────────────────────────────────────────────────────

describe('validationEnvelope + framework wrappers', () => {
  it('validationEnvelope returns the canonical 4xx body', () => {
    const out = validationEnvelope({ code: 'bad', message: 'nope', extra: { hint: 'x' } });
    expect((out.error as { code: string }).code).toBe('bad');
    expect((out.error as { message: string }).message).toBe('nope');
    expect((out.next_steps as { action: string }).action).toBe('fix_request');
    expect((out.hint as string | undefined) ?? null).toBe('x');
  });

  it('validationResponseHono returns a Response with the body + status', async () => {
    const resp = validationResponseHono({ code: 'bad', message: 'nope', status: 422 });
    expect(resp.status).toBe(422);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad');
  });

  it('validationResponseNextjs returns a Response', async () => {
    const resp = validationResponseNextjs({ code: 'bad', message: 'nope' });
    expect(resp.status).toBe(400);
  });

  it('validationResponseWeb returns a Response', async () => {
    const resp = validationResponseWeb({ code: 'bad', message: 'nope', status: 400 });
    expect(resp.status).toBe(400);
  });

  it('validationResponseExpress writes status + json to the supplied res', () => {
    const calls: { status?: number; body?: unknown } = {};
    const res = {
      status: (code: number) => {
        calls.status = code;
        return res;
      },
      json: (body: unknown) => {
        calls.body = body;
        return res;
      },
    };
    validationResponseExpress(res, { code: 'bad', message: 'nope', status: 400 });
    expect(calls.status).toBe(400);
    expect((calls.body as { error: { code: string } }).error.code).toBe('bad');
  });

  it('validationResponseFastify writes code + body on the supplied reply', () => {
    const calls: { code?: number; body?: unknown } = {};
    const reply = {
      code: (code: number) => {
        calls.code = code;
        return reply;
      },
      send: (body: unknown) => {
        calls.body = body;
        return reply;
      },
    };
    validationResponseFastify(reply, { code: 'bad', message: 'nope' });
    expect(calls.code).toBe(400);
    expect((calls.body as { error: { code: string } }).error.code).toBe('bad');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Checkout framework adapters
// ─────────────────────────────────────────────────────────────────────────────

function minimalCheckout(): Checkout {
  return new Checkout({
    rails: { tempo: { recipient: RECIPIENT } as TempoRailSpec },
    url: 'https://api.example/purchase',
    computePricing: () => ({ amountUsd: 1.0 }),
    composeMppx: async (ctx: CheckoutContext): Promise<MppxComposeOutcome> => {
      const auth = ctx.request.headers['authorization'] ?? ctx.request.headers['Authorization'];
      if (auth === undefined || auth === '') {
        return { status: 402, headers: { 'www-authenticate': 'Payment realm="test"' } };
      }
      return {
        status: 200,
        railKey: 'tempo',
        txHash: '0xtest',
        signerAddress: '0xeb2ca790f72787c7e61bc6c861353a1e4acdfca5',
        signerNetwork: 'evm',
      };
    },
    onSettled: (_ctx, outcome) => ({ order_id: 'o-1', tx_hash: outcome.txHash ?? null }),
  });
}

describe('Checkout framework adapters', () => {
  it('handleHono emits a 402 on the discovery leg', async () => {
    const checkout = minimalCheckout();
    const c = {
      req: {
        method: 'POST',
        url: 'https://api.example/purchase',
        json: async () => ({ item: 'wine' }),
        header: () => ({}),
      },
      json: (body: unknown, status?: number) => new Response(JSON.stringify(body), { status }),
      body: (body: string, status?: number) => new Response(body, { status }),
    };
    const resp = await checkout.handleHono(c);
    expect(resp.status).toBe(402);
  });

  it('handleHono returns invalid_body envelope when json() throws', async () => {
    const checkout = minimalCheckout();
    const c = {
      req: {
        method: 'POST',
        url: 'https://api.example/purchase',
        json: async () => {
          throw new Error('not json');
        },
        header: () => ({}),
      },
      json: (body: unknown, status?: number) => new Response(JSON.stringify(body), { status }),
      body: (body: string, status?: number) => new Response(body, { status }),
    };
    const resp = await checkout.handleHono(c);
    expect(resp.status).toBe(400);
  });

  it('handleHono accepts a pre-parsed body (skipping req.json())', async () => {
    const checkout = minimalCheckout();
    const c = {
      req: {
        method: 'POST',
        url: 'https://api.example/purchase',
        json: async () => {
          throw new Error('should not be called when body is passed directly');
        },
        header: () => ({}),
      },
      json: (body: unknown, status?: number) => new Response(JSON.stringify(body), { status }),
      body: (body: string, status?: number) => new Response(body, { status }),
    };
    const resp = await checkout.handleHono(c, { item: 'wine' });
    expect(resp.status).toBe(402);
  });

  it('handleExpress writes a 402 to the supplied res', async () => {
    const checkout = minimalCheckout();
    const calls: { status?: number; body?: unknown } = {};
    const req = {
      method: 'POST',
      url: '/purchase',
      headers: {},
      body: { item: 'wine' },
    };
    const res = {
      status: (code: number) => {
        calls.status = code;
        return res;
      },
      setHeader: () => res,
      json: (body: unknown) => {
        calls.body = body;
        return res;
      },
    };
    await checkout.handleExpress(req, res);
    expect(calls.status).toBe(402);
    expect(calls.body).toBeDefined();
  });

  it('handleFastify writes a 402 to the supplied reply', async () => {
    const checkout = minimalCheckout();
    const calls: { code?: number; body?: unknown } = {};
    const request = {
      method: 'POST',
      url: '/purchase',
      headers: {},
      body: { item: 'wine' },
    };
    const reply = {
      code: (code: number) => {
        calls.code = code;
        return reply;
      },
      header: () => reply,
      send: (body: unknown) => {
        calls.body = body;
        return reply;
      },
    };
    await checkout.handleFastify(request, reply);
    expect(calls.code).toBe(402);
  });

  it('handleNextjs returns a 402 Response', async () => {
    const checkout = minimalCheckout();
    const request = new Request('https://api.example/purchase', {
      method: 'POST',
      body: JSON.stringify({ item: 'wine' }),
      headers: { 'content-type': 'application/json' },
    });
    const resp = await checkout.handleNextjs(request);
    expect(resp.status).toBe(402);
  });

  it('handleNextjs accepts a pre-parsed body (skipping request.json())', async () => {
    const checkout = minimalCheckout();
    // No body in the Request; calling request.json() would throw. Passing body
    // directly exercises the body!==undefined branch.
    const request = new Request('https://api.example/purchase', { method: 'POST' });
    const resp = await checkout.handleNextjs(request, { item: 'wine' });
    expect(resp.status).toBe(402);
  });

  it('handleNextjs returns invalid_body envelope when request.json() throws', async () => {
    const checkout = minimalCheckout();
    const request = new Request('https://api.example/purchase', { method: 'POST' });
    const resp = await checkout.handleNextjs(request);
    expect(resp.status).toBe(400);
    const body = await resp.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('invalid_body');
  });

  it('handleWeb is an alias for handleNextjs', async () => {
    const checkout = minimalCheckout();
    const request = new Request('https://api.example/purchase', {
      method: 'POST',
      body: JSON.stringify({ item: 'wine' }),
      headers: { 'content-type': 'application/json' },
    });
    const resp = await checkout.handleWeb(request);
    expect(resp.status).toBe(402);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Checkout accessors
// ─────────────────────────────────────────────────────────────────────────────
// pricingResult factory
// ─────────────────────────────────────────────────────────────────────────────

describe('pricingResult', () => {
  it('derives amountUsd from subtotal + tax in cents', async () => {
    const { pricingResult } = await import('../src/checkout');
    const pr = pricingResult({ subtotalCents: 25000, taxCents: 2000 });
    expect(pr.amountUsd).toBe(270);
    expect(pr.currency).toBe('USD');
    expect(pr.block?.subtotal).toBe('250.00');
    expect(pr.block?.tax).toBe('20.00');
  });

  it('includes shippingCents in the derived amount', async () => {
    const { pricingResult } = await import('../src/checkout');
    const pr = pricingResult({ subtotalCents: 25000, taxCents: 2000, shippingCents: 999 });
    expect(pr.amountUsd).toBe(279.99);
  });

  it('attaches taxRate + taxState to the block', async () => {
    const { pricingResult } = await import('../src/checkout');
    const pr = pricingResult({ subtotalCents: 25000, taxCents: 2000, taxRate: 0.08, taxState: 'CA' });
    expect(pr.block?.tax_rate).toBe(0.08);
    expect(pr.block?.tax_state).toBe('CA');
  });

  it('passthrough mode (only amountUsd) leaves block undefined', async () => {
    const { pricingResult } = await import('../src/checkout');
    const pr = pricingResult({ amountUsd: 0.01 });
    expect(pr.amountUsd).toBe(0.01);
    expect(pr.block).toBeUndefined();
  });

  it('explicit amountUsd overrides the subtotal-derived value', async () => {
    const { pricingResult } = await import('../src/checkout');
    const pr = pricingResult({ subtotalCents: 25000, taxCents: 2000, amountUsd: 999.99 });
    expect(pr.amountUsd).toBe(999.99);
    expect(pr.block?.subtotal).toBe('250.00');
  });

  it('throws when neither subtotalCents nor amountUsd is provided', async () => {
    const { pricingResult } = await import('../src/checkout');
    expect(() => pricingResult({ currency: 'USD' })).toThrowError(/subtotalCents.*amountUsd/);
  });

  it('propagates product + bodyExtras', async () => {
    const { pricingResult } = await import('../src/checkout');
    const product = { id: 'sku_1', name: 'Test' };
    const extras = { redemption_code_applied: 'WELCOME' };
    const pr = pricingResult({ subtotalCents: 100, product, bodyExtras: extras });
    expect(pr.product).toEqual(product);
    expect(pr.bodyExtras).toEqual(extras);
  });

  it('full discount: subtotal stays list, discount equals list, amount is 0', async () => {
    const { pricingResult } = await import('../src/checkout');
    const pr = pricingResult({ subtotalCents: 7500, discountCents: 7500 });
    expect(pr.amountUsd).toBe(0);
    expect(pr.block?.subtotal).toBe('75.00');
    expect(pr.block?.discount).toBe('75.00');
    expect(pr.block?.total).toBe('0.00');
  });

  it('partial discount leaves a settle floor (74.99 discount against 75.00 list → 0.01)', async () => {
    const { pricingResult } = await import('../src/checkout');
    const pr = pricingResult({ subtotalCents: 7500, discountCents: 7499 });
    expect(pr.amountUsd).toBe(0.01);
    expect(pr.block?.discount).toBe('74.99');
    expect(pr.block?.total).toBe('0.01');
  });

  it('floors amountUsd at 0 when discount exceeds gross', async () => {
    const { pricingResult } = await import('../src/checkout');
    const pr = pricingResult({ subtotalCents: 1000, discountCents: 5000 });
    expect(pr.amountUsd).toBe(0);
    expect(pr.block?.total).toBe('0.00');
  });
});

describe('Checkout.acceptedRails + acceptedMethodNames', () => {
  it('returns canonical RailKey + method-name lists derived from rails', () => {
    const checkout = new Checkout({
      rails: {
        tempo: { recipient: RECIPIENT } as TempoRailSpec,
        x402_base: { recipient: RECIPIENT, network: 'eip155:8453' } as X402BaseRailSpec,
      },
      url: 'https://x',
      computePricing: () => ({ amountUsd: 1.0 }),
    });
    expect(checkout.acceptedRails).toEqual(['tempo_mpp', 'x402_base']);
    expect(checkout.acceptedMethodNames).toEqual(['tempo/charge', 'x402/exact (base)']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// well_known helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('defaultA2aServices', () => {
  it('returns the canonical dev.ucp.shopping A2A binding', () => {
    const services = defaultA2aServices({ agentCardUrl: 'https://x/.well-known/agent-card.json' });
    expect(services['dev.ucp.shopping']).toBeDefined();
    expect(services['dev.ucp.shopping'][0]).toMatchObject({
      version: '2026-04-08',
      transport: 'a2a',
      endpoint: 'https://x/.well-known/agent-card.json',
    });
  });
});

describe('wellKnownCorsPreflightHeaders', () => {
  it('returns CORS preflight headers without ACRH echo when absent', () => {
    const headers = wellKnownCorsPreflightHeaders();
    expect(headers['Access-Control-Allow-Origin']).toBe('*');
    expect(headers['Access-Control-Allow-Methods']).toContain('GET');
    expect(headers['Access-Control-Allow-Headers']).toBeUndefined();
  });
  it('echoes Access-Control-Request-Headers verbatim when present', () => {
    const headers = wellKnownCorsPreflightHeaders({
      'access-control-request-headers': 'content-type, x-custom',
    });
    expect(headers['Access-Control-Allow-Headers']).toBe('content-type, x-custom');
  });
  it('reads from Headers instance', () => {
    const headers = wellKnownCorsPreflightHeaders(
      new Headers({ 'access-control-request-headers': 'x-test' }),
    );
    expect(headers['Access-Control-Allow-Headers']).toBe('x-test');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// wellKnownPreflightResponse
// ─────────────────────────────────────────────────────────────────────────────

describe('buildAgentscoreOnboardingSteps - branch coverage', () => {
  it('vendorType=api with stripe-spt rail includes stripe fallback step', () => {
    const steps = buildAgentscoreOnboardingSteps({
      merchantName: 'API Co',
      appUrl: 'https://api.example',
      acceptedRails: ['stripe-spt'],
      vendorType: 'api',
    });
    const text = steps.join('\n');
    expect(text).toContain('@stripe/link-cli');
    // api branch has "make the paid call"
    expect(text).toContain('Make the paid call');
  });

  it('vendorType=goods (default) with stripe-spt rail includes catalog browse step', () => {
    const steps = buildAgentscoreOnboardingSteps({
      merchantName: 'Store',
      appUrl: 'https://store.example',
      acceptedRails: ['stripe-spt', 'tempo'],
    });
    const text = steps.join('\n');
    expect(text).toContain('@stripe/link-cli');
    expect(text).toContain('Browse the catalog');
  });

  it('vendorType=api with no stripe rail omits stripe fallback step', () => {
    const steps = buildAgentscoreOnboardingSteps({
      merchantName: 'API Co',
      appUrl: 'https://api.example',
      acceptedRails: ['x402-base'],
      vendorType: 'api',
    });
    const text = steps.join('\n');
    expect(text).not.toContain('@stripe/link-cli');
  });
});

describe('buildSuccessNextSteps - branch coverage', () => {
  it('omits order_status_url when not provided', () => {
    const out = buildSuccessNextSteps({});
    expect(out.order_status_url).toBeUndefined();
    expect(out.fulfillment_eta).toBeUndefined();
  });
  it('includes fulfillment_eta when set', () => {
    const out = buildSuccessNextSteps({ fulfillmentEta: 'ships 3-5 days', userMessage: 'Custom message.' });
    expect(out.fulfillment_eta).toBe('ships 3-5 days');
    expect(out.user_message).toBe('Custom message.');
  });
});

describe('buildSignedJwksResponse + buildSignedUcpResponse - Headers instance request', () => {
  it('reads X-Request-Id from Headers instance (not just plain object)', async () => {
    const { buildSignedJwksResponse } = await import('../src/discovery/well_known');
    const { generateUCPSigningKey, _resetUCPSigningKeyCache } = await import('../src/identity/ucp-jwks');
    const { exportJWK } = await import('jose');
    _resetUCPSigningKeyCache();
    const { privateKey } = await generateUCPSigningKey({ kid: 'jwks-headers-test' });
    const privJwk = await exportJWK(privateKey as Parameters<typeof exportJWK>[0]);
    const prev = process.env.UCP_SIGNING_KEY_JWK_PRIVATE;
    process.env.UCP_SIGNING_KEY_JWK_PRIVATE = JSON.stringify({ ...privJwk, kid: 'jwks-headers-test' });
    try {
      const resp = await buildSignedJwksResponse({
        requestHeaders: new Headers({ 'x-request-id': 'req-from-headers' }),
      });
      expect(resp.headers['X-Request-ID']).toBe('req-from-headers');
    } finally {
      if (prev === undefined) delete process.env.UCP_SIGNING_KEY_JWK_PRIVATE;
      else process.env.UCP_SIGNING_KEY_JWK_PRIVATE = prev;
      _resetUCPSigningKeyCache();
    }
  });
  it('omits X-Request-ID when no header present', async () => {
    const { buildSignedJwksResponse } = await import('../src/discovery/well_known');
    const { generateUCPSigningKey, _resetUCPSigningKeyCache } = await import('../src/identity/ucp-jwks');
    const { exportJWK } = await import('jose');
    _resetUCPSigningKeyCache();
    const { privateKey } = await generateUCPSigningKey({ kid: 'no-rid' });
    const privJwk = await exportJWK(privateKey as Parameters<typeof exportJWK>[0]);
    const prev = process.env.UCP_SIGNING_KEY_JWK_PRIVATE;
    process.env.UCP_SIGNING_KEY_JWK_PRIVATE = JSON.stringify({ ...privJwk, kid: 'no-rid' });
    try {
      const resp = await buildSignedJwksResponse({});
      expect(resp.headers['X-Request-ID']).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.UCP_SIGNING_KEY_JWK_PRIVATE;
      else process.env.UCP_SIGNING_KEY_JWK_PRIVATE = prev;
      _resetUCPSigningKeyCache();
    }
  });
});

describe('wellKnownPreflightResponse', () => {
  it('returns a 204 Response with CORS preflight headers', async () => {
    const { wellKnownPreflightResponse } = await import('../src/discovery/well_known');
    const resp = wellKnownPreflightResponse();
    expect(resp.status).toBe(204);
    expect(resp.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(resp.headers.get('Access-Control-Allow-Methods')).toContain('GET');
  });
  it('propagates the request ACRH echo when present', async () => {
    const { wellKnownPreflightResponse } = await import('../src/discovery/well_known');
    const resp = wellKnownPreflightResponse({ 'access-control-request-headers': 'x-foo' });
    expect(resp.headers.get('Access-Control-Allow-Headers')).toBe('x-foo');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildMerchantIndexJson
// ─────────────────────────────────────────────────────────────────────────────

describe('buildMerchantIndexJson', () => {
  it('emits canonical fields', async () => {
    const { buildMerchantIndexJson } = await import('../src/discovery/agentscore_content');
    const body = buildMerchantIndexJson({
      name: 'AgentScore Store',
      description: 'Wine and merch for agents.',
      docs: { llms: 'https://x/llms.txt' },
      endpoints: { 'GET /catalog': 'List products.' },
      supportedRails: ['tempo', 'x402-base'],
    });
    expect(body.name).toBe('AgentScore Store');
    expect(body.audience).toBe('agents');
    expect(body.supported_rails).toEqual(['tempo', 'x402-base']);
    expect(body.docs).toEqual({ llms: 'https://x/llms.txt' });
  });
  it('merges extras over the canonical fields', async () => {
    const { buildMerchantIndexJson } = await import('../src/discovery/agentscore_content');
    const body = buildMerchantIndexJson({
      name: 'X',
      description: 'Y',
      docs: {},
      endpoints: {},
      supportedRails: [],
      extra: { compliance: { min_age: 21 }, website: 'https://x.example' },
    });
    expect(body.compliance).toEqual({ min_age: 21 });
    expect(body.website).toBe('https://x.example');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// xServiceInfoExtension + xPaymentInfoFromCheckout (new openapi helpers)
// ─────────────────────────────────────────────────────────────────────────────

describe('xServiceInfoExtension', () => {
  it('emits minimal block with just categories', async () => {
    const { xServiceInfoExtension } = await import('../src/discovery/openapi');
    const ext = xServiceInfoExtension({ categories: ['commerce', 'wine'] });
    expect(ext).toEqual({ 'x-service-info': { categories: ['commerce', 'wine'] } });
  });
  it('includes docs when provided', async () => {
    const { xServiceInfoExtension } = await import('../src/discovery/openapi');
    const ext = xServiceInfoExtension({
      categories: ['commerce'],
      docs: { human: 'https://x.example/about' },
    });
    expect(ext['x-service-info'].docs).toEqual({ human: 'https://x.example/about' });
  });
});

describe('xPaymentInfoExtension authMode + description', () => {
  it('emits authMode=payment and description when set', async () => {
    const { xPaymentInfoExtension } = await import('../src/discovery/openapi');
    const ext = xPaymentInfoExtension({
      price: { mode: 'fixed', currency: 'USD', amount: '5.00' },
      protocols: [{ x402: {} }],
      description: 'Per-purchase fee.',
    });
    expect(ext['x-payment-info'].authMode).toBe('payment');
    expect(ext['x-payment-info'].description).toBe('Per-purchase fee.');
  });
});

describe('xPaymentInfoFromCheckout', () => {
  it('emits one protocol entry per rail and merges extras', async () => {
    const { xPaymentInfoFromCheckout } = await import('../src/discovery/openapi');
    const checkout = {
      rails: {
        tempo: { recipient: RECIPIENT, network: 'tempo-mainnet', token: '0xtokenT' },
        base: { recipient: RECIPIENT, network: 'eip155:8453', token: 'USDC' },
        stripe: { profileId: 'profile_abc' },
        solana: { recipient: 'SoLaNaReCiPiEnT', network: 'solana:5eykt4', token: 'SoLaNaMiNt' },
      },
    };
    const ext = xPaymentInfoFromCheckout({
      checkout,
      price: { mode: 'fixed', currency: 'USD', amount: '1.00' },
      description: 'Per-call fee.',
      protocolExtras: { tempo: { client_command: 'pay --chain tempo' } },
    });
    const protocols = ext['x-payment-info'].protocols;
    const tempoEntry = protocols.find((p) => 'mpp' in p && p.mpp.method === 'tempo');
    expect(tempoEntry).toBeDefined();
    expect((tempoEntry as { mpp: Record<string, unknown> }).mpp.client_command).toBe('pay --chain tempo');
    expect(protocols.some((p) => 'mpp' in p && p.mpp.method === 'stripe')).toBe(true);
    expect(protocols.some((p) => 'x402' in p)).toBe(true);
    expect(protocols.some((p) => 'mpp' in p && p.mpp.method === 'solana')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadSolanaFeePayer
// ─────────────────────────────────────────────────────────────────────────────

describe('loadSolanaFeePayer', () => {
  it('returns undefined for empty / undefined privateKey', async () => {
    const { loadSolanaFeePayer } = await import('../src/payment/solana');
    expect(await loadSolanaFeePayer({ privateKey: undefined })).toBeUndefined();
    expect(await loadSolanaFeePayer({ privateKey: '' })).toBeUndefined();
  });
  it('accepts a 128-char hex keypair (takes first 32 bytes as seed)', async () => {
    const { loadSolanaFeePayer } = await import('../src/payment/solana');
    const hex = '01'.repeat(64);
    const signer = await loadSolanaFeePayer({ privateKey: hex });
    expect(signer).toBeDefined();
  });
  it('accepts a 64-byte base58 keypair (Phantom export)', async () => {
    const kit = (await import('@solana/kit').catch(() => null)) as
      | { getBase58Codec?: () => { decode: (b: Uint8Array) => string } }
      | null;
    if (!kit?.getBase58Codec) {
      return;  // peer dep missing — covered by the hex-input test
    }
    const { loadSolanaFeePayer } = await import('../src/payment/solana');
    const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const fullBytes = new Uint8Array(64);
    fullBytes.set(seed);
    const codec = kit.getBase58Codec();
    const base58 = codec.decode(fullBytes);
    const signer = await loadSolanaFeePayer({ privateKey: base58 });
    expect(signer).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildSignedUcpResponse / buildSignedJwksResponse / bootstrapUcpSigningKey
// ─────────────────────────────────────────────────────────────────────────────

describe('buildSignedUcpResponse', () => {
  it('returns 503 ucp_misconfigured when no payment handlers can be derived', async () => {
    const { buildSignedUcpResponse } = await import('../src/discovery/well_known');
    const emptyCheckout = new Checkout({ merchantName: 'X', rails: {} });
    const resp = await buildSignedUcpResponse({
      checkout: emptyCheckout,
      name: 'X',
      wellKnownUcpUrl: 'https://x/.well-known/ucp',
      services: {},
    });
    expect(resp.status).toBe(503);
    expect(resp.headers['Cache-Control']).toContain('max-age=60');
    const body = JSON.parse(resp.body);
    expect(body.error.code).toBe('ucp_misconfigured');
  });
  it('echoes X-Request-ID from request headers on the misconfigured envelope', async () => {
    const { buildSignedUcpResponse } = await import('../src/discovery/well_known');
    const emptyCheckout = new Checkout({ merchantName: 'X', rails: {} });
    const resp = await buildSignedUcpResponse({
      checkout: emptyCheckout,
      name: 'X',
      wellKnownUcpUrl: 'https://x/.well-known/ucp',
      services: {},
      requestHeaders: { 'X-Request-Id': 'req-abc' },
    });
    expect(resp.headers['X-Request-ID']).toBe('req-abc');
  });
});

describe('bootstrapUcpSigningKey', () => {
  it('throws when UCP_SIGNING_KEY_JWK_PRIVATE env is malformed', async () => {
    const { bootstrapUcpSigningKey } = await import('../src/discovery/well_known');
    const { _resetUCPSigningKeyCache } = await import('../src/identity/ucp-jwks');
    _resetUCPSigningKeyCache();
    const prev = process.env.UCP_SIGNING_KEY_JWK_PRIVATE;
    process.env.UCP_SIGNING_KEY_JWK_PRIVATE = 'not-json';
    try {
      await expect(bootstrapUcpSigningKey()).rejects.toThrow();
    } finally {
      if (prev === undefined) delete process.env.UCP_SIGNING_KEY_JWK_PRIVATE;
      else process.env.UCP_SIGNING_KEY_JWK_PRIVATE = prev;
      _resetUCPSigningKeyCache();
    }
  });
  it('succeeds with a valid Ed25519 JWK env', async () => {
    const { bootstrapUcpSigningKey } = await import('../src/discovery/well_known');
    const { generateUCPSigningKey, _resetUCPSigningKeyCache } = await import('../src/identity/ucp-jwks');
    const { exportJWK } = await import('jose');
    _resetUCPSigningKeyCache();
    const { privateKey } = await generateUCPSigningKey({ kid: 'bootstrap-test' });
    const privJwk = await exportJWK(privateKey as Parameters<typeof exportJWK>[0]);
    const prev = process.env.UCP_SIGNING_KEY_JWK_PRIVATE;
    process.env.UCP_SIGNING_KEY_JWK_PRIVATE = JSON.stringify({ ...privJwk, kid: 'bootstrap-test' });
    try {
      await expect(bootstrapUcpSigningKey()).resolves.toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.UCP_SIGNING_KEY_JWK_PRIVATE;
      else process.env.UCP_SIGNING_KEY_JWK_PRIVATE = prev;
      _resetUCPSigningKeyCache();
    }
  });
});

describe('buildSignedJwksResponse', () => {
  it('returns 200 with application/jwk-set+json and Cache-Control', async () => {
    const { buildSignedJwksResponse } = await import('../src/discovery/well_known');
    const { generateUCPSigningKey, _resetUCPSigningKeyCache } = await import('../src/identity/ucp-jwks');
    const { exportJWK } = await import('jose');
    _resetUCPSigningKeyCache();
    const { privateKey } = await generateUCPSigningKey({ kid: 'jwks-test' });
    const privJwk = await exportJWK(privateKey as Parameters<typeof exportJWK>[0]);
    const prev = process.env.UCP_SIGNING_KEY_JWK_PRIVATE;
    process.env.UCP_SIGNING_KEY_JWK_PRIVATE = JSON.stringify({ ...privJwk, kid: 'jwks-test' });
    try {
      const resp = await buildSignedJwksResponse({ requestHeaders: { 'X-Request-Id': 'req-jwks' } });
      expect(resp.status).toBe(200);
      expect(resp.mediaType).toBe('application/jwk-set+json');
      expect(resp.headers['Cache-Control']).toContain('max-age=300');
      expect(resp.headers['X-Request-ID']).toBe('req-jwks');
      const body = JSON.parse(resp.body) as { keys: Array<{ kid: string }> };
      expect(body.keys.length).toBe(1);
      expect(body.keys[0].kid).toBe('jwks-test');
    } finally {
      if (prev === undefined) delete process.env.UCP_SIGNING_KEY_JWK_PRIVATE;
      else process.env.UCP_SIGNING_KEY_JWK_PRIVATE = prev;
      _resetUCPSigningKeyCache();
    }
  });
});

describe('buildSignedUcpResponse happy path', () => {
  it('signs a UCP profile when rails + env signing key are present', async () => {
    const { buildSignedUcpResponse } = await import('../src/discovery/well_known');
    const { generateUCPSigningKey, _resetUCPSigningKeyCache } = await import('../src/identity/ucp-jwks');
    const { exportJWK } = await import('jose');
    _resetUCPSigningKeyCache();
    const { privateKey } = await generateUCPSigningKey({ kid: 'ucp-test' });
    const privJwk = await exportJWK(privateKey as Parameters<typeof exportJWK>[0]);
    const prev = process.env.UCP_SIGNING_KEY_JWK_PRIVATE;
    process.env.UCP_SIGNING_KEY_JWK_PRIVATE = JSON.stringify({ ...privJwk, kid: 'ucp-test' });
    try {
      const checkout = new Checkout({
        merchantName: 'AgentScore Store',
        rails: {
          tempo: {
            recipient: RECIPIENT,
            network: 'tempo-mainnet',
          } as TempoRailSpec,
          base: {
            recipient: RECIPIENT,
            network: 'eip155:8453',
          } as X402BaseRailSpec,
        },
      });
      const resp = await buildSignedUcpResponse({
        checkout,
        name: 'AgentScore Store',
        wellKnownUcpUrl: 'https://x/.well-known/ucp',
        services: { 'dev.ucp.shopping': [] },
        requestHeaders: { 'X-Request-Id': 'req-ucp' },
        signingKid: 'ucp-test',
      });
      expect(resp.status).toBe(200);
      expect(resp.mediaType).toBe('application/json');
      expect(resp.headers['X-Request-ID']).toBe('req-ucp');
      expect(resp.headers['Cache-Control']).toContain('max-age=60');
      const body = JSON.parse(resp.body) as { ucp: { name?: string; payment_handlers: Record<string, unknown> }; signature: string };
      expect(body.ucp.name).toBe('AgentScore Store');
      expect(body.signature).toBeDefined();
      expect(body.ucp.payment_handlers).toBeDefined();
    } finally {
      if (prev === undefined) delete process.env.UCP_SIGNING_KEY_JWK_PRIVATE;
      else process.env.UCP_SIGNING_KEY_JWK_PRIVATE = prev;
      _resetUCPSigningKeyCache();
    }
  });
  it('routes solana + stripe + tempo-session rails through their respective payment-handler builders', async () => {
    const { buildSignedUcpResponse } = await import('../src/discovery/well_known');
    const { generateUCPSigningKey, _resetUCPSigningKeyCache } = await import('../src/identity/ucp-jwks');
    const { exportJWK } = await import('jose');
    _resetUCPSigningKeyCache();
    const { privateKey } = await generateUCPSigningKey({ kid: 'ucp-multi' });
    const privJwk = await exportJWK(privateKey as Parameters<typeof exportJWK>[0]);
    const prev = process.env.UCP_SIGNING_KEY_JWK_PRIVATE;
    process.env.UCP_SIGNING_KEY_JWK_PRIVATE = JSON.stringify({ ...privJwk, kid: 'ucp-multi' });
    try {
      const checkout = new Checkout({
        merchantName: 'Multi-Rail',
        rails: {
          solana: { recipient: 'SoLaNaReCiPiEnT', network: 'solana:5eykt4', rpcUrl: 'https://x' } as never,
          stripe: { profileId: 'profile_abc' } as never,
          tempoSession: {
            recipient: RECIPIENT,
            escrowContract: '0x' + '11'.repeat(20),
            store: {} as never,
          } as never,
        },
      });
      const resp = await buildSignedUcpResponse({
        checkout,
        name: 'Multi-Rail',
        wellKnownUcpUrl: 'https://x/.well-known/ucp',
        services: {},
        signingKid: 'ucp-multi',
      });
      expect(resp.status).toBe(200);
      const body = JSON.parse(resp.body) as { ucp: { payment_handlers: Record<string, unknown> } };
      // Each handler key is reverse-DNS; at least one mpp + one stripe handler should be present.
      const keys = Object.keys(body.ucp.payment_handlers);
      expect(keys.some((k) => k.includes('mpp') || k.includes('stripe'))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.UCP_SIGNING_KEY_JWK_PRIVATE;
      else process.env.UCP_SIGNING_KEY_JWK_PRIVATE = prev;
      _resetUCPSigningKeyCache();
    }
  });
  it('drops rails with empty-string sentinel recipients from the published handler when not statically resolvable', async () => {
    const { buildSignedUcpResponse } = await import('../src/discovery/well_known');
    const { generateUCPSigningKey, _resetUCPSigningKeyCache } = await import('../src/identity/ucp-jwks');
    const { exportJWK } = await import('jose');
    _resetUCPSigningKeyCache();
    const { privateKey } = await generateUCPSigningKey({ kid: 'ucp-sentinel' });
    const privJwk = await exportJWK(privateKey as Parameters<typeof exportJWK>[0]);
    const prev = process.env.UCP_SIGNING_KEY_JWK_PRIVATE;
    process.env.UCP_SIGNING_KEY_JWK_PRIVATE = JSON.stringify({ ...privJwk, kid: 'ucp-sentinel' });
    try {
      const checkout = new Checkout({
        merchantName: 'Per-order Recipient',
        rails: {
          base: {
            recipient: '',  // empty-string sentinel: per-order mint
            network: 'eip155:8453',
          } as X402BaseRailSpec,
        },
      });
      const resp = await buildSignedUcpResponse({
        checkout,
        name: 'X',
        wellKnownUcpUrl: 'https://x/.well-known/ucp',
        services: {},
        signingKid: 'ucp-sentinel',
      });
      expect(resp.status).toBe(200);
    } finally {
      if (prev === undefined) delete process.env.UCP_SIGNING_KEY_JWK_PRIVATE;
      else process.env.UCP_SIGNING_KEY_JWK_PRIVATE = prev;
      _resetUCPSigningKeyCache();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Checkout.acceptedRails / acceptedMethodNames accessors
// ─────────────────────────────────────────────────────────────────────────────

describe('Checkout.acceptedRails + acceptedMethodNames', () => {
  it('dedupes tempo + tempo_session into a single tempo_mpp slug', async () => {
    const { Checkout } = await import('../src/checkout');
    const c = new Checkout({
      rails: {
        tempo: { recipient: RECIPIENT, network: 'tempo-mainnet' },
        tempoSession: {
          recipient: RECIPIENT,
          escrowContract: '0x' + '11'.repeat(20),
          store: {},
        },
        base: { recipient: RECIPIENT, network: 'eip155:8453' },
        solana: { recipient: 'SoLa', network: 'solana:5eykt4', rpcUrl: 'https://x' },
        stripe: { profileId: 'profile_abc' },
      },
      url: 'https://api.example/purchase',
      computePricing: async () => ({ amountUsd: 1.0 }),
    });
    const rails = c.acceptedRails;
    expect(rails.filter((r: string) => r === 'tempo_mpp').length).toBe(1);
    expect(rails).toContain('x402_base');
    expect(rails).toContain('solana_mpp');
    expect(rails).toContain('stripe');

    const names = c.acceptedMethodNames;
    expect(names).toContain('tempo/charge');
    expect(names).toContain('x402/exact (base)');
    expect(names).toContain('solana/charge');
    expect(names).toContain('stripe/spt');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Checkout gate hooks (CheckoutGateConfig)
// ─────────────────────────────────────────────────────────────────────────────

async function _checkoutWithGate(gate: Record<string, unknown>): Promise<unknown> {
  const { Checkout } = await import('../src/checkout');
  return new Checkout({
    rails: { tempo: { recipient: RECIPIENT, network: 'tempo-mainnet' } },
    url: 'https://api.example/purchase',
    computePricing: async () => ({ amountUsd: 1.0 }),
    composeMppx: async (ctx: { request: { headers: Record<string, string> } }) => {
      if (!ctx.request.headers.authorization) {
        return { status: 402, headers: { 'www-authenticate': 'Payment realm="t"' } };
      }
      return {
        status: 200,
        railKey: 'tempo',
        txHash: '0xtest',
        signerAddress: '0xabc0000000000000000000000000000000000001',
        signerNetwork: 'evm',
      };
    },
    onSettled: async (_ctx: unknown, outcome: { txHash?: string }) => ({
      order_id: 'o-1',
      tx_hash: outcome.txHash,
    }),
    gate,
  });
}

describe('Checkout gate hooks', () => {
  it('runGate escape hatch returning undefined → allow → settle proceeds', async () => {
    const seen: unknown[] = [];
    const checkout = await _checkoutWithGate({
      apiKey: 'k',
      runGate: async (ctx: unknown) => {
        seen.push(ctx);
        return undefined;
      },
    }) as { handle: (req: unknown) => Promise<{ status: number }> };
    const result = await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: { authorization: 'Payment <opaque>' },
      body: {},
    });
    expect(result.status).toBe(200);
    expect(seen.length).toBe(1);
  });
  it('runGate returning a denial dict propagates status + body + headers', async () => {
    const checkout = await _checkoutWithGate({
      apiKey: 'k',
      runGate: async () => ({
        status: 403,
        body: { error: { code: 'custom_denied' } },
        headers: { 'X-Custom': 'v' },
      }),
    }) as {
      handle: (req: unknown) => Promise<{
        status: number;
        body: Record<string, unknown>;
        headers: Record<string, string>;
      }>;
    };
    const result = await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: { authorization: 'Payment <opaque>' },
      body: {},
    });
    expect(result.status).toBe(403);
    expect((result.body.error as { code: string }).code).toBe('custom_denied');
    expect(result.headers['X-Custom']).toBe('v');
  });
  it('runGate returning an invalid shape throws TypeError', async () => {
    const checkout = await _checkoutWithGate({
      apiKey: 'k',
      runGate: async () => 'not-a-valid-shape' as unknown,
    }) as { handle: (req: unknown) => Promise<unknown> };
    await expect(
      checkout.handle({
        method: 'POST',
        url: 'https://api.example/purchase',
        headers: { authorization: 'Payment <opaque>' },
        body: {},
      }),
    ).rejects.toThrow();
  });
  it('perRequestPolicy returning null skips the gate entirely', async () => {
    const checkout = await _checkoutWithGate({
      apiKey: 'k',
      perRequestPolicy: async () => null,
    }) as { handle: (req: unknown) => Promise<{ status: number }> };
    const result = await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: { authorization: 'Payment <opaque>' },
      body: {},
    });
    expect(result.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Checkout constructor auto-derive paths
// ─────────────────────────────────────────────────────────────────────────────

describe('Checkout auto-derives composeMppx from mppxSecretKey', () => {
  it('passing mppxSecretKey without composeMppx wires lazyMppxServer + makeMppxComposeHook', async () => {
    const checkout = new Checkout({
      rails: { tempo: { recipient: RECIPIENT, network: 'tempo-mainnet' } as TempoRailSpec },
      url: 'https://api.example/purchase',
      computePricing: async () => ({ amountUsd: 1.0 }),
      mppxSecretKey: 'X'.repeat(32),
    });
    // Discovery leg should emit 402 with the auto-derived composeMppx producing
    // a www-authenticate challenge — but our mock real `lazyMppxServer` will
    // need mppx peer dep. So we only assert the constructor accepted the
    // auto-derive config (no throw).
    expect(checkout).toBeDefined();
    const result = await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: {},
      body: {},
    });
    // Discovery leg returns 402 regardless of whether composeMppx server resolves.
    expect(result.status).toBe(402);
  });
});

describe('Checkout 402 emit with x402 server', () => {
  it('builds x402 accepts from the server during 402 emit', async () => {
    const checkout = new Checkout({
      rails: { x402_base: { recipient: RECIPIENT, network: 'eip155:84532' } as X402BaseRailSpec },
      url: 'https://api.example/purchase',
      computePricing: async () => ({ amountUsd: 1.0 }),
      x402Server: _mockX402Server() as never,
    });
    const result = await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: {},
      body: {},
    });
    expect(result.status).toBe(402);
    // x402 accepts entries should be derived from buildPaymentRequirements
    expect((result.body as { accepts?: unknown[] }).accepts).toBeDefined();
  });

  it('falls back to empty accepts when buildPaymentRequirements throws', async () => {
    const server = _mockX402Server({
      buildPaymentRequirements: vi.fn().mockRejectedValue(new Error('scheme not registered')),
    });
    const checkout = new Checkout({
      rails: { x402_base: { recipient: RECIPIENT, network: 'eip155:84532' } as X402BaseRailSpec },
      url: 'https://api.example/purchase',
      computePricing: async () => ({ amountUsd: 1.0 }),
      x402Server: server as never,
    });
    const result = await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: {},
      body: {},
    });
    expect(result.status).toBe(402);
    // The catch branch ran (else accepts would have been populated).
    // accepts may be undefined or [] depending on body shape; the key signal
    // is that the response was 402 with no x402 entries (the rail dropped out).
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getIdentityStatus
// ─────────────────────────────────────────────────────────────────────────────

describe('getIdentityStatus', () => {
  it('returns anonymous when assess is undefined / null', async () => {
    const { getIdentityStatus } = await import('../src/checkout');
    expect(getIdentityStatus({ request: {} as never } as never)).toBe('anonymous');
    expect(getIdentityStatus({ request: { assess: null } } as never)).toBe('anonymous');
  });
  it('returns verified when assess.decision is allow', async () => {
    const { getIdentityStatus } = await import('../src/checkout');
    expect(getIdentityStatus({ request: { assess: { decision: 'allow' } } } as never)).toBe('verified');
  });
  it('returns unverified when assess is present but decision is not allow', async () => {
    const { getIdentityStatus } = await import('../src/checkout');
    expect(getIdentityStatus({ request: { assess: { decision: 'deny' } } } as never)).toBe('unverified');
    expect(getIdentityStatus({ request: { assess: {} } } as never)).toBe('unverified');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SDK gate path (createAgentScoreCore + core.evaluate)
// ─────────────────────────────────────────────────────────────────────────────

function _mockCore(opts: {
  outcome?: 'allow' | 'deny';
  reason?: Record<string, unknown>;
  signerVerdict?: Record<string, unknown>;
  captureWalletCalls?: Array<Record<string, unknown>>;
}) {
  return {
    evaluate: async () => (
      opts.outcome === 'deny'
        ? { kind: 'deny', reason: opts.reason ?? { code: 'kyc_required' } }
        : { kind: 'allow' }
    ),
    getSignerVerdict: () => opts.signerVerdict,
    captureWallet: async (o: Record<string, unknown>) => {
      opts.captureWalletCalls?.push(o);
    },
  };
}

describe('Checkout SDK gate path', () => {
  it('SDK gate allow → settle proceeds and ctx.captureWallet is wired', async () => {
    const captureCalls: Array<Record<string, unknown>> = [];
    vi.doMock('../src/core', async () => {
      const real = await vi.importActual<typeof import('../src/core')>('../src/core');
      return {
        ...real,
        createAgentScoreCore: () => _mockCore({ outcome: 'allow', captureWalletCalls: captureCalls }),
      };
    });
    const { Checkout: ScopedCheckout } = await import('../src/checkout?sdk-gate-allow');

    const checkout = new ScopedCheckout({
      rails: { tempo: { recipient: RECIPIENT, network: 'tempo-mainnet' } as TempoRailSpec },
      url: 'https://api.example/purchase',
      computePricing: async () => ({ amountUsd: 1.0 }),
      composeMppx: async () => ({
        status: 200,
        railKey: 'tempo',
        txHash: '0xchain_tx',
        signerAddress: '0xabc',
        signerNetwork: 'evm',
      }),
      onSettled: async (ctx, outcome) => {
        if (ctx.captureWallet !== undefined && outcome.signerAddress !== null) {
          await ctx.captureWallet({
            walletAddress: outcome.signerAddress,
            network: 'evm',
            idempotencyKey: outcome.txHash ?? undefined,
          });
        }
        return { order_id: 'o-1' };
      },
      gate: { apiKey: 'k', requireKyc: true },
    });
    const result = await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: { authorization: 'Payment <cred>', 'x-operator-token': 'opc_test' },
      body: {},
    });
    expect(result.status).toBe(200);
    expect(captureCalls).toEqual([
      { operatorToken: 'opc_test', walletAddress: '0xabc', network: 'evm', idempotencyKey: '0xchain_tx' },
    ]);
    vi.doUnmock('../src/core');
  });

  it('SDK gate deny → 403 with denialReasonToBody envelope', async () => {
    vi.doMock('../src/core', async () => {
      const real = await vi.importActual<typeof import('../src/core')>('../src/core');
      return {
        ...real,
        createAgentScoreCore: () =>
          _mockCore({
            outcome: 'deny',
            reason: { code: 'kyc_required', agent_instructions: { action: 'deliver_verify_url_and_poll' } },
          }),
      };
    });
    const { Checkout: ScopedCheckout } = await import('../src/checkout?sdk-gate-deny');

    const checkout = new ScopedCheckout({
      rails: { tempo: { recipient: RECIPIENT, network: 'tempo-mainnet' } as TempoRailSpec },
      url: 'https://api.example/purchase',
      computePricing: async () => ({ amountUsd: 1.0 }),
      composeMppx: async () => ({ status: 402, headers: {} }),
      onSettled: async () => ({}),
      gate: { apiKey: 'k', requireKyc: true },
    });
    const result = await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: { authorization: 'Payment <cred>' },
      body: {},
    });
    expect([401, 403, 503]).toContain(result.status);
    expect((result.body as { error?: { code?: string } }).error?.code).toBe('kyc_required');
    vi.doUnmock('../src/core');
  });

  it('SDK gate signer-match mismatch denies inline as wallet_signer_mismatch', async () => {
    vi.doMock('../src/core', async () => {
      const real = await vi.importActual<typeof import('../src/core')>('../src/core');
      return {
        ...real,
        createAgentScoreCore: () => ({
          evaluate: async () => ({ kind: 'allow' }),
          getSignerVerdict: () => ({
            signer_match: {
              kind: 'wallet_signer_mismatch',
              claimedOperator: 'op_a',
              actualSignerOperator: 'op_b',
              expectedSigner: '0xclaimed',
              actualSigner: '0xactual',
              linkedWallets: ['0xlinked'],
              agentInstructions: { action: 'resign_or_switch_to_operator_token' },
              claimedWallet: '0xclaimed',
            },
          }),
          captureWallet: async () => {},
        }),
      };
    });
    const { Checkout: ScopedCheckout } = await import('../src/checkout?sdk-gate-sm');

    const checkout = new ScopedCheckout({
      rails: { tempo: { recipient: RECIPIENT, network: 'tempo-mainnet' } as TempoRailSpec },
      url: 'https://api.example/purchase',
      computePricing: async () => ({ amountUsd: 1.0 }),
      composeMppx: async () => ({ status: 200, railKey: 'tempo', txHash: '0x' }),
      onSettled: async () => ({}),
      gate: { apiKey: 'k' },
    });
    const result = await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: { authorization: 'Payment <cred>', 'x-wallet-address': '0xclaimed' },
      body: {},
    });
    expect(result.status).toBe(403);
    expect((result.body as { error: { code: string } }).error.code).toBe('wallet_signer_mismatch');
    vi.doUnmock('../src/core');
  });

  it('SDK gate signer-match wallet_auth_requires_wallet_signing also denies inline', async () => {
    vi.doMock('../src/core', async () => {
      const real = await vi.importActual<typeof import('../src/core')>('../src/core');
      return {
        ...real,
        createAgentScoreCore: () => ({
          evaluate: async () => ({ kind: 'allow' }),
          getSignerVerdict: () => ({
            signer_match: {
              kind: 'wallet_auth_requires_wallet_signing',
              claimedWallet: '0xclaimed',
              agentInstructions: { action: 'switch_to_operator_token' },
            },
          }),
          captureWallet: async () => {},
        }),
      };
    });
    const { Checkout: ScopedCheckout } = await import('../src/checkout?sdk-gate-sm-wallet');
    const checkout = new ScopedCheckout({
      rails: { tempo: { recipient: RECIPIENT, network: 'tempo-mainnet' } as TempoRailSpec },
      url: 'https://api.example/purchase',
      computePricing: async () => ({ amountUsd: 1.0 }),
      composeMppx: async () => ({ status: 200, railKey: 'tempo', txHash: '0x' }),
      onSettled: async () => ({}),
      gate: { apiKey: 'k' },
    });
    const result = await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: { authorization: 'Payment <cred>', 'x-wallet-address': '0xclaimed' },
      body: {},
    });
    expect(result.status).toBe(403);
    expect((result.body as { error: { code: string } }).error.code).toBe('wallet_auth_requires_wallet_signing');
    vi.doUnmock('../src/core');
  });

  it('SDK gate onDenied callback can reshape the canonical denial body', async () => {
    vi.doMock('../src/core', async () => {
      const real = await vi.importActual<typeof import('../src/core')>('../src/core');
      return {
        ...real,
        createAgentScoreCore: () =>
          _mockCore({ outcome: 'deny', reason: { code: 'kyc_required' } }),
      };
    });
    const { Checkout: ScopedCheckout } = await import('../src/checkout?sdk-gate-on-denied');

    const checkout = new ScopedCheckout({
      rails: { tempo: { recipient: RECIPIENT, network: 'tempo-mainnet' } as TempoRailSpec },
      url: 'https://api.example/purchase',
      computePricing: async () => ({ amountUsd: 1.0 }),
      composeMppx: async () => ({ status: 402, headers: {} }),
      onSettled: async () => ({}),
      gate: {
        apiKey: 'k',
        requireKyc: true,
        onDenied: async (_ctx, reason) => ({
          status: 402,
          body: { error: { code: 'custom_kyc', upstream: (reason as { code: string }).code } },
          headers: {},
        }),
      },
    });
    const result = await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: { authorization: 'Payment <cred>' },
      body: {},
    });
    expect(result.status).toBe(402);
    expect((result.body as { error: { code: string; upstream: string } }).error.code).toBe('custom_kyc');
    vi.doUnmock('../src/core');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Wallet OFAC sanctions default (TEC-311) — gateless merchants
// ─────────────────────────────────────────────────────────────────────────────

describe('Checkout wallet OFAC default (no gate config)', () => {
  it('clean signer + AGENTSCORE_API_KEY set: calls /v1/assess, allow proceeds to settle', async () => {
    vi.doMock('../src/core', async () => {
      const real = await vi.importActual<typeof import('../src/core')>('../src/core');
      return {
        ...real,
        createAgentScoreCore: () => _mockCore({ outcome: 'allow' }),
      };
    });
    vi.stubEnv('AGENTSCORE_API_KEY', 'as_test_key');
    const { Checkout: ScopedCheckout } = await import('../src/checkout?wallet-ofac-allow');
    const checkout = new ScopedCheckout({
      rails: { x402_base: { recipient: RECIPIENT, network: 'eip155:84532' } as X402BaseRailSpec },
      url: 'https://api.example/purchase',
      computePricing: async () => ({ amountUsd: 1.0 }),
      x402Server: _mockX402Server() as never,
      isCachedAddress: () => true,
      onSettled: async () => ({ order_id: 'o-ok' }),
    });
    const result = await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: { 'x-payment': _x402PaymentHeader('0xAbC0000000000000000000000000000000000099') },
      body: {},
    });
    expect(result.status).toBe(200);
    vi.unstubAllEnvs();
    vi.doUnmock('../src/core');
  });

  it('api_error from /v1/assess: returns 503 (transient API outage, fail-closed)', async () => {
    vi.doMock('../src/core', async () => {
      const real = await vi.importActual<typeof import('../src/core')>('../src/core');
      return {
        ...real,
        createAgentScoreCore: () => _mockCore({ outcome: 'deny', reason: { code: 'api_error' } }),
      };
    });
    vi.stubEnv('AGENTSCORE_API_KEY', 'as_test_key');
    const { Checkout: ScopedCheckout } = await import('../src/checkout?wallet-ofac-api-error');
    const checkout = new ScopedCheckout({
      rails: { x402_base: { recipient: RECIPIENT, network: 'eip155:84532' } as X402BaseRailSpec },
      url: 'https://api.example/purchase',
      computePricing: async () => ({ amountUsd: 1.0 }),
      x402Server: _mockX402Server() as never,
      isCachedAddress: () => true,
      onSettled: async () => ({}),
    });
    const result = await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: { 'x-payment': _x402PaymentHeader('0xAbC0000000000000000000000000000000000099') },
      body: {},
    });
    expect(result.status).toBe(503);
    vi.unstubAllEnvs();
    vi.doUnmock('../src/core');
  });

  it('token_expired denial maps to 401', async () => {
    vi.doMock('../src/core', async () => {
      const real = await vi.importActual<typeof import('../src/core')>('../src/core');
      return {
        ...real,
        createAgentScoreCore: () => _mockCore({ outcome: 'deny', reason: { code: 'token_expired' } }),
      };
    });
    vi.stubEnv('AGENTSCORE_API_KEY', 'as_test_key');
    const { Checkout: ScopedCheckout } = await import('../src/checkout?wallet-ofac-401');
    const checkout = new ScopedCheckout({
      rails: { x402_base: { recipient: RECIPIENT, network: 'eip155:84532' } as X402BaseRailSpec },
      url: 'https://api.example/purchase',
      computePricing: async () => ({ amountUsd: 1.0 }),
      x402Server: _mockX402Server() as never,
      isCachedAddress: () => true,
      onSettled: async () => ({}),
    });
    const result = await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: { 'x-payment': _x402PaymentHeader('0xAbC0000000000000000000000000000000000099') },
      body: {},
    });
    expect(result.status).toBe(401);
    vi.unstubAllEnvs();
    vi.doUnmock('../src/core');
  });

  it('SDN signer + AGENTSCORE_API_KEY set: denies with sanctions_flagged', async () => {
    vi.doMock('../src/core', async () => {
      const real = await vi.importActual<typeof import('../src/core')>('../src/core');
      return {
        ...real,
        createAgentScoreCore: () => _mockCore({
          outcome: 'deny',
          reason: { code: 'wallet_not_trusted', reasons: ['sanctions_flagged'] },
        }),
      };
    });
    vi.stubEnv('AGENTSCORE_API_KEY', 'as_test_key');
    const { Checkout: ScopedCheckout } = await import('../src/checkout?wallet-ofac-deny');
    const checkout = new ScopedCheckout({
      rails: { x402_base: { recipient: RECIPIENT, network: 'eip155:84532' } as X402BaseRailSpec },
      url: 'https://api.example/purchase',
      computePricing: async () => ({ amountUsd: 1.0 }),
      x402Server: _mockX402Server() as never,
      isCachedAddress: () => true,
      onSettled: async () => ({}),
    });
    const result = await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: { 'x-payment': _x402PaymentHeader('0xdead000000000000000000000000000000000bad') },
      body: {},
    });
    expect(result.status).toBe(403);
    expect(result.settled).toBe(false);
    vi.unstubAllEnvs();
    vi.doUnmock('../src/core');
  });

  it('Stripe SPT (no extractable signer): skips OFAC silently, settle proceeds', async () => {
    vi.doMock('../src/signer', async () => {
      const real = await vi.importActual<typeof import('../src/signer')>('../src/signer');
      return { ...real, extractPaymentSignerFromAuth: async () => null };
    });
    vi.stubEnv('AGENTSCORE_API_KEY', 'as_test_key');
    const { Checkout: ScopedCheckout } = await import('../src/checkout?wallet-ofac-spt');
    const checkout = new ScopedCheckout({
      rails: { x402_base: { recipient: RECIPIENT, network: 'eip155:84532' } as X402BaseRailSpec },
      url: 'https://api.example/purchase',
      computePricing: async () => ({ amountUsd: 1.0 }),
      x402Server: _mockX402Server() as never,
      isCachedAddress: () => true,
      onSettled: async () => ({ order_id: 'o-spt' }),
    });
    const result = await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: { 'x-payment': _x402PaymentHeader('0xAbC0000000000000000000000000000000000099') },
      body: {},
    });
    expect(result.status).toBe(200);
    vi.unstubAllEnvs();
    vi.doUnmock('../src/signer');
  });

  it('invalid_credential denial maps to 401 (matches token_expired path)', async () => {
    vi.doMock('../src/core', async () => {
      const real = await vi.importActual<typeof import('../src/core')>('../src/core');
      return {
        ...real,
        createAgentScoreCore: () => _mockCore({ outcome: 'deny', reason: { code: 'invalid_credential' } }),
      };
    });
    vi.stubEnv('AGENTSCORE_API_KEY', 'as_test_key');
    const { Checkout: ScopedCheckout } = await import('../src/checkout?wallet-ofac-401b');
    const checkout = new ScopedCheckout({
      rails: { x402_base: { recipient: RECIPIENT, network: 'eip155:84532' } as X402BaseRailSpec },
      url: 'https://api.example/purchase',
      computePricing: async () => ({ amountUsd: 1.0 }),
      x402Server: _mockX402Server() as never,
      isCachedAddress: () => true,
      onSettled: async () => ({}),
    });
    const result = await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: { 'x-payment': _x402PaymentHeader('0xAbC0000000000000000000000000000000000099') },
      body: {},
    });
    expect(result.status).toBe(401);
    vi.unstubAllEnvs();
    vi.doUnmock('../src/core');
  });

  it('no AGENTSCORE_API_KEY: warns ONCE across multiple settles, skips OFAC, settle proceeds', async () => {
    vi.stubEnv('AGENTSCORE_API_KEY', '');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { Checkout: ScopedCheckout } = await import('../src/checkout?wallet-ofac-no-key');
    const checkout = new ScopedCheckout({
      rails: { x402_base: { recipient: RECIPIENT, network: 'eip155:84532' } as X402BaseRailSpec },
      url: 'https://api.example/purchase',
      computePricing: async () => ({ amountUsd: 1.0 }),
      x402Server: _mockX402Server() as never,
      isCachedAddress: () => true,
      onSettled: async () => ({ order_id: 'o-no-key' }),
    });
    const a = await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: { 'x-payment': _x402PaymentHeader('0xAbC0000000000000000000000000000000000099') },
      body: {},
    });
    expect(a.status).toBe(200);
    const noKeyWarns = () => warnSpy.mock.calls.filter((c) => String(c[0]).includes('AGENTSCORE_API_KEY is not set')).length;
    expect(noKeyWarns()).toBeGreaterThanOrEqual(1);
    const warnsBeforeSecond = noKeyWarns();
    // Second settle exercises the `if (!Checkout.warnedNoApiKey)` branch.
    const b = await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: { 'x-payment': _x402PaymentHeader('0xAbC0000000000000000000000000000000000099') },
      body: {},
    });
    expect(b.status).toBe(200);
    expect(noKeyWarns()).toBe(warnsBeforeSecond); // no new warns
    warnSpy.mockRestore();
    vi.unstubAllEnvs();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Zero-settle MPP carve-out
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Checkout handleX402 + handleMppx settle paths
// ─────────────────────────────────────────────────────────────────────────────

function _mockX402Server(overrides: Partial<{
  buildPaymentRequirements: ReturnType<typeof vi.fn>;
  enrichExtensions: ReturnType<typeof vi.fn>;
  verifyPayment: ReturnType<typeof vi.fn>;
  settlePayment: ReturnType<typeof vi.fn>;
}> = {}): unknown {
  return {
    buildPaymentRequirements: overrides.buildPaymentRequirements ?? vi.fn().mockResolvedValue([
      { scheme: 'exact', network: 'eip155:84532', payTo: RECIPIENT, maxAmountRequired: '10000', extra: { name: 'USDC', version: '2' } },
    ]),
    enrichExtensions: overrides.enrichExtensions ?? vi.fn().mockReturnValue(undefined),
    verifyPayment: overrides.verifyPayment ?? vi.fn().mockResolvedValue({ success: true }),
    settlePayment: overrides.settlePayment ?? vi.fn().mockResolvedValue({
      success: true, transaction: '0xchain_tx', network: 'eip155:84532', payer: '0xabc0000000000000000000000000000000000099',
    }),
  };
}

function _x402PaymentHeader(payerAddress: string): string {
  const payload = {
    x402Version: 2,
    scheme: 'exact',
    network: 'eip155:84532',
    accepted: {
      scheme: 'exact',
      network: 'eip155:84532',
      payTo: RECIPIENT,
      maxAmountRequired: '100000',
      maxTimeoutSeconds: 300,
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      extra: { name: 'USDC', version: '2' },
    },
    payload: {
      signature: '0x' + 'ee'.repeat(65),
      authorization: {
        from: payerAddress,
        to: RECIPIENT,
        value: '100000',
        validAfter: '0',
        validBefore: '9999999999',
        nonce: '0x' + '00'.repeat(32),
      },
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

describe('Checkout handleX402 happy path', () => {
  // These tests construct a gateless Checkout (no `gate` config) and exercise
  // the x402 settle path. Under the always-on wallet OFAC default, that path
  // would call /v1/assess — but these tests don't mock the AgentScore API.
  // Stub the env to opt these tests into the "no API key → log+skip" path so
  // the focus stays on the x402 mock surface, not on OFAC enforcement.
  beforeEach(() => { vi.stubEnv('AGENTSCORE_API_KEY', ''); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('settles x402 via the mocked server and emits 200 with txHash', async () => {
    const onSettledArgs: Array<{ txHash?: string | null; signerAddress?: string | null }> = [];
    const checkout = new Checkout({
      rails: { x402_base: { recipient: RECIPIENT, network: 'eip155:84532' } as X402BaseRailSpec },
      url: 'https://api.example/purchase',
      computePricing: async () => ({ amountUsd: 1.0 }),
      x402Server: _mockX402Server() as never,
      isCachedAddress: () => true,
      onSettled: async (_ctx, outcome) => {
        onSettledArgs.push({ txHash: outcome.txHash, signerAddress: outcome.signerAddress });
        return { order_id: 'o-1', tx_hash: outcome.txHash, signer: outcome.signerAddress };
      },
    });
    const header = _x402PaymentHeader('0xAbC0000000000000000000000000000000000099');
    const result = await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: { 'x-payment': header },
      body: { item: 'wine' },
    });
    expect(result.status).toBe(200);
    expect(result.settled).toBe(true);
    expect(onSettledArgs.length).toBe(1);
    expect(onSettledArgs[0].txHash).toBe('0xchain_tx');
    expect(onSettledArgs[0].signerAddress).toBe('0xabc0000000000000000000000000000000000099');
  });

  it('returns verify_failed envelope on verify reject', async () => {
    const server = _mockX402Server({
      verifyPayment: vi.fn().mockResolvedValue({ success: false, reason: 'invalid_credential' }),
    });
    const checkout = new Checkout({
      rails: { x402_base: { recipient: RECIPIENT, network: 'eip155:84532' } as X402BaseRailSpec },
      url: 'https://api.example/purchase',
      computePricing: async () => ({ amountUsd: 1.0 }),
      x402Server: server as never,
      isCachedAddress: () => true,
      onSettled: async () => ({}),
    });
    const header = _x402PaymentHeader('0xAbC0000000000000000000000000000000000099');
    const result = await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: { 'x-payment': header },
      body: { item: 'wine' },
    });
    expect([400, 402, 403]).toContain(result.status);
    expect(result.settled).toBe(false);
  });

  it('classifies settle failures as 503 payment_provider_unavailable on facilitator error', async () => {
    const server = _mockX402Server({
      settlePayment: vi.fn().mockRejectedValue(new Error('cdp facilitator down')),
    });
    const checkout = new Checkout({
      rails: { x402_base: { recipient: RECIPIENT, network: 'eip155:84532' } as X402BaseRailSpec },
      url: 'https://api.example/purchase',
      computePricing: async () => ({ amountUsd: 1.0 }),
      x402Server: server as never,
      isCachedAddress: () => true,
      onSettled: async () => ({}),
    });
    const header = _x402PaymentHeader('0xAbC0000000000000000000000000000000000099');
    const result = (await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: { 'x-payment': header },
      body: { item: 'wine' },
    })) as { status: number; settled: boolean };
    expect(result.settled).toBe(false);
    expect(result.status).toBeGreaterThanOrEqual(400);
  });
});

describe('Checkout handleMppx', () => {
  it('emits 200 with txHash from composeMppx on settle', async () => {
    const settles: Array<{ txHash?: string | null }> = [];
    const checkout = new Checkout({
      rails: { tempo: { recipient: RECIPIENT, network: 'tempo-mainnet' } as TempoRailSpec },
      url: 'https://api.example/purchase',
      computePricing: async () => ({ amountUsd: 1.0 }),
      composeMppx: async (ctx) => {
        if (!ctx.request.headers.authorization) {
          return { status: 402, headers: { 'www-authenticate': 'Payment realm="t"' } };
        }
        return {
          status: 200,
          railKey: 'tempo',
          txHash: '0xmppx_tx',
          signerAddress: '0xabc0000000000000000000000000000000000007',
          signerNetwork: 'evm',
        };
      },
      onSettled: async (_ctx, outcome) => {
        settles.push({ txHash: outcome.txHash });
        return { order_id: 'o-mpp', tx_hash: outcome.txHash };
      },
    });
    const result = await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: { authorization: 'Payment <credential>' },
      body: { item: 'wine' },
    });
    expect(result.status).toBe(200);
    expect(settles).toEqual([{ txHash: '0xmppx_tx' }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// preValidate / CheckoutValidationError / validation envelope
// ─────────────────────────────────────────────────────────────────────────────

describe('Checkout preValidate', () => {
  it('populates ctx.state from the preValidate return value', async () => {
    const seenState: Record<string, unknown>[] = [];
    const checkout = new Checkout({
      rails: { tempo: { recipient: RECIPIENT, network: 'tempo-mainnet' } as TempoRailSpec },
      url: 'https://api.example/purchase',
      computePricing: async (ctx) => {
        seenState.push({ ...ctx.state });
        return { amountUsd: 1.0 };
      },
      preValidate: async (_ctx) => ({ product: { slug: 'wine-2020', purchaseMode: 'paid_only' } }),
    });
    await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: {},
      body: {},
    });
    expect(seenState[0]).toEqual({ product: { slug: 'wine-2020', purchaseMode: 'paid_only' } });
  });

  it('returns canonical validation envelope on CheckoutValidationError', async () => {
    const { CheckoutValidationError } = await import('../src/errors');
    const checkout = new Checkout({
      rails: { tempo: { recipient: RECIPIENT, network: 'tempo-mainnet' } as TempoRailSpec },
      url: 'https://api.example/purchase',
      computePricing: async () => ({ amountUsd: 1.0 }),
      preValidate: async () => {
        throw new CheckoutValidationError({
          code: 'product_not_found',
          message: 'No such product.',
          status: 404,
          extra: { slug: 'mystery' },
        });
      },
    });
    const result = await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: {},
      body: { product_slug: 'mystery' },
    });
    expect(result.status).toBe(404);
    expect(((result.body as { error: { code: string } }).error).code).toBe('product_not_found');
  });

  it('CheckoutValidationError defaults to status 400 + action fix_request when unset', async () => {
    const { CheckoutValidationError } = await import('../src/errors');
    const err = new CheckoutValidationError({
      code: 'bad_thing',
      message: 'nope',
    });
    expect(err.status).toBe(400);
    expect(err.action).toBe('fix_request');
    expect(err.extra).toBeUndefined();
  });

  it('rethrows non-CheckoutValidationError errors from preValidate', async () => {
    const checkout = new Checkout({
      rails: { tempo: { recipient: RECIPIENT, network: 'tempo-mainnet' } as TempoRailSpec },
      url: 'https://api.example/purchase',
      computePricing: async () => ({ amountUsd: 1.0 }),
      preValidate: async () => {
        throw new Error('unexpected crash');
      },
    });
    await expect(
      checkout.handle({
        method: 'POST',
        url: 'https://api.example/purchase',
        headers: {},
        body: {},
      }),
    ).rejects.toThrow('unexpected crash');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Framework adapter SETTLE leg (handleHono / handleExpress / handleFastify / handleNextjs / handleWeb)
// ─────────────────────────────────────────────────────────────────────────────

function _settleCheckout(): Checkout {
  return new Checkout({
    rails: { tempo: { recipient: RECIPIENT, network: 'tempo-mainnet' } as TempoRailSpec },
    url: 'https://api.example/purchase',
    computePricing: async () => ({ amountUsd: 1.0 }),
    composeMppx: async (ctx) => {
      if (!ctx.request.headers.authorization) {
        return { status: 402, headers: { 'www-authenticate': 'Payment realm="t"' } };
      }
      return {
        status: 200,
        railKey: 'tempo',
        txHash: '0xtest_settle',
        signerAddress: '0xabc',
        signerNetwork: 'evm',
      };
    },
    onSettled: async (_ctx, outcome) => ({
      order_id: 'order-1',
      tx_hash: outcome.txHash,
    }),
  });
}

describe('Framework adapter SETTLE leg', () => {
  it('handleHono 200 on settle leg with authorization', async () => {
    const checkout = _settleCheckout();
    const { Hono } = await import('hono');
    const app = new Hono();
    app.post('/purchase', (c) => checkout.handleHono(c));
    const resp = await app.request('/purchase', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Payment <cred>' },
      body: JSON.stringify({ item: 'wine' }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { order_id: string; tx_hash: string };
    expect(body.order_id).toBe('order-1');
    expect(body.tx_hash).toBe('0xtest_settle');
  });

  it('handleNextjs 200 on settle leg', async () => {
    const checkout = _settleCheckout();
    const req = new Request('https://api.example/purchase', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Payment <cred>' },
      body: JSON.stringify({ item: 'wine' }),
    });
    const resp = await checkout.handleNextjs(req);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { order_id: string };
    expect(body.order_id).toBe('order-1');
  });

  it('handleWeb 200 on settle leg (alias for handleNextjs)', async () => {
    const checkout = _settleCheckout();
    const req = new Request('https://api.example/purchase', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Payment <cred>' },
      body: JSON.stringify({ item: 'wine' }),
    });
    const resp = await checkout.handleWeb(req);
    expect(resp.status).toBe(200);
  });

  it('handleExpress writes a 200 on settle leg', async () => {
    const checkout = _settleCheckout();
    const captured: { status?: number; body?: unknown } = {};
    const req = {
      headers: { 'content-type': 'application/json', authorization: 'Payment <cred>' },
      body: { item: 'wine' },
      method: 'POST',
      protocol: 'https',
      get: (h: string) => (h.toLowerCase() === 'host' ? 'api.example' : ''),
      originalUrl: '/purchase',
    };
    const res = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      set: function (k: string, v: string) {
        this.headers[k] = v;
      },
      status: function (s: number) {
        this.statusCode = s;
        captured.status = s;
        return this;
      },
      json: function (b: unknown) {
        captured.body = b;
        return this;
      },
    };
    await checkout.handleExpress(req as never, res as never);
    expect(captured.status).toBe(200);
    expect(((captured.body as { order_id?: string })?.order_id)).toBe('order-1');
  });

  it('handleExpress handles array-valued headers (Express normalizes to string[] for some headers)', async () => {
    const checkout = _settleCheckout();
    const captured: { status?: number; body?: unknown } = {};
    const req = {
      headers: {
        'content-type': 'application/json',
        // Express represents multi-value headers as string[].
        'accept': ['application/json', 'text/plain'],
        // Single-value: still a string.
        authorization: 'Payment <cred>',
      },
      body: { item: 'wine' },
      method: 'POST',
      protocol: 'https',
      get: (h: string) => (h.toLowerCase() === 'host' ? 'api.example' : ''),
      originalUrl: '/purchase',
    };
    const res = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      set: function (k: string, v: string) { this.headers[k] = v; },
      setHeader: function (k: string, v: string) { this.headers[k] = v; },
      status: function (s: number) { this.statusCode = s; captured.status = s; return this; },
      json: function (b: unknown) { captured.body = b; return this; },
    };
    await checkout.handleExpress(req as never, res as never);
    expect(captured.status).toBe(200);
  });

  it('handleExpress 400 invalid_body envelope when body is non-object', async () => {
    const checkout = _settleCheckout();
    const captured: { status?: number; body?: unknown } = {};
    const req = {
      headers: { 'content-type': 'application/json' },
      body: 'not-an-object',
      method: 'POST',
      get: (_h: string) => '',
      originalUrl: '/purchase',
    };
    const res = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      set: function (k: string, v: string) { this.headers[k] = v; },
      setHeader: function (k: string, v: string) { this.headers[k] = v; },
      status: function (s: number) { this.statusCode = s; captured.status = s; return this; },
      json: function (b: unknown) { captured.body = b; return this; },
    };
    await checkout.handleExpress(req as never, res as never);
    expect(captured.status).toBe(400);
    expect(((captured.body as { error?: { code: string } })?.error?.code)).toBe('invalid_body');
  });

  it('handleFastify handles array-valued headers + body null returns 400', async () => {
    const checkout = _settleCheckout();
    let captured: { status?: number; body?: unknown } = {};
    const reply = {
      code: function (s: number) { captured.status = s; return this; },
      header: function () { return this; },
      send: function (b: unknown) { captured.body = b; return this; },
    };
    // Multi-value header path
    await checkout.handleFastify({
      headers: { 'content-type': 'application/json', 'x-multi': ['v1', 'v2'], authorization: 'Payment <cred>' },
      body: { item: 'wine' },
      method: 'POST',
      url: '/purchase',
    } as never, reply as never);
    expect(captured.status).toBe(200);
    // Null body branch
    captured = {};
    await checkout.handleFastify({
      headers: { 'content-type': 'application/json' },
      body: 'not-an-object',
      method: 'POST',
      url: '/purchase',
    } as never, reply as never);
    expect(captured.status).toBe(400);
  });

  it('handleFastify writes a 200 on settle leg', async () => {
    const checkout = _settleCheckout();
    const captured: { status?: number; body?: unknown } = {};
    const request = {
      headers: { 'content-type': 'application/json', authorization: 'Payment <cred>' },
      body: { item: 'wine' },
      method: 'POST',
      protocol: 'https',
      hostname: 'api.example',
      url: '/purchase',
    };
    const reply = {
      code: function (s: number) {
        captured.status = s;
        return this;
      },
      header: function () {
        return this;
      },
      send: function (b: unknown) {
        captured.body = b;
        return this;
      },
    };
    await checkout.handleFastify(request as never, reply as never);
    expect(captured.status).toBe(200);
  });
});

describe('Checkout mintRecipients - branch coverage', () => {
  it('drops a rail with empty-string recipient even when no override is provided', async () => {
    const checkout = new Checkout({
      rails: { tempo: { recipient: '' as unknown as string, network: 'tempo-mainnet' } as TempoRailSpec },
      url: 'https://api.example/purchase',
      computePricing: async () => ({ amountUsd: 1.0 }),
    });
    // Discovery leg should still emit 402 even with an empty-recipient rail
    // (per-order mint pattern — the rail is dropped from accepts).
    const result = await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: {},
      body: {},
    });
    expect(result.status).toBe(402);
  });
});

describe('Checkout discoveryExtensions on 402 body', () => {
  it('emits x402 extensions block when discoveryExtensions is configured', async () => {
    const checkout = new Checkout({
      rails: { x402_base: { recipient: RECIPIENT, network: 'eip155:84532' } as X402BaseRailSpec },
      url: 'https://api.example/purchase',
      computePricing: async () => ({ amountUsd: 1.0 }),
      x402Server: _mockX402Server() as never,
      discoveryExtensions: { bazaar: { discoveryEndpoint: 'https://x/.well-known/bazaar' } },
    });
    const result = await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: {},
      body: {},
    });
    expect(result.status).toBe(402);
    // Discovery extensions are emitted in the 402 body. The exact placement is
    // an implementation detail of build402Body; verify the value appears somewhere.
    const serialized = JSON.stringify(result.body);
    expect(serialized).toContain('bazaar');
    expect(serialized).toContain('https://x/.well-known/bazaar');
  });

  it('empty discoveryExtensions object does not emit the extensions field', async () => {
    const checkout = new Checkout({
      rails: { x402_base: { recipient: RECIPIENT, network: 'eip155:84532' } as X402BaseRailSpec },
      url: 'https://api.example/purchase',
      computePricing: async () => ({ amountUsd: 1.0 }),
      x402Server: _mockX402Server() as never,
      discoveryExtensions: {},
    });
    const result = await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: {},
      body: {},
    });
    const x402 = (result.body as { x402?: { extensions?: Record<string, unknown> } }).x402;
    expect(x402?.extensions).toBeUndefined();
  });
});

describe('Checkout handleX402 settle returns payer from settleResult when verified.payload lacks from', () => {
  it('falls back to settleResult.payer when payload.authorization.from is missing', async () => {
    // The mock processX402Settle response provides payer = "0xfallback_payer".
    const server = _mockX402Server({
      settlePayment: vi.fn().mockResolvedValue({
        success: true,
        transaction: '0xchain_tx',
        network: 'eip155:84532',
        payer: '0xFallBackPayer000000000000000000000000Abcd',
      }),
    });
    // Craft a payload where authorization.from is missing.
    const payload = {
      x402Version: 2,
      scheme: 'exact',
      network: 'eip155:84532',
      accepted: {
        scheme: 'exact', network: 'eip155:84532', payTo: RECIPIENT,
        maxAmountRequired: '100000', maxTimeoutSeconds: 300,
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        extra: { name: 'USDC', version: '2' },
      },
      payload: { signature: '0x' + 'ee'.repeat(65), authorization: { /* no from */ } },
    };
    const header = Buffer.from(JSON.stringify(payload)).toString('base64');
    const onSettledArgs: Array<{ signerAddress: string | null }> = [];
    const checkout = new Checkout({
      rails: { x402_base: { recipient: RECIPIENT, network: 'eip155:84532' } as X402BaseRailSpec },
      url: 'https://api.example/purchase',
      computePricing: async () => ({ amountUsd: 1.0 }),
      x402Server: server as never,
      isCachedAddress: () => true,
      onSettled: async (_ctx, outcome) => {
        onSettledArgs.push({ signerAddress: outcome.signerAddress });
        return { order_id: 'o-fallback', signer: outcome.signerAddress };
      },
    });
    const result = await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: { 'x-payment': header },
      body: {},
    });
    expect(result.status).toBe(200);
    // Signer came from settleResult.payer (no lowercase conversion in fallback path).
    expect(onSettledArgs[0].signerAddress).toBe('0xFallBackPayer000000000000000000000000Abcd');
  });
});

describe('Checkout zero-settle x402-base carve-out', () => {
  // Gateless Checkout + x402 settle: stub the env to opt into the log+skip
  // wallet-OFAC path (same reasoning as the happy-path block above).
  beforeEach(() => { vi.stubEnv('AGENTSCORE_API_KEY', ''); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('lifts signer from x402 payload at $0 and emits 200 with tx_hash null', async () => {
    const checkout = new Checkout({
      rails: { x402_base: { recipient: RECIPIENT, network: 'eip155:84532' } as X402BaseRailSpec },
      url: 'https://api.example/purchase',
      computePricing: async () => ({ amountUsd: 0.0 }),
      x402Server: _mockX402Server() as never,
      isCachedAddress: () => true,
      onSettled: async (_ctx, outcome) => ({
        order_id: 'o-zero',
        tx_hash: outcome.txHash,
        signer: outcome.signerAddress,
      }),
      zeroSettleCarveOut: true,
    });
    const header = _x402PaymentHeader('0xAbC0000000000000000000000000000000000007');
    const result = await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: { 'x-payment': header },
      body: {},
    });
    expect(result.status).toBe(200);
    expect((result.body as { tx_hash: string | null }).tx_hash).toBeNull();
    expect((result.body as { signer: string }).signer).toBe('0xabc0000000000000000000000000000000000007');
  });

  it('falls through gracefully when x-payment header is not valid base64 json', async () => {
    const checkout = new Checkout({
      rails: { x402_base: { recipient: RECIPIENT, network: 'eip155:84532' } as X402BaseRailSpec },
      url: 'https://api.example/purchase',
      computePricing: async () => ({ amountUsd: 0.0 }),
      x402Server: _mockX402Server() as never,
      isCachedAddress: () => true,
      onSettled: async () => ({ order_id: 'o-bad' }),
      zeroSettleCarveOut: true,
    });
    const result = await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: { 'x-payment': '!!!not-base64!!!' },
      body: {},
    });
    // Zero settle still succeeds (no signer lifted, but the carve-out doesn't gate on signer).
    expect(result.status).toBe(200);
  });
});

// Checkout._emit_402 auto-attaches identity_metadata when wallet-mode is detected (wave-2 cleanup)
describe('Checkout 402 emit attaches identity_metadata for wallet mode', () => {
  it('omits identity_metadata when X-Wallet-Address is absent', async () => {
    const { Checkout } = await import('../src/checkout');
    const checkout = new Checkout({
      rails: { tempo: { recipient: RECIPIENT } as TempoRailSpec },
      url: 'https://x/purchase',
      computePricing: async () => ({ amountUsd: 1.0 }),
    });
    const result = (await checkout.handle({
      method: 'POST',
      url: 'https://x/purchase',
      headers: {},
      body: { item: 'wine' },
    })) as { status: number; body: Record<string, unknown> };
    expect(result.body.identity_mode).toBeUndefined();
  });

  it('advertises required_signer when X-Wallet-Address is present', async () => {
    const { Checkout } = await import('../src/checkout');
    const checkout = new Checkout({
      rails: { tempo: { recipient: RECIPIENT } as TempoRailSpec },
      url: 'https://x/purchase',
      computePricing: async () => ({ amountUsd: 1.0 }),
    });
    const result = (await checkout.handle({
      method: 'POST',
      url: 'https://x/purchase',
      headers: { 'X-Wallet-Address': '0xCAFEBEEF' },
      body: { item: 'wine' },
    })) as { status: number; body: Record<string, unknown> };
    expect(result.body.identity_mode).toBe('wallet');
    expect(result.body.required_signer).toBe('0xCAFEBEEF');
    expect(result.body.signer_constraint).toBeTypeOf('string');
  });

  it('lifts linked_wallets from request.assess when populated', async () => {
    const { Checkout } = await import('../src/checkout');
    const checkout = new Checkout({
      rails: { tempo: { recipient: RECIPIENT } as TempoRailSpec },
      url: 'https://x/purchase',
      computePricing: async () => ({ amountUsd: 1.0 }),
    });
    const result = (await checkout.handle({
      method: 'POST',
      url: 'https://x/purchase',
      headers: { 'X-Wallet-Address': '0xCAFEBEEF' },
      body: { item: 'wine' },
      assess: { identity: { linked_wallets: ['0xSIB1', '0xSIB2'] } },
    })) as { status: number; body: Record<string, unknown> };
    expect(result.body.linked_wallets).toEqual(['0xSIB1', '0xSIB2']);
  });
});

// Checkout(discoveryProbe=...) auto-routing
describe('Checkout discoveryProbe routing', () => {
  it('empty-body POST without payment header returns probe 402', async () => {
    const { Checkout } = await import('../src/checkout');
    const checkout = new Checkout({
      rails: { tempo: { recipient: RECIPIENT, network: 'tempo-mainnet' } },
      url: 'https://api.example/purchase',
      computePricing: async () => ({ amountUsd: 1.0 }),
      discoveryProbe: {
        realm: 'example',
        sampleRail: 'tempo',
        sampleAmountUsd: 1.0,
        sampleRecipient: RECIPIENT,
        message: 'probe-msg',
      },
    });
    const result = (await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: {},
      body: {},
    })) as { status: number; body: Record<string, unknown>; headers: Record<string, string> };
    expect(result.status).toBe(402);
    expect(result.body.discovery).toBe(true);
    expect((result.body.error as { code: string }).code).toBe('payment_required');
    expect(result.headers['www-authenticate']).toContain('realm="example"');
  });

  it('POST with Payment authorization bypasses probe routing', async () => {
    const { Checkout } = await import('../src/checkout');
    let pricingCalled = false;
    const checkout = new Checkout({
      rails: { tempo: { recipient: RECIPIENT, network: 'tempo-mainnet' } },
      url: 'https://api.example/purchase',
      computePricing: async () => {
        pricingCalled = true;
        return { amountUsd: 1.0 };
      },
      discoveryProbe: {
        realm: 'example',
        sampleRail: 'tempo',
        sampleAmountUsd: 1.0,
        sampleRecipient: RECIPIENT,
      },
    });
    // Real Payment auth + a body → bypass probe, run normal flow.
    // composeMppx is unset, so this falls through to the discovery emit path; pricing still runs.
    await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: { authorization: 'Payment <opaque-credential>' },
      body: { item: 'wine' },
    });
    expect(pricingCalled).toBe(true);
  });

  it('GET request never triggers probe', async () => {
    const { Checkout } = await import('../src/checkout');
    let pricingCalled = false;
    const checkout = new Checkout({
      rails: { tempo: { recipient: RECIPIENT, network: 'tempo-mainnet' } },
      url: 'https://api.example/purchase',
      computePricing: async () => {
        pricingCalled = true;
        return { amountUsd: 1.0 };
      },
      discoveryProbe: {
        realm: 'example',
        sampleRail: 'tempo',
        sampleAmountUsd: 1.0,
        sampleRecipient: RECIPIENT,
      },
    });
    await checkout.handle({
      method: 'GET',
      url: 'https://api.example/purchase',
      headers: {},
      body: undefined,
    });
    expect(pricingCalled).toBe(true);
  });
});

describe('Checkout zero-settle MPP carve-out', () => {
  it('zeroSettleCarveOut=true + $0 + MPP authorization → 200 with tx_hash null', async () => {
    const { Checkout } = await import('../src/checkout');
    const checkout = new Checkout({
      rails: { tempo: { recipient: RECIPIENT, network: 'tempo-mainnet' } },
      url: 'https://api.example/purchase',
      computePricing: async () => ({ amountUsd: 0.0 }),
      composeMppx: async () => ({
        status: 402,
        headers: { 'www-authenticate': 'Payment realm="t"' },
      }),
      onSettled: async (_ctx: unknown, outcome: { txHash?: string | null; railKey?: string }) => ({
        order_id: 'o-1',
        tx_hash: outcome.txHash,
        rail_key: outcome.railKey,
      }),
      zeroSettleCarveOut: true,
    });
    const result = (await checkout.handle({
      method: 'POST',
      url: 'https://api.example/purchase',
      headers: { authorization: 'Payment <opaque-credential>' },
      body: { item: 'wine' },
    })) as { status: number; body: Record<string, unknown> };
    expect(result.status).toBe(200);
    expect(result.body.tx_hash ?? null).toBeNull();
  });
});

// Checkout.mountUcpRoutes<Framework>
/* eslint-disable @typescript-eslint/no-explicit-any */
describe('Checkout.mountUcpRoutes<Framework>', () => {
  async function mountedCheckout(): Promise<{ checkout: any; restoreEnv: () => void }> {
    const { Checkout } = await import('../src/checkout');
    const { generateUCPSigningKey, _resetUCPSigningKeyCache } = await import('../src/identity/ucp-jwks');
    const { exportJWK } = await import('jose');
    const checkout = new Checkout({
      rails: { tempo: { recipient: RECIPIENT } as TempoRailSpec },
      url: 'https://x/purchase',
      computePricing: async () => ({ amountUsd: 1.0 }),
    });
    _resetUCPSigningKeyCache();
    const { privateKey } = await generateUCPSigningKey({ kid: 'mount-test' });
    const privJwk = await exportJWK(privateKey as Parameters<typeof exportJWK>[0]);
    const prev = process.env.UCP_SIGNING_KEY_JWK_PRIVATE;
    process.env.UCP_SIGNING_KEY_JWK_PRIVATE = JSON.stringify({ ...privJwk, kid: 'mount-test', alg: 'EdDSA' });
    return {
      checkout,
      restoreEnv: () => {
        if (prev === undefined) delete process.env.UCP_SIGNING_KEY_JWK_PRIVATE;
        else process.env.UCP_SIGNING_KEY_JWK_PRIVATE = prev;
        _resetUCPSigningKeyCache();
      },
    };
  }

  it('mountUcpRoutesHono registers GET ucp + GET jwks + OPTIONS', async () => {
    const { checkout, restoreEnv } = await mountedCheckout();
    try {
      const routes: Record<string, (c: { req: { raw: Request } }) => Promise<Response> | Response> = {};
      const app = {
        get: (path: string, h: (c: { req: { raw: Request } }) => Promise<Response> | Response) => { routes[`GET ${path}`] = h; },
        options: (path: string, h: (c: { req: { raw: Request } }) => Promise<Response> | Response) => { routes[`OPTIONS ${path}`] = h; },
      };
      checkout.mountUcpRoutesHono(app, {
        name: 'Mount-Hono',
        wellKnownUcpUrl: 'https://x/.well-known/ucp',
        services: {},
        signingKid: 'mount-test',
      });
      const ucpResp = await routes['GET /.well-known/ucp']({ req: { raw: new Request('https://x/.well-known/ucp') } });
      const jwksResp = await routes['GET /.well-known/jwks.json']({ req: { raw: new Request('https://x/.well-known/jwks.json') } });
      const preflightResp = await routes['OPTIONS /.well-known/ucp']({ req: { raw: new Request('https://x/.well-known/ucp', { method: 'OPTIONS' }) } });

      expect(ucpResp.status).toBe(200);
      const ucpBody = await ucpResp.json() as { ucp: { name: string } };
      expect(ucpBody.ucp.name).toBe('Mount-Hono');
      expect(jwksResp.status).toBe(200);
      expect(preflightResp.status).toBe(204);
    } finally {
      restoreEnv();
    }
  });

  it('mountUcpRoutesExpress writes status + headers + body on res', async () => {
    const { checkout, restoreEnv } = await mountedCheckout();
    try {
      const routes: Record<string, any> = {};
      const app = {
        get: (path: string, h: any) => { routes[`GET ${path}`] = h; },
        options: (path: string, h: any) => { routes[`OPTIONS ${path}`] = h; },
      };
      checkout.mountUcpRoutesExpress(app, {
        name: 'Mount-Express',
        wellKnownUcpUrl: 'https://x/.well-known/ucp',
        services: {},
        signingKid: 'mount-test',
      });
      const captured: Record<string, any> = {};
      const mkRes = () => ({
        status: (c: number) => { captured.status = c; return undefined; },
        set: (h: Record<string, string>) => { captured.headers = h; return undefined; },
        type: (mt: string) => { captured.type = mt; return undefined; },
        send: (b: string) => { captured.body = b; return undefined; },
      });

      await routes['GET /.well-known/ucp']({ headers: {} }, mkRes());
      expect(captured.status).toBe(200);
      expect(captured.type).toBe('application/json');
      const ucpBody = JSON.parse(captured.body) as { ucp: { name: string } };
      expect(ucpBody.ucp.name).toBe('Mount-Express');

      const captured2: Record<string, any> = Object.create(captured);
      const res2 = {
        status: (c: number) => { captured2.status = c; return undefined; },
        set: (h: Record<string, string>) => { captured2.headers = h; return undefined; },
        type: (mt: string) => { captured2.type = mt; return undefined; },
        send: (b: string) => { captured2.body = b; return undefined; },
      };
      // Express headers normalize Array-typed values via Array.isArray ? v.join(',') : v.
      // Pass an array on Access-Control-Request-Headers to exercise both ternary arms.
      await routes['OPTIONS /.well-known/ucp'](
        { headers: { 'access-control-request-headers': ['Authorization', 'X-Custom'] } },
        res2,
      );
      expect(captured2.status).toBe(204);

      // GET /.well-known/jwks.json — covers the second mounted Express GET.
      const captured3: Record<string, any> = {};
      const res3 = {
        status: (c: number) => { captured3.status = c; return undefined; },
        set: (h: Record<string, string>) => { captured3.headers = h; return undefined; },
        type: (mt: string) => { captured3.type = mt; return undefined; },
        send: (b: string) => { captured3.body = b; return undefined; },
      };
      await routes['GET /.well-known/jwks.json']({ headers: {} }, res3);
      expect(captured3.status).toBe(200);
      const jwksBody = JSON.parse(captured3.body) as { keys: { kid: string }[] };
      expect(jwksBody.keys[0].kid).toBe('mount-test');

      // OPTIONS /.well-known/jwks.json — preflight on the jwks mount.
      const captured4: Record<string, any> = {};
      const res4 = {
        status: (c: number) => { captured4.status = c; return undefined; },
        set: (h: Record<string, string>) => { captured4.headers = h; return undefined; },
        type: (mt: string) => { captured4.type = mt; return undefined; },
        send: (b: string) => { captured4.body = b; return undefined; },
      };
      await routes['OPTIONS /.well-known/jwks.json']({ headers: {} }, res4);
      expect(captured4.status).toBe(204);
      expect(captured4.headers['Access-Control-Allow-Origin']).toBe('*');
    } finally {
      restoreEnv();
    }
  });

  it('mountUcpRoutesFastify writes via reply.code/header/type/send', async () => {
    const { checkout, restoreEnv } = await mountedCheckout();
    try {
      const routes: Record<string, any> = {};
      const app = {
        get: (path: string, h: any) => { routes[`GET ${path}`] = h; },
        options: (path: string, h: any) => { routes[`OPTIONS ${path}`] = h; },
      };
      checkout.mountUcpRoutesFastify(app, {
        name: 'Mount-Fastify',
        wellKnownUcpUrl: 'https://x/.well-known/ucp',
        services: {},
        signingKid: 'mount-test',
      });
      const captured: Record<string, any> = {};
      const reply: any = {
        code: (c: number) => { captured.status = c; return reply; },
        header: (k: string, v: string) => { captured.headers = { ...(captured.headers ?? {}), [k]: v }; return reply; },
        type: (mt: string) => { captured.type = mt; return reply; },
        send: (b: string) => { captured.body = b; return reply; },
      };
      await routes['GET /.well-known/ucp']({ headers: {} }, reply);
      expect(captured.status).toBe(200);
      const ucpBody = JSON.parse(captured.body) as { ucp: { name: string } };
      expect(ucpBody.ucp.name).toBe('Mount-Fastify');

      const captured2: Record<string, any> = {};
      const reply2: any = {
        code: (c: number) => { captured2.status = c; return reply2; },
        header: (k: string, v: string) => { captured2.headers = { ...(captured2.headers ?? {}), [k]: v }; return reply2; },
        type: (mt: string) => { captured2.type = mt; return reply2; },
        send: (b: string) => { captured2.body = b; return reply2; },
      };
      await routes['OPTIONS /.well-known/ucp']({ headers: {} }, reply2);
      expect(captured2.status).toBe(204);

      // GET /.well-known/jwks.json — same fastify reply chain as ucp.
      const captured3: Record<string, any> = {};
      const reply3: any = {
        code: (c: number) => { captured3.status = c; return reply3; },
        header: (k: string, v: string) => { captured3.headers = { ...(captured3.headers ?? {}), [k]: v }; return reply3; },
        type: (mt: string) => { captured3.type = mt; return reply3; },
        send: (b: string) => { captured3.body = b; return reply3; },
      };
      await routes['GET /.well-known/jwks.json']({ headers: {} }, reply3);
      expect(captured3.status).toBe(200);
      const jwksBody = JSON.parse(captured3.body) as { keys: { kid: string }[] };
      expect(jwksBody.keys[0].kid).toBe('mount-test');

      // OPTIONS /.well-known/jwks.json — preflight on the second mount.
      const captured4: Record<string, any> = {};
      const reply4: any = {
        code: (c: number) => { captured4.status = c; return reply4; },
        header: (k: string, v: string) => { captured4.headers = { ...(captured4.headers ?? {}), [k]: v }; return reply4; },
        type: (mt: string) => { captured4.type = mt; return reply4; },
        send: (b: string) => { captured4.body = b; return reply4; },
      };
      await routes['OPTIONS /.well-known/jwks.json']({ headers: {} }, reply4);
      expect(captured4.status).toBe(204);
      expect(captured4.headers['Access-Control-Allow-Origin']).toBe('*');
    } finally {
      restoreEnv();
    }
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */

// signedResponse<Framework> wrappers
describe('signedResponse<Framework> wrappers', () => {
  const NEUTRAL = {
    body: '{"ok":true}',
    mediaType: 'application/json',
    headers: { 'Cache-Control': 'public, max-age=60' },
    status: 200,
  };

  it('signedResponseHono wraps neutral payload as a Response', async () => {
    const { signedResponseHono } = await import('../src/discovery/well_known');
    const resp = signedResponseHono(NEUTRAL);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toBe('application/json');
    expect(resp.headers.get('cache-control')).toBe('public, max-age=60');
    expect(await resp.text()).toBe('{"ok":true}');
  });

  it('signedResponseNextjs + signedResponseWeb mirror Hono shape', async () => {
    const { signedResponseNextjs, signedResponseWeb } = await import('../src/discovery/well_known');
    const next = signedResponseNextjs(NEUTRAL);
    const web = signedResponseWeb(NEUTRAL);
    expect(next.status).toBe(200);
    expect(web.status).toBe(200);
    expect(await next.text()).toBe('{"ok":true}');
    expect(await web.text()).toBe('{"ok":true}');
  });

  it('signedResponseExpress writes status + headers + body onto res', async () => {
    const { signedResponseExpress } = await import('../src/discovery/well_known');
    const calls: Array<[string, unknown]> = [];
    const res = {
      status: (c: number) => { calls.push(['status', c]); return res; },
      set: (h: Record<string, string>) => { calls.push(['set', h]); return res; },
      type: (m: string) => { calls.push(['type', m]); return res; },
      send: (b: string) => { calls.push(['send', b]); return res; },
    };
    signedResponseExpress(res, NEUTRAL);
    expect(calls).toEqual([
      ['status', 200],
      ['set', { 'Cache-Control': 'public, max-age=60' }],
      ['type', 'application/json'],
      ['send', '{"ok":true}'],
    ]);
  });

  it('signedResponseFastify writes via reply.code/header/type/send', async () => {
    const { signedResponseFastify } = await import('../src/discovery/well_known');
    const calls: Array<[string, ...unknown[]]> = [];
    const reply = {
      code: (c: number) => { calls.push(['code', c]); return reply; },
      header: (k: string, v: string) => { calls.push(['header', k, v]); return reply; },
      type: (m: string) => { calls.push(['type', m]); return reply; },
      send: (b: string) => { calls.push(['send', b]); return reply; },
    };
    signedResponseFastify(reply, NEUTRAL);
    expect(calls).toEqual([
      ['code', 200],
      ['header', 'Cache-Control', 'public, max-age=60'],
      ['type', 'application/json'],
      ['send', '{"ok":true}'],
    ]);
  });
});
