/**
 * Bazaar discovery extension wrapper. Vendors pass their merchant config and we wrap
 * `declareDiscoveryExtension` from `@x402/extensions/bazaar`. The returned value is
 * registered on the x402 server (e.g., via `createX402Server({bazaar: true})` or
 * `server.registerExtension(...)`).
 *
 * `@x402/extensions` is an optional peer dependency.
 */
interface BazaarDiscoveryConfig {
  bodyType?: 'json' | 'form';
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  [key: string]: unknown;
}

interface BazaarModule {
  declareDiscoveryExtension?: (config: BazaarDiscoveryConfig) => unknown;
}

interface BazaarServerModule {
  bazaarResourceServerExtension?: {
    key: string;
    enrichDeclaration?: (declaration: unknown, transportContext: unknown) => unknown;
  };
}

/**
 * Run the Bazaar server extension's request-time enrichment on a declared discovery
 * `extensions` map. The reference x402 flow relies on `bazaarResourceServerExtension`
 * to fill `info.input.method` (the v2 discovery schema requires it ∈ POST/PUT/PATCH)
 * and `routeTemplate` from the actual request; declaring the extension alone leaves
 * them absent, so validators reject. Returns the map unchanged when no bazaar
 * declaration is present or `@x402/extensions` is not installed.
 */
export async function enrichBazaarDiscoveryExtensions(
  extensions: Record<string, unknown> | undefined,
  request: { method: string; path: string },
): Promise<Record<string, unknown> | undefined> {
  if (extensions === undefined) return extensions;
  const bazaar = await dynamicImport<BazaarServerModule>('@x402/extensions/bazaar');
  const ext = bazaar?.bazaarResourceServerExtension;
  /* v8 ignore next -- peer-dep-absence guard; @x402/extensions is installed in test env */
  if (!ext?.key || typeof ext.enrichDeclaration !== 'function') return extensions;
  const declaration = extensions[ext.key];
  if (declaration === undefined) return extensions;
  const transportContext = {
    method: request.method,
    adapter: { getPath: () => request.path },
    routePattern: request.path,
  };
  return { ...extensions, [ext.key]: ext.enrichDeclaration(declaration, transportContext) };
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
