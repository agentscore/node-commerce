/**
 * One-shot generator for the data-driven-claims cross-lang fixture (Node side).
 *
 * Writes `tests/fixtures/cross-lang/node-data-driven-claims.json`. Unlike the
 * other cross-lang fixtures (which hand-craft the `agentscore-identity`
 * capability), this one EXERCISES `buildUCPProfile`'s data path: it constructs
 * a synthetic `AgentScoreData` with the API-shape "missing" sentinels (empty
 * string for kyc_level, null for age_bracket / jurisdiction / verified_at) and
 * lets the builder coalesce them. Both languages MUST emit identical canonical
 * bytes for this input or cross-lang verify drifts silently in production.
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

const OUT = join(__dirname, '..', 'tests', 'fixtures', 'cross-lang', 'node-data-driven-claims.json');
const KID = 'node-data-driven-claims-EdDSA';

async function main(): Promise<void> {
  const { privateKey, publicJWK } = await generateUCPSigningKey({ kid: KID });

  const data: AgentScoreData = {
    decision: 'allow',
    decision_reasons: [],
    resolved_operator: 'op_data_driven',
    verify_url: 'https://agentscore.sh/verify/op_data_driven',
    account_verification: {
      // Empty string is the API's "set but unknown" shape for some columns;
      // null is the shape for others. The builder must coerce both to the
      // schema default identically across node and python.
      kyc_level: '',
      sanctions_clear: false,
      age_bracket: null as unknown as string,
      jurisdiction: null as unknown as string,
      verified_at: null,
    },
  };

  const profile = buildUCPProfile({
    name: 'Data Driven Claims Merchant',
    services: [{ type: 'rest', url: 'https://d.example.com' }],
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
