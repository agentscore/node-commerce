import { describe, expect, it } from 'vitest';
import { build402Body } from '../../src/challenge/body';
import { respond402 } from '../../src/challenge/respond_402';

describe('respond402', () => {
  it('preserves mppx WWW-Authenticate verbatim and lowercases the header keys', () => {
    const result = respond402({
      mppxChallengeHeaders: {
        'WWW-Authenticate': 'Payment id="ord_x", method="tempo", request="..."',
        'Content-Type': 'application/json',
      },
      body: build402Body({ acceptedMethods: [{ method: 'tempo/charge' }] }),
    });
    expect(result.status).toBe(402);
    expect(result.headers['www-authenticate']).toContain('tempo');
    expect(result.headers['content-type']).toBe('application/json');
    expect((result.body.accepted_methods as unknown[])[0]).toEqual({ method: 'tempo/charge' });
    expect('payment-required' in result.headers).toBe(false);
  });

  it('layers PAYMENT-REQUIRED when x402 is set', () => {
    const result = respond402({
      mppxChallengeHeaders: { 'www-authenticate': 'Payment id="ord_y"' },
      body: build402Body({ acceptedMethods: [] }),
      x402: {
        x402Version: 2,
        accepts: [{ scheme: 'exact', network: 'eip155:84532' }],
        resource: { url: 'https://x.example/y', mimeType: 'application/json' },
      },
    });
    expect(result.headers['payment-required']).toBeDefined();
    const decoded = JSON.parse(
      Buffer.from(result.headers['payment-required']!, 'base64').toString(),
    );
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts[0].network).toBe('eip155:84532');
  });

  it('returns a structured Respond402Result value (framework-neutral)', () => {
    const result = respond402({
      mppxChallengeHeaders: {},
      body: { foo: 'bar' },
    });
    expect(result.body).toEqual({ foo: 'bar' });
    expect(result.headers['content-type']).toBe('application/json');
    expect(result.status).toBe(402);
  });
});
