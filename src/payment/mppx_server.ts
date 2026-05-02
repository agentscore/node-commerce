import { createMppxStripe } from '../stripe-multichain/mppx_stripe';
import { USDC } from './usdc';

export interface CreateMppxServerOptions {
  /** Symbolic rail config — commerce wires the boilerplate (tempo.charge, mppStripe.charge, etc.). */
  rails?: {
    /** One-shot Tempo USDC charge (intent: 'charge'). */
    tempo?: {
      recipient: string;
      /** Custom currency token. Default: USDC on Tempo. */
      currency?: string;
      /** Use Tempo testnet (Moderato). Default false. */
      testnet?: boolean;
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
  };
  /** Advanced: pass mppx method instances directly (in addition to or instead of `rails`). */
  methods?: unknown[];
  /** MPP secret key (merchant's). */
  secretKey: string;
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
export async function createMppxServer(opts: CreateMppxServerOptions): Promise<unknown> {
  const mppx = await dynamicImport<MppxModule>('mppx/server');
  /* v8 ignore start -- peer-dep-absence guard; mppx is installed in the test env */
  if (!mppx?.Mppx?.create) {
    throw new Error('mppx not installed — `npm install mppx` to use createMppxServer.');
  }
  /* v8 ignore stop */

  const methods: unknown[] = [...(opts.methods ?? [])];

  if (opts.rails?.tempo) {
    /* v8 ignore start -- peer-dep version-mismatch guard; current mppx ships tempo.charge */
    if (!mppx.tempo?.charge) {
      throw new Error('mppx.tempo.charge not available — check installed mppx version.');
    }
    /* v8 ignore stop */
    const t = opts.rails.tempo;
    const defaultCurrency = t.testnet ? USDC.tempo.testnet.address : USDC.tempo.mainnet.address;
    methods.push(
      mppx.tempo.charge({
        currency: t.currency ?? defaultCurrency,
        recipient: t.recipient,
        testnet: t.testnet ?? false,
      }),
    );
  }

  if (opts.rails?.tempo_session) {
    /* v8 ignore start -- peer-dep version-mismatch guard; current mppx ships tempo.session */
    if (!mppx.tempo?.session) {
      throw new Error(
        'mppx.tempo.session not available — your mppx version may not support sessions yet. Upgrade with `npm install mppx@latest`.',
      );
    }
    /* v8 ignore stop */
    const s = opts.rails.tempo_session;
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

  if (opts.rails?.stripe) {
    const stripeMethod = await createMppxStripe(opts.rails.stripe);
    methods.push(stripeMethod);
  }

  return mppx.Mppx.create({ methods, secretKey: opts.secretKey });
}

async function dynamicImport<T>(moduleName: string): Promise<T | null> {
  try {
    return (await import(moduleName)) as T;
  } catch {
    return null;
  }
}
