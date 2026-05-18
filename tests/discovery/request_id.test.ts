import { describe, expect, it } from 'vitest';
import { echoRequestIdHeaderHono } from '../../src/discovery/request_id';

describe('echoRequestIdHeaderHono', () => {
  it('sets X-Request-ID header from c.get("requestId")', async () => {
    const middleware = echoRequestIdHeaderHono();
    const headers: Record<string, string> = {};
    await middleware(
      {
        get: (key: 'requestId') => (key === 'requestId' ? 'req-abc-123' : undefined),
        header: (name: string, value: string) => {
          headers[name] = value;
        },
      },
      async () => {},
    );
    expect(headers['X-Request-ID']).toBe('req-abc-123');
  });

  it('skips header when requestId is absent', async () => {
    const middleware = echoRequestIdHeaderHono();
    const headers: Record<string, string> = {};
    await middleware(
      {
        get: () => undefined,
        header: (name: string, value: string) => {
          headers[name] = value;
        },
      },
      async () => {},
    );
    expect(headers['X-Request-ID']).toBeUndefined();
  });
});
