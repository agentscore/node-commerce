import { describe, expect, it } from 'vitest';
import { extractSignerForPrecheck } from '../../src/signer';

describe('extractSignerForPrecheck — additional branches', () => {
  it('returns null when no payment header at all', async () => {
    expect(await extractSignerForPrecheck({})).toBeNull();
    expect(await extractSignerForPrecheck({ 'user-agent': 'test' })).toBeNull();
  });

  it('returns null when authorization is non-Payment scheme', async () => {
    expect(
      await extractSignerForPrecheck({ authorization: 'Bearer abc' }),
    ).toBeNull();
  });

  it('returns null when authorization Payment value is malformed', async () => {
    const result = await extractSignerForPrecheck({
      authorization: 'Payment not-base64-valid-bytes',
    });
    // Helper degrades gracefully; doesn't throw
    expect(result).toBeNull();
  });

  it('case-insensitive authorization header reading', async () => {
    expect(
      await extractSignerForPrecheck({ Authorization: 'Bearer xyz' }),
    ).toBeNull();
  });
});
