/**
 * Default discovery paths emitted by `@agent-score/commerce` builders. These are
 * the public-by-design endpoints agents and crawlers fetch to learn the
 * merchant's shape: OpenAPI, llms.txt, MPP well-known, A2A agent card, UCP profile.
 * They should NOT carry `X-Robots-Tag: noindex` since the whole point is for
 * agents (and search/discovery crawlers) to find them.
 *
 * Everything else on an agent-only API should noindex by default — there's no
 * human-shaped HTML to surface to general search engines, and accidental
 * indexing leaks transactional endpoints into noisy SERPs.
 */
export const defaultDiscoveryPaths: ReadonlySet<string> = new Set([
  '/openapi.json',
  '/llms.txt',
  '/.well-known/mpp.json',
  '/.well-known/agent-card.json',
  '/.well-known/ucp',
  '/favicon.png',
  '/favicon.ico',
]);

/**
 * Pure predicate for "is this path a known discovery surface?". Compose this
 * into your own framework's middleware when you don't want the bundled Hono
 * wrapper. Custom paths are the union with the defaults — pass `replace: true`
 * to skip the defaults.
 */
export function isDiscoveryPath(
  path: string,
  options?: { customPaths?: Iterable<string>; replace?: boolean },
): boolean {
  if (options?.replace) {
    return new Set(options.customPaths ?? []).has(path);
  }
  if (defaultDiscoveryPaths.has(path)) return true;
  if (options?.customPaths) {
    for (const p of options.customPaths) if (p === path) return true;
  }
  return false;
}

export interface NoindexNonDiscoveryOptions {
  /** Additional discovery paths beyond the defaults (e.g. `/sitemap.xml`,
   *  `/.well-known/foo`). Merged with the defaults unless `replacePaths: true`. */
  customPaths?: Iterable<string>;
  /** When true, ignore the bundled defaults and only treat `customPaths` as
   *  discovery surfaces. Use when the merchant deliberately chooses a different
   *  set (e.g. omits `/openapi.json` from a closed API). */
  replacePaths?: boolean;
  /** Override the X-Robots-Tag value applied to non-discovery paths. Defaults to
   *  the standard "noindex, nofollow, noarchive, nosnippet" tuple — change only
   *  if you have a very specific crawl-shape requirement. */
  robotsTag?: string;
}

const DEFAULT_ROBOTS_TAG = 'noindex, nofollow, noarchive, nosnippet';

/**
 * Hono middleware that sets `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet`
 * on every response except the merchant's discovery surfaces (OpenAPI, llms.txt,
 * well-known files). Mount globally near the top of your middleware stack:
 *
 *   app.use('*', noindexNonDiscoveryPaths());
 *   app.use('*', noindexNonDiscoveryPaths({ customPaths: ['/sitemap.xml'] }));
 *
 * Pure helpers (`isDiscoveryPath`, `defaultDiscoveryPaths`) are exported for
 * non-Hono frameworks — wire them into your own middleware idiom.
 */
export function noindexNonDiscoveryPaths(options?: NoindexNonDiscoveryOptions) {
  const customSet = options?.customPaths ? new Set(options.customPaths) : undefined;
  const robotsTag = options?.robotsTag ?? DEFAULT_ROBOTS_TAG;
  return async (c: { req: { path: string }; header: (k: string, v: string) => void }, next: () => Promise<void>) => {
    await next();
    const path = c.req.path;
    const isDiscovery = options?.replacePaths
      ? customSet?.has(path) ?? false
      : defaultDiscoveryPaths.has(path) || (customSet?.has(path) ?? false);
    if (!isDiscovery) c.header('X-Robots-Tag', robotsTag);
  };
}
