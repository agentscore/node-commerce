import { describe, expect, it } from 'vitest';
import { extractOwnerScope, hashOperatorToken } from '../src/identity/tokens';

// A real EIP-55 checksummed EVM address + its lowercase form. The stored `orders.wallet_address`
// column persists the lowercased signer, so extractOwnerScope MUST lowercase the inbound
// X-Wallet-Address — otherwise a checksummed header misses its own order rows (404).
const CHECKSUMMED = '0xeb2Ca790F72787c7e61bC6c861353a1e4ACDFCa5';
const LOWERCASED = CHECKSUMMED.toLowerCase();

describe('extractOwnerScope', () => {
  it('normalizes (lowercases) the EVM X-Wallet-Address', () => {
    const scope = extractOwnerScope({ 'x-wallet-address': CHECKSUMMED });
    expect(scope.walletAddress).toBe(LOWERCASED);
    expect(scope.operatorTokenHash).toBeUndefined();
  });

  it('a checksummed wallet resolves the SAME scope as its lowercase form', () => {
    // The whole point of the fix: both casings collapse to one canonical column value, so a
    // checksummed-EVM read hits the same order rows the lowercased signer was persisted under.
    const checksummed = extractOwnerScope({ 'x-wallet-address': CHECKSUMMED });
    const lower = extractOwnerScope({ 'x-wallet-address': LOWERCASED });
    expect(checksummed.walletAddress).toBe(lower.walletAddress);
    expect(checksummed.walletAddress).toBe(LOWERCASED);
  });

  it('preserves a Solana base58 address verbatim (case-sensitive)', () => {
    // Solana addresses are base58 and case-sensitive — normalization MUST NOT lowercase them.
    const sol = 'DQyrAcCrDXQ7iiRTHtPhHkjFmh1mVGwXqUL9F4FUe9YN';
    const scope = extractOwnerScope({ 'x-wallet-address': sol });
    expect(scope.walletAddress).toBe(sol);
  });

  it('hashes the operator token (never returns plaintext)', () => {
    const scope = extractOwnerScope({ 'x-operator-token': 'opc_secret123' });
    expect(scope.walletAddress).toBeUndefined();
    expect(scope.operatorTokenHash).toBe(hashOperatorToken('opc_secret123'));
    expect(scope.operatorTokenHash).not.toContain('opc_');
  });

  it('returns both when both headers are present (wallet normalized)', () => {
    const scope = extractOwnerScope({
      'x-wallet-address': CHECKSUMMED,
      'x-operator-token': 'opc_a',
    });
    expect(scope.walletAddress).toBe(LOWERCASED);
    expect(scope.operatorTokenHash).toBe(hashOperatorToken('opc_a'));
  });

  it('returns an empty scope when neither header is present', () => {
    expect(extractOwnerScope({})).toEqual({});
  });

  it('accepts a Web Fetch Request and reads from .headers', () => {
    const req = new Request('https://example/orders/1', {
      headers: { 'x-wallet-address': CHECKSUMMED },
    });
    expect(extractOwnerScope(req).walletAddress).toBe(LOWERCASED);
  });

  it('accepts a Web Fetch Headers directly', () => {
    const headers = new Headers({ 'x-operator-token': 'opc_b' });
    expect(extractOwnerScope(headers).operatorTokenHash).toBe(hashOperatorToken('opc_b'));
  });
});
