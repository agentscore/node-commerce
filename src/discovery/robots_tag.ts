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
  '/skill.md',
  '/SKILL.md',
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

/** Predicate the per-framework wrappers share. Pulled out so non-listed frameworks
 *  can compose it directly (`if (!shouldNoindex(path, opts)) ...`). */
function shouldNoindex(path: string, customSet: Set<string> | undefined, replacePaths: boolean | undefined): boolean {
  const isDiscovery = replacePaths
    ? (customSet?.has(path) ?? false)
    : defaultDiscoveryPaths.has(path) || (customSet?.has(path) ?? false);
  return !isDiscovery;
}

/**
 * Hono middleware. Mount globally near the top of your middleware stack:
 *
 *   app.use('*', noindexNonDiscoveryPaths());
 *   app.use('*', noindexNonDiscoveryPaths({ customPaths: ['/sitemap.xml'] }));
 *
 * Per-framework variants (`noindexNonDiscoveryPathsExpress`,
 * `noindexNonDiscoveryPathsFastify`, `noindexNonDiscoveryPathsWeb`) ship below.
 * For Next.js Route Handlers, use `applyNoindexHeader(response, path, opts)`
 * inline since route handlers don't have a global mount point.
 */
export function noindexNonDiscoveryPaths(options?: NoindexNonDiscoveryOptions) {
  const customSet = options?.customPaths ? new Set(options.customPaths) : undefined;
  const robotsTag = options?.robotsTag ?? DEFAULT_ROBOTS_TAG;
  return async (c: { req: { path: string }; header: (k: string, v: string) => void }, next: () => Promise<void>) => {
    await next();
    if (shouldNoindex(c.req.path, customSet, options?.replacePaths)) {
      c.header('X-Robots-Tag', robotsTag);
    }
  };
}

/** Express middleware. Sets the header before `next()` so route handlers can
 *  override per-response if they need to. */
export function noindexNonDiscoveryPathsExpress(options?: NoindexNonDiscoveryOptions) {
  const customSet = options?.customPaths ? new Set(options.customPaths) : undefined;
  const robotsTag = options?.robotsTag ?? DEFAULT_ROBOTS_TAG;
  return (
    req: { path: string },
    res: { setHeader: (name: string, value: string) => void },
    next: () => void,
  ) => {
    if (shouldNoindex(req.path, customSet, options?.replacePaths)) {
      res.setHeader('X-Robots-Tag', robotsTag);
    }
    next();
  };
}

/** Fastify plugin (use as `app.register(noindexNonDiscoveryPathsFastify, opts)`).
 *  Registers an `onRequest` hook so the header lands on every response. */
interface FastifyReqLike { url?: string; routerPath?: string }
interface FastifyReplyLike { header: (name: string, value: string) => void }
interface FastifyAppLike {
  addHook(event: 'onRequest', handler: (req: FastifyReqLike, reply: FastifyReplyLike, done: () => void) => void): void;
}
export function noindexNonDiscoveryPathsFastify(
  app: FastifyAppLike,
  options: NoindexNonDiscoveryOptions | undefined,
  done: () => void,
): void {
  const customSet = options?.customPaths ? new Set(options.customPaths) : undefined;
  const robotsTag = options?.robotsTag ?? DEFAULT_ROBOTS_TAG;
  app.addHook('onRequest', (req, reply, hookDone) => {
    const path = (req.url ?? req.routerPath ?? '').split('?')[0];
    if (shouldNoindex(path, customSet, options?.replacePaths)) {
      reply.header('X-Robots-Tag', robotsTag);
    }
    hookDone();
  });
  done();
}

/** Web Fetch / Cloudflare Workers / Deno / Bun helper. Returns a wrapped
 *  Response that carries `X-Robots-Tag` on non-discovery paths. Pair with the
 *  request's URL pathname:
 *
 *    return wrapNoindexResponse(new URL(req.url).pathname, response);
 */
export function wrapNoindexResponse(
  path: string,
  response: Response,
  options?: NoindexNonDiscoveryOptions,
): Response {
  const customSet = options?.customPaths ? new Set(options.customPaths) : undefined;
  const robotsTag = options?.robotsTag ?? DEFAULT_ROBOTS_TAG;
  if (!shouldNoindex(path, customSet, options?.replacePaths)) return response;
  const headers = new Headers(response.headers);
  headers.set('X-Robots-Tag', robotsTag);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Next.js Route Handler helper. Call inline before returning the Response:
 *
 *    export async function POST(req: Request) {
 *      const path = new URL(req.url).pathname;
 *      const res = Response.json({...});
 *      return applyNoindexHeader(res, path);
 *    }
 *
 *  Same wrapper shape as the Web Fetch helper — exported separately for clarity
 *  in Next.js docs/examples. */
export const applyNoindexHeader = wrapNoindexResponse;
