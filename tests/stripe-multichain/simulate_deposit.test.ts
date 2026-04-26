import { afterEach, describe, expect, it, vi } from 'vitest';
import { simulateCryptoDeposit } from '../../src/stripe-multichain/simulate_deposit';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('simulateCryptoDeposit', () => {
  it('POSTs to the test_helpers endpoint with form-encoded body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await simulateCryptoDeposit({
      paymentIntentId: 'pi_test_1',
      network: 'base',
      buyerWallet: '0xbuyer',
      stripeSecretKey: 'sk_test_xxx',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/v1/test_helpers/payment_intents/pi_test_1/simulate_crypto_deposit');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk_test_xxx');
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect((init as RequestInit).body).toContain('network=base');
    expect((init as RequestInit).body).toContain('buyer_wallet=0xbuyer');
  });

  it('throws on non-2xx responses', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'invalid_request',
    } as Response) as unknown as typeof fetch;
    await expect(
      simulateCryptoDeposit({
        paymentIntentId: 'pi_x',
        network: 'tempo',
        stripeSecretKey: 'sk_test_xxx',
      }),
    ).rejects.toThrow(/simulate_crypto_deposit failed.*invalid_request/);
  });
});
