import { AsyncLocalStorage } from 'node:async_hooks';
import { createMppxStripe } from '../stripe-multichain/mppx_stripe';
import { networks } from './networks';
import {
  resolveRecipient,
  type SolanaMppRailSpec,
  type StripeRailSpec,
  type TempoRailSpec,
  type TempoSessionRailSpec,
} from './rail_spec';
import { USDC } from './usdc';

export type MppxRailSpec =
  | TempoRailSpec
  | SolanaMppRailSpec
  | TempoSessionRailSpec
  | StripeRailSpec;

type SolanaMppNetwork = 'mainnet-beta' | 'devnet' | 'localnet';

interface MppxModule {
  Mppx?: { create: (opts: { methods: unknown[]; secretKey: string }) => unknown };
  tempo?: {
    charge: (opts: { currency: string; recipient: string; testnet?: boolean }) => unknown;
    session?: (opts: {
      currency: string;
      recipient: string;
      escrowContract: string;
      store: unknown;
      testnet?: boolean;
      chains?: unknown;
    }) => unknown;
  };
}

interface SolanaMppModule {
  charge?: (opts: {
    recipient: string;
    currency?: string;
    decimals?: number;
    network?: string;
    rpcUrl?: string;
    signer?: unknown;
    tokenProgram?: string;
  }) => unknown;
}

function isStripeRailSpec(s: MppxRailSpec): s is StripeRailSpec {
  return !('recipient' in s);
}

function isTempoSessionRailSpec(s: MppxRailSpec): s is TempoSessionRailSpec {
  return 'escrowContract' in s && 'store' in s;
}

function isSolanaMppRailSpec(s: MppxRailSpec): s is SolanaMppRailSpec {
  if (!('recipient' in s)) return false;
  if ('escrowContract' in s) return false;
  if ('rpcUrl' in s || 'tokenProgram' in s) return true;
  return (s as { network?: string }).network?.startsWith('solana:') ?? false;
}

/** Resolve a Solana network identifier to the `@solana/mpp` form. Accepts both
 *  CAIP-2 (`'solana:5eykt4UsFv8…'` / `'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'`)
 *  AND the raw `@solana/mpp` strings (`'mainnet-beta'` / `'devnet'` / `'localnet'`)
 *  so merchants can pass either form. Falls back to `'mainnet-beta'` for unknown
 *  values to preserve the prior default. */
function solanaNetworkFromCAIP2(caip2: string | undefined): SolanaMppNetwork {
  if (caip2 === 'devnet' || caip2 === networks.solana.devnet.caip2) return 'devnet';
  if (caip2 === 'localnet') return 'localnet';
  return 'mainnet-beta';
}

function solanaDefaultRpcUrl(network: SolanaMppNetwork): string {
  if (network === 'mainnet-beta') return 'https://api.mainnet-beta.solana.com';
  if (network === 'devnet') return 'https://api.devnet.solana.com';
  return 'http://localhost:8899';
}

/**
 * One-call mppx server setup. Wires `tempo.charge(...)`, `tempo.session(...)`,
 * `@solana/mpp.charge(...)`, and Stripe SPT (via createMppxStripe) from canonical
 * `*RailSpec` configs, replacing the boilerplate of constructing each method by
 * hand.
 *
 *   const mppx = await createMppxServer({
 *     rails: {
 *       tempo: { recipient: TEMPO_ADDR } satisfies TempoRailSpec,
 *       solana: { recipient: SOL_ADDR } satisfies SolanaMppRailSpec,
 *       stripe: { profileId: STRIPE_PROFILE_ID, secretKey: STRIPE_SECRET_KEY } satisfies StripeRailSpec,
 *     },
 *     secretKey: MPP_SECRET_KEY,
 *   });
 *
 * Keys are rail names (`tempo` / `solana` / `tempo_session` / `stripe`); values
 * are the matching `*RailSpec` types every other helper also consumes.
 *
 * `mppx` is an OPTIONAL peer dependency — install it only if you accept MPP rails.
 */
