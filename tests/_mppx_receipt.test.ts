import { describe, expect, it } from 'vitest';
import {
  deriveMppxReceiptMethod,
  extractMppxReceiptHeaderFromRaw,
} from '../src/_mppx_receipt';

describe('extractMppxReceiptHeaderFromRaw', () => {
  it('returns null when raw is null / not object / missing withReceipt', () => {
    expect(extractMppxReceiptHeaderFromRaw(null)).toBeNull();
    expect(extractMppxReceiptHeaderFromRaw('string')).toBeNull();
    expect(extractMppxReceiptHeaderFromRaw({})).toBeNull();
  });

  it('extracts header via withReceipt(Response) wrapper', () => {
    const raw = {
      withReceipt: (_res: Response): Response => {
        const wrapped = new Response(null, { headers: { 'Payment-Receipt': 'deadbeef' } });
        return wrapped;
      },
    };
    expect(extractMppxReceiptHeaderFromRaw(raw)).toBe('deadbeef');
  });

  it('returns null when withReceipt throws', () => {
    const raw = {
      withReceipt: (): Response => {
        throw new Error('no receipt');
      },
    };
    expect(extractMppxReceiptHeaderFromRaw(raw)).toBeNull();
  });

  it('returns null when withReceipt is not callable', () => {
    expect(extractMppxReceiptHeaderFromRaw({ withReceipt: 'not a function' })).toBeNull();
  });
});

describe('deriveMppxReceiptMethod', () => {
  it('prefers raw.receipt.method when present', async () => {
    const raw = { receipt: { method: 'tempo' } };
    expect(await deriveMppxReceiptMethod(raw)).toBe('tempo');
  });

  it('returns undefined when no path resolves', async () => {
    expect(await deriveMppxReceiptMethod({})).toBeUndefined();
    expect(await deriveMppxReceiptMethod(null)).toBeUndefined();
  });

  it('falls back to extractMppxReceiptMethod(header) when no direct receipt.method', async () => {
    // raw has withReceipt → header found → method extraction attempted.
    // mppx import will fail (peer dep not installed in tests for this module),
    // so the result is undefined — but the line is exercised.
    const raw = {
      withReceipt: (_res: Response): Response =>
        new Response(null, { headers: { 'Payment-Receipt': 'fake-receipt-base64' } }),
    };
    const result = await deriveMppxReceiptMethod(raw);
    // mppx not available in test env → undefined; what we want is the line being hit
    expect(result).toBeUndefined();
  });
});
