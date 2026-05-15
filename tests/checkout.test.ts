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
