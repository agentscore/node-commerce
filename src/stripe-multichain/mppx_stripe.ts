/**
 * Wraps the `mppStripe.charge(...)` boilerplate from `mppx/server`. Returns the value
 * vendors pass into `Mppx.create({ methods: [...] })`. mppx is an OPTIONAL peer dependency —
 * vendors who don't use Stripe SPT don't need to install it.
 *
 * Example:
 *
 *   import { Mppx, tempo } from 'mppx/server';
 *   import { createMppxStripe } from '@agent-score/commerce/stripe-multichain';
 *
 *   const stripeMethod = await createMppxStripe({
 *     profileId: process.env.STRIPE_PROFILE_ID!,
 *     secretKey: process.env.STRIPE_SECRET_KEY!,
 *   });
 *
 *   const mppx = Mppx.create({
 *     methods: [tempo.charge({...}), stripeMethod],
 *     secretKey: process.env.MPP_SECRET_KEY!,
 *   });
 *
 * Throws if mppx is not installed.
 */
export async function createMppxStripe({
  profileId,
  secretKey,
  paymentMethodTypes,
}: {
  /** Stripe profile_id / network_id (the value advertised in your `stripe/charge` accepted_methods entry). */
  profileId: string;
  /** Stripe secret key — mppx uses it to validate inbound SharedPaymentTokens. */
  secretKey: string;
  /** Payment method types this stripe rail accepts. Default ['card', 'link']. */
  paymentMethodTypes?: string[];
}): Promise<unknown> {
  const moduleName = 'mppx/server';
  const mppx = (await import(moduleName).catch(() => null)) as {
    stripe?: {
      charge: (config: {
        networkId: string;
        paymentMethodTypes?: string[];
        secretKey: string;
      }) => unknown;
    };
  } | null;
  /* v8 ignore start -- peer-dep-absence guard; mppx is installed in the test env so this branch can't be exercised without mocking the dynamic import */
  if (!mppx?.stripe?.charge) {
    throw new Error(
      'mppx not installed — install with `npm install mppx` to use createMppxStripe.',
    );
  }
  /* v8 ignore stop */
  return mppx.stripe.charge({
    networkId: profileId,
    paymentMethodTypes: paymentMethodTypes ?? ['card', 'link'],
    secretKey,
  });
}