export async function createMppxServer({
  rails,
  methods: extraMethods,
  secretKey,
}: {
  rails?: Record<string, MppxRailSpec>;
  methods?: unknown[];
  secretKey: string;
}): Promise<unknown> {
  const mppx = await dynamicImport<MppxModule>('mppx/server');
  /* v8 ignore start -- peer-dep-absence guard; mppx is installed in the test env */
  if (!mppx?.Mppx?.create) {
    throw new Error('mppx not installed — `npm install mppx` to use createMppxServer.');
  }
  /* v8 ignore stop */

  const methods: unknown[] = [...(extraMethods ?? [])];

  for (const [name, spec] of Object.entries(rails ?? {})) {
    if (isStripeRailSpec(spec)) {
      methods.push(await registerStripe(spec));
      continue;
    }
    if (isTempoSessionRailSpec(spec)) {
      methods.push(await registerTempoSession(mppx, spec));
      continue;
    }
    if (isSolanaMppRailSpec(spec)) {
      methods.push(await registerSolana(spec));
      continue;
    }
    // Default: TempoRailSpec (bare `{recipient, ...}` with no Solana / session markers).
    methods.push(registerTempo(mppx, spec as TempoRailSpec, name));
  }

  return mppx.Mppx.create({ methods, secretKey });
}

function registerTempo(mppx: MppxModule, spec: TempoRailSpec, _name: string): unknown {
  /* v8 ignore start -- peer-dep version-mismatch guard; current mppx ships tempo.charge */
  if (!mppx.tempo?.charge) {
    throw new Error('mppx.tempo.charge not available — check installed mppx version.');
  }
  /* v8 ignore stop */
  const defaultCurrency = spec.testnet ? USDC.tempo.testnet.address : USDC.tempo.mainnet.address;
  if (typeof spec.recipient !== 'string') {
    throw new TypeError(
      'createMppxServer: TempoRailSpec requires a string recipient (per-order factories not supported here).',
    );
  }
  return mppx.tempo.charge({
    currency: spec.token ?? defaultCurrency,
    recipient: spec.recipient,
    testnet: spec.testnet ?? false,
  });
}

async function registerTempoSession(mppx: MppxModule, spec: TempoSessionRailSpec): Promise<unknown> {
  /* v8 ignore start -- peer-dep version-mismatch guard; current mppx ships tempo.session */
  if (!mppx.tempo?.session) {
    throw new Error(
      'mppx.tempo.session not available — your mppx version may not support sessions yet. Upgrade with `npm install mppx@latest`.',
    );
  }
  /* v8 ignore stop */
  const defaultCurrency = spec.testnet ? USDC.tempo.testnet.address : USDC.tempo.mainnet.address;
  return mppx.tempo.session({
    currency: spec.currency ?? defaultCurrency,
    recipient: await resolveRecipient(spec.recipient),
    escrowContract: spec.escrowContract,
    store: spec.store,
    testnet: spec.testnet ?? false,
    ...(spec.chains ? { chains: spec.chains } : {}),
  });
}

async function registerSolana(spec: SolanaMppRailSpec): Promise<unknown> {
  const solanaMpp = await dynamicImport<SolanaMppModule>('@solana/mpp/server');
  if (!solanaMpp?.charge) {
    throw new Error(
      '@solana/mpp not installed — `npm install @solana/mpp @solana/kit` to use the solana rail.',
    );
  }
  const network = solanaNetworkFromCAIP2(spec.network);
  const defaultMint =
    network === 'mainnet-beta' ? USDC.solana.mainnet.mint : USDC.solana.devnet.mint;
  const defaultDecimals =
    network === 'mainnet-beta' ? USDC.solana.mainnet.decimals : USDC.solana.devnet.decimals;
  if (typeof spec.recipient !== 'string') {
    throw new TypeError(
      'createMppxServer: SolanaMppRailSpec requires a string recipient (per-order factories not supported here).',
    );
  }
  const baseMethod = solanaMpp.charge({
    recipient: spec.recipient,
    currency: spec.token ?? defaultMint,
    decimals: spec.decimals ?? defaultDecimals,
    network,
    ...(spec.rpcUrl ? { rpcUrl: spec.rpcUrl } : {}),
    ...(spec.signer ? { signer: spec.signer } : {}),
    ...(spec.tokenProgram ? { tokenProgram: spec.tokenProgram } : {}),
  }) as SolanaChargeMethod;
  return wrapSolanaChargeWithFinalizedBlockhash(baseMethod, spec.rpcUrl ?? solanaDefaultRpcUrl(network));
}

