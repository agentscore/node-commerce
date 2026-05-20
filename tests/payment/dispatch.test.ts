import { describe, expect, it, vi } from 'vitest';
import { dispatchSettlementByNetwork } from '../../src/payment/dispatch';

describe('dispatchSettlementByNetwork', () => {
  it('routes EVM payloads to handlers.evm', async () => {
    const evm = vi.fn().mockResolvedValue('evm-result');
    const svm = vi.fn();
    const result = await dispatchSettlementByNetwork(
      { accepted: { network: 'eip155:8453' }, payload: 'x' },
      { evm, svm },
    );
    expect(result).toBe('evm-result');
    expect(evm).toHaveBeenCalled();
    expect(svm).not.toHaveBeenCalled();
  });

  it('routes Solana payloads to handlers.svm', async () => {
    const evm = vi.fn();
    const svm = vi.fn().mockResolvedValue('svm-result');
    const result = await dispatchSettlementByNetwork(
      { accepted: { network: 'solana:5eykt' }, payload: 'y' },
      { evm, svm },
    );
    expect(result).toBe('svm-result');
    expect(svm).toHaveBeenCalled();
    expect(evm).not.toHaveBeenCalled();
  });

  it('throws CheckoutValidationError(503, payment_provider_unavailable) when matching handler is missing', async () => {
    await expect(
      dispatchSettlementByNetwork({ accepted: { network: 'eip155:1' } }, { svm: vi.fn() }),
    ).rejects.toMatchObject({
      name: 'CheckoutValidationError',
      code: 'payment_provider_unavailable',
      status: 503,
      message: expect.stringContaining('No EVM settlement handler'),
    });
    await expect(
      dispatchSettlementByNetwork({ accepted: { network: 'solana:foo' } }, { evm: vi.fn() }),
    ).rejects.toMatchObject({
      name: 'CheckoutValidationError',
      code: 'payment_provider_unavailable',
      status: 503,
      message: expect.stringContaining('No Solana settlement handler'),
    });
  });

  it('throws CheckoutValidationError(503, payment_provider_unavailable) on unrecognized network family', async () => {
    await expect(
      dispatchSettlementByNetwork({ accepted: { network: 'cosmos:foo' } }, {}),
    ).rejects.toMatchObject({
      name: 'CheckoutValidationError',
      code: 'payment_provider_unavailable',
      status: 503,
      message: expect.stringContaining('Unrecognized network'),
    });
  });
});
