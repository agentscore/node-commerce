import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractPaymentSignerAddress, readX402PaymentHeader } from '../src/signer';

const SOLANA_GENESIS_MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const SOLANA_SIGNER = 'GEQg2TM4VL315Bd4LLkGrhBjdNfoatKjCJYHBDPM3D74';

const SIGNER_LOWER = '0xabcdef0123456789abcdef0123456789abcdef01';
const SIGNER_MIXED = '0xABCDEF0123456789ABCDEF0123456789ABCDEF01';

// Monotonic cache-bust for dynamic imports. Using `Date.now()` would collide when
// two tests run within the same millisecond (likely on fast CPUs or under CI load),
// which would share a cached module and break the vi.doMock state — flake.
let _importCounter = 0;
const freshImportKey = () => `${Date.now()}-${++_importCounter}`;

afterEach(() => {
  vi.restoreAllMocks();
});

const encodeX402 = (payload: unknown): string =>
  Buffer.from(JSON.stringify(payload)).toString('base64');

const makeRequest = (headers: Record<string, string> = {}): Request =>
  new Request('https://example.com/purchase', { headers });

describe('readX402PaymentHeader', () => {
  it('returns the payment-signature header when present', () => {
    const req = makeRequest({ 'payment-signature': 'abc' });
    expect(readX402PaymentHeader(req)).toBe('abc');
  });

  it('falls back to x-payment when payment-signature is absent', () => {
    const req = makeRequest({ 'x-payment': 'xyz' });
    expect(readX402PaymentHeader(req)).toBe('xyz');
  });

  it('prefers payment-signature over x-payment when both are set', () => {
    const req = makeRequest({ 'payment-signature': 'first', 'x-payment': 'second' });
    expect(readX402PaymentHeader(req)).toBe('first');
  });

  it('returns undefined when neither header is present', () => {
    expect(readX402PaymentHeader(makeRequest())).toBeUndefined();
  });
});

