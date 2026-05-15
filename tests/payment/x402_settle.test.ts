import { describe, expect, it, vi } from 'vitest';
import { classifyX402SettleResult, processX402Settle } from '../../src/payment/x402_settle';
import type { X402Server } from '../../src/payment/x402_server';
import type { ProcessX402SettleResult } from '../../src/payment/x402_settle';

const baseInput = {
  payload: { accepted: { network: 'eip155:8453', payTo: '0xfeed' } },
  resourceConfig: { scheme: 'exact', network: 'eip155:8453', price: '$0.10', payTo: '0xfeed' },
  resourceMeta: { url: 'https://example.com/x', description: 'demo', mimeType: 'application/json' },
};

function makeServer(overrides: Partial<{
  buildPaymentRequirements: ReturnType<typeof vi.fn>;
  enrichExtensions: ReturnType<typeof vi.fn>;
  verifyPayment: ReturnType<typeof vi.fn>;
  settlePayment: ReturnType<typeof vi.fn>;
}>): X402Server {
  return {
    buildPaymentRequirements: overrides.buildPaymentRequirements ?? vi.fn().mockResolvedValue([{ matched: true }]),
    enrichExtensions: overrides.enrichExtensions ?? vi.fn().mockReturnValue(undefined),
    verifyPayment: overrides.verifyPayment ?? vi.fn().mockResolvedValue({ success: true }),
    settlePayment: overrides.settlePayment ?? vi.fn().mockResolvedValue({ tx: '0xabc' }),
  } as unknown as X402Server;
}

describe('processX402Settle', () => {
  it('returns success on the happy path with paymentResponseHeader as base64 of the settle result', async () => {
    const server = makeServer({});
    const result = await processX402Settle({ x402Server: server, ...baseInput });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.matchedRequirement).toEqual({ matched: true });
      expect(result.settleResult).toEqual({ tx: '0xabc' });
      expect(result.paymentResponseHeader).toBe(Buffer.from(JSON.stringify({ tx: '0xabc' })).toString('base64'));
    }
  });

  it('returns no_requirements when buildPaymentRequirements yields an empty array', async () => {
    const server = makeServer({ buildPaymentRequirements: vi.fn().mockResolvedValue([]) });
    const result = await processX402Settle({ x402Server: server, ...baseInput });
    expect(result).toEqual({
      success: false,
      phase: 'no_requirements',
      reason: 'x402Server.buildPaymentRequirements returned empty',
    });
  });

  it('returns verify_failed when verifyPayment yields { success: false }', async () => {
    const server = makeServer({ verifyPayment: vi.fn().mockResolvedValue({ success: false, reason: 'invalid_credential' }) });
    const result = await processX402Settle({ x402Server: server, ...baseInput });
    expect(result.success).toBe(false);
    if (!result.success && result.phase === 'verify_failed') {
      expect((result.verifyResult as { reason: string }).reason).toBe('invalid_credential');
    }
  });

  it('returns settle_failed when settlePayment throws', async () => {
    const server = makeServer({ settlePayment: vi.fn().mockRejectedValue(new Error('chain rejected tx')) });
    const result = await processX402Settle({ x402Server: server, ...baseInput });
    expect(result.success).toBe(false);
    if (!result.success && result.phase === 'settle_failed') {
      expect((result.error as Error).message).toBe('chain rejected tx');
    }
  });

  describe('facilitator_error wrap', () => {
    it('wraps buildPaymentRequirements throws as facilitator_error step=build_requirements', async () => {
      const server = makeServer({
        buildPaymentRequirements: vi.fn().mockRejectedValue(new Error('facilitator: network not supported')),
      });
      const result = await processX402Settle({ x402Server: server, ...baseInput });
      expect(result.success).toBe(false);
      if (!result.success && result.phase === 'facilitator_error') {
        expect(result.step).toBe('build_requirements');
        expect((result.error as Error).message).toBe('facilitator: network not supported');
      }
    });

    it('wraps enrichExtensions throws as facilitator_error step=enrich_extensions', async () => {
      const server = makeServer({
        enrichExtensions: vi.fn().mockImplementation(() => { throw new Error('extension barfed'); }),
      });
      const result = await processX402Settle({ x402Server: server, ...baseInput, extension: { kind: 'bazaar' } });
      expect(result.success).toBe(false);
      if (!result.success && result.phase === 'facilitator_error') {
        expect(result.step).toBe('enrich_extensions');
        expect((result.error as Error).message).toBe('extension barfed');
      }
    });

    it('wraps verifyPayment throws as facilitator_error step=process_payment_request', async () => {
      const server = makeServer({
        verifyPayment: vi.fn().mockRejectedValue(new Error('CDP facilitator: solana:devnet not supported')),
      });
      const result = await processX402Settle({ x402Server: server, ...baseInput });
      expect(result.success).toBe(false);
      if (!result.success && result.phase === 'facilitator_error') {
        expect(result.step).toBe('verify_payment');
        expect((result.error as Error).message).toBe('CDP facilitator: solana:devnet not supported');
      }
    });

    it('does NOT swallow settle errors as facilitator_error — settle_failed stays its own phase', async () => {
      const server = makeServer({ settlePayment: vi.fn().mockRejectedValue(new Error('on-chain rejection')) });
      const result = await processX402Settle({ x402Server: server, ...baseInput });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.phase).toBe('settle_failed');
      }
    });
  });
});

