import { createMppxStripe } from '../stripe-multichain/mppx_stripe';
import { USDC } from './usdc';

export type SolanaMppNetwork = 'mainnet-beta' | 'devnet' | 'localnet';

interface CreateMppxServerRails {
    /** One-shot Tempo USDC charge (intent: 'charge'). */
    tempo?: {
      recipient: string;
      /** Custom currency token. Default: USDC on Tempo. */
      currency?: string;
      /** Use Tempo testnet (Moderato). Default false. */
      testnet?: boolean;
    };
    /**
     * Solana SPL charge (intent: 'charge'). Bakes createAssociatedTokenIdempotent
     * into the buyer's tx so payments work against any payTo, fresh or warmed.
     *
     * Requires `@solana/mpp` + `@solana/kit` peer deps.
     * Underlying spec: paymentauth.org/draft-solana-charge-00.
     */
    solana?: {
      /** Base58-encoded Solana recipient public key. */
      recipient: string;
      /** SPL token mint (base58). Default: USDC for the selected network. */
      currency?: string;
      /** Token decimals. Default 6 (USDC). */
      decimals?: number;
      /** Solana network. Default 'mainnet-beta'. */
      network?: SolanaMppNetwork;
      /** Custom RPC URL. Default: public RPC for the network. */
      rpcUrl?: string;
      /**
       * Optional fee-payer signer for server-side fee sponsorship. When provided,
       * the server's pubkey is advertised as `feePayerKey` in the 402 challenge and
       * the server co-signs settle txs as fee payer (so buyers don't need SOL, and
       * ATA-creation rent is server-funded). Construct via
       * `@solana/kit`'s `createKeyPairSignerFromBytes` or equivalent.
       *
       * Typed as `unknown` to avoid a hard dep on @solana/kit at this layer; pass any
       * `TransactionPartialSigner` from `@solana/kit`.
       */
      signer?: unknown;
      /** SPL token program hint (TOKEN_PROGRAM or TOKEN_2022_PROGRAM). Auto-detected when omitted. */
      tokenProgram?: string;
    };
    /**
     * Tempo session (intent: 'session') — pay-as-you-go channel for repeated calls or
     * SSE-streamed responses. Vendor brings their own ChannelStore (DB-backed implementation
     * tracking open channels + voucher state) and an `escrowContract` address.
     */
    tempo_session?: {
      recipient: string;
      currency?: string;
      testnet?: boolean;
      /**
       * On-chain escrow contract address that holds channel deposits and pays out
       * cumulative vouchers on settlement. Vendor-deployed.
       */
      escrowContract: string;
      /**
       * Channel store implementation tracking open channels + cumulative voucher state.
       * Pass an instance of mppx's `ChannelStore` interface (you can use the in-memory
       * default for dev or implement a Postgres/Redis-backed store for production).
       */
      store: unknown;
      /** Optional supported chains; defaults to mppx defaults. */
      chains?: unknown;
    };
  /** Stripe SPT (Shared Payment Token) — see also @agent-score/commerce/stripe-multichain. */
  stripe?: {
    profileId: string;
    secretKey: string;
    paymentMethodTypes?: string[];
  };
}

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

/**
 * One-call mppx server setup. Wires `tempo.charge(...)`, `tempo.session(...)`, and Stripe SPT
 * (via createMppxStripe) from symbolic rail config, replacing the boilerplate of constructing
 * each method by hand.
 *
 *   const mppx = await createMppxServer({
 *     rails: {
 *       tempo: { recipient: TEMPO_ADDR, testnet: false },             // intent: 'charge'
 *       tempo_session: {                                                // intent: 'session'
 *         recipient: TEMPO_ADDR,
 *         escrowContract: ESCROW_ADDR,
 *         store: myChannelStore,
 *       },
 *       stripe: { profileId: STRIPE_PROFILE_ID, secretKey: STRIPE_SECRET_KEY },
 *     },
 *     secretKey: MPP_SECRET_KEY,
 *   });
 *
 * `mppx` is an OPTIONAL peer dependency — install it only if you accept MPP rails.
 */
