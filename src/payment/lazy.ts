/**
 * Lazy-init helpers for x402 + mppx servers.
 *
 * Every merchant accepting these rails writes the same singleton-with-lock
 * pattern around `createX402Server` / `createMppxServer`. These helpers collapse
 * the boilerplate to a single call; the returned getter is safe to call from
 * any number of concurrent handlers; only one server instance is ever
 * constructed per merchant.
 *
 * The x402 helper also derives the facilitator choice (`coinbase` vs `http`)
 * from optional CDP credentials so merchants don't repeat the boot-time
 * conditional.
 */
import { createMppxServer, type MppxRailSpec } from './mppx_server';
import { createX402Server, type X402Server, type X402SymbolicRail } from './x402_server';
import type { X402BaseRailSpec } from './rail_spec';

function x402RailName(spec: X402BaseRailSpec): X402SymbolicRail {
  const network = spec.network ?? 'eip155:8453';
  if (network === 'eip155:8453') return 'x402-base-mainnet';
  if (network === 'eip155:84532') return 'x402-base-sepolia';
  throw new Error(
    `lazyX402Server: unsupported X402BaseRailSpec.network=${JSON.stringify(network)}`,
  );
}

/**
 * Build a memoized async getter for an x402 server.
 *
 * First call constructs the server; subsequent calls return the cached
 * instance. Concurrent first-callers serialize on a Promise lock so we never
 * construct two and discard one.
 *
 * When both CDP creds are passed, the server uses Coinbase's facilitator;
 * otherwise it falls back to the public HTTP facilitator. Merchants who only
 * have one of the two creds get the HTTP fallback.
 */
export function lazyX402Server(opts: {
  spec: X402BaseRailSpec;
  cdpApiKeyId?: string;
  cdpApiKeySecret?: string;
}): () => Promise<X402Server> {
  const { spec, cdpApiKeyId, cdpApiKeySecret } = opts;
  const railName = x402RailName(spec);
  const useCdp = Boolean(cdpApiKeyId && cdpApiKeySecret);
  const facilitator: 'coinbase' | 'http' = useCdp ? 'coinbase' : 'http';

  let cached: X402Server | undefined;
  let pending: Promise<X402Server> | undefined;

  return async (): Promise<X402Server> => {
    if (cached !== undefined) return cached;
    if (pending !== undefined) return pending;
    pending = (async () => {
      const server = await createX402Server({ facilitator, rails: [railName] });
      cached = server;
      pending = undefined;
      return server;
    })();
    return pending;
  };
}

/**
 * Build a memoized async getter for an mppx server.
 *
 * Same singleton + lock semantics as {@link lazyX402Server}. Forwards `rails`
 * + `secretKey` unchanged to {@link createMppxServer}.
 */
export function lazyMppxServer(opts: {
  rails: Record<string, MppxRailSpec>;
  secretKey: string;
}): () => Promise<unknown> {
  const { rails, secretKey } = opts;
  let cached: unknown;
  let pending: Promise<unknown> | undefined;

  return async (): Promise<unknown> => {
    if (cached !== undefined) return cached;
    if (pending !== undefined) return pending;
    pending = (async () => {
      const server = await createMppxServer({ secretKey, rails });
      cached = server;
      pending = undefined;
      return server;
    })();
    return pending;
  };
}