describe('extractPaymentSignerAddress — x402 path', () => {
  it('returns the lowercased `from` address from a valid x402 payload', async () => {
    const req = makeRequest();
    const header = encodeX402({ payload: { authorization: { from: SIGNER_MIXED } } });
    const result = await extractPaymentSignerAddress(req, header);
    expect(result).toBe(SIGNER_LOWER);
  });

  it('returns null when the x402 payload is not valid base64 JSON', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await extractPaymentSignerAddress(makeRequest(), '!!!not-base64!!!');
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('returns null when `payload.authorization.from` is missing', async () => {
    const header = encodeX402({ payload: { authorization: {} } });
    expect(await extractPaymentSignerAddress(makeRequest(), header)).toBeNull();
  });

  it('returns null when `from` is not a valid 0x-prefixed address', async () => {
    const header = encodeX402({ payload: { authorization: { from: 'not-a-wallet' } } });
    expect(await extractPaymentSignerAddress(makeRequest(), header)).toBeNull();
  });

  it('returns null when neither header nor x402 payload is supplied', async () => {
    expect(await extractPaymentSignerAddress(makeRequest(), undefined)).toBeNull();
  });
});

describe('extractPaymentSignerAddress — MPP path', () => {
  // mppx is an optional peer dep and is not installed in the gate's test env. The dynamic
  // import resolves to null and the helper falls through, leaving MPP extraction a no-op
  // for merchants who don't opt in to MPP.
  it('returns null when Authorization: Payment is set but mppx is unavailable', async () => {
    const req = makeRequest({ authorization: 'Payment some-mpp-credential' });
    expect(await extractPaymentSignerAddress(req)).toBeNull();
  });

  it('returns null when the Authorization header is not the Payment scheme', async () => {
    const req = makeRequest({ authorization: 'Bearer unrelated-token' });
    expect(await extractPaymentSignerAddress(req)).toBeNull();
  });

  it('prefers MPP when both MPP and x402 are present, falling back to x402 on MPP miss', async () => {
    // Because mppx is unavailable, MPP path yields null and the x402 path runs instead.
    const header = encodeX402({ payload: { authorization: { from: SIGNER_MIXED } } });
    const req = makeRequest({ authorization: 'Payment mpp-cred' });
    expect(await extractPaymentSignerAddress(req, header)).toBe(SIGNER_LOWER);
  });

  it('extracts the lowercased 0x address from an MPP DID (did:pkh:eip155:...)', async () => {
    vi.doMock('mppx', () => ({
      Credential: {
        extractPaymentScheme: () => true,
        fromRequest: () => ({ source: `did:pkh:eip155:8453:${SIGNER_MIXED}` }),
      },
    }));
    const { extractPaymentSignerAddress: freshExtract } = await import(
      `../src/signer?mpp=${freshImportKey()}`
    );
    const req = makeRequest({ authorization: 'Payment mpp-cred' });
    const result = await freshExtract(req);
    expect(result).toBe(SIGNER_LOWER);
    vi.doUnmock('mppx');
  });

  it('extracts the base58 address from an MPP DID (did:pkh:solana:...) with network=solana', async () => {
    vi.doMock('mppx', () => ({
      Credential: {
        extractPaymentScheme: () => true,
        fromRequest: () => ({ source: `did:pkh:solana:${SOLANA_GENESIS_MAINNET}:${SOLANA_SIGNER}` }),
      },
    }));
    const { extractPaymentSigner: freshExtract } = await import(
      `../src/signer?mpp-solana=${freshImportKey()}`
    );
    const req = makeRequest({ authorization: 'Payment mpp-cred' });
    const result = await freshExtract(req);
    expect(result).toEqual({ address: SOLANA_SIGNER, network: 'solana' });
    vi.doUnmock('mppx');
  });

  it('falls back to decoding payload.transaction when source is unset (Solana pull mode)', async () => {
    // Stand-in for @solana/kit. The extract path passes payload bytes through
    // getBase64Codec → getTransactionDecoder → getCompiledTransactionMessageDecoder
    // and then walks instructions for SPL TransferChecked. We hand it a fake
    // compiled message whose 0th instruction is a TokenProgram TransferChecked
    // with the authority at account index 3.
    const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const fakeMessage = {
      staticAccounts: [
        TOKEN_PROGRAM,             // 0: program (referenced by programAddressIndex below)
        'SrcATAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        'MintXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        'DstATAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        SOLANA_SIGNER,             // 4: authority
      ],
      instructions: [
        {
          programAddressIndex: 0,
          accountIndices: [1, 2, 3, 4],
          data: new Uint8Array([12, 0, 0, 0, 0, 0, 0, 0, 0, 6]),
        },
      ],
    };
    vi.doMock('mppx', () => ({
      Credential: {
        extractPaymentScheme: () => true,
        fromRequest: () => ({
          payload: { transaction: 'AAAA', type: 'transaction' },
        }),
      },
    }));
    vi.doMock('@solana/kit', () => ({
      getBase64Codec: () => ({ encode: () => new Uint8Array([0]) }),
      getTransactionDecoder: () => ({ decode: () => ({ messageBytes: new Uint8Array([0]) }) }),
      getCompiledTransactionMessageDecoder: () => ({ decode: () => fakeMessage }),
    }));
    const { extractPaymentSigner: freshExtract } = await import(
      `../src/signer?solana-tx=${freshImportKey()}`
    );
    const req = makeRequest({ authorization: 'Payment mpp-cred' });
    const result = await freshExtract(req);
    expect(result).toEqual({ address: SOLANA_SIGNER, network: 'solana' });
    vi.doUnmock('mppx');
    vi.doUnmock('@solana/kit');
  });

  it('returns null on push-mode Solana credentials (payload.type=signature, no tx to decode)', async () => {
    vi.doMock('mppx', () => ({
      Credential: {
        extractPaymentScheme: () => true,
        fromRequest: () => ({
          payload: { signature: 'sigBytes', type: 'signature' },
        }),
      },
    }));
    const { extractPaymentSigner: freshExtract } = await import(
      `../src/signer?solana-push=${freshImportKey()}`
    );
    const req = makeRequest({ authorization: 'Payment mpp-cred' });
    expect(await freshExtract(req)).toBeNull();
    vi.doUnmock('mppx');
  });

  it('returns null when the MPP credential source is not a did:pkh:eip155 shape', async () => {
    vi.doMock('mppx', () => ({
      Credential: {
        extractPaymentScheme: () => true,
        fromRequest: () => ({ source: 'did:web:example.com' }),
      },
    }));
    const { extractPaymentSignerAddress: freshExtract } = await import(
      `../src/signer?mpp-nonevm=${freshImportKey()}`
    );
    const req = makeRequest({ authorization: 'Payment mpp-cred' });
    expect(await freshExtract(req)).toBeNull();
    vi.doUnmock('mppx');
  });

  it('logs and falls through when mppx throws during extraction', async () => {
    vi.doMock('mppx', () => ({
      Credential: {
        extractPaymentScheme: () => { throw new Error('mpp parse failed'); },
        fromRequest: () => ({}),
      },
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { extractPaymentSignerAddress: freshExtract } = await import(
      `../src/signer?mpp-throw=${freshImportKey()}`
    );
    const req = makeRequest({ authorization: 'Payment mpp-cred' });
    expect(await freshExtract(req)).toBeNull();
    expect(warn).toHaveBeenCalled();
    vi.doUnmock('mppx');
  });
});

describe('extractPaymentSignerAddress — Solana credentials are no longer extracted', () => {
  it('returns null for a credential carrying a Solana network (Solana goes through MPP solana/charge; gate signer-extraction skipped)', async () => {
    const header = encodeX402({
      accepted: { network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' },
      payload: { transaction: Buffer.from('any-tx').toString('base64') },
    });
    expect(await extractPaymentSignerAddress(makeRequest(), header)).toBeNull();
  });

  it('still extracts EIP-3009 EVM signer when accepted.network is missing (back-compat)', async () => {
    const header = encodeX402({ payload: { authorization: { from: SIGNER_MIXED } } });
    expect(await extractPaymentSignerAddress(makeRequest(), header)).toBe(SIGNER_LOWER);
  });
});
