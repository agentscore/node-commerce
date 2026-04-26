/**
 * Generic x402 server interface. Different versions of @x402/core may expose different
 * shapes; we only require register() and (optionally) registerV1().
 */
export interface X402ServerLike {
  register(network: string, scheme: unknown): void;
  registerV1?(network: string, scheme: unknown): void;
}

/**
 * Registers an x402 scheme on both v1 and v2 of the protocol.
 *
 * Why: the @x402/core HTTP parser hardcodes `x402Version === 1`, while the client's
 * `.register()` defaults to v2. Without registering on both versions, a merchant
 * emitting a v1 response gets "No client registered for x402 version: 1" even
 * though the scheme handler is identical between versions. Every merchant trips
 * on this; the helper hides the workaround.
 */
export function registerX402SchemesV1V2(
  server: X402ServerLike,
  network: string,
  scheme: unknown,
): void {
  server.register(network, scheme);
  if (typeof server.registerV1 === 'function') {
    server.registerV1(network, scheme);
  }
}