describe('classifyX402SettleResult', () => {
  it('returns null on success', async () => {
    const successResult: ProcessX402SettleResult = {
      success: true,
      matchedRequirement: { matched: true },
      settleResult: { tx: '0xabc' },
      paymentResponseHeader: 'base64',
      verifyResult: { success: true },
    };
    expect(classifyX402SettleResult(successResult)).toBeNull();
  });

  it('maps no_requirements to 500 payment_internal_error / contact_support', () => {
    const classified = classifyX402SettleResult({
      success: false,
      phase: 'no_requirements',
      reason: 'empty',
    });
    expect(classified).not.toBeNull();
    expect(classified!.status).toBe(500);
    expect(classified!.code).toBe('payment_internal_error');
    expect(classified!.nextSteps.action).toBe('contact_support');
  });

  it('maps verify_failed to 400 payment_proof_invalid / regenerate_payment_credential', () => {
    const classified = classifyX402SettleResult({
      success: false,
      phase: 'verify_failed',
      verifyResult: { success: false, reason: 'expired' },
    });
    expect(classified).not.toBeNull();
    expect(classified!.status).toBe(400);
    expect(classified!.code).toBe('payment_proof_invalid');
    expect(classified!.nextSteps.action).toBe('regenerate_payment_credential');
  });

  it('maps facilitator_error to 503 payment_provider_unavailable / try_different_rail', () => {
    const classified = classifyX402SettleResult({
      success: false,
      phase: 'facilitator_error',
      step: 'process_payment_request',
      error: new Error('CDP rejects solana:devnet'),
    });
    expect(classified).not.toBeNull();
    expect(classified!.status).toBe(503);
    expect(classified!.code).toBe('payment_provider_unavailable');
    expect(classified!.nextSteps.action).toBe('try_different_rail');
  });

  it('maps settle_failed to 503 payment_provider_unavailable / retry_or_swap_method with retry_after_seconds', () => {
    const classified = classifyX402SettleResult({
      success: false,
      phase: 'settle_failed',
      error: new Error('on-chain rejection'),
      matchedRequirement: { matched: true },
    });
    expect(classified).not.toBeNull();
    expect(classified!.status).toBe(503);
    expect(classified!.code).toBe('payment_provider_unavailable');
    expect(classified!.nextSteps.action).toBe('retry_or_swap_method');
    expect(classified!.nextSteps.retry_after_seconds).toBe(10);
  });

  it('classified message and nextSteps.user_message do NOT leak raw error details', () => {
    const sensitiveError = new Error('CDP-INTERNAL-TRACE-ID-12345 secret-key-in-stack');
    const classified = classifyX402SettleResult({
      success: false,
      phase: 'facilitator_error',
      step: 'process_payment_request',
      error: sensitiveError,
    });
    expect(classified).not.toBeNull();
    expect(classified!.message).not.toContain('CDP-INTERNAL-TRACE-ID-12345');
    expect(classified!.message).not.toContain('secret-key-in-stack');
    expect(classified!.nextSteps.user_message).not.toContain('CDP-INTERNAL-TRACE-ID-12345');
  });
});
