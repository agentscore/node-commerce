import { describe, expect, it } from 'vitest';
import { defaultReadOnlyOnDenied } from '../src/identity/default_denied';

describe('defaultReadOnlyOnDenied', () => {
  it('returns 401 + unauthorized + missing-identity copy on missing_identity', () => {
    const r = defaultReadOnlyOnDenied({ code: 'missing_identity' });
    expect(r.status).toBe(401);
    expect(r.body.error).toEqual({
      code: 'unauthorized',
      message: 'X-Wallet-Address or X-Operator-Token header required',
    });
    expect(r.headers?.['Cache-Control']).toBe('no-store');
  });

  it('returns 401 + Invalid identity on other denials', () => {
    const r = defaultReadOnlyOnDenied({ code: 'token_expired' });
    expect(r.status).toBe(401);
    expect(r.body.error).toEqual({ code: 'unauthorized', message: 'Invalid identity' });
    expect(r.headers?.['Cache-Control']).toBe('no-store');
  });

  it('still spreads denialReasonToBody so agent_instructions ride through', () => {
    const r = defaultReadOnlyOnDenied({
      code: 'wallet_not_trusted',
      reasons: ['sanctions_flagged'],
    });
    expect(r.status).toBe(401);
    // Body carries through the denial-derived fields beyond just `error`.
    expect(Object.keys(r.body).length).toBeGreaterThan(1);
  });

  it('collapses api_error to 401 too (no 5xx leakage on read-only routes)', () => {
    const r = defaultReadOnlyOnDenied({ code: 'api_error' });
    expect(r.status).toBe(401);
  });
});
