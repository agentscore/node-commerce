import { networks } from './networks';
import { registerX402SchemesV1V2 } from './x402';

export type X402SymbolicRail =
  | 'x402-base-mainnet'
  | 'x402-base-sepolia'
  | 'x402-base-mainnet-upto'
  | 'x402-base-sepolia-upto';

export type X402FacilitatorChoice = 'coinbase' | 'http' | unknown;

export interface CreateX402ServerOptions {
  /**
   * Facilitator selection:
   * - 'coinbase' → Coinbase CDP facilitator (requires `@coinbase/x402` installed)
   * - 'http' → HTTP-only public testnet facilitator
   * - any object → custom facilitator instance, used directly
   * - omitted → defaults to 'http'
   */
  facilitator?: X402FacilitatorChoice;
  /**
   * Symbolic rail names to register schemes for. Each gets v1+v2 dual-register applied.
   * Requires `@x402/evm` peer dep installed.
   */
  rails?: X402SymbolicRail[];
  /** Advanced: register custom {network, scheme} pairs (in addition to or instead of `rails`). */
  schemes?: { network: string; scheme: unknown }[];
  /** Register the Bazaar discovery extension. Requires `@x402/extensions` installed. */
  bazaar?: boolean;
  /** Initialize the server immediately (calls facilitator). Default true. */
  initialize?: boolean;
}

/**
 * Loose type for the x402 resource server. We name the methods commerce calls during
 * setup; everything else (settlePayment, buildPaymentRequirements, processPaymentRequest,
 * enrichExtensions, etc.) is callable via the index signature so vendor code can use the
 * full @x402/core surface without us having to mirror every method signature.
 */
export interface X402Server {
  register(network: string, scheme: unknown): void;
  registerV1?(network: string, scheme: unknown): void;
  registerExtension(ext: unknown): void;
  initialize(): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

interface X402CoreModule {
  x402ResourceServer: new (facilitator?: unknown) => X402Server;
  HTTPFacilitatorClient: new (facilitator?: unknown) => unknown;
}

interface SchemeModule {
  ExactEvmScheme?: new () => unknown;
  UptoEvmScheme?: new () => unknown;
}

interface CoinbaseModule {
  facilitator?: unknown;
}

interface BazaarModule {
  bazaarResourceServerExtension?: unknown;
}

/**
 * One-call x402 server setup. Resolves facilitator, constructs the server, registers
 * schemes per network with v1+v2 dual-register, optionally adds the Bazaar extension,
 * and initializes — replaces ~15 lines of boilerplate with a single config call.
 *
 * x402 packages are peer dependencies — vendors install only the schemes they use.
 * Throws a guiding error if a required peer is missing.
 *
 *   const server = await createX402Server({
 *     facilitator: 'coinbase',
 *     rails: ['x402-base-mainnet'],
 *     bazaar: true,
 *   });
 */
export async function createX402Server(opts: CreateX402ServerOptions = {}): Promise<X402Server> {
  const x402Core = (await dynamicImport<X402CoreModule>('@x402/core/server')) ?? null;
  /* v8 ignore start -- peer-dep-absence guard; @x402/core is installed in test env */
  if (!x402Core) {
    throw new Error(
      '@x402/core not installed — `npm install @x402/core` to use createX402Server.',
    );
  }
  /* v8 ignore stop */

  let facilitator: unknown;
  if (opts.facilitator === 'coinbase') {
    const cb = await dynamicImport<CoinbaseModule>('@coinbase/x402');
    /* v8 ignore start -- peer-dep-absence guard; @coinbase/x402 is installed in test env */
    if (!cb?.facilitator) {
      throw new Error(
        '@coinbase/x402 not installed — `npm install @coinbase/x402` for facilitator: "coinbase".',
      );
    }
    /* v8 ignore stop */
    facilitator = new x402Core.HTTPFacilitatorClient(cb.facilitator);
  } else if (opts.facilitator === undefined || opts.facilitator === 'http') {
    facilitator = new x402Core.HTTPFacilitatorClient();
  } else {
    facilitator = opts.facilitator;
  }

  const server = new x402Core.x402ResourceServer(facilitator);

  let evmExactModule: SchemeModule | null = null;
  let evmUptoModule: SchemeModule | null = null;
  for (const rail of opts.rails ?? []) {
    const isUpto = rail.endsWith('-upto');
    if (rail.startsWith('x402-base')) {
      const baseRail = isUpto ? rail.slice(0, -5) : rail;
      const network =
        baseRail === 'x402-base-mainnet' ? networks.base.mainnet.caip2 : networks.base.sepolia.caip2;
      if (isUpto) {
        evmUptoModule ??= await dynamicImport<SchemeModule>('@x402/evm/upto/server');
        /* v8 ignore start -- peer-dep-absence guard; @x402/evm is installed in test env */
        if (!evmUptoModule?.UptoEvmScheme) {
          throw new Error('@x402/evm not installed — `npm install @x402/evm` for x402 base upto rails.');
        }
        /* v8 ignore stop */
        registerX402SchemesV1V2(server, network, new evmUptoModule.UptoEvmScheme());
      } else {
        evmExactModule ??= await dynamicImport<SchemeModule>('@x402/evm/exact/server');
        /* v8 ignore start -- peer-dep-absence guard; @x402/evm is installed in test env */
        if (!evmExactModule?.ExactEvmScheme) {
          throw new Error('@x402/evm not installed — `npm install @x402/evm` for x402 base rails.');
        }
        /* v8 ignore stop */
        registerX402SchemesV1V2(server, network, new evmExactModule.ExactEvmScheme());
      }
    }
  }

  for (const { network, scheme } of opts.schemes ?? []) {
    registerX402SchemesV1V2(server, network, scheme);
  }

  if (opts.bazaar) {
    const bazaar = await dynamicImport<BazaarModule>('@x402/extensions/bazaar');
    /* v8 ignore start -- peer-dep-absence guard; @x402/extensions is installed in test env */
    if (!bazaar?.bazaarResourceServerExtension) {
      throw new Error(
        '@x402/extensions not installed — `npm install @x402/extensions` for bazaar discovery.',
      );
    }
    /* v8 ignore stop */
    server.registerExtension(bazaar.bazaarResourceServerExtension);
  }

  if (opts.initialize !== false) {
    await server.initialize();
  }
  return server;
}

async function dynamicImport<T>(moduleName: string): Promise<T | null> {
  try {
    return (await import(moduleName)) as T;
  } catch {
    return null;
  }
}
