/**
 * Network-aware signer extraction from MPP and x402 credentials.
 *
 * `extractPaymentSigner(request, x402Header?)` returns `{address, network: 'evm'|'solana'} | null`
 * — the network field tells `captureWallet` which key family to attribute the signer to.
 * `readX402PaymentHeader(request)` is a small helper for pulling the x402 header out of a
 * Request when you want to pre-extract it.
 */
export {
  extractPaymentSigner,
  readX402PaymentHeader,
} from '../signer';
export type { PaymentSigner, SignerNetwork } from '../signer';