async function registerStripe(spec: StripeRailSpec): Promise<unknown> {
  if (!spec.profileId || !spec.secretKey) {
    throw new Error(
      'createMppxServer: StripeRailSpec requires both profileId and secretKey.',
    );
  }
  return createMppxStripe({
    profileId: spec.profileId,
    secretKey: spec.secretKey,
    paymentMethodTypes: spec.paymentMethodTypes,
  });
}

async function dynamicImport<T>(moduleName: string): Promise<T | null> {
  try {
    return (await import(moduleName)) as T;
  } catch {
    return null;
  }
}

type SolanaChargeRequestArgs = { credential?: unknown; request?: unknown };
type SolanaChargeMethod = {
  request?: (args: SolanaChargeRequestArgs) => Promise<unknown>;
} & Record<string, unknown>;

/**
 * Wraps `@solana/mpp.charge()`'s Method so the issued challenge carries a
 * `finalized` blockhash instead of `confirmed`.
 *
 * `@solana/mpp` <= 0.5.2 fetches `getLatestBlockhash` with `commitment: 'confirmed'`
 * but its broadcast `sendTransaction` sets `skipPreflight: false` without an
 * overridden `preflightCommitment`. The RPC server's default preflight commitment
 * is `finalized`, which rejects any blockhash that hasn't yet finalized with a
 * "Blockhash not found" error. Handing the client a `finalized` blockhash up
 * front sidesteps the mismatch.
 *
 * Trade-off: the signing window shrinks from ~58s (confirmed) to ~46s (finalized).
 * Fine for agent-driven flows; manual signing flows still have plenty of margin.
 */
export function wrapSolanaChargeWithFinalizedBlockhash(
  baseMethod: SolanaChargeMethod,
  rpcUrl: string,
): SolanaChargeMethod {
  return {
    ...baseMethod,
    async request(args: SolanaChargeRequestArgs) {
      const orig = (await baseMethod.request!(args)) as
        | { methodDetails?: Record<string, unknown> }
        | undefined;
      if (args.credential || !orig || typeof orig !== 'object') return orig;
      try {
        const res = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: 1,
            jsonrpc: '2.0',
            method: 'getLatestBlockhash',
            params: [{ commitment: 'finalized' }],
          }),
        });
        const data = (await res.json()) as { result?: { value?: { blockhash?: string } } };
        const finalized = data?.result?.value?.blockhash;
        if (finalized) {
          return {
            ...orig,
            methodDetails: { ...(orig.methodDetails ?? {}), recentBlockhash: finalized },
          };
        }
      } catch {
        /* fall back to upstream's confirmed blockhash */
      }
      return orig;
    },
  };
}

/**
 * Result shape of `composeMppxRequest`. mppx's `mppx.compose(...)(request)`
 * resolves to one of two variants — type-narrowed here so consumers can
 * `if (result.status === 200) { result.withReceipt(...) }` without an
 * `as any` cast.
 */
export type MppxComposeResult =
  | {
      status: 200;
      /** Wraps a Response with the `Payment-Receipt` header attached. */
      withReceipt: (response: Response) => Response;
      [k: string]: unknown;
    }
  | {
      status: 402;
      /** The 402 challenge Response mppx emitted (carries WWW-Authenticate). */
      challenge: Response;
      [k: string]: unknown;
    };

