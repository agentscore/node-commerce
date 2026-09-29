/**
 * Checkout × opt-in verification-session bootstrap.
 *
 * An identity-gated Checkout lets a buyer ask for a verify_url without first building a payment
 * credential: the discovery 402 advertises `X-Verification-Session: create`, and a request carrying
 * it (and no identity or payment credential) runs the gate, whose missing-identity path mints a
 * session and answers 403. Crawlers replaying a valid example body never send the header, so they
 * keep getting a plain 402 and mint nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Checkout, VERIFICATION_SESSION_HEADER, type CheckoutRequest } from '../src/checkout';
import type { StripeRailSpec, X402BaseRailSpec } from '../src/payment/rail_spec';

const { sessionCalls, assessCalls } = vi.hoisted(() => ({
  sessionCalls: [] as Array<Record<string, unknown>>,
  assessCalls: [] as Array<unknown>,
}));

vi.mock('@agent-score/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-score/sdk')>();
  return {
    ...actual,
    AgentScore: class {
      async createSession(body: Record<string, unknown>) {
        sessionCalls.push(body);
        return {
          session_id: 'sess_boot',
          poll_secret: 'poll_boot',
          verify_url: 'https://www.agentscore.com/verify?session=sess_boot',
          poll_url: 'https://api.agentscore.com/v1/sessions/sess_boot',
        };
      }
      async assess(...args: unknown[]) {
        assessCalls.push(args);
        return { decision: 'allow', decision_reasons: [] };
      }
    },
  };
});

afterEach(() => {
  sessionCalls.length = 0;
  assessCalls.length = 0;
});

function req(headers: Record<string, string> = {}): CheckoutRequest {
  return {
    method: 'POST',
    url: 'https://wine.example/purchase',
    headers: { 'content-type': 'application/json', ...headers },
    body: { item: 'wine' },
  };
}

function gatedCheckout() {
  return new Checkout({
    rails: { stripe: { profileId: 'profile_x' } as StripeRailSpec },
    url: 'https://wine.example/purchase',
    computePricing: () => ({ amountUsd: 50 }),
    gate: { apiKey: 'as_test_key', requireKyc: true, minAge: 21 },
  });
}

describe('Checkout: verification-session bootstrap', () => {
  it('advertises the bootstrap header on an identity-gated 402 when no identity is sent', async () => {
    const res = await gatedCheckout().handle(req());
    expect(res.status).toBe(402);
    const bootstrap = res.body.identity_bootstrap as { header: string; value: string; instructions: string };
    expect(bootstrap.header).toBe(VERIFICATION_SESSION_HEADER);
    expect(bootstrap.value).toBe('create');
    expect(bootstrap.instructions).toContain('verify_url');
    expect(sessionCalls).toHaveLength(0);
  });

  it('answers the header with the gate 403 carrying verify_url and poll data, without paying', async () => {
    const res = await gatedCheckout().handle(req({ [VERIFICATION_SESSION_HEADER]: 'create' }));
    expect(res.status).toBe(403);
    expect(res.settled).toBe(false);
    expect(res.body.verify_url).toBe('https://www.agentscore.com/verify?session=sess_boot');
    expect(res.body.session_id).toBe('sess_boot');
    expect(res.body.poll_secret).toBe('poll_boot');
    expect(sessionCalls).toHaveLength(1);
  });

  it('matches the header name and value case-insensitively', async () => {
    const res = await gatedCheckout().handle(req({ 'x-verification-session': ' CREATE ' }));
    expect(res.status).toBe(403);
    expect(sessionCalls).toHaveLength(1);
  });

  it('ignores the header when the request already carries an identity', async () => {
    const res = await gatedCheckout().handle(req({ [VERIFICATION_SESSION_HEADER]: 'create', 'X-Operator-Token': 'opc_x' }));
    expect(res.status).toBe(402);
    expect(res.body.identity_bootstrap).toBeUndefined();
    expect(sessionCalls).toHaveLength(0);
    expect(assessCalls).toHaveLength(0);
  });

  it('ignores any other header value', async () => {
    const res = await gatedCheckout().handle(req({ [VERIFICATION_SESSION_HEADER]: 'yes' }));
    expect(res.status).toBe(402);
    expect(sessionCalls).toHaveLength(0);
  });

  it('neither advertises nor honors the header on a merchant without an identity gate', async () => {
    const gateless = new Checkout({
      rails: { x402_base: { recipient: '0xT' } as X402BaseRailSpec },
      url: 'https://api.example/call',
      computePricing: () => ({ amountUsd: 0.01 }),
    });
    const advertised = await gateless.handle(req());
    expect(advertised.status).toBe(402);
    expect(advertised.body.identity_bootstrap).toBeUndefined();
    const asked = await gateless.handle(req({ [VERIFICATION_SESSION_HEADER]: 'create' }));
    expect(asked.status).toBe(402);
    expect(sessionCalls).toHaveLength(0);
  });
});
