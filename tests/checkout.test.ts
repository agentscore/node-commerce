import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Checkout,
  type CheckoutContext,
  type CheckoutRequest,
  type MppxComposeOutcome,
  type PricingResult,
} from '../src/checkout';
import type {
  SolanaMppRailSpec,
  StripeRailSpec,
  TempoRailSpec,
  X402BaseRailSpec,
} from '../src/payment/rail_spec';

const FAKE_MPP_CRED = Buffer.from(
  JSON.stringify({ challenge: { id: 'ch_1', realm: 'api.example' }, payload: { type: 'hash', hash: '0xabc' } }),
).toString('base64');

function req(overrides: Partial<CheckoutRequest> = {}): CheckoutRequest {
  return {
    method: 'POST',
    url: 'https://api.example/purchase',
    headers: {},
    body: { item: 'wine' },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 402 emit — every rail combination
// ─────────────────────────────────────────────────────────────────────────────

describe('Checkout — 402 emit by rail combination', () => {
  it('x402-only, no MPP, no identity (API seller pattern)', async () => {
    const checkout = new Checkout({
      rails: { x402_base: { recipient: '0xTREASURY' } as X402BaseRailSpec },
      url: 'https://api.example/call',
      computePricing: () => ({ amountUsd: 0.01 }),
    });
    const result = await checkout.handle(req());
    expect(result.status).toBe(402);
    expect(result.settled).toBe(false);
    expect(result.body.accepted_methods).toBeDefined();
    expect(result.referenceId).toBeTruthy();
  });

  it('MPP-only with no x402 (Tempo + Stripe goods seller)', async () => {
    const checkout = new Checkout({
      rails: {
        tempo: { recipient: '0xtempo' } as TempoRailSpec,
        stripe: { profileId: 'profile_x' } as StripeRailSpec,
      },
      url: 'https://api.example/purchase',
      computePricing: () => ({ amountUsd: 250 }),
    });
    const result = await checkout.handle(req());
    expect(result.status).toBe(402);
    expect('payment-required' in result.headers).toBe(false);
  });

  it('custodial-only (Stripe SPT only)', async () => {
    const checkout = new Checkout({
      rails: { stripe: { profileId: 'profile_x' } as StripeRailSpec },
      url: 'https://api.example/purchase',
      computePricing: () => ({ amountUsd: 50 }),
    });
    const result = await checkout.handle(req());
    expect(result.status).toBe(402);
    expect(result.body.accepted_methods).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MPP compose path
// ─────────────────────────────────────────────────────────────────────────────

describe('Checkout — composeMppx hook', () => {
  it('200 from compose runs onSettled and returns success', async () => {
    const onSettled = vi.fn().mockResolvedValue(null);
    const composeMppx = vi.fn(
      async (): Promise<MppxComposeOutcome> => ({
        status: 200,
        paymentResponseHeader: 'ok',
      }),
    );
    const checkout = new Checkout({
      rails: { tempo: { recipient: '0xtempo' } as TempoRailSpec },
      url: 'https://api.example/purchase',
      computePricing: () => ({ amountUsd: 10 }),
      composeMppx,
      onSettled,
    });
    const result = await checkout.handle(req({ headers: { authorization: `Payment ${FAKE_MPP_CRED}` } }));
    expect(result.status).toBe(200);
    expect(result.headers['payment-response']).toBe('ok');
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it('paymentReceiptHeader from compose surfaces as Payment-Receipt response header', async () => {
    const receiptHeader = 'eyJzdGF0dXMiOiJzdWNjZXNzIn0';
    const composeMppx = vi.fn(
      async (): Promise<MppxComposeOutcome> => ({
        status: 200,
        paymentReceiptHeader: receiptHeader,
      }),
    );
    const checkout = new Checkout({
      rails: { tempo: { recipient: '0xtempo' } as TempoRailSpec },
      url: 'https://api.example/purchase',
      computePricing: () => ({ amountUsd: 10 }),
      composeMppx,
    });
    const result = await checkout.handle(req({ headers: { authorization: `Payment ${FAKE_MPP_CRED}` } }));
    expect(result.status).toBe(200);
    expect(result.headers['payment-receipt']).toBe(receiptHeader);
  });

  it('omitted paymentReceiptHeader does not emit a Payment-Receipt response header', async () => {
    const composeMppx = vi.fn(
      async (): Promise<MppxComposeOutcome> => ({
        status: 200,
      }),
    );
    const checkout = new Checkout({
      rails: { tempo: { recipient: '0xtempo' } as TempoRailSpec },
      url: 'https://api.example/purchase',
      computePricing: () => ({ amountUsd: 10 }),
      composeMppx,
    });
    const result = await checkout.handle(req({ headers: { authorization: `Payment ${FAKE_MPP_CRED}` } }));
    expect(result.status).toBe(200);
    expect('payment-receipt' in result.headers).toBe(false);
  });

  it('auto-extracts Payment-Receipt from raw.withReceipt when hook omits the field', async () => {
    const composeMppx = vi.fn(
      async (): Promise<MppxComposeOutcome> => ({
        status: 200,
        raw: {
          withReceipt(response: Response): Response {
            const headers = new Headers(response.headers);
            headers.set('Payment-Receipt', 'auto-extracted-receipt-value');
            return new Response(response.body, { status: response.status, headers });
          },
        },
      }),
    );
    const checkout = new Checkout({
      rails: { tempo: { recipient: '0xtempo' } as TempoRailSpec },
      url: 'https://api.example/purchase',
      computePricing: () => ({ amountUsd: 10 }),
      composeMppx,
    });
    const result = await checkout.handle(req({ headers: { authorization: `Payment ${FAKE_MPP_CRED}` } }));
    expect(result.status).toBe(200);
    expect(result.headers['payment-receipt']).toBe('auto-extracted-receipt-value');
  });

  it('explicit paymentReceiptHeader wins over raw.withReceipt auto-extract', async () => {
    const composeMppx = vi.fn(
      async (): Promise<MppxComposeOutcome> => ({
        status: 200,
        paymentReceiptHeader: 'explicit-value',
        raw: {
          withReceipt(response: Response): Response {
            const headers = new Headers(response.headers);
            headers.set('Payment-Receipt', 'auto-value-IGNORED');
            return new Response(response.body, { status: response.status, headers });
          },
        },
      }),
    );
    const checkout = new Checkout({
      rails: { tempo: { recipient: '0xtempo' } as TempoRailSpec },
      url: 'https://api.example/purchase',
      computePricing: () => ({ amountUsd: 10 }),
      composeMppx,
    });
    const result = await checkout.handle(req({ headers: { authorization: `Payment ${FAKE_MPP_CRED}` } }));
    expect(result.status).toBe(200);
    expect(result.headers['payment-receipt']).toBe('explicit-value');
  });

  it('raw.withReceipt that throws falls through silently to no header', async () => {
    const composeMppx = vi.fn(
      async (): Promise<MppxComposeOutcome> => ({
        status: 200,
        raw: {
          withReceipt(): Response {
            throw new Error('mppx isMissingReceiptResponseError sentinel');
          },
        },
      }),
    );
    const checkout = new Checkout({
      rails: { tempo: { recipient: '0xtempo' } as TempoRailSpec },
      url: 'https://api.example/purchase',
      computePricing: () => ({ amountUsd: 10 }),
      composeMppx,
    });
    const result = await checkout.handle(req({ headers: { authorization: `Payment ${FAKE_MPP_CRED}` } }));
    expect(result.status).toBe(200);
    expect('payment-receipt' in result.headers).toBe(false);
  });

  it('402 from compose on settle leg returns 402 carrying the fresh challenge', async () => {
    const composeMppx = vi.fn(
      async (): Promise<MppxComposeOutcome> => ({
        status: 402,
        headers: { 'www-authenticate': 'Payment id="ord_x"' },
      }),
    );
    const checkout = new Checkout({
      rails: { tempo: { recipient: '0xtempo' } as TempoRailSpec },
      url: 'https://api.example/purchase',
      computePricing: () => ({ amountUsd: 10 }),
      composeMppx,
    });
    const result = await checkout.handle(req({ headers: { authorization: `Payment ${FAKE_MPP_CRED}` } }));
    // mppx rejected the credential and emitted a fresh challenge; return it as a
    // 402 the agent re-pays against, not a 400 that x402/MPP clients abort on.
    expect(result.status).toBe(402);
    expect(result.headers['www-authenticate']).toBe('Payment id="ord_x"');
    expect((result.body.error as Record<string, unknown>).code).toBe('payment_proof_invalid');
    expect(result.settlePhase).toBe('verify_failed');
  });

  it('settle-leg compose 402 with captured Tempo KeyNotFound surfaces tempo_key_not_registered', async () => {
    // Simulate mppx's `console.error('mppx: internal verification error', e)`
    // firing inside the merchant's composeMppx hook. The capture wrapper around
    // handleMppx's call to composeMppx routes this into the failureReason that
    // the classifier picks up.
    const composeMppx = vi.fn(
      async (): Promise<MppxComposeOutcome> => {
        console.error('mppx: internal verification error', {
          shortMessage: 'RPC Request failed.',
          details: 'keychain validation failed: AccountKeychainError(KeyNotFound(KeyNotFound))',
        });
        return {
          status: 402,
          headers: { 'www-authenticate': 'Payment id="ord_x"' },
        };
      },
    );
    const checkout = new Checkout({
      rails: { tempo: { recipient: '0xtempo' } as TempoRailSpec },
      url: 'https://api.example/purchase',
      computePricing: () => ({ amountUsd: 10 }),
      composeMppx,
    });
    const result = await checkout.handle(req({ headers: { authorization: `Payment ${FAKE_MPP_CRED}` } }));
    expect(result.status).toBe(401);
    expect((result.body.error as Record<string, unknown>).code).toBe('tempo_key_not_registered');
    expect(result.settlePhase).toBe('verify_failed');
  });

  it('discovery-leg compose_mppx layers fresh WWW-Auth into the 402', async () => {
    const composeMppx = vi.fn(
      async (): Promise<MppxComposeOutcome> => ({
        status: 402,
        headers: { 'www-authenticate': 'Payment id="ord_y"' },
      }),
    );
    const checkout = new Checkout({
      rails: { tempo: { recipient: '0xtempo' } as TempoRailSpec },
      url: 'https://api.example/purchase',
      computePricing: () => ({ amountUsd: 10 }),
      composeMppx,
    });
    const result = await checkout.handle(req());
    expect(result.status).toBe(402);
    expect(result.headers['www-authenticate']).toBe('Payment id="ord_y"');
    expect(result.body.accepted_methods).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Custom hooks
// ─────────────────────────────────────────────────────────────────────────────

describe('Checkout — custom hooks', () => {
  it('computePricing can branch on identity', async () => {
    const price = (ctx: CheckoutContext): PricingResult => {
      if (ctx.request.assess?.identity_status === 'verified') {
        return { amountUsd: 8 };
      }
      return { amountUsd: 10 };
    };
    const checkout = new Checkout({
      rails: { x402_base: { recipient: '0xTREASURY' } as X402BaseRailSpec },
      url: 'https://api.example/call',
      computePricing: price,
    });
    const anon = await checkout.handle(req());
    expect(anon.body.amount_usd).toBe('10.00');
    const verified = await checkout.handle(req({ assess: { identity_status: 'verified' } }));
    expect(verified.body.amount_usd).toBe('8.00');
  });

  it('mintRecipients overrides rail recipients', async () => {
    const checkout = new Checkout({
      rails: {
        tempo: { recipient: '0xstatic_tempo' } as TempoRailSpec,
        x402_base: { recipient: '0xstatic_base' } as X402BaseRailSpec,
      },
      url: 'https://api.example/purchase',
      computePricing: () => ({ amountUsd: 100 }),
      mintRecipients: () => ({ tempo: '0xPERORDER_TEMPO', x402_base: '0xPERORDER_BASE' }),
    });
    const result = await checkout.handle(req());
    expect(result.status).toBe(402);
    const acceptedStr = JSON.stringify(result.body.accepted_methods);
    expect(acceptedStr).toContain('0xPERORDER_TEMPO');
    expect(acceptedStr).toContain('0xPERORDER_BASE');
  });

  it('mintReferenceId can override the default UUID', async () => {
    const checkout = new Checkout({
      rails: { x402_base: { recipient: '0xT' } as X402BaseRailSpec },
      url: 'https://api.example/purchase',
      computePricing: () => ({ amountUsd: 1 }),
      mintReferenceId: () => 'ord_abc123',
    });
    const result = await checkout.handle(req());
    expect(result.referenceId).toBe('ord_abc123');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stripe SPT $0.50 minimum auto-drop on emit_402
// ─────────────────────────────────────────────────────────────────────────────

describe('Checkout — stripe rail auto-drop on emit_402', () => {
  it('drops stripe from accepted_methods when amountUsd < $0.50', async () => {
    const checkout = new Checkout({
      rails: {
        tempo: { recipient: '0xT' } as TempoRailSpec,
        stripe: { profileId: 'profile_test_abc' } as never,
      },
      url: 'https://api.example/purchase',
      computePricing: () => ({ amountUsd: 0.01 }),
    });
    const result = await checkout.handle(req());
    expect(result.status).toBe(402);
    const acceptedStr = JSON.stringify(result.body.accepted_methods);
    expect(acceptedStr).not.toContain('stripe');
  });

  it('keeps stripe in accepted_methods when amountUsd >= $0.50', async () => {
    const checkout = new Checkout({
      rails: {
        tempo: { recipient: '0xT' } as TempoRailSpec,
        stripe: { profileId: 'profile_test_abc' } as never,
      },
      url: 'https://api.example/purchase',
      computePricing: () => ({ amountUsd: 0.5 }),
    });
    const result = await checkout.handle(req());
    expect(result.status).toBe(402);
    const acceptedStr = JSON.stringify(result.body.accepted_methods);
    expect(acceptedStr).toContain('stripe');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Init guards
// ─────────────────────────────────────────────────────────────────────────────

describe('Checkout — init guards', () => {
  it('x402Server requires an X402BaseRailSpec in rails["x402_base"]', () => {
    expect(
      () =>
        new Checkout({
          rails: { tempo: { recipient: '0xT' } as TempoRailSpec },
          url: 'https://x.example',
          computePricing: () => ({ amountUsd: 1 }),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          x402Server: {} as any,
        }),
    ).toThrow(/X402BaseRailSpec/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Solana rail dispatch (smoke test that Solana specs survive _emit_402 path)
// ─────────────────────────────────────────────────────────────────────────────

describe('Checkout — Solana rail compatibility', () => {
  it('emits 402 with Solana MPP rail in accepted_methods', async () => {
    const checkout = new Checkout({
      rails: {
        solana_mpp: {
          recipient: 'solanaaddr',
          network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        } as SolanaMppRailSpec,
      },
      url: 'https://api.example/purchase',
      computePricing: () => ({ amountUsd: 10 }),
    });
    const result = await checkout.handle(req());
    expect(result.status).toBe(402);
    const acceptedStr = JSON.stringify(result.body.accepted_methods);
    expect(acceptedStr).toContain('solana');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// railsKeyForMppxMethod — maps mppx credential method → merchant rails-dict key
// ─────────────────────────────────────────────────────────────────────────────

describe('Checkout — railsKeyForMppxMethod', () => {
  const buildCheckout = (rails: Record<string, unknown>) =>
    new Checkout({
      rails: rails as Parameters<typeof Checkout>[0]['rails'],
      url: 'https://api.example/purchase',
      computePricing: () => ({ amountUsd: 10 }),
    });

  // Cast away `private` so tests can exercise the helper directly. This keeps
  // the helper internal to consumers while still allowing focused coverage.
  const railsKeyFor = (c: Checkout, method: string): string | undefined =>
    (c as unknown as { railsKeyForMppxMethod: (m: string) => string | undefined })
      .railsKeyForMppxMethod(method);

  it('matches stripe to the merchant\'s StripeRailSpec key', () => {
    const c = buildCheckout({
      tempo_charge: { recipient: '0xtempo' } as TempoRailSpec,
      stripe_spt: { profileId: 'profile_x' } as StripeRailSpec,
    });
    expect(railsKeyFor(c, 'stripe')).toBe('stripe_spt');
  });

  it('matches solana to a SolanaMppRailSpec via solana: network prefix', () => {
    const c = buildCheckout({
      tempo: { recipient: '0xtempo' } as TempoRailSpec,
      sol_rail: {
        recipient: 'solanaaddr',
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      } as SolanaMppRailSpec,
      stripe: { profileId: 'profile_x' } as StripeRailSpec,
    });
    expect(railsKeyFor(c, 'solana')).toBe('sol_rail');
  });

  it('matches solana via rpcUrl marker even without solana: network', () => {
    const c = buildCheckout({
      sol_rpc: { recipient: 'solanaaddr', rpcUrl: 'https://api.devnet.solana.com' },
      stripe: { profileId: 'profile_x' } as StripeRailSpec,
    });
    expect(railsKeyFor(c, 'solana')).toBe('sol_rpc');
  });

  it('matches solana via tokenProgram marker', () => {
    const c = buildCheckout({
      sol_token: { recipient: 'solanaaddr', tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
    });
    expect(railsKeyFor(c, 'solana')).toBe('sol_token');
  });

  it('matches tempo to the first TempoRailSpec key, skipping x402 base + solana + stripe', () => {
    const c = buildCheckout({
      x402_base: { recipient: '0xbase', network: 'eip155:8453' } as X402BaseRailSpec,
      sol_rail: { recipient: 'solanaaddr', network: 'solana:abc' } as SolanaMppRailSpec,
      tempo_charge: { recipient: '0xtempo' } as TempoRailSpec,
      stripe: { profileId: 'profile_x' } as StripeRailSpec,
    });
    expect(railsKeyFor(c, 'tempo')).toBe('tempo_charge');
  });

  it('returns undefined when no rail matches the credential method', () => {
    const c = buildCheckout({
      tempo_charge: { recipient: '0xtempo' } as TempoRailSpec,
    });
    expect(railsKeyFor(c, 'solana')).toBeUndefined();
    expect(railsKeyFor(c, 'stripe')).toBeUndefined();
  });

  it('returns undefined for unknown methods', () => {
    const c = buildCheckout({
      tempo_charge: { recipient: '0xtempo' } as TempoRailSpec,
      stripe: { profileId: 'profile_x' } as StripeRailSpec,
    });
    expect(railsKeyFor(c, 'unknown-method')).toBeUndefined();
    expect(railsKeyFor(c, '')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// handleMppx — railKey is derived from receipt method when available
// ─────────────────────────────────────────────────────────────────────────────

describe('Checkout — MPP railKey end-to-end derivation', () => {
  const buildCheckout = (
    composeMppx: (ctx: CheckoutContext) => Promise<MppxComposeOutcome>,
    onSettled: (ctx: CheckoutContext, outcome: { railKey?: string }) => Promise<Record<string, unknown>>,
  ) =>
    new Checkout({
      rails: {
        tempo_charge: { recipient: '0xtempo' } as TempoRailSpec,
        sol_rail: { recipient: 'solanaaddr', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' } as SolanaMppRailSpec,
        stripe_spt: { profileId: 'profile_x' } as StripeRailSpec,
      },
      url: 'https://api.example/purchase',
      computePricing: (): PricingResult => ({ amountUsd: 10 }),
      composeMppx,
      onSettled: onSettled as Parameters<typeof Checkout>[0]['onSettled'],
    });

  it('uses receipt.method (solana) to set railKey to sol_rail, not mppRailKey()', async () => {
    let observedRailKey: string | undefined;
    const checkout = buildCheckout(
      async () => ({
        status: 200,
        raw: { receipt: { method: 'solana' } },
      }),
      async (_ctx, outcome) => {
        observedRailKey = outcome.railKey;
        return { ok: true };
      },
    );
    const result = await checkout.handle(req({ headers: { authorization: `Payment ${FAKE_MPP_CRED}` } }));
    expect(result.status).toBe(200);
    expect(observedRailKey).toBe('sol_rail');
  });

  it('uses receipt.method (tempo) to pick tempo_charge', async () => {
    let observedRailKey: string | undefined;
    const checkout = buildCheckout(
      async () => ({
        status: 200,
        raw: { receipt: { method: 'tempo' } },
      }),
      async (_ctx, outcome) => {
        observedRailKey = outcome.railKey;
        return { ok: true };
      },
    );
    await checkout.handle(req({ headers: { authorization: `Payment ${FAKE_MPP_CRED}` } }));
    expect(observedRailKey).toBe('tempo_charge');
  });

  it('uses receipt.method (stripe) to pick stripe_spt', async () => {
    let observedRailKey: string | undefined;
    const checkout = buildCheckout(
      async () => ({
        status: 200,
        raw: { receipt: { method: 'stripe' } },
      }),
      async (_ctx, outcome) => {
        observedRailKey = outcome.railKey;
        return { ok: true };
      },
    );
    await checkout.handle(req({ headers: { authorization: `Payment ${FAKE_MPP_CRED}` } }));
    expect(observedRailKey).toBe('stripe_spt');
  });

  it('falls back to mppRailKey when receipt has no method and hook does not set railKey', async () => {
    let observedRailKey: string | undefined;
    const checkout = buildCheckout(
      async () => ({ status: 200, raw: {} }),
      async (_ctx, outcome) => {
        observedRailKey = outcome.railKey;
        return { ok: true };
      },
    );
    await checkout.handle(req({ headers: { authorization: `Payment ${FAKE_MPP_CRED}` } }));
    // mppRailKey() returns the first non-stripe, non-EVM rail key.
    expect(observedRailKey).toBe('tempo_charge');
  });

  it('honors explicit composed.railKey when no receipt method is available', async () => {
    let observedRailKey: string | undefined;
    const checkout = buildCheckout(
      async () => ({ status: 200, raw: {}, railKey: 'explicit_override' }),
      async (_ctx, outcome) => {
        observedRailKey = outcome.railKey;
        return { ok: true };
      },
    );
    await checkout.handle(req({ headers: { authorization: `Payment ${FAKE_MPP_CRED}` } }));
    expect(observedRailKey).toBe('explicit_override');
  });

  it('receipt-derived key wins over composed.railKey when both are present', async () => {
    let observedRailKey: string | undefined;
    const checkout = buildCheckout(
      async () => ({
        status: 200,
        raw: { receipt: { method: 'solana' } },
        railKey: 'stripe_spt',
      }),
      async (_ctx, outcome) => {
        observedRailKey = outcome.railKey;
        return { ok: true };
      },
    );
    await checkout.handle(req({ headers: { authorization: `Payment ${FAKE_MPP_CRED}` } }));
    expect(observedRailKey).toBe('sol_rail');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveRecipients error handling — mintRecipients throwing
// CheckoutValidationError lands as a 4xx envelope; other errors rethrow
// (covers the cross-bundle name-based catch added cross-bundle compat).
// ─────────────────────────────────────────────────────────────────────────────

describe('Checkout — mintRecipients error handling', () => {
  it('converts CheckoutValidationError from mintRecipients into a 4xx envelope', async () => {
    const { CheckoutValidationError } = await import('../src/errors');
    const checkout = new Checkout({
      rails: { x402_base: { recipient: '0xT' } as X402BaseRailSpec },
      url: 'https://api.example/purchase',
      computePricing: () => ({ amountUsd: 1 }),
      mintRecipients: () => {
        throw new CheckoutValidationError({
          code: 'invalid_credential',
          message: 'cred busted',
          action: 'retry_without_credential',
          status: 401,
        });
      },
    });
    const result = await checkout.handle(req());
    expect(result.status).toBe(401);
    expect((result.body.error as { code: string }).code).toBe('invalid_credential');
  });

  it('catches a cross-bundle CheckoutValidationError by err.name (not instanceof)', async () => {
    // Simulate an error thrown from a sibling-bundle CheckoutValidationError
    // (subpath entries produce separate class identities under splitting:false).
    class CrossBundleError extends Error {
      readonly code = 'invalid_credential';
      readonly status = 401;
      readonly action = 'retry_without_credential';
      constructor() {
        super('different bundle');
        this.name = 'CheckoutValidationError';
      }
    }
    const checkout = new Checkout({
      rails: { x402_base: { recipient: '0xT' } as X402BaseRailSpec },
      url: 'https://api.example/purchase',
      computePricing: () => ({ amountUsd: 1 }),
      mintRecipients: () => { throw new CrossBundleError(); },
    });
    const result = await checkout.handle(req());
    expect(result.status).toBe(401);
    expect((result.body.error as { code: string }).code).toBe('invalid_credential');
  });

  it('rethrows non-CheckoutValidationError errors from mintRecipients', async () => {
    const checkout = new Checkout({
      rails: { x402_base: { recipient: '0xT' } as X402BaseRailSpec },
      url: 'https://api.example/purchase',
      computePricing: () => ({ amountUsd: 1 }),
      mintRecipients: () => { throw new Error('upstream boom'); },
    });
    await expect(checkout.handle(req())).rejects.toThrow(/upstream boom/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// x402 settle binding (anti funds-drain) + zero-settle sub-cent guard.
// These drive a full x402 settle through a fake X402Server; the env stub opts the
// always-on wallet-OFAC default into its "no API key → log+skip" path so the focus
// stays on the bind/zero-settle behavior (OFAC default is covered elsewhere).
// ─────────────────────────────────────────────────────────────────────────────

const BIND_NETWORK = 'eip155:84532';
const BIND_RECIPIENT = '0xc3128D86669e842573306CA82f60A005A41C44D4';

function makeFakeX402Server() {
  return {
    buildPaymentRequirements: vi.fn(async () => [
      {
        scheme: 'exact',
        network: BIND_NETWORK,
        payTo: BIND_RECIPIENT,
        maxAmountRequired: '10000',
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        resource: 'https://api.example/purchase',
        description: 'test',
        mimeType: 'application/json',
        maxTimeoutSeconds: 300,
        extra: { name: 'USDC', version: '2' },
      },
    ]),
    enrichExtensions: vi.fn(() => undefined),
    verifyPayment: vi.fn(async () => ({ isValid: true })),
    settlePayment: vi.fn(async () => ({ success: true, transaction: '0xdeadbeef', network: BIND_NETWORK })),
    paymentRequirementsExtraName: vi.fn(() => 'USDC'),
  };
}

function x402Header(payTo: string, network = BIND_NETWORK): string {
  const payload = {
    x402Version: 2,
    scheme: 'exact',
    network,
    accepted: { network, payTo, scheme: 'exact' },
    payload: { authorization: { from: '0xeb2Ca790F72787c7e61bC6c861353a1e4ACDFCa5' } },
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

describe('Checkout — x402 v2 resource metadata + extensions on the 402', () => {
  beforeEach(() => { vi.stubEnv('AGENTSCORE_API_KEY', ''); });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('carries resourceInfo + discoveryExtensions in both the body and the PAYMENT-REQUIRED header', async () => {
    const checkout = new Checkout({
      rails: { x402_base: { recipient: BIND_RECIPIENT, network: BIND_NETWORK } as X402BaseRailSpec },
      url: 'https://api.example/purchase',
      computePricing: () => ({ amountUsd: 0.01 }),
      x402Server: makeFakeX402Server() as never,
      resourceInfo: { serviceName: 'Example Enrich', tags: ['data', 'enrichment'], iconUrl: 'https://ex.com/i.png' },
      discoveryExtensions: { 'com.coinbase.bazaar': { info: {}, schema: {} } },
    });
    const result = await checkout.handle(req());
    expect(result.status).toBe(402);
    // Body carries resource + extensions.
    expect((result.body.resource as { serviceName?: string }).serviceName).toBe('Example Enrich');
    expect(result.body.extensions).toEqual({ 'com.coinbase.bazaar': { info: {}, schema: {} } });
    // The PAYMENT-REQUIRED header (the canonical x402 transport) carries them too.
    const decoded = JSON.parse(Buffer.from(result.headers['payment-required'], 'base64').toString('utf-8'));
    expect(decoded.resource.serviceName).toBe('Example Enrich');
    expect(decoded.resource.tags).toEqual(['data', 'enrichment']);
    expect(decoded.resource.iconUrl).toBe('https://ex.com/i.png');
    expect(decoded.extensions).toEqual({ 'com.coinbase.bazaar': { info: {}, schema: {} } });
  });

  it('emits an https resource.url behind a TLS-terminating proxy (X-Forwarded-Proto)', async () => {
    const checkout = new Checkout({
      rails: { x402_base: { recipient: BIND_RECIPIENT, network: BIND_NETWORK } as X402BaseRailSpec },
      url: 'https://api.example/purchase',
      computePricing: () => ({ amountUsd: 0.01 }),
      x402Server: makeFakeX402Server() as never,
    });
    // Behind ALB / CloudFront the inbound URL is http://; the proxy sets X-Forwarded-Proto: https.
    const result = await checkout.handle(req({
      url: 'http://api.example/purchase',
      headers: { 'x-forwarded-proto': 'https' },
    }));
    expect(result.status).toBe(402);
    const decoded = JSON.parse(Buffer.from(result.headers['payment-required'], 'base64').toString('utf-8'));
    expect(decoded.resource.url).toBe('https://api.example/purchase');
  });

  it('enriches the Bazaar discovery extension with info.input.method from the request', async () => {
    const { createBazaarDiscovery } = await import('../src/discovery/bazaar');
    const bazaar = (await createBazaarDiscovery({
      bodyType: 'json',
      input: { domain: { type: 'string' } },
      output: { matches: { type: 'array' } },
    })) as Record<string, unknown>;
    const checkout = new Checkout({
      rails: { x402_base: { recipient: BIND_RECIPIENT, network: BIND_NETWORK } as X402BaseRailSpec },
      url: 'https://api.example/company/base',
      computePricing: () => ({ amountUsd: 0.01 }),
      x402Server: makeFakeX402Server() as never,
      discoveryExtensions: bazaar,
    });
    const result = await checkout.handle(req({ url: 'https://api.example/company/base' }));
    expect(result.status).toBe(402);
    const decoded = JSON.parse(Buffer.from(result.headers['payment-required'], 'base64').toString('utf-8'));
    // info.input.method (required by the v2 discovery schema) is absent at declaration
    // time and filled by the server enrichment from the request method.
    expect((decoded.extensions.bazaar.info.input as { method?: string }).method).toBe('POST');
  });
});

describe('Checkout — x402 payTo binding to the configured static recipient', () => {
  beforeEach(() => { vi.stubEnv('AGENTSCORE_API_KEY', ''); });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  function buildCheckout(server = makeFakeX402Server()) {
    return new Checkout({
      // STATIC recipient, no mintRecipients, no isCachedAddress → Checkout auto-binds payTo to it.
      rails: { x402_base: { recipient: BIND_RECIPIENT, network: BIND_NETWORK } as X402BaseRailSpec },
      url: 'https://api.example/purchase',
      computePricing: () => ({ amountUsd: 0.01 }),
      x402Server: server as never,
    });
  }

  it('REJECTS a settle whose payTo is NOT the configured recipient (hostile redirect)', async () => {
    const server = makeFakeX402Server();
    const checkout = buildCheckout(server);
    // Agent forges payTo = their own wallet (a VALID EVM address, so it clears the shape check —
    // the rejection is specifically the recipient bind, not address validation). The permissive
    // default must NOT apply to a static-recipient merchant: rejected before the facilitator runs.
    const attacker = '0xbadbadbadbadbadbadbadbadbadbadbadbadbad0';
    const result = await checkout.handle(req({
      headers: { 'x-payment': x402Header(attacker) },
    }));
    expect(result.status).toBe(400);
    expect(result.settled).toBe(false);
    expect((result.body.error as { code: string }).code).toBe('payment_proof_invalid');
    expect(server.settlePayment).not.toHaveBeenCalled();
  });

  it('ACCEPTS a settle whose payTo equals the configured recipient (case-insensitive)', async () => {
    const server = makeFakeX402Server();
    const checkout = buildCheckout(server);
    // Honest payTo, hex body case-flipped (keeping the `0x` prefix lowercase so it still passes the
    // EVM address-shape check) to prove the recipient bind itself is case-insensitive.
    const flipped = '0x' + BIND_RECIPIENT.slice(2).toLowerCase();
    const result = await checkout.handle(req({
      headers: { 'x-payment': x402Header(flipped) },
    }));
    expect(result.status).toBe(200);
    expect(result.settled).toBe(true);
    expect(server.settlePayment).toHaveBeenCalled();
  });

  it('a merchant-supplied isCachedAddress still wins (per-order minting path unchanged)', async () => {
    const server = makeFakeX402Server();
    const seen = '0xabcdef0000000000000000000000000000000aaa'; // per-order minted deposit address
    const checkout = new Checkout({
      rails: { x402_base: { recipient: BIND_RECIPIENT, network: BIND_NETWORK } as X402BaseRailSpec },
      url: 'https://api.example/purchase',
      computePricing: () => ({ amountUsd: 0.01 }),
      x402Server: server as never,
      // Custom lookup: only the per-order minted address is valid — NOT the static rail recipient.
      isCachedAddress: (addr) => addr.toLowerCase() === seen.toLowerCase(),
    });
    // The static rail recipient is now rejected (custom lookup overrides the static-set bind)...
    const staticRes = await checkout.handle(req({ headers: { 'x-payment': x402Header(BIND_RECIPIENT) } }));
    expect(staticRes.status).toBe(400);
    // ...and the per-order minted address is accepted.
    const mintedRes = await checkout.handle(req({ headers: { 'x-payment': x402Header(seen) } }));
    expect(mintedRes.status).toBe(200);
  });

  it('binds to the per-request minted recipient over the static set (static recipient + mintRecipients)', async () => {
    // payTo bind regression B: a rail carries BOTH a static recipient AND mintRecipients (static =
    // discovery default; per-request mint = the real payTo). Binding to the construction-time static
    // set would reject the legit minted payTo. The fix binds to ctx.recipients['x402_base'] (mirroring
    // the compute-first path), so the minted payTo settles and the stale static recipient is rejected.
    const server = makeFakeX402Server();
    const minted = '0xabcdef0000000000000000000000000000000aaa'; // per-order minted payTo
    const checkout = new Checkout({
      rails: { x402_base: { recipient: BIND_RECIPIENT, network: BIND_NETWORK } as X402BaseRailSpec },
      url: 'https://api.example/purchase',
      computePricing: () => ({ amountUsd: 0.01 }),
      x402Server: server as never,
      mintRecipients: () => ({ x402_base: minted }),
    });
    // The per-request minted payTo settles...
    const mintedRes = await checkout.handle(req({ headers: { 'x-payment': x402Header(minted) } }));
    expect(mintedRes.status).toBe(200);
    expect(mintedRes.settled).toBe(true);
    expect(server.settlePayment).toHaveBeenCalled();
    // ...and the now-stale construction-time static recipient is rejected.
    const staticRes = await checkout.handle(req({ headers: { 'x-payment': x402Header(BIND_RECIPIENT) } }));
    expect(staticRes.status).toBe(400);
    expect(staticRes.settled).toBe(false);
  });
});

describe('Checkout — zero-settle carve-out gates on the real amount (sub-cent guard)', () => {
  beforeEach(() => { vi.stubEnv('AGENTSCORE_API_KEY', ''); });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('a $0.002 NON-zero price does NOT take the zero-settle path (it settles on-chain)', async () => {
    // Math.round(0.002 * 100) === 0, so the old cents-based gate would skip the on-chain settle
    // and deliver the goods for free. The fixed gate compares the real amount: $0.002 !== 0 → it
    // falls through to a real x402 settle (the facilitator IS called).
    const server = makeFakeX402Server();
    const checkout = new Checkout({
      rails: { x402_base: { recipient: BIND_RECIPIENT, network: BIND_NETWORK } as X402BaseRailSpec },
      url: 'https://api.example/purchase',
      computePricing: () => ({ amountUsd: 0.002, decimals: 4 }),
      x402Server: server as never,
      zeroSettleCarveOut: true,
    });
    const result = await checkout.handle(req({ headers: { 'x-payment': x402Header(BIND_RECIPIENT) } }));
    expect(result.status).toBe(200);
    expect(result.settled).toBe(true);
    // Real settle ran — NOT the zero-settle carve-out (which never calls the facilitator).
    expect(server.settlePayment).toHaveBeenCalled();
  });

  it('a genuine $0 price still takes the zero-settle carve-out (no facilitator call)', async () => {
    const server = makeFakeX402Server();
    const checkout = new Checkout({
      rails: { x402_base: { recipient: BIND_RECIPIENT, network: BIND_NETWORK } as X402BaseRailSpec },
      url: 'https://api.example/purchase',
      computePricing: () => ({ amountUsd: 0 }),
      x402Server: server as never,
      zeroSettleCarveOut: true,
    });
    const result = await checkout.handle(req({ headers: { 'x-payment': x402Header(BIND_RECIPIENT) } }));
    expect(result.status).toBe(200);
    // Zero-settle path: the facilitator is NEVER called (CDP rejects value=0).
    expect(server.settlePayment).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Zero-settle carve-out — railKey resolves from the bound credential (no receipt
// exists on the $0 path, so the receipt-method derivation can't run) and the
// x402 branch verifies the credential before honoring the carve-out.
// ─────────────────────────────────────────────────────────────────────────────

describe('Checkout — zero-settle railKey resolves from the bound credential', () => {
  beforeEach(() => { vi.stubEnv('AGENTSCORE_API_KEY', ''); });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  const SOLANA_SIGNER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
  const EVM_SIGNER = '0xeb2Ca790F72787c7e61bC6c861353a1e4ACDFCa5';

  function mppAuthHeader(source: string): string {
    return 'Payment ' + Buffer.from(JSON.stringify({ source })).toString('base64');
  }

  function buildZeroCheckout(
    rails: ConstructorParameters<typeof Checkout>[0]['rails'],
    onSettled: (ctx: CheckoutContext, outcome: { railKey?: string; signerNetwork?: string | null }) => Promise<Record<string, unknown>>,
    composeMppx: (ctx: CheckoutContext) => Promise<MppxComposeOutcome>,
  ) {
    return new Checkout({
      rails,
      url: 'https://api.example/purchase',
      computePricing: (): PricingResult => ({ amountUsd: 0 }),
      zeroSettleCarveOut: true,
      composeMppx,
      onSettled: onSettled as Parameters<typeof Checkout>[0]['onSettled'],
    });
  }

  it('a Solana MPP credential resolves railKey to the solana rail, not the tempo default', async () => {
    let observed: { railKey?: string; signerNetwork?: string | null } | undefined;
    const composeMppx = vi.fn(async (): Promise<MppxComposeOutcome> => ({ status: 200, raw: {} }));
    const checkout = buildZeroCheckout(
      {
        tempo_charge: { recipient: '0xtempo' } as TempoRailSpec,
        sol_rail: { recipient: 'solanaaddr', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' } as SolanaMppRailSpec,
      },
      async (_ctx, outcome) => { observed = outcome; return { ok: true }; },
      composeMppx,
    );
    const result = await checkout.handle(req({
      headers: { authorization: mppAuthHeader(`did:pkh:solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${SOLANA_SIGNER}`) },
    }));
    expect(result.status).toBe(200);
    expect(observed?.railKey).toBe('sol_rail');
    expect(observed?.signerNetwork).toBe('solana');
    // The $0 path never composes/settles upstream.
    expect(composeMppx).not.toHaveBeenCalled();
  });

  it('a Tempo credential resolves railKey to the tempo rail even when solana is declared first', async () => {
    // A hash/transaction credential at $0 means the agent signed against a
    // NONZERO quote that re-priced to $0 at settle (no-match flows). Upstream
    // cannot settle those at $0, so the carve-out absorbs them — no compose
    // call, no charge — and railKey derives from the recovered signer network,
    // order-independent of rail declaration.
    let observed: { railKey?: string; signerNetwork?: string | null } | undefined;
    const composeMppx = vi.fn(async (): Promise<MppxComposeOutcome> => ({ status: 200, raw: {} }));
    const checkout = buildZeroCheckout(
      {
        sol_rail: { recipient: 'solanaaddr', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' } as SolanaMppRailSpec,
        tempo_charge: { recipient: '0xtempo' } as TempoRailSpec,
      },
      async (_ctx, outcome) => { observed = outcome; return { ok: true }; },
      composeMppx,
    );
    const result = await checkout.handle(req({
      headers: {
        authorization: 'Payment ' + Buffer.from(JSON.stringify({
          source: `did:pkh:eip155:42431:${EVM_SIGNER}`,
          payload: { type: 'hash', hash: '0xabc' },
        })).toString('base64'),
      },
    }));
    expect(result.status).toBe(200);
    expect(composeMppx).not.toHaveBeenCalled();
    expect(observed?.railKey).toBe('tempo_charge');
    expect(observed?.signerNetwork).toBe('evm');
  });

  it('a $0 PROOF credential delegates to the settle path (mppx verifies zero-amount proofs natively)', async () => {
    let observed: { railKey?: string; signerNetwork?: string | null } | undefined;
    const composeMppx = vi.fn(async (): Promise<MppxComposeOutcome> => ({
      status: 200,
      raw: { receipt: { method: 'tempo' } },
    }));
    const checkout = buildZeroCheckout(
      {
        sol_rail: { recipient: 'solanaaddr', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' } as SolanaMppRailSpec,
        tempo_charge: { recipient: '0xtempo' } as TempoRailSpec,
      },
      async (_ctx, outcome) => { observed = outcome; return { ok: true }; },
      composeMppx,
    );
    const result = await checkout.handle(req({
      headers: {
        authorization: 'Payment ' + Buffer.from(JSON.stringify({
          source: `did:pkh:eip155:42431:${EVM_SIGNER}`,
          payload: { type: 'proof', signature: '0x' + 'ab'.repeat(65) },
        })).toString('base64'),
      },
    }));
    expect(result.status).toBe(200);
    expect(composeMppx).toHaveBeenCalledOnce();
    expect(observed?.railKey).toBe('tempo_charge');
  });

  it('a parseable credential with no typed payload keeps the carve-out (null signer, fallback railKey)', async () => {
    let observed: { railKey?: string; signerNetwork?: string | null } | undefined;
    const composeMppx = vi.fn(async (): Promise<MppxComposeOutcome> => ({ status: 200, raw: {} }));
    const checkout = buildZeroCheckout(
      {
        tempo_charge: { recipient: '0xtempo' } as TempoRailSpec,
        sol_rail: { recipient: 'solanaaddr', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' } as SolanaMppRailSpec,
      },
      async (_ctx, outcome) => { observed = outcome; return { ok: true }; },
      composeMppx,
    );
    const result = await checkout.handle(req({
      headers: { authorization: 'Payment ' + Buffer.from(JSON.stringify({ nope: true })).toString('base64') },
    }));
    expect(result.status).toBe(200);
    expect(composeMppx).not.toHaveBeenCalled();
    expect(observed?.railKey).toBe('tempo_charge');
    expect(observed?.signerNetwork).toBeNull();
  });

  it('a token-style (JWT-shaped) credential at $0 keeps the carve-out', async () => {
    // Stripe SPT and other token credentials pass the shape gate but have no
    // $0 settle semantics upstream — carve-out, null signer, no compose call.
    let observed: { railKey?: string; signerNetwork?: string | null } | undefined;
    const composeMppx = vi.fn(async (): Promise<MppxComposeOutcome> => ({ status: 200, raw: {} }));
    const checkout = buildZeroCheckout(
      { tempo_charge: { recipient: '0xtempo' } as TempoRailSpec },
      async (_ctx, outcome) => { observed = outcome; return { ok: true }; },
      composeMppx,
    );
    const result = await checkout.handle(req({
      headers: { authorization: 'Payment eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2ln' },
    }));
    expect(result.status).toBe(200);
    expect(composeMppx).not.toHaveBeenCalled();
    expect(observed?.signerNetwork).toBeNull();
  });

  it('zeroSettleCarveOut=false never carves out at $0 (every credential attempts a real settle)', async () => {
    const composeMppx = vi.fn(async (): Promise<MppxComposeOutcome> => ({
      status: 402,
      headers: { 'www-authenticate': 'Payment realm="t"' },
    }));
    const checkout = new Checkout({
      rails: { tempo_charge: { recipient: '0xtempo' } as TempoRailSpec },
      url: 'https://api.example/purchase',
      computePricing: (): PricingResult => ({ amountUsd: 0 }),
      composeMppx,
    });
    const result = await checkout.handle(req({
      headers: {
        authorization: 'Payment ' + Buffer.from(JSON.stringify({
          source: `did:pkh:eip155:42431:${EVM_SIGNER}`,
          payload: { type: 'hash', hash: '0xabc' },
        })).toString('base64'),
      },
    }));
    expect(composeMppx).toHaveBeenCalledOnce();
    // compose rejected the credential and re-challenged: 402, not a dead-end 400.
    expect(result.status).toBe(402);
  });
});

describe('Checkout — zero-settle x402 branch verifies the credential first', () => {
  beforeEach(() => { vi.stubEnv('AGENTSCORE_API_KEY', ''); });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  function buildZeroX402Checkout(server = makeFakeX402Server()) {
    return new Checkout({
      rails: { x402_base: { recipient: BIND_RECIPIENT, network: BIND_NETWORK } as X402BaseRailSpec },
      url: 'https://api.example/purchase',
      computePricing: (): PricingResult => ({ amountUsd: 0 }),
      x402Server: server as never,
      zeroSettleCarveOut: true,
    });
  }

  it('REJECTS a $0 settle whose payTo is not the configured recipient (no free goods on a forged header)', async () => {
    const checkout = buildZeroX402Checkout();
    const attacker = '0xbadbadbadbadbadbadbadbadbadbadbadbadbad0';
    const result = await checkout.handle(req({ headers: { 'x-payment': x402Header(attacker) } }));
    expect(result.status).toBe(400);
    expect(result.settled).toBe(false);
    expect((result.body.error as { code: string }).code).toBe('payment_proof_invalid');
  });

  it('does not settle a $0 undecodable payment header; re-challenges with a fresh 402', async () => {
    const checkout = buildZeroX402Checkout();
    const result = await checkout.handle(req({ headers: { 'x-payment': '!!not-base64-json!!' } }));
    // Junk credential never settles (no free goods), but the agent gets a fresh
    // 402 challenge to re-pay, not a dead-end 400.
    expect(result.status).toBe(402);
    expect(result.settled).toBe(false);
  });

  it('a verified $0 credential still recovers the signer for attribution', async () => {
    const server = makeFakeX402Server();
    const checkout = buildZeroX402Checkout(server);
    const result = await checkout.handle(req({ headers: { 'x-payment': x402Header(BIND_RECIPIENT) } }));
    expect(result.status).toBe(200);
    expect(server.settlePayment).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Credential shape gate. A junk payment header skips the merchant's paid
// preValidate probe and the identity-gate assess call, then re-challenges with
// a fresh 402 (pricing + recipient minting + compose run, same as any discovery
// leg) so an x402/MPP client re-pays instead of aborting on a 400.
// ─────────────────────────────────────────────────────────────────────────────

describe('Checkout — credential shape gate (pre-hook)', () => {
  beforeEach(() => { vi.stubEnv('AGENTSCORE_API_KEY', ''); });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('a junk MPP Authorization header re-challenges with a fresh 402, no preValidate', async () => {
    const preValidate = vi.fn(async () => ({}));
    const composeMppx = vi.fn(async (): Promise<MppxComposeOutcome> => ({
      status: 402,
      headers: { 'www-authenticate': 'Payment realm="fresh"' },
    }));
    const checkout = new Checkout({
      rails: { tempo: { recipient: '0xtempo' } as TempoRailSpec },
      url: 'https://api.example/purchase',
      preValidate,
      computePricing: (): PricingResult => ({ amountUsd: 10 }),
      composeMppx,
    });
    const result = await checkout.handle(req({ headers: { authorization: 'Payment total-garbage!!!' } }));
    expect(result.status).toBe(402);
    expect(result.settlePhase).toBe('credential_malformed');
    expect(result.headers['www-authenticate']).toBe('Payment realm="fresh"');
    // The junk credential must not burn the merchant's paid probe.
    expect(preValidate).not.toHaveBeenCalled();
  });

  it('a junk x402 header re-challenges with a fresh 402, no preValidate or settle', async () => {
    const preValidate = vi.fn(async () => ({}));
    const server = makeFakeX402Server();
    const checkout = new Checkout({
      rails: { x402_base: { recipient: BIND_RECIPIENT, network: BIND_NETWORK } as X402BaseRailSpec },
      url: 'https://api.example/purchase',
      preValidate,
      computePricing: (): PricingResult => ({ amountUsd: 0.01 }),
      x402Server: server as never,
    });
    const result = await checkout.handle(req({ headers: { 'x-payment': '!!!garbage!!!' } }));
    expect(result.status).toBe(402);
    expect(result.settlePhase).toBe('credential_malformed');
    // Junk must not burn the paid probe or attempt a settle.
    expect(preValidate).not.toHaveBeenCalled();
    expect(server.settlePayment).not.toHaveBeenCalled();
  });

  it('the malformed-credential 402 carries a usable challenge body (accepted_methods)', async () => {
    const server = makeFakeX402Server();
    const checkout = new Checkout({
      rails: { x402_base: { recipient: BIND_RECIPIENT, network: BIND_NETWORK } as X402BaseRailSpec },
      url: 'https://api.example/purchase',
      computePricing: (): PricingResult => ({ amountUsd: 0.01 }),
      x402Server: server as never,
    });
    const result = await checkout.handle(req({ headers: { 'x-payment': 'not-decodable' } }));
    expect(result.status).toBe(402);
    // A fresh challenge the agent can re-pay against, not a bare error body.
    expect(result.body.accepted_methods).toBeDefined();
  });

  it('a JWT-shaped Payment token passes the shape gate (token-style credentials stay dispatchable)', async () => {
    const composeMppx = vi.fn(async (): Promise<MppxComposeOutcome> => ({ status: 200, raw: {} }));
    const checkout = new Checkout({
      rails: { tempo: { recipient: '0xtempo' } as TempoRailSpec },
      url: 'https://api.example/purchase',
      computePricing: (): PricingResult => ({ amountUsd: 10 }),
      composeMppx,
    });
    const jwt = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2ln';
    const result = await checkout.handle(req({ headers: { authorization: `Payment ${jwt}` } }));
    expect(result.status).toBe(200);
    expect(composeMppx).toHaveBeenCalledOnce();
  });

  it('credentialPreCheck: false opts out (junk header reaches the dispatch path as before)', async () => {
    const preValidate = vi.fn(async () => ({}));
    const composeMppx = vi.fn(async (): Promise<MppxComposeOutcome> => ({
      status: 402,
      headers: { 'www-authenticate': 'Payment realm="t"' },
    }));
    const checkout = new Checkout({
      rails: { tempo: { recipient: '0xtempo' } as TempoRailSpec },
      url: 'https://api.example/purchase',
      preValidate,
      computePricing: (): PricingResult => ({ amountUsd: 10 }),
      composeMppx,
      credentialPreCheck: false,
    });
    const result = await checkout.handle(req({ headers: { authorization: 'Payment total-garbage!!!' } }));
    expect(preValidate).toHaveBeenCalledOnce();
    expect(composeMppx).toHaveBeenCalled();
    expect(result.settlePhase).not.toBe('credential_malformed');
  });

  it('an x402 header at a Tempo-only merchant is NOT enforced (discovery behavior unchanged)', async () => {
    const checkout = new Checkout({
      rails: { tempo: { recipient: '0xtempo' } as TempoRailSpec },
      url: 'https://api.example/purchase',
      computePricing: (): PricingResult => ({ amountUsd: 10 }),
      composeMppx: async () => ({ status: 402, headers: { 'www-authenticate': 'Payment realm="t"' } }),
    });
    const result = await checkout.handle(req({ headers: { 'x-payment': '!!!garbage!!!' } }));
    // No x402 rail → the junk x402 header is ignored and the request falls
    // through to the anonymous discovery leg (402 with rails), same as before.
    expect(result.status).toBe(402);
  });
});
