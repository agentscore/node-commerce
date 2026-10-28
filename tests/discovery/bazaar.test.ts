import { bazaarResourceServerExtension, validateDiscoveryExtension } from '@x402/extensions/bazaar';
import { describe, expect, it } from 'vitest';
import { createBazaarDiscovery, enrichBazaarDiscoveryExtensions } from '../../src/discovery/bazaar';

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

  it.each(['json', 'form-data', 'text'] as const)(
    'declares a %s body that the upstream validator accepts',
    async (bodyType) => {
      const declared = (await createBazaarDiscovery({ bodyType, input: { q: 'x' } })) as Record<string, unknown>;
      const enriched = await enrichBazaarDiscoveryExtensions(declared, { method: 'POST', path: '/search' });
      const result = validateDiscoveryExtension(enriched?.[bazaarResourceServerExtension.key] as never);
      expect(result).toEqual({ valid: true });
    },
  );

  it('the upstream validator rejects a bodyType outside the declared union', async () => {
    const declared = (await createBazaarDiscovery({ bodyType: 'form' as never, input: { q: 'x' } })) as Record<
      string,
      unknown
    >;
    const enriched = await enrichBazaarDiscoveryExtensions(declared, { method: 'POST', path: '/search' });
    const result = validateDiscoveryExtension(enriched?.[bazaarResourceServerExtension.key] as never);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining('bodyType'));
  });
});
