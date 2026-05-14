/**
 * Tests for `hashOperatorToken` — canonical sha256 hex digest used to persist
 * operator tokens without storing plaintext on disk.
 *
 * The expected digests below are hardcoded — locked as the cross-language
 * contract with the Python sibling at `python-commerce/tests/test_tokens.py`.
 * Both files reference the same fixture inputs and the same expected output
 * bytes. A drift in either language (algorithm swap, encoding change, accidental
 * truncation) fails that language's test against the locked digest.
 */

import { describe, expect, it } from 'vitest';
import { hashOperatorToken } from '../../src/identity/tokens.js';

// Cross-language fixture inputs + expected digests. Computed once as
// sha256(<input> utf-8) and locked here so the Node and Python tests assert
// against identical bytes.
//
// Table-driven via `it.each` so each fixture runs as an independent test case:
// if multiple fixtures drift simultaneously, every failure is reported (a
// for-loop inside one `it(...)` would short-circuit on the first failure).
const FIXTURES: [string, string][] = [
  ['opc_test', '97c30e2a512b5968772c2930705bdafff4831d672556dce26c92b83f7e58508d'],
  ['opc_cross_lang_fixture', '96690dd2659bc1e33227e943d5f8a526c7c95a0ede5775a1573abab6578ca8ec'],
  ['opc_anything', 'e6ba517ac96ee39190c4d703b2d968fec96e87827374e56095a2f443d870730d'],
  ['opc_42', '731985dd676ea0702b3e6f6cbb107eaf467319e2801e6f953f08cbcc7dd71684'],
  // Non-ASCII fixture — UTF-8 encoding of "é" is 0xC3 0xA9; locks the encoding
  // contract so a future implementation that swaps Node's default encoding
  // still produces the same bytes.
  ['opc_é', 'c1dba11d60cbfc1264d115e07a74a0355b6a66ded4ee3f930024a1733ba6942f'],
  // Empty-string sha256 is a canonical value documented in many specs; locking
  // it here catches an implementation that silently rejects or transforms "".
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
];

describe('hashOperatorToken', () => {
  it.each(FIXTURES)('locked cross-language digest for %j', (plaintext, expected) => {
    expect(hashOperatorToken(plaintext)).toBe(expected);
  });

  it('output is 64 lowercase hex chars', () => {
    const out = hashOperatorToken('opc_anything');
    expect(out).toHaveLength(64);
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic across calls (no salt, no nonce)', () => {
    expect(hashOperatorToken('opc_42')).toBe(hashOperatorToken('opc_42'));
  });

  it('distinct inputs produce distinct outputs', () => {
    expect(hashOperatorToken('opc_a')).not.toBe(hashOperatorToken('opc_b'));
  });
});
