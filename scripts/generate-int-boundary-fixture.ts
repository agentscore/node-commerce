/**
 * One-shot generator for the int-boundary cross-lang fixture (Node side).
 *
 * Writes `tests/fixtures/cross-lang/node-int-boundary.json`. The fixture
 * exercises the safe-integer boundary that BOTH languages must round-trip
 * identically: `Number.MAX_SAFE_INTEGER` (2^53 - 1), its negative, zero, and
 * small ints. Lossy values (>2^53) are NOT in the fixture (they're rejected
 * at sign time); they're unit-tested in each language's signing path.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildUCPProfile, type UCPSigningKey } from '../src/identity/ucp';
import {
  buildJWKSResponse,
  generateUCPSigningKey,
  signUCPProfile,
} from '../src/identity/ucp-jwks';

const OUT = join(__dirname, '..', 'tests', 'fixtures', 'cross-lang', 'node-int-boundary.json');
const KID = 'node-int-boundary-EdDSA';

async function main(): Promise<void> {
  const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: KID });

  const profile = buildUCPProfile({
    name: 'Int Boundary Merchant',
    services: [{ type: 'rest', url: 'https://i.example.com' }],
    payment_handlers: [],
    signing_keys: [publicJWK as UCPSigningKey],
    extras: {
      max_safe_int: 9007199254740991,
      min_safe_int: -9007199254740991,
      small_int: 42,
      neg_small_int: -42,
      zero: 0,
    },
  });

  const signed = await signUCPProfile(profile, { signingKey: privateKey, kid: KID });

  const fixture = {
    profile: signed,
    jwks: buildJWKSResponse([publicJWK]),
    alg: 'EdDSA',
    kid: KID,
    generator: 'node',
  };

  writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`);
  console.warn(`wrote ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
