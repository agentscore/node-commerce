import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildIdempotencyKey } from '../../src/payment/idempotency';

describe('buildIdempotencyKey', () => {
  it('returns paymentIntentId verbatim when provided', () => {
    expect(buildIdempotencyKey({ paymentIntentId: 'pi_abc123' })).toBe('pi_abc123');
  });

  it('synthesizes from orderId + amountCents when no paymentIntentId', () => {
    expect(buildIdempotencyKey({ orderId: 'ord_xyz', amountCents: 25000 })).toBe('pi-ord_xyz-25000');
  });

  it('uses orderId-only when amountCents missing', () => {
    expect(buildIdempotencyKey({ orderId: 'ord_xyz' })).toBe('pi-ord_xyz');
  });

  it('returns undefined when neither paymentIntentId nor orderId provided', () => {
    expect(buildIdempotencyKey({})).toBeUndefined();
  });

  it('paymentIntentId wins over orderId fallback', () => {
    expect(
      buildIdempotencyKey({ paymentIntentId: 'pi_abc', orderId: 'ord_xyz', amountCents: 100 }),
    ).toBe('pi_abc');
  });

  it('applies prefix to paymentIntentId path', () => {
    expect(buildIdempotencyKey({ paymentIntentId: 'pi_abc', prefix: 'refund' })).toBe('refund-pi_abc');
  });

  it('applies prefix to orderId fallback path', () => {
    expect(buildIdempotencyKey({ orderId: 'ord_x', prefix: 'void' })).toBe('void-pi-ord_x');
  });

  describe('200-char cap warning', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('does not warn for keys at or under 200 chars', () => {
      const key = 'a'.repeat(200);
      buildIdempotencyKey({ paymentIntentId: key });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('warns when key exceeds 200 chars', () => {
      const key = 'a'.repeat(201);
      const result = buildIdempotencyKey({ paymentIntentId: key });
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0]?.[0]).toContain('idempotency key longer than 200 chars');
      // Returns the original key unchanged — server is the source of truth for truncation.
      expect(result).toBe(key);
    });
  });
});
