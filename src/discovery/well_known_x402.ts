/**
 * `buildWellKnownX402`: emits the x402scan v1 `/.well-known/x402` discovery shape.
 *
 * x402scan accepts three discovery strategies (OpenAPI > `/.well-known/x402` > endpoint
 * probe). Most AgentScore merchants already publish a richer `/.well-known/mpp.json`,
 * but x402scan's strict parser only reads the v1 shape, so we emit both. The two
 * coexist on different paths.
 *
 * Spec (verbatim, x402scan):
 *
 *   {
 *     "version": 1,
 *     "resources": ["POST /api/route", ...]
 *   }
 *
 * Resource entries are `"METHOD /path"` strings, not objects. Runtime 402 behavior
 * is authoritative over this static metadata.
 */

export interface WellKnownX402Resource {
  /** HTTP method, uppercase: `'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'`. */
  method: string;
  /** Path, leading slash: `'/purchase'`. */
  path: string;
}

export interface BuildWellKnownX402Input {
  /** Invocable, payment-required routes. Each entry becomes `"METHOD /path"`. */
  resources: WellKnownX402Resource[];
}

export interface WellKnownX402Document {
  version: 1;
  resources: string[];
}

export function buildWellKnownX402(input: BuildWellKnownX402Input): WellKnownX402Document {
  return {
    version: 1,
    resources: input.resources.map((r) => `${r.method.toUpperCase()} ${r.path}`),
  };
}
