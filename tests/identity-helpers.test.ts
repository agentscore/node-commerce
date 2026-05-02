/**
 * Cross-adapter read-helper coverage for getAgentScoreData / getGateQuotaInfo.
 *
 * Each adapter exposes read-only helpers that pull state stashed on the
 * framework-specific request container during gate evaluate. These tests exercise
 * the read-path-only contract: prime the container with a fake state and verify
 * the helper returns what's there. Full end-to-end gate flow is covered by the
 * per-adapter gate tests; this file targets the trivial reader surface that
 * doesn't get exercised on the failOpen / fail-closed paths.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  getAgentScoreData as getExpressAgentScoreData,
  getGateQuotaInfo as getExpressGateQuotaInfo,
} from '../src/identity/express';
import {
  getAgentScoreData as getFastifyAgentScoreData,
  getGateQuotaInfo as getFastifyGateQuotaInfo,
} from '../src/identity/fastify';
import { getGateQuotaInfo as getHonoGateQuotaInfo } from '../src/identity/hono';
import type { Request as ExpressRequest } from 'express';
import type { FastifyRequest } from 'fastify';
import type { Context } from 'hono';


// Couples to the internal GATE_STATE_KEY string in each adapter; intentional —
// the read helpers are thin wrappers over that key, and the test exercises the
// extraction logic directly.
const GATE_STATE_KEY = '__agentscoreGate';

const FAKE_QUOTA = { limit: 1000, used: 780, reset: '2026-06-01T00:00:00Z' };
const FAKE_ASSESS_DATA = { decision: 'allow', operatorToken: null } as const;

describe('express getAgentScoreData', () => {
  it('returns the attached AgentScoreData', () => {
    const req = { agentscore: FAKE_ASSESS_DATA } as unknown as ExpressRequest;
    expect(getExpressAgentScoreData(req)).toBe(FAKE_ASSESS_DATA);
  });

  it('returns undefined when nothing is attached', () => {
    const req = {} as unknown as ExpressRequest;
    expect(getExpressAgentScoreData(req)).toBeUndefined();
  });
});

describe('express getGateQuotaInfo', () => {
  it('returns the quota envelope when state has it', () => {
    const req = { [GATE_STATE_KEY]: { quota: FAKE_QUOTA } } as unknown as ExpressRequest;
    expect(getExpressGateQuotaInfo(req)).toBe(FAKE_QUOTA);
  });

  it('returns undefined when state is absent', () => {
    const req = {} as unknown as ExpressRequest;
    expect(getExpressGateQuotaInfo(req)).toBeUndefined();
  });

  it('returns undefined when state is present but quota is not', () => {
    const req = { [GATE_STATE_KEY]: { degraded: false } } as unknown as ExpressRequest;
    expect(getExpressGateQuotaInfo(req)).toBeUndefined();
  });
});

describe('fastify getAgentScoreData', () => {
  it('returns the attached AgentScoreData', () => {
    const request = { agentscore: FAKE_ASSESS_DATA } as unknown as FastifyRequest;
    expect(getFastifyAgentScoreData(request)).toBe(FAKE_ASSESS_DATA);
  });

  it('returns undefined when nothing is attached', () => {
    const request = {} as unknown as FastifyRequest;
    expect(getFastifyAgentScoreData(request)).toBeUndefined();
  });
});

describe('fastify getGateQuotaInfo', () => {
  it('returns the quota envelope when state has it', () => {
    const request = {
      [GATE_STATE_KEY]: { quota: FAKE_QUOTA },
    } as unknown as FastifyRequest;
    expect(getFastifyGateQuotaInfo(request)).toBe(FAKE_QUOTA);
  });

  it('returns undefined when state is absent', () => {
    const request = {} as unknown as FastifyRequest;
    expect(getFastifyGateQuotaInfo(request)).toBeUndefined();
  });

  it('returns undefined when state is present but quota is not', () => {
    const request = { [GATE_STATE_KEY]: { degraded: false } } as unknown as FastifyRequest;
    expect(getFastifyGateQuotaInfo(request)).toBeUndefined();
  });
});

describe('hono getGateQuotaInfo', () => {
  it('returns the quota envelope when state has it', () => {
    const c = {
      get: vi.fn().mockReturnValue({ quota: FAKE_QUOTA }),
    } as unknown as Context;
    expect(getHonoGateQuotaInfo(c)).toBe(FAKE_QUOTA);
  });

  it('returns undefined when state is absent', () => {
    const c = { get: vi.fn().mockReturnValue(undefined) } as unknown as Context;
    expect(getHonoGateQuotaInfo(c)).toBeUndefined();
  });

  it('returns undefined when state is present but quota is not', () => {
    const c = {
      get: vi.fn().mockReturnValue({ degraded: false }),
    } as unknown as Context;
    expect(getHonoGateQuotaInfo(c)).toBeUndefined();
  });
});

describe('passthrough re-export modules', () => {
  it('payment/signer.ts re-exports extractPaymentSigner + readX402PaymentHeader', async () => {
    const mod = await import('../src/payment/signer');
    expect(mod.extractPaymentSigner).toBeDefined();
    expect(mod.readX402PaymentHeader).toBeDefined();
  });

  it('api/index.ts re-exports AgentScore + AgentScoreError + test-address helpers', async () => {
    const mod = await import('../src/api/index');
    expect(mod.AgentScore).toBeDefined();
    expect(mod.AgentScoreError).toBeDefined();
    expect(mod.AGENTSCORE_TEST_ADDRESSES).toBeDefined();
    expect(mod.isAgentScoreTestAddress).toBeDefined();
  });
});
