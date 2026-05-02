/**
 * Bazaar discovery extension wrapper. Vendors pass their merchant config and we wrap
 * `declareDiscoveryExtension` from `@x402/extensions/bazaar`. The returned value is
 * registered on the x402 server (e.g., via `createX402Server({bazaar: true})` or
 * `server.registerExtension(...)`).
 *
 * `@x402/extensions` is an optional peer dependency.
 */
export interface BazaarDiscoveryConfig {
  bodyType?: 'json' | 'form';
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  [key: string]: unknown;
}

interface BazaarModule {
  declareDiscoveryExtension?: (config: BazaarDiscoveryConfig) => unknown;
}

export async function createBazaarDiscovery(config: BazaarDiscoveryConfig): Promise<unknown> {
  const bazaar = await dynamicImport<BazaarModule>('@x402/extensions/bazaar');
  /* v8 ignore start -- peer-dep-absence guard; @x402/extensions is installed in test env */
  if (!bazaar?.declareDiscoveryExtension) {
    throw new Error(
      '@x402/extensions not installed — `npm install @x402/extensions` for createBazaarDiscovery.',
    );
  }
  /* v8 ignore stop */
  return bazaar.declareDiscoveryExtension(config);
}

async function dynamicImport<T>(moduleName: string): Promise<T | null> {
  try {
    return (await import(moduleName)) as T;
  } catch {
    /* v8 ignore next -- catch fires only when peer dep is missing; installed in test env */
    return null;
  }
}
