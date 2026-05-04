import { describe, expect, it } from 'vitest';
import { buildWellKnownX402 } from '../../src/discovery/well_known_x402';

describe('buildWellKnownX402', () => {
  it('emits {version: 1, resources: ["METHOD /path"]} per the x402scan v1 spec', () => {
    const doc = buildWellKnownX402({
      resources: [
        { method: 'POST', path: '/purchase' },
        { method: 'GET', path: '/catalog' },
      ],
    });
    expect(doc).toEqual({
      version: 1,
      resources: ['POST /purchase', 'GET /catalog'],
    });
  });

  it('uppercases the method even when caller passes lowercase', () => {
    const doc = buildWellKnownX402({ resources: [{ method: 'post', path: '/purchase' }] });
    expect(doc.resources).toEqual(['POST /purchase']);
  });

  it('preserves resource ordering', () => {
    const doc = buildWellKnownX402({
      resources: [
        { method: 'POST', path: '/a' },
        { method: 'POST', path: '/b' },
        { method: 'POST', path: '/c' },
      ],
    });
    expect(doc.resources).toEqual(['POST /a', 'POST /b', 'POST /c']);
  });

  it('emits an empty resources array when input is empty', () => {
    expect(buildWellKnownX402({ resources: [] })).toEqual({ version: 1, resources: [] });
  });
});
