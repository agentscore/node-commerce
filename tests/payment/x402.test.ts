import { describe, expect, it, vi } from 'vitest';
import { registerX402SchemesV1V2 } from '../../src/payment/x402';

describe('registerX402SchemesV1V2', () => {
  it('calls register() and registerV1() when both are present', () => {
    const register = vi.fn();
    const registerV1 = vi.fn();
    const server = { register, registerV1 };
    const scheme = { name: 'fake-scheme' };
    registerX402SchemesV1V2(server, 'eip155:8453', scheme);
    expect(register).toHaveBeenCalledWith('eip155:8453', scheme);
    expect(registerV1).toHaveBeenCalledWith('eip155:8453', scheme);
  });

  it('only calls register() when registerV1 is absent', () => {
    const register = vi.fn();
    const server = { register };
    registerX402SchemesV1V2(server, 'solana:foo', { x: 1 });
    expect(register).toHaveBeenCalledTimes(1);
  });
});