export async function createMppxServer({
  rails,
  methods: extraMethods,
  secretKey,
}: {
  /** Symbolic rail config — commerce wires the boilerplate (tempo.charge, mppStripe.charge, solana.charge, etc.). */
  rails?: CreateMppxServerRails;
  /** Advanced: pass mppx method instances directly (in addition to or instead of `rails`). */
  methods?: unknown[];
  /** MPP secret key (merchant's). */
  secretKey: string;
}): Promise<unknown> {
  const mppx = await dynamicImport<MppxModule>('mppx/server');
  /* v8 ignore start -- peer-dep-absence guard; mppx is installed in the test env */
  if (!mppx?.Mppx?.create) {
    throw new Error('mppx not installed — `npm install mppx` to use createMppxServer.');
  }
  /* v8 ignore stop */

  const methods: unknown[] = [...(extraMethods ?? [])];

  if (rails?.tempo) {
    /* v8 ignore start -- peer-dep version-mismatch guard; current mppx ships tempo.charge */
    if (!mppx.tempo?.charge) {
      throw new Error('mppx.tempo.charge not available — check installed mppx version.');
    }
    /* v8 ignore stop */
    const t = rails.tempo;
    const defaultCurrency = t.testnet ? USDC.tempo.testnet.address : USDC.tempo.mainnet.address;
    methods.push(
      mppx.tempo.charge({
        currency: t.currency ?? defaultCurrency,
        recipient: t.recipient,
        testnet: t.testnet ?? false,
      }),
    );
  }

  if (rails?.tempo_session) {
    /* v8 ignore start -- peer-dep version-mismatch guard; current mppx ships tempo.session */
    if (!mppx.tempo?.session) {
      throw new Error(
        'mppx.tempo.session not available — your mppx version may not support sessions yet. Upgrade with `npm install mppx@latest`.',
      );
    }
    /* v8 ignore stop */
    const s = rails.tempo_session;
    const defaultCurrency = s.testnet ? USDC.tempo.testnet.address : USDC.tempo.mainnet.address;
    methods.push(
      mppx.tempo.session({
        currency: s.currency ?? defaultCurrency,
        recipient: s.recipient,
        escrowContract: s.escrowContract,
        store: s.store,
        testnet: s.testnet ?? false,
        ...(s.chains ? { chains: s.chains } : {}),
      }),
    );
  }

  if (rails?.solana) {
    const solanaMpp = await dynamicImport<SolanaMppModule>('@solana/mpp/server');
    if (!solanaMpp?.charge) {
      throw new Error(
        '@solana/mpp not installed — `npm install @solana/mpp @solana/kit` to use the solana rail.',
      );
    }
    const s = rails.solana;
    const network: SolanaMppNetwork = s.network ?? 'mainnet-beta';
    const defaultMint =
      network === 'mainnet-beta' ? USDC.solana.mainnet.mint : USDC.solana.devnet.mint;
    const defaultDecimals =
      network === 'mainnet-beta' ? USDC.solana.mainnet.decimals : USDC.solana.devnet.decimals;
    const baseMethod = solanaMpp.charge({
      recipient: s.recipient,
      currency: s.currency ?? defaultMint,
      decimals: s.decimals ?? defaultDecimals,
      network,
      ...(s.rpcUrl ? { rpcUrl: s.rpcUrl } : {}),
      ...(s.signer ? { signer: s.signer } : {}),
      ...(s.tokenProgram ? { tokenProgram: s.tokenProgram } : {}),
    }) as SolanaChargeMethod;
    const rpcUrl =
      s.rpcUrl ??
      (network === 'mainnet-beta'
        ? 'https://api.mainnet-beta.solana.com'
        : network === 'devnet'
          ? 'https://api.devnet.solana.com'
          : 'http://localhost:8899');
    methods.push(wrapSolanaChargeWithFinalizedBlockhash(baseMethod, rpcUrl));
  }

  if (rails?.stripe) {
    const stripeMethod = await createMppxStripe(rails.stripe);
    methods.push(stripeMethod);
  }

  return mppx.Mppx.create({ methods, secretKey });
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
