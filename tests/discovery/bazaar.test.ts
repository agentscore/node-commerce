import { describe, expect, it } from 'vitest';
import { createBazaarDiscovery } from '../../src/discovery/bazaar';

describe('createBazaarDiscovery', () => {
  it('returns a Bazaar discovery extension when @x402/extensions is installed', async () => {
    const ext = await createBazaarDiscovery({ bodyType: 'json' });
    expect(ext).toBeDefined();
  });

  it('passes through input/output config', async () => {
    const ext = await createBazaarDiscovery({
      bodyType: 'json',
      input: { q: 'string' },
      output: { results: 'array' },
    });
    expect(ext).toBeDefined();
  });
});
