import { describe, expect, it } from 'vitest';
import { networks } from '../../src/payment/networks';
import { verifyX402Request } from '../../src/payment/x402_validation';

const accepted = {
  base: networks.base.sepolia.caip2,
  svm: networks.solana.devnet.caip2,
};

describe('verifyX402Request', () => {
  it('failure body always includes regenerate_payment_credential next_steps + warning', async () => {
    const res = await verifyX402Request({
      request: new Request('https://m.example/x'),
      isCachedAddress: async () => true,
      acceptedNetworks: accepted,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.body.error.code).toBe('payment_proof_invalid');
      expect(res.body.next_steps.action).toBe('regenerate_payment_credential');
      expect(res.body.next_steps.user_message).toMatch(/X-Payment|credential|fresh/);
      expect(res.body.next_steps.warning).toContain('tempo wallet transfer');
    }
  });

  it('returns ok:true for a valid evm payload', async () => {
    const payTo = '0x' + 'a'.repeat(40);
    const headerValue = Buffer.from(JSON.stringify({ accepted: { network: accepted.base, payTo } })).toString('base64');
    const res = await verifyX402Request({
      request: new Request('https://m.example/x', { headers: { 'x-payment': headerValue } }),
      isCachedAddress: async () => true,
      acceptedNetworks: accepted,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.signedPayTo).toBe(payTo);
      expect(res.isSolana).toBe(false);
    }
  });
});
