import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wrapSolanaChargeWithFinalizedBlockhash } from '../../src/payment/mppx_server';

describe('wrapSolanaChargeWithFinalizedBlockhash', () => {
  const rpcUrl = 'http://rpc.test';
  const baseRequestResult = {
    methodDetails: { recentBlockhash: 'CONFIRMED_HASH', network: 'devnet' },
    recipient: 'JDK3GZwsmgWwdFicNnrLHEgZc54SNYp6egWL9LL3k9f5',
  };

  let originalFetch: typeof fetch | undefined;
  let baseMethod: { request: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    baseMethod = { request: vi.fn(async () => baseRequestResult) };
  });

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("replaces recentBlockhash with the RPC's finalized blockhash", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ result: { value: { blockhash: 'FINALIZED_HASH' } } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const wrapped = wrapSolanaChargeWithFinalizedBlockhash(baseMethod, rpcUrl);
    const result = (await wrapped.request!({ request: {} })) as {
      methodDetails: Record<string, unknown>;
    };

    expect(result.methodDetails.recentBlockhash).toBe('FINALIZED_HASH');
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.method).toBe('getLatestBlockhash');
    expect(body.params[0].commitment).toBe('finalized');
  });

  it('passes through unchanged when args.credential is set (verify path)', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const wrapped = wrapSolanaChargeWithFinalizedBlockhash(baseMethod, rpcUrl);
    const result = await wrapped.request!({ credential: { foo: 'bar' } });

    expect(result).toBe(baseRequestResult);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to the upstream confirmed blockhash when fetch throws', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('rpc unreachable');
    }) as unknown as typeof fetch;

    const wrapped = wrapSolanaChargeWithFinalizedBlockhash(baseMethod, rpcUrl);
    const result = (await wrapped.request!({ request: {} })) as {
      methodDetails: { recentBlockhash: string };
    };

    expect(result.methodDetails.recentBlockhash).toBe('CONFIRMED_HASH');
  });

  it('falls back when the RPC returns no blockhash', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ result: { value: {} } }), { status: 200 }),
    ) as unknown as typeof fetch;

    const wrapped = wrapSolanaChargeWithFinalizedBlockhash(baseMethod, rpcUrl);
    const result = (await wrapped.request!({ request: {} })) as {
      methodDetails: { recentBlockhash: string };
    };

    expect(result.methodDetails.recentBlockhash).toBe('CONFIRMED_HASH');
  });

  it('returns the upstream value as-is when it is null/undefined', async () => {
    baseMethod.request.mockResolvedValueOnce(undefined);
    const wrapped = wrapSolanaChargeWithFinalizedBlockhash(baseMethod, rpcUrl);
    const result = await wrapped.request!({ request: {} });
    expect(result).toBeUndefined();
  });
});
