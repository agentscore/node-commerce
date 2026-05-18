/**
 * JWS round-trip for A2A Agent Card signatures (RFC 7515).
 *
 * Per A2A spec §4.4.7, the card body is signed without `signatures`, the
 * signature is computed over the canonical serialization, then attached back as
 * one of `card.signatures[]`. Verifiers reconstruct the body without
 * `signatures` and verify each entry against the merchant's published JWKS.
 *
 * This test proves we can sign and verify an unsigned `A2AAgentCard` produced
 * by `buildA2AAgentCard` end-to-end, with no key fields stripped or mangled.
 */

import {
  CompactSign,
  compactVerify,
  exportJWK,
  generateKeyPair,
  importJWK,
  type JWK,
} from 'jose';
import { describe, expect, it } from 'vitest';
import {
  buildA2AAgentCard,
  ucpA2AExtension,
  type A2AAgentCard,
  type A2AAgentCardSignature,
} from '../../src/identity/a2a';

async function signCard(
  card: A2AAgentCard,
  privateJwk: JWK,
  kid: string,
): Promise<A2AAgentCardSignature> {
  const { signatures: _ignore, ...bodyWithoutSignatures } = card;
  void _ignore;
  const payload = new TextEncoder().encode(JSON.stringify(bodyWithoutSignatures));
  const key = await importJWK(privateJwk, 'EdDSA');
  const jws = await new CompactSign(payload).setProtectedHeader({ alg: 'EdDSA', kid }).sign(key);
  const [protectedHeader, , signature] = jws.split('.');
  return { protected: protectedHeader!, signature: signature! };
}

async function verifyCard(card: A2AAgentCard, publicJwk: JWK): Promise<true> {
  if (!card.signatures || card.signatures.length === 0) {
    throw new Error('card has no signatures');
  }
  const sig = card.signatures[0]!;
  const { signatures: _ignore, ...bodyWithoutSignatures } = card;
  void _ignore;
  const payload = new TextEncoder().encode(JSON.stringify(bodyWithoutSignatures));
  const payloadB64 = Buffer.from(payload)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const jws = `${sig.protected}.${payloadB64}.${sig.signature}`;
  const key = await importJWK(publicJwk, 'EdDSA');
  await compactVerify(jws, key);
  return true;
}

describe('A2A AgentCard JWS round-trip (RFC 7515)', () => {
  it('signs an unsigned card and verifies the signature', async () => {
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    const privateJwk = await exportJWK(privateKey);

    const unsigned = buildA2AAgentCard({
      name: 'Example Merchant',
      description: 'Buy products via agent payments.',
      url: 'https://agents.example.com',
      version: '1.0.0',
      skills: [
        {
          id: 'purchase',
          name: 'Purchase',
          description: 'Buy products via agent payments.',
          tags: ['commerce', 'payment'],
        },
      ],
      extensions: [ucpA2AExtension()],
    });

    const signature = await signCard(unsigned, privateJwk, 'merchant-key-1');
    const signed: A2AAgentCard = { ...unsigned, signatures: [signature] };

    await expect(verifyCard(signed, publicJwk)).resolves.toBe(true);
  });

  it('verification fails when the body is tampered with', async () => {
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    const privateJwk = await exportJWK(privateKey);

    const unsigned = buildA2AAgentCard({
      name: 'Example',
      description: 'd',
      url: 'https://x.example',
      skills: [{ id: 'p', name: 'P', description: 'd', tags: ['t'] }],
    });
    const signature = await signCard(unsigned, privateJwk, 'k1');
    const tampered: A2AAgentCard = {
      ...unsigned,
      description: 'tampered',
      signatures: [signature],
    };

    await expect(verifyCard(tampered, publicJwk)).rejects.toThrow();
  });
});
