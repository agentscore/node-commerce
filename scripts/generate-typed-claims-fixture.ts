/**
 * One-shot generator for the typed-claims cross-lang fixture (Node side).
 *
 * Writes `tests/fixtures/cross-lang/node-typed-claims.json`. Sibling to
 * `generate-data-driven-claims-fixture.ts` but exercises the **typed**
 * `AgentScoreData.account_verification` / `AgentScoreData.operator_verification`
 * read path (no raw fallback) so cross-lang verify catches drift on the
 * typed-field-only call site. Python's `build_ucp_profile` reads the typed
 * fields first without consulting raw when they are present, so both
 * languages must emit the identical canonical bytes for this hand-constructed
 * input shape.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildUCPProfile, type UCPSigningKey } from '../src/identity/ucp';
import {
  buildJWKSResponse,
  generateUCPSigningKey,
  signUCPProfile,
} from '../src/identity/ucp-jwks';
import type { AgentScoreData } from '../src/core';

const OUT = join(__dirname, '..', 'tests', 'fixtures', 'cross-lang', 'node-typed-claims.json');
const KID = 'node-typed-claims-EdDSA';

async function main(): Promise<void> {
  const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: KID });

  const data: AgentScoreData = {
    decision: 'allow',
    decision_reasons: [],
    resolved_operator: 'op_typed_claims',
    verify_url: 'https://agentscore.sh/verify/op_typed_claims',
    operator_verification: {
      level: 'enhanced',
      operator_type: 'api',
      verified_at: '2026-04-01T00:00:00Z',
    },
    account_verification: {
      kyc_level: 'enhanced',
      sanctions_clear: true,
      age_bracket: '21+',
      jurisdiction: 'US',
      verified_at: '2026-04-01T00:00:00Z',
    },
  };

  const profile = buildUCPProfile({
    name: 'Typed Claims Merchant',
    services: [{ type: 'rest', url: 'https://t.example.com' }],
    payment_handlers: [],
    signing_keys: [publicJWK as UCPSigningKey],
    data,
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
