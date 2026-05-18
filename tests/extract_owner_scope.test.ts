import { describe, expect, it } from 'vitest';
import { extractOwnerScope, hashOperatorToken } from '../src/identity/tokens';

describe('extractOwnerScope', () => {
  it('returns wallet address verbatim when X-Wallet-Address present', () => {
    const scope = extractOwnerScope({ 'x-wallet-address': '0xABCDEF' });
    expect(scope.walletAddress).toBe('0xABCDEF');
    expect(scope.operatorTokenHash).toBeUndefined();
  });

  it('hashes the operator token (never returns plaintext)', () => {
    const scope = extractOwnerScope({ 'x-operator-token': 'opc_secret123' });
    expect(scope.walletAddress).toBeUndefined();
    expect(scope.operatorTokenHash).toBe(hashOperatorToken('opc_secret123'));
    expect(scope.operatorTokenHash).not.toContain('opc_');
  });

  it('returns both when both headers are present', () => {
    const scope = extractOwnerScope({
      'x-wallet-address': '0xeb2Ca790F72787c7e61bC6c861353a1e4ACDFCa5',
      'x-operator-token': 'opc_a',
    });
    expect(scope.walletAddress).toBe('0xeb2Ca790F72787c7e61bC6c861353a1e4ACDFCa5');
    expect(scope.operatorTokenHash).toBe(hashOperatorToken('opc_a'));
  });

  it('returns an empty scope when neither header is present', () => {
    expect(extractOwnerScope({})).toEqual({});
  });

  it('accepts a Web Fetch Request and reads from .headers', () => {
    const req = new Request('https://example/orders/1', {
      headers: { 'x-wallet-address': '0xfeed' },
    });
    expect(extractOwnerScope(req).walletAddress).toBe('0xfeed');
  });

  it('accepts a Web Fetch Headers directly', () => {
    const headers = new Headers({ 'x-operator-token': 'opc_b' });
    expect(extractOwnerScope(headers).operatorTokenHash).toBe(hashOperatorToken('opc_b'));
  });
});
