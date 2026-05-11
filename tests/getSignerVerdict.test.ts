/**
 * Per-adapter coverage for `getSignerVerdict`: returns `undefined` when no signer was
 * extracted (operator-token-only paths, no payment credential, missing gate state) and
 * delegates to `core.getSignerVerdict(claimedWallet)` when a wallet-auth request is
 * cached.
 */
import { describe, expect, it, vi } from 'vitest';

const WALLET = '0x1111111111111111111111111111111111111111';

// ---------------------------------------------------------------------------
// Hono
// ---------------------------------------------------------------------------

describe('hono getSignerVerdict', () => {
  it('returns undefined when no gate state', async () => {
    const { getSignerVerdict } = await import('../src/identity/hono');
    const c = { get: (_k: string) => undefined } as unknown as import('hono').Context;
    expect(getSignerVerdict(c)).toBeUndefined();
  });

  it('returns undefined for operator-token-only requests', async () => {
    const { getSignerVerdict } = await import('../src/identity/hono');
    const fakeCore = { getSignerVerdict: vi.fn() };
    const c = {
      get: (k: string) =>
        k === '__agentscoreGate' ? { core: fakeCore, walletAddress: undefined } : undefined,
    } as unknown as import('hono').Context;
    expect(getSignerVerdict(c)).toBeUndefined();
    expect(fakeCore.getSignerVerdict).not.toHaveBeenCalled();
  });

  it('delegates to core when wallet_address is set', async () => {
    const { getSignerVerdict } = await import('../src/identity/hono');
    const sentinel = { signer_match: null, signer_sanctions: null };
    const fakeCore = { getSignerVerdict: vi.fn().mockReturnValue(sentinel) };
    const c = {
      get: (k: string) =>
        k === '__agentscoreGate' ? { core: fakeCore, walletAddress: WALLET } : undefined,
    } as unknown as import('hono').Context;
    expect(getSignerVerdict(c)).toBe(sentinel);
    expect(fakeCore.getSignerVerdict).toHaveBeenCalledWith(WALLET);
  });
});

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------

describe('express getSignerVerdict', () => {
  it('returns undefined when no gate state', async () => {
    const { getSignerVerdict } = await import('../src/identity/express');
    const req = {} as unknown as Parameters<typeof getSignerVerdict>[0];
    expect(getSignerVerdict(req)).toBeUndefined();
  });

  it('returns undefined for operator-token-only requests', async () => {
    const { getSignerVerdict } = await import('../src/identity/express');
    const fakeCore = { getSignerVerdict: vi.fn() };
    const req = {
      __agentscoreGate: { core: fakeCore, walletAddress: undefined },
    } as unknown as Parameters<typeof getSignerVerdict>[0];
    expect(getSignerVerdict(req)).toBeUndefined();
    expect(fakeCore.getSignerVerdict).not.toHaveBeenCalled();
  });

  it('delegates to core when wallet_address is set', async () => {
    const { getSignerVerdict } = await import('../src/identity/express');
    const sentinel = { signer_match: null, signer_sanctions: null };
    const fakeCore = { getSignerVerdict: vi.fn().mockReturnValue(sentinel) };
    const req = {
      __agentscoreGate: { core: fakeCore, walletAddress: WALLET },
    } as unknown as Parameters<typeof getSignerVerdict>[0];
    expect(getSignerVerdict(req)).toBe(sentinel);
    expect(fakeCore.getSignerVerdict).toHaveBeenCalledWith(WALLET);
  });
});

// ---------------------------------------------------------------------------
// Fastify
// ---------------------------------------------------------------------------

describe('fastify getSignerVerdict', () => {
  it('returns undefined when no gate state', async () => {
    const { getSignerVerdict } = await import('../src/identity/fastify');
    const request = {} as unknown as Parameters<typeof getSignerVerdict>[0];
    expect(getSignerVerdict(request)).toBeUndefined();
  });

  it('returns undefined for operator-token-only requests', async () => {
    const { getSignerVerdict } = await import('../src/identity/fastify');
    const fakeCore = { getSignerVerdict: vi.fn() };
    const request = {
      __agentscoreGate: { core: fakeCore, walletAddress: undefined },
    } as unknown as Parameters<typeof getSignerVerdict>[0];
    expect(getSignerVerdict(request)).toBeUndefined();
    expect(fakeCore.getSignerVerdict).not.toHaveBeenCalled();
  });

  it('delegates to core when wallet_address is set', async () => {
    const { getSignerVerdict } = await import('../src/identity/fastify');
    const sentinel = { signer_match: null, signer_sanctions: null };
    const fakeCore = { getSignerVerdict: vi.fn().mockReturnValue(sentinel) };
    const request = {
      __agentscoreGate: { core: fakeCore, walletAddress: WALLET },
    } as unknown as Parameters<typeof getSignerVerdict>[0];
    expect(getSignerVerdict(request)).toBe(sentinel);
    expect(fakeCore.getSignerVerdict).toHaveBeenCalledWith(WALLET);
  });
});
