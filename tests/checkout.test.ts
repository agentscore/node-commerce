import { describe, expect, it, vi } from 'vitest';
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
    const result = await checkout.handle(req({ headers: { authorization: 'Payment id=abc' } }));
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
    const result = await checkout.handle(req({ headers: { authorization: 'Payment id=abc' } }));
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
    const result = await checkout.handle(req({ headers: { authorization: 'Payment id=abc' } }));
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
    const result = await checkout.handle(req({ headers: { authorization: 'Payment id=abc' } }));
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
    const result = await checkout.handle(req({ headers: { authorization: 'Payment id=abc' } }));
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
    const result = await checkout.handle(req({ headers: { authorization: 'Payment id=abc' } }));
    expect(result.status).toBe(200);
    expect('payment-receipt' in result.headers).toBe(false);
  });

  it('402 from compose on settle leg maps to 400 payment_proof_invalid', async () => {
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
    const result = await checkout.handle(req({ headers: { authorization: 'Payment id=abc' } }));
    expect(result.status).toBe(400);
    expect(result.headers['www-authenticate']).toBe('Payment id="ord_x"');
    expect((result.body.error as Record<string, unknown>).code).toBe('payment_proof_invalid');
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
    const result = await checkout.handle(req({ headers: { authorization: 'Payment xyz' } }));
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
    await checkout.handle(req({ headers: { authorization: 'Payment xyz' } }));
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
    await checkout.handle(req({ headers: { authorization: 'Payment xyz' } }));
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
    await checkout.handle(req({ headers: { authorization: 'Payment xyz' } }));
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
    await checkout.handle(req({ headers: { authorization: 'Payment xyz' } }));
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
    await checkout.handle(req({ headers: { authorization: 'Payment xyz' } }));
    expect(observedRailKey).toBe('sol_rail');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveRecipients error handling — mintRecipients throwing
// CheckoutValidationError lands as a 4xx envelope; other errors rethrow
// (covers the cross-bundle name-based catch added in 2.1.1).
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
