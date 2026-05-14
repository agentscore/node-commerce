/**
 * Stripe PaymentIntent + deposit-address cache.
 *
 * Stripe-multichain merchants need three lookups during a request lifecycle:
 *
 *   1. **Is this on-chain `pay_to` address one we minted?** — when an MPP credential
 *      arrives with a `recipient`, verify it matches a recently-minted Stripe deposit
 *      address. Validates the credential's deposit address against the addresses the
 *      merchant has actually minted.
 *
 *   2. **Which PaymentIntent owns this deposit address?** — when settling, the
 *      `simulate_crypto_deposit` test_helpers call needs the PaymentIntent id for the
 *      deposit address that was paid to.
 *
 *   3. **Which sibling deposit addresses belong to the same PaymentIntent?** — when
 *      enriching a 402 with x402 entries, the merchant needs the Base + Solana addresses
 *      Stripe minted alongside the original Tempo address (one PI carries up to three).
 *
 * All three are TTL-bounded (default 300s — long enough for an agent to retry, short
 * enough to bound memory). Backed by Redis when `redisUrl` is set, falls back to
 * in-process Map otherwise. Single-instance servers can use the in-memory cache;
 * multi-instance deployments need a shared cache (Redis) so a deposit lands on
 * whichever instance settles it.
 */

// ioredis is an optional peer dep — typed structurally to avoid pulling its types into
// the build for merchants that run in-process without Redis. The structural type covers
// only the methods we call (set with EX/get/on); merchants using Redis install ioredis
// themselves.
interface RedisLike {
  set: (key: string, value: string, mode: 'EX', ttl: number) => Promise<unknown>;
  get: (key: string) => Promise<string | null>;
  on: (event: 'error', cb: (err: Error) => void) => unknown;
}


export interface PiCache {
  /** Mark an on-chain address as one this merchant minted. Idempotent + TTL-bounded. */
  cacheAddress(address: string): Promise<void>;
  /** Return true when the address was minted by this merchant within TTL. */
  hasAddress(address: string): Promise<boolean>;
  /** Associate an on-chain deposit address with the Stripe PaymentIntent that minted it. */
  cachePaymentIntent(depositAddress: string, paymentIntentId: string): void;
  /** Get the Stripe PaymentIntent id for a previously-minted deposit address, or undefined. */
  getPaymentIntentId(depositAddress: string): string | undefined;
  /** Associate a PaymentIntent id with the full set of sibling deposit addresses (one per network). */
  cacheNetworkAddresses(paymentIntentId: string, addresses: Record<string, string>): void;
  /** Look up the deposit address Stripe minted on a specific network for a given PaymentIntent. */
  getNetworkDepositAddress(paymentIntentId: string, network: string): string | undefined;
  /** Stop the background TTL-eviction loop. Call from server shutdown handlers. */
  stop(): void;
}

interface Entry<T> { value: T; expiresAt: number }

export function createPiCache({
  redisUrl,
  ttlSeconds = 300,
  keyPrefix = 'payto:',
}: {
  /** Redis connection URL (e.g. `rediss://…cache.amazonaws.com:6379`). When omitted,
   *  the cache falls back to in-process Maps with the same API. */
  redisUrl?: string;
  /** TTL for cached entries in seconds. Default 300. */
  ttlSeconds?: number;
  /** Prefix for Redis keys. Default `'payto:'`. */
  keyPrefix?: string;
} = {}): PiCache {

  let redis: RedisLike | null = null;
  const addrMemCache = new Map<string, number>();
  const piCache = new Map<string, Entry<string>>();
  const networkAddressCache = new Map<string, Entry<Record<string, string>>>();

  const evict = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of piCache) { if (v.expiresAt < now) piCache.delete(k); }
    for (const [k, v] of networkAddressCache) { if (v.expiresAt < now) networkAddressCache.delete(k); }
    for (const [k, expires] of addrMemCache) { if (expires < now) addrMemCache.delete(k); }
  }, 60_000);
  // Don't keep the event loop alive on test shutdown / one-shot scripts.
  if (typeof evict.unref === 'function') evict.unref();

  async function getRedis(): Promise<RedisLike | null> {
    if (!redisUrl) return null;
    if (redis) return redis;
    // Dynamic import keeps ioredis as an optional peer dep — merchants without
    // Redis don't pay the install cost.
    const mod = await import('ioredis' as string).catch(() => null) as
      | { default: new (url: string, opts: unknown) => RedisLike }
      | null;
    if (!mod) {
      console.error('[pi-cache] redisUrl set but `ioredis` is not installed. Run `npm install ioredis` or unset redisUrl.');
      return null;
    }
    redis = new mod.default(redisUrl, {
      connectTimeout: 5000,
      maxRetriesPerRequest: 1,
      tls: redisUrl.startsWith('rediss://') ? {} : undefined,
    });
    redis.on('error', (err: Error) => console.error('[pi-cache] Redis error:', err.message));
    return redis;
  }

  return {
    async cacheAddress(address) {
      const r = await getRedis();
      if (r) await r.set(`${keyPrefix}${address}`, '1', 'EX', ttlSeconds).catch(() => {});
      addrMemCache.set(address, Date.now() + ttlSeconds * 1000);
    },
    async hasAddress(address) {
      const r = await getRedis();
      if (r) {
        const val = await r.get(`${keyPrefix}${address}`).catch(() => null);
        if (val) return true;
      }
      const expiry = addrMemCache.get(address);
      return !!expiry && expiry > Date.now();
    },
    cachePaymentIntent(depositAddress, paymentIntentId) {
      piCache.set(depositAddress, { value: paymentIntentId, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    getPaymentIntentId(depositAddress) {
      const entry = piCache.get(depositAddress);
      if (!entry) return undefined;
      if (entry.expiresAt < Date.now()) { piCache.delete(depositAddress); return undefined; }
      return entry.value;
    },
    cacheNetworkAddresses(paymentIntentId, addresses) {
      networkAddressCache.set(paymentIntentId, { value: addresses, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    getNetworkDepositAddress(paymentIntentId, network) {
      const entry = networkAddressCache.get(paymentIntentId);
      if (!entry) return undefined;
      if (entry.expiresAt < Date.now()) { networkAddressCache.delete(paymentIntentId); return undefined; }
      return entry.value[network];
    },
    stop() {
      clearInterval(evict);
    },
  };
}
