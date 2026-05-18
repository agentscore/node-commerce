import Fastify from 'fastify';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { conditionalAgentscoreGate as conditionalExpress } from '../../src/identity/express';
import { conditionalAgentscoreGate as conditionalFastify } from '../../src/identity/fastify';
import { conditionalAgentscoreGate as conditionalHono } from '../../src/identity/hono';
import {
  conditionalAgentscoreMiddleware,
  withConditionalAgentScoreGate as withConditionalNext,
} from '../../src/identity/nextjs';
import {
  createConditionalAgentScoreGate,
  withConditionalAgentScoreGate as withConditionalWeb,
} from '../../src/identity/web';

const NOOP_OPTS = { apiKey: 'as_test_dummy' };

describe('hono conditional gate', () => {
  it('flows through when no payment header', async () => {
    const app = new Hono();
    app.use('/x', conditionalHono(NOOP_OPTS));
    app.get('/x', (c) => c.json({ ok: true }));
    const res = await app.request('/x');
    expect(res.status).toBe(200);
  });

  it('fires the gate when payment header present (denial path)', async () => {
    const app = new Hono();
    app.use(
      '/x',
      conditionalHono({
        ...NOOP_OPTS,
        extractIdentity: () => undefined,
      }),
    );
    app.get('/x', (c) => c.json({ ok: true }));
    const res = await app.request('/x', {
      headers: { 'x-payment': '<base64>' },
    });
    // No identity + payment header → gate denies with missing_identity (403)
    expect(res.status).toBe(403);
  });
});

describe('express conditional gate', () => {
  it('returns a middleware fn that calls next() with no payment header', async () => {
    const middleware = conditionalExpress(NOOP_OPTS);
    let nextCalled = false;
    await middleware(
      { headers: {} } as never,
      {} as never,
      () => {
        nextCalled = true;
      },
    );
    expect(nextCalled).toBe(true);
  });

  it('fires the gate when payment header present (denial path)', async () => {
    const middleware = conditionalExpress({
      ...NOOP_OPTS,
      extractIdentity: () => undefined,
    });
    let denialStatus = 0;
    const fakeRes = {
      status: (s: number) => {
        denialStatus = s;
        return fakeRes;
      },
      json: () => fakeRes,
    };
    await middleware(
      { headers: { 'x-payment': '<base64>' } } as never,
      fakeRes as never,
      () => {},
    );
    expect(denialStatus).toBe(403);
  });
});

describe('next.js conditional middleware', () => {
  it('fires the gate when payment header present (denial path)', async () => {
    const gate = conditionalAgentscoreMiddleware({
      ...NOOP_OPTS,
      extractIdentity: () => undefined,
    });
    const req = new Request('https://x', { headers: { 'x-payment': '<base64>' } });
    const res = await gate(req);
    expect(res).toBeDefined();
    expect(res!.status).toBe(403);
  });

  it('returns undefined when no payment header', async () => {
    const gate = conditionalAgentscoreMiddleware(NOOP_OPTS);
    const req = new Request('https://x');
    expect(await gate(req)).toBeUndefined();
  });

  it('withConditionalAgentScoreGate flows through to handler with empty gate arg', async () => {
    const handler = withConditionalNext(NOOP_OPTS, async () => new Response('ok'));
    const res = await handler(new Request('https://x'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('withConditionalAgentScoreGate fires the gate when payment header present', async () => {
    const handler = withConditionalNext(
      { ...NOOP_OPTS, extractIdentity: () => undefined },
      async () => new Response('handler reached'),
    );
    const req = new Request('https://x', { headers: { 'x-payment': '<base64>' } });
    const res = await handler(req);
    expect(res.status).toBe(403);
  });
});

describe('fastify conditional gate plugin', () => {
  it('flows through when no payment header', async () => {
    const app = Fastify();
    await app.register(conditionalFastify, NOOP_OPTS);
    app.get('/x', async () => ({ ok: true }));
    const res = await app.inject({ method: 'GET', url: '/x' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('fires the gate when payment header present (denial path)', async () => {
    const app = Fastify();
    await app.register(conditionalFastify, {
      ...NOOP_OPTS,
      extractIdentity: () => undefined,
    });
    app.get('/x', async () => ({ ok: true }));
    const res = await app.inject({ method: 'GET', url: '/x', headers: { 'x-payment': '<base64>' } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe('web conditional gate', () => {
  it('createConditionalAgentScoreGate allows discovery legs', async () => {
    const guard = createConditionalAgentScoreGate(NOOP_OPTS);
    const result = await guard(new Request('https://x'));
    expect(result.allowed).toBe(true);
  });

  it('withConditionalAgentScoreGate flows through to handler', async () => {
    const handler = withConditionalWeb(NOOP_OPTS, async () => new Response('ok'));
    const res = await handler(new Request('https://x'), {});
    expect(res.status).toBe(200);
  });

  it('createConditionalAgentScoreGate fires the gate on settle leg', async () => {
    const guard = createConditionalAgentScoreGate({
      ...NOOP_OPTS,
      extractIdentity: () => undefined,
    });
    const req = new Request('https://x', { headers: { 'x-payment': '<base64>' } });
    const result = await guard(req);
    expect(result.allowed).toBe(false);
  });

  it('withConditionalAgentScoreGate fires the gate on settle leg', async () => {
    const handler = withConditionalWeb(
      { ...NOOP_OPTS, extractIdentity: () => undefined },
      async () => new Response('handler reached'),
    );
    const req = new Request('https://x', { headers: { 'x-payment': '<base64>' } });
    const res = await handler(req, {});
    expect(res.status).toBe(403);
  });
});
