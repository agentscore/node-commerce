import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  simulateCryptoDeposit,
  simulateDepositIfTestMode,
  STRIPE_TEST_TX_HASH_SUCCESS,
} from '../../src/stripe-multichain/simulate_deposit';

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

  it('uses default buyer wallet per network when not provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await simulateCryptoDeposit({
      paymentIntentId: 'pi_x',
      network: 'solana',
      stripeSecretKey: 'sk_test_xxx',
    });
    const body = (fetchMock.mock.calls[0]![1] as RequestInit).body as string;
    expect(body).toContain('buyer_wallet=11111111111111111111111111111111');
  });

  it('falls back to an empty buyer_wallet for a network with no default + no override', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await simulateCryptoDeposit({
      paymentIntentId: 'pi_x',
      network: 'polygon' as unknown as 'base',
      stripeSecretKey: 'sk_test_xxx',
    });
    const body = (fetchMock.mock.calls[0]![1] as RequestInit).body as string;
    expect(body).toContain('buyer_wallet=');
    expect(new URLSearchParams(body).get('buyer_wallet')).toBe('');
  });

  it('passes tokenCurrency, transactionHash, and extra params + Stripe-Version header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await simulateCryptoDeposit({
      paymentIntentId: 'pi_x',
      network: 'base',
      stripeSecretKey: 'sk_test_xxx',
      stripeVersion: '2026-03-04.preview',
      tokenCurrency: 'usdc',
      transactionHash: STRIPE_TEST_TX_HASH_SUCCESS,
      extra: { foo: 'bar' },
    });
    const [, init] = fetchMock.mock.calls[0]!;
    const body = (init as RequestInit).body as string;
    expect(body).toContain('token_currency=usdc');
    expect(body).toContain('transaction_hash=');
    expect(body).toContain('foo=bar');
    expect(((init as RequestInit).headers as Record<string, string>)['Stripe-Version']).toBe(
      '2026-03-04.preview',
    );
  });

  it('honors custom stripeApiBase', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await simulateCryptoDeposit({
      paymentIntentId: 'pi_x',
      network: 'tempo',
      stripeSecretKey: 'sk_test_xxx',
      stripeApiBase: 'https://api.stripe.example',
    });
    expect(fetchMock.mock.calls[0]![0]).toContain('https://api.stripe.example/v1/test_helpers/');
  });
});

describe('simulateDepositIfTestMode', () => {
  it('no-ops when stripeSecretKey is not a test key', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const lookup = vi.fn(() => 'pi_x');
    await simulateDepositIfTestMode({
      getPaymentIntentId: lookup,
      depositAddress: '0xabc',
      network: 'base',
      stripeSecretKey: 'sk_live_xxx',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('warns + returns when no PI is cached for the deposit address', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await simulateDepositIfTestMode({
      getPaymentIntentId: () => undefined,
      depositAddress: '0xdeadbeef00000000',
      network: 'tempo',
      stripeSecretKey: 'sk_test_xxx',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping deposit simulation'));
    warnSpy.mockRestore();
  });

  it('calls simulateCryptoDeposit with the cached PI + success hash on a test key', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await simulateDepositIfTestMode({
      getPaymentIntentId: () => 'pi_lookup',
      depositAddress: '0xabc',
      network: 'base',
      buyerWallet: '0xbuyer',
      stripeSecretKey: 'sk_test_xxx',
      stripeVersion: '2026-03-04.preview',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = (fetchMock.mock.calls[0]![1] as RequestInit).body as string;
    expect(body).toContain('token_currency=usdc');
    expect(body).toContain('transaction_hash=');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('✓ Simulated base deposit'));
    warnSpy.mockRestore();
  });

  it('logs + swallows errors from the underlying call (does not throw)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'kapow',
    } as Response) as unknown as typeof fetch;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      simulateDepositIfTestMode({
        getPaymentIntentId: () => 'pi_x',
        depositAddress: '0xabc',
        network: 'tempo',
        stripeSecretKey: 'sk_test_xxx',
      }),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('✗ Failed to simulate tempo deposit'),
      expect.any(String),
    );
    errSpy.mockRestore();
  });

  it('stringifies a non-Error rejection in the failure log (the non-Error ternary side)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue('raw-string-failure') as unknown as typeof fetch;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      simulateDepositIfTestMode({
        getPaymentIntentId: () => 'pi_x',
        depositAddress: '0xabc',
        network: 'base',
        stripeSecretKey: 'sk_test_xxx',
      }),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('✗ Failed to simulate base deposit'),
      'raw-string-failure',
    );
    errSpy.mockRestore();
  });
});