/**
 * Run `mppx.compose(...intents)(request)` with a typed return. Replaces the
 * `(mppx as any).compose(...intents)(request)` cast every hand-rolled
 * `composeMppx` hook ends up writing.
 *
 * @example
 * ```ts
 * const result = await composeMppxRequest(mppx, [
 *   ['tempo/charge', { amount, currency, decimals, recipient }],
 *   ['stripe/charge', { amount, currency: 'usd', decimals: 2 }],
 * ], ctx.request.raw);
 * if (result.status === 402) return { status: 402, headers: mppxChallengeHeaders(result) };
 * return { status: 200, raw: result };
 * ```
 */
/** Capture the inner verification error that mppx swallows on failed verify().
 *
 *  mppx's outer catch (`Mppx.js`) replaces non-`PaymentError` exceptions
 *  (e.g., raw viem `RpcRequestError` from a Tempo `eth_sendRawTransactionSync`
 *  rejection) with a bare `new VerificationFailedError()` before emitting
 *  `payment.failed`, so the original message never reaches the response or
 *  the event payload. The only place it survives is `console.error('mppx:
 *  internal verification error', e)` which mppx calls BEFORE the wrap.
 *
 *  We hook `console.error` once at module load, route captured messages
 *  into the current async context, and let `runWithMppxFailureCapture()`
 *  create the context. Concurrent requests get their own contexts via
 *  AsyncLocalStorage so they don't cross-pollute. The hook is a no-op
 *  outside an active context, so it doesn't affect other callers of
 *  `console.error`.
 */
interface MppxCaptureCtx {
  reason: string | null;
}
const mppxCapture = new AsyncLocalStorage<MppxCaptureCtx>();
let consoleErrorPatched = false;
function ensureConsoleErrorPatch() {
  if (consoleErrorPatched) return;
  consoleErrorPatched = true;
  const original = console.error.bind(console);
  console.error = function captureMppxInternal(...args: unknown[]) {
    if (args[0] === 'mppx: internal verification error' && args[1] !== undefined) {
      const ctx = mppxCapture.getStore();
      if (ctx) {
        const e = args[1] as { shortMessage?: unknown; message?: unknown; details?: unknown };
        const reason =
          typeof e?.shortMessage === 'string'
            ? e.shortMessage
            : typeof e?.message === 'string'
              ? e.message
              : String(args[1]);
        const details = e?.details;
        ctx.reason =
          typeof details === 'string' && details.length > 0 ? `${reason} (${details})` : reason;
      }
    }
    return original(...args);
  };
}

/** Run `fn` inside an async context that captures the inner mppx
 *  verification error (when one fires). Returns the function's result
 *  plus the captured `failureReason` string (null if no error fired or
 *  no console.error hit during this scope). Used by `Checkout.handleMppx`
 *  to surface typed error codes (`tempo_key_not_registered`, etc.) on
 *  the 402 path without changing the per-merchant `composeMppx` API.
 */
export async function runWithMppxFailureCapture<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; failureReason: string | null }> {
  ensureConsoleErrorPatch();
  const ctx: MppxCaptureCtx = { reason: null };
  const result = await mppxCapture.run(ctx, fn);
  return { result, failureReason: ctx.reason };
}

export async function composeMppxRequest(
  mppx: unknown,
  intents: readonly unknown[],
  request: Request,
): Promise<MppxComposeResult> {
  if (!mppx || typeof mppx !== 'object' || !('compose' in mppx)) {
    throw new Error('composeMppxRequest: argument is not an mppx server instance');
  }
  const compose = (mppx as { compose: unknown }).compose;
  if (typeof compose !== 'function') {
    throw new Error('composeMppxRequest: mppx.compose is not a function');
  }
  ensureConsoleErrorPatch();
  const typedCompose = compose as (
    ...intents: readonly unknown[]
  ) => (req: Request) => Promise<MppxComposeResult>;
  const handler = typedCompose.apply(mppx, [...intents]);
  return handler(request);
}

/**
 * Extract the 402 challenge response's headers as a plain `Record<string, string>`,
 * the shape `MppxComposeOutcome.headers` accepts. Wraps the one-liner every
 * hand-rolled compose hook writes.
 */
export function mppxChallengeHeaders(result: { challenge: Response }): Record<string, string> {
  return Object.fromEntries(result.challenge.headers);
}
