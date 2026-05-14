/**
 * Public-API surface tests.
 *
 * Locks the documented public surface so a future helper that lands in a module
 * but is forgotten in the barrel re-export (`src/index.ts` or a subpath
 * `src/<x>/index.ts`) fails CI. We hit that exact gap on `loadUCPSigningKeyFromEnv`
 * during the TEC-302 lift-up: the helper was defined in `src/identity/ucp-jwks.ts`
 * but never re-exported from `src/index.ts`, and the helper's own test imported
 * from the module path so it never noticed. Consumers (martin-estate) couldn't
 * `import { loadUCPSigningKeyFromEnv } from '@agent-score/commerce'` until the
 * barrel was patched.
 *
 * For every TEC-302 lift-up helper we assert:
 *   - the symbol is importable from its documented path
 *   - it's the same object as the module-level export (no double-rebinding)
 */

import { describe, expect, it } from 'vitest';

describe('public-surface — top-level @agent-score/commerce barrel', () => {
  it('exports the UCP env-loader (loadUCPSigningKeyFromEnv) from the top-level barrel', async () => {
    const topLevel = await import('../src/index.js');
    const module = await import('../src/identity/ucp-jwks.js');
    expect(typeof topLevel.loadUCPSigningKeyFromEnv).toBe('function');
    expect(topLevel.loadUCPSigningKeyFromEnv).toBe(module.loadUCPSigningKeyFromEnv);
    expect(Object.keys(module)).toContain('loadUCPSigningKeyFromEnv');
  });

  it('exports hashOperatorToken from the top-level barrel', async () => {
    const topLevel = await import('../src/index.js');
    const module = await import('../src/identity/tokens.js');
    expect(typeof topLevel.hashOperatorToken).toBe('function');
    expect(topLevel.hashOperatorToken).toBe(module.hashOperatorToken);
  });
});

describe('public-surface — @agent-score/commerce/payment subpath', () => {
  it('exports detectRailFromHeaders + zeroAmountCarveOut + usdToAtomic', async () => {
    const subpath = await import('../src/payment/index.js');
    expect(typeof subpath.detectRailFromHeaders).toBe('function');
    expect(typeof subpath.zeroAmountCarveOut).toBe('function');
    expect(typeof subpath.usdToAtomic).toBe('function');
  });

  it('exports classifyX402SettleResult + classifyOrchestrationError', async () => {
    const subpath = await import('../src/payment/index.js');
    expect(typeof subpath.classifyX402SettleResult).toBe('function');
    expect(typeof subpath.classifyOrchestrationError).toBe('function');
  });

  it('exports extractPaymentSigner + extractPaymentSignerFromAuth', async () => {
    const subpath = await import('../src/payment/index.js');
    expect(typeof subpath.extractPaymentSigner).toBe('function');
    expect(typeof subpath.extractPaymentSignerFromAuth).toBe('function');
  });
});
