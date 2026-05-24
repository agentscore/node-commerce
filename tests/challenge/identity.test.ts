import { describe, expect, it } from 'vitest';
import { buildIdentityMetadata } from '../../src/challenge/identity';

describe('buildIdentityMetadata', () => {
  it('returns minimal block for operator_token mode', () => {
    expect(buildIdentityMetadata({ mode: 'operator_token' })).toEqual({
      identity_mode: 'operator_token',
    });
  });

  it('echoes wallet + linked_wallets + signer_constraint for wallet mode', () => {
    const block = buildIdentityMetadata({
      mode: 'wallet',
      wallet: '0xabc',
      linkedWallets: ['0xabc', '0xdef'],
    });
    expect(block.identity_mode).toBe('wallet');
    expect(block.required_signer).toBe('0xabc');
    expect(block.linked_wallets).toEqual(['0xabc', '0xdef']);
    expect(block.signer_constraint).toContain('linked_wallets');
  });

  it('uses signerMatchResult.expectedSigner when present', () => {
    const block = buildIdentityMetadata({
      mode: 'wallet',
      wallet: '0xclaimed',
      signerMatchResult: { kind: 'pass', expectedSigner: '0xexpected' },
    });
    expect(block.required_signer).toBe('0xexpected');
  });

  it('omits linked_wallets when empty', () => {
    const block = buildIdentityMetadata({ mode: 'wallet', wallet: '0xabc', linkedWallets: [] });
    expect(block).not.toHaveProperty('linked_wallets');
  });

  it('omits required_signer in wallet mode when no wallet is supplied', () => {
    const block = buildIdentityMetadata({ mode: 'wallet' });
    expect(block.identity_mode).toBe('wallet');
    expect(block).not.toHaveProperty('required_signer');
  });
});
