/** Compute-first settle-path tests with fake x402_server + composeMppx so the
 *  helper exercises both _handleX402Settle (verify + processX402Settle) and
 *  _handleMppSettle (compose + receipt method extraction) paths. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeFirstCheckout, createQuoteCache, type ComputeFirstSettledContext } from '../src';

const X402_NETWORK = 'eip155:84532';
const X402_PAY_TO = '0xc3128D86669e842573306CA82f60A005A41C44D4';

const baseOpts = {
  url: 'https://api.example.com/search',
  rails: {
    tempo: {
      recipient: '0xtempo',
      network: 'tempo-testnet' as const,
      chainId: 42431,
      token: '0x20c0000000000000000000000000000000000000',
      symbol: 'USDC.e' as const,
      decimals: 6,
      testnet: true,
    },
    x402_base: {
      recipient: X402_PAY_TO,
      network: X402_NETWORK as `${string}:${string}`,
      chainId: 84532,
      mode: 'exact' as const,
    },
  },
};

function makeFakeX402Server() {
  return {
    buildPaymentRequirements: vi.fn(async () => [
      {
        scheme: 'exact',
        network: X402_NETWORK,
        payTo: X402_PAY_TO,
        maxAmountRequired: '10000',
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        resource: 'https://api.example.com/search',
        description: 'test',
        mimeType: 'application/json',
        maxTimeoutSeconds: 300,
        extra: { name: 'USDC', version: '2' },
      },
    ]),
    enrichExtensions: vi.fn(() => undefined),
    verifyPayment: vi.fn(async () => ({ isValid: true })),
    settlePayment: vi.fn(async () => ({ success: true, transaction: '0xdeadbeef', network: X402_NETWORK })),
    paymentRequirementsExtraName: vi.fn(() => 'USDC'),
  };
}

function makeX402PaymentHeader(network = X402_NETWORK, payTo = X402_PAY_TO): string {
  const payload = {
    x402Version: 2,
    scheme: 'exact',
    network,
    accepted: { network, payTo, scheme: 'exact' },
    payload: { authorization: { from: '0xeb2Ca790F72787c7e61bC6c861353a1e4ACDFCa5' } },
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

describe('computeFirstCheckout — x402 settle path', () => {
  // computeFirstCheckout enforces wallet OFAC SDN before settle (matches
  // Checkout's `runWalletSanctionsOnly`). Stub the env to opt these tests into
  // the "no API key → log+skip" path so the focus stays on x402 settle, not on
  // OFAC enforcement. The OFAC default is covered by tests in seamless-helpers.test.ts.
  beforeEach(() => { vi.stubEnv('AGENTSCORE_API_KEY', ''); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('completes the round-trip: probe caches → settle replays cached body', async () => {
    const cache = createQuoteCache();
    const fakeServer = makeFakeX402Server();
    const handler = computeFirstCheckout({
      ...baseOpts,
      name: 'search_x402',
      unitPriceCents: 1,
      x402Server: fakeServer,
      cache,
      runWork: async () => ({ resultCount: 2, body: { matches: ['hit1', 'hit2'], total: 2 } }),
    });

    // Probe
    const probeBody = { query: 'acme', limit: 3 };
    const probeRes = await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(probeBody),
    }));
    expect(probeRes.status).toBe(402);

    // Settle with x402 header
    const settleRes = await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-payment': makeX402PaymentHeader(),
      },
      body: JSON.stringify(probeBody),
    }));
    expect(settleRes.status).toBe(200);
    const body = await settleRes.json() as {
      payment_status: string;
      charged_usd: string;
      rail: string;
      result: { matches: string[] };
    };
    expect(body.payment_status).toBe('completed');
    expect(body.charged_usd).toBe('0.02'); // 2 results × $0.01
    expect(body.rail).toContain('Base');
    expect(body.result.matches).toEqual(['hit1', 'hit2']);
    expect(fakeServer.verifyPayment).toHaveBeenCalled();
    expect(fakeServer.settlePayment).toHaveBeenCalled();
  });

  it('onSettled hook fires after successful x402 settle', async () => {
    const cache = createQuoteCache();
    const fakeServer = makeFakeX402Server();
    const settledCalls: ComputeFirstSettledContext[] = [];
    const handler = computeFirstCheckout({
      ...baseOpts,
      name: 'search_onsettled',
      unitPriceCents: 1,
      x402Server: fakeServer,
      cache,
      runWork: async () => ({ resultCount: 1, body: { matches: ['a'] } }),
      onSettled: async (ctx) => {
        settledCalls.push(ctx);
      },
    });

    const body = { q: 'x' };
    await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-payment': makeX402PaymentHeader(),
      },
      body: JSON.stringify(body),
    }));
    expect(settledCalls).toHaveLength(1);
    expect(settledCalls[0]!.rail).toBe('x402');
    expect(settledCalls[0]!.priceCents).toBe(1);
  });

  it('settle failure surfaces 502 with settle_failed error', async () => {
    const cache = createQuoteCache();
    const fakeServer = makeFakeX402Server();
    fakeServer.settlePayment = vi.fn(async () => {
      throw new Error('facilitator rejected');
    });
    const handler = computeFirstCheckout({
      ...baseOpts,
      name: 'settle_fail',
      unitPriceCents: 1,
      x402Server: fakeServer,
      cache,
      runWork: async () => ({ resultCount: 1, body: { matches: ['a'] } }),
    });

    const body = { q: 'x' };
    await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    const settleRes = await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-payment': makeX402PaymentHeader(),
      },
      body: JSON.stringify(body),
    }));
    expect(settleRes.status).toBe(502);
    const errBody = await settleRes.json() as { error: { code: string } };
    expect(errBody.error.code).toBe('settle_failed');
  });
});

describe('computeFirstCheckout — MPP settle path', () => {
  // Same env-stub pattern as x402 settle (wallet OFAC path needs an API key
  // or a mocked SDK; we cover the actual OFAC path in seamless-helpers).
  beforeEach(() => { vi.stubEnv('AGENTSCORE_API_KEY', ''); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('composeMppx success → 200 with rail label', async () => {
    const cache = createQuoteCache();
    const fakeServer = makeFakeX402Server();
    const handler = computeFirstCheckout({
      ...baseOpts,
      name: 'mpp_settle',
      unitPriceCents: 1,
      x402Server: fakeServer,
      cache,
      runWork: async () => ({ resultCount: 1, body: { matches: ['a'] } }),
      composeMppx: async (ctx) => {
        if (!ctx.request.headers.get('authorization')) {
          return { status: 402, headers: { 'www-authenticate': 'Payment realm="example"' } };
        }
        return {
          status: 200,
          raw: { receipt: { method: 'tempo' } },
          txHash: 'pi_test_123',
          signerAddress: '0xeb2Ca790F72787c7e61bC6c861353a1e4ACDFCa5',
          signerNetwork: 'evm' as const,
        };
      },
    });

    const body = { q: 'x' };
    // Probe
    await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    // Settle with MPP auth
    const settleRes = await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Payment <base64-credential>',
      },
      body: JSON.stringify(body),
    }));
    expect(settleRes.status).toBe(200);
    const settled = await settleRes.json() as { rail: string; payment_intent_id?: string };
    expect(settled.rail).toContain('Tempo');
    expect(settled.payment_intent_id).toBe('pi_test_123');
  });

  it('onSettled fires on MPP success + errors are caught', async () => {
    const cache = createQuoteCache();
    const fakeServer = makeFakeX402Server();
    let onSettledFired = false;
    const handler = computeFirstCheckout({
      ...baseOpts,
      name: 'mpp_onsettled',
      unitPriceCents: 1,
      x402Server: fakeServer,
      cache,
      runWork: async () => ({ resultCount: 1, body: { matches: ['a'] } }),
      composeMppx: async (ctx) => {
        if (!ctx.request.headers.get('authorization')) {
          return { status: 402, headers: {} };
        }
        return {
          status: 200,
          raw: { receipt: { method: 'solana' } },
          txHash: 'pi_sol_123',
          signerAddress: 'SolAddr',
          signerNetwork: 'solana' as const,
        };
      },
      onSettled: async () => {
        onSettledFired = true;
        throw new Error('intentional onSettled error — should be caught + logged');
      },
    });

    const body = { q: 'x' };
    await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    const settleRes = await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Payment <base64>',
      },
      body: JSON.stringify(body),
    }));
    // Should succeed (200) even though onSettled threw — error is caught + logged.
    expect(settleRes.status).toBe(200);
    expect(onSettledFired).toBe(true);
  });

  it('buildX402AcceptsFor402 throwing during emit_402 drops x402 rail without crashing', async () => {
    const cache = createQuoteCache();
    const fakeServer = makeFakeX402Server();
    fakeServer.buildPaymentRequirements = vi.fn(async () => {
      throw new Error('buildPaymentRequirements broken');
    });
    const handler = computeFirstCheckout({
      ...baseOpts,
      name: 'x402_emit_fail',
      unitPriceCents: 1,
      x402Server: fakeServer,
      cache,
      runWork: async () => ({ resultCount: 1, body: {} }),
    });
    const res = await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: 'x' }),
    }));
    expect(res.status).toBe(402);
  });

  it('composeMppx probe-leg throwing drops MPP rails from 402 without crashing', async () => {
    const cache = createQuoteCache();
    const fakeServer = makeFakeX402Server();
    const handler = computeFirstCheckout({
      ...baseOpts,
      name: 'compose_probe_throw',
      unitPriceCents: 1,
      x402Server: fakeServer,
      cache,
      runWork: async () => ({ resultCount: 1, body: {} }),
      composeMppx: async () => {
        throw new Error('mppx server unreachable');
      },
    });
    const res = await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: 'x' }),
    }));
    expect(res.status).toBe(402);
  });

  it('invalid X-Payment header → verify failure returns 4xx envelope', async () => {
    const cache = createQuoteCache();
    const fakeServer = makeFakeX402Server();
    const handler = computeFirstCheckout({
      ...baseOpts,
      name: 'invalid_x402_header',
      unitPriceCents: 1,
      x402Server: fakeServer,
      cache,
      runWork: async () => ({ resultCount: 1, body: {} }),
    });
    const body = { q: 'invalid' };
    await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    const settleRes = await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-payment': 'not-valid-base64-json',
      },
      body: JSON.stringify(body),
    }));
    expect(settleRes.status).toBe(400);
  });

  it('x402 onSettled throwing is caught + logged (response still 200)', async () => {
    const cache = createQuoteCache();
    const fakeServer = makeFakeX402Server();
    const handler = computeFirstCheckout({
      ...baseOpts,
      name: 'x402_onsettled_throw',
      unitPriceCents: 1,
      x402Server: fakeServer,
      cache,
      runWork: async () => ({ resultCount: 1, body: { matches: ['a'] } }),
      onSettled: async () => {
        throw new Error('onSettled broken');
      },
    });
    const body = { q: 'x' };
    await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    const settleRes = await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-payment': makeX402PaymentHeader(),
      },
      body: JSON.stringify(body),
    }));
    expect(settleRes.status).toBe(200);
  });

  it('mppRailLabel covers stripe + unknown method fallback', async () => {
    const cache = createQuoteCache();
    const fakeServer = makeFakeX402Server();
    // Stripe scheme test
    const handler = computeFirstCheckout({
      ...baseOpts,
      name: 'mpp_stripe',
      unitPriceCents: 1,
      x402Server: fakeServer,
      cache,
      runWork: async () => ({ resultCount: 1, body: {} }),
      composeMppx: async (ctx) => {
        if (!ctx.request.headers.get('authorization')) return { status: 402, headers: {} };
        return { status: 200, raw: { receipt: { method: 'stripe' } } };
      },
    });
    const body = { q: 'stripe' };
    await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    const res = await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Payment <x>' },
      body: JSON.stringify(body),
    }));
    const settled = await res.json() as { rail: string };
    expect(settled.rail).toBe('Stripe (card+link)');
  });

  it('mppRailLabel falls back to "MPP" on unknown receipt method', async () => {
    const cache = createQuoteCache();
    const fakeServer = makeFakeX402Server();
    const handler = computeFirstCheckout({
      ...baseOpts,
      name: 'mpp_unknown',
      unitPriceCents: 1,
      x402Server: fakeServer,
      cache,
      runWork: async () => ({ resultCount: 1, body: {} }),
      composeMppx: async (ctx) => {
        if (!ctx.request.headers.get('authorization')) return { status: 402, headers: {} };
        return { status: 200, raw: { receipt: { method: 'unknown_scheme' } } };
      },
    });
    const body = { q: 'unknown' };
    await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    const res = await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Payment <x>' },
      body: JSON.stringify(body),
    }));
    const settled = await res.json() as { rail: string };
    expect(settled.rail).toBe('MPP');
  });

  it('MPP signer falls back to extractPaymentSigner when composeMppx omits signerAddress', async () => {
    const cache = createQuoteCache();
    const fakeServer = makeFakeX402Server();
    const handler = computeFirstCheckout({
      ...baseOpts,
      name: 'mpp_signer_fallback',
      unitPriceCents: 1,
      x402Server: fakeServer,
      cache,
      runWork: async () => ({ resultCount: 1, body: {} }),
      composeMppx: async (ctx) => {
        if (!ctx.request.headers.get('authorization')) return { status: 402, headers: {} };
        // No signerAddress in result — helper falls back to extractPaymentSigner.
        return { status: 200, raw: { receipt: { method: 'tempo' } } };
      },
    });
    const body = { q: 'sigfb' };
    await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    const res = await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Payment <x>' },
      body: JSON.stringify(body),
    }));
    expect(res.status).toBe(200);
  });

  it('MPP signer resolves from the Authorization DID when composeMppx omits signerAddress (onSettled gets signer + txHash)', async () => {
    // Mock mppx so extractPaymentSigner's MPP-credential path returns a real
    // EVM signer from the `did:pkh:eip155` source — exercising the line-559
    // `.then(s => s ? {...} : undefined)` truthy branch + the onSettled
    // signer/txHash spreads (572-573) that the signerAddress-supplied tests skip.
    vi.doMock('mppx', () => ({
      Credential: {
        extractPaymentScheme: () => true,
        fromRequest: () => ({ source: 'did:pkh:eip155:42431:0xEB2Ca790F72787c7e61bC6c861353a1e4ACDFCa5' }),
      },
    }));
    try {
      const cache = createQuoteCache();
      const fakeServer = makeFakeX402Server();
      let settledSigner: ComputeFirstSettledContext['signer'] | undefined;
      let settledIntent: string | undefined;
      const handler = computeFirstCheckout({
        ...baseOpts,
        name: 'mpp_did_signer',
        unitPriceCents: 1,
        x402Server: fakeServer,
        cache,
        runWork: async () => ({ resultCount: 1, body: { matches: ['a'] } }),
        composeMppx: async (ctx) => {
          if (!ctx.request.headers.get('authorization')) return { status: 402, headers: {} };
          // No signerAddress — forces the extractPaymentSigner fallback.
          return { status: 200, raw: { receipt: { method: 'tempo' } }, txHash: 'pi_did_999' };
        },
        onSettled: async (ctx) => {
          settledSigner = ctx.signer;
          settledIntent = ctx.paymentIntentId;
        },
      });
      const body = { q: 'didsig' };
      await handler.handleWeb(new Request('https://api.example.com/search', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }));
      const res = await handler.handleWeb(new Request('https://api.example.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Payment <mpp-cred>' },
        body: JSON.stringify(body),
      }));
      expect(res.status).toBe(200);
      const settled = await res.json() as { signer?: { address: string; network: string } };
      expect(settled.signer?.address).toBe('0xeb2ca790f72787c7e61bc6c861353a1e4acdfca5');
      expect(settled.signer?.network).toBe('evm');
      expect(settledSigner?.address).toBe('0xeb2ca790f72787c7e61bc6c861353a1e4acdfca5');
      expect(settledIntent).toBe('pi_did_999');
    } finally {
      vi.doUnmock('mppx');
    }
  });

  it('validateInput throwing non-CheckoutValidationError re-throws', async () => {
    const handler = computeFirstCheckout({
      ...baseOpts,
      name: 'validate_rethrow',
      unitPriceCents: 1,
      x402Server: makeFakeX402Server(),
      validateInput: () => {
        throw new Error('not a CheckoutValidationError');
      },
      runWork: async () => ({ resultCount: 1, body: {} }),
    });
    await expect(
      handler.handleWeb(new Request('https://api.example.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q: 'x' }),
      })),
    ).rejects.toThrow('not a CheckoutValidationError');
  });

  it('composeMppx non-200 status → 400 mpp_settle_failed with passed-through headers', async () => {
    const cache = createQuoteCache();
    const fakeServer = makeFakeX402Server();
    const handler = computeFirstCheckout({
      ...baseOpts,
      name: 'mpp_fail',
      unitPriceCents: 1,
      x402Server: fakeServer,
      cache,
      runWork: async () => ({ resultCount: 1, body: { matches: ['a'] } }),
      composeMppx: async (ctx) => {
        if (!ctx.request.headers.get('authorization')) {
          return { status: 402, headers: { 'www-authenticate': 'Payment realm="x"' } };
        }
        return {
          status: 402,
          headers: { 'www-authenticate': 'Payment realm="rejected"' },
        };
      },
    });

    const body = { q: 'x' };
    await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    const settleRes = await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Payment <base64>',
      },
      body: JSON.stringify(body),
    }));
    expect(settleRes.status).toBe(400);
    const errBody = await settleRes.json() as { error: { code: string } };
    expect(errBody.error.code).toBe('mpp_settle_failed');
  });
});

describe('computeFirstCheckout — wallet OFAC enforcement (always-on default)', () => {
  it('denies on signer-sanctions outcome before the rail handler fires', async () => {
    vi.doMock('../src/core', async () => {
      const real = await vi.importActual<typeof import('../src/core')>('../src/core');
      return {
        ...real,
        createAgentScoreCore: () => ({
          evaluate: async () => ({
            kind: 'deny',
            reason: { code: 'wallet_not_trusted', reasons: ['sanctions_flagged'] },
          }),
          getSignerVerdict: () => undefined,
          captureWallet: async () => undefined,
        }),
      };
    });
    vi.stubEnv('AGENTSCORE_API_KEY', 'as_test_key');
    const cache = createQuoteCache();
    const fakeServer = makeFakeX402Server();
    const { computeFirstCheckout: SCComputeFirstCheckout } = await import('../src/checkout_compute_first?ofac-deny');
    const handler = SCComputeFirstCheckout({
      ...baseOpts,
      name: 'ofac_deny',
      unitPriceCents: 1,
      x402Server: fakeServer,
      cache,
      runWork: async () => ({ resultCount: 1, body: { matches: ['x'] } }),
    });
    const body = { q: 'x' };
    await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    const settleRes = await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-payment': makeX402PaymentHeader(),
      },
      body: JSON.stringify(body),
    }));
    // Wallet OFAC denial: status mapped from reason.code → 403 via the helper.
    expect(settleRes.status).toBe(403);
    expect(fakeServer.verifyPayment).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    vi.doUnmock('../src/core');
  });

  it('no AGENTSCORE_API_KEY: logs warn once, skips OFAC, x402 settle proceeds', async () => {
    vi.stubEnv('AGENTSCORE_API_KEY', '');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Reset the shared warn-once flag — earlier tests in this run may have
    // tripped it (see src/_warnings.ts).
    const { _resetWarnedNoApiKey } = await import('../src/_warnings');
    _resetWarnedNoApiKey();
    const cache = createQuoteCache();
    const fakeServer = makeFakeX402Server();
    const { computeFirstCheckout: SCComputeFirstCheckout } = await import('../src/checkout_compute_first?ofac-no-key');
    const handler = SCComputeFirstCheckout({
      ...baseOpts,
      name: 'ofac_no_key',
      unitPriceCents: 1,
      x402Server: fakeServer,
      cache,
      runWork: async () => ({ resultCount: 1, body: { matches: ['y'] } }),
    });
    const body = { q: 'y' };
    await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    const settleRes = await handler.handleWeb(new Request('https://api.example.com/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-payment': makeX402PaymentHeader(),
      },
      body: JSON.stringify(body),
    }));
    expect(settleRes.status).toBe(200);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('AGENTSCORE_API_KEY is not set'))).toBe(true);
    warnSpy.mockRestore();
    vi.unstubAllEnvs();
  });
});
