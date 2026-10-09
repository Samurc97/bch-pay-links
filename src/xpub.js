import {
  decodeHdPublicKey,
  deriveHdPublicNodeChild,
  sha256,
  ripemd160,
  encodeCashAddress,
} from '@bitauth/libauth';

/**
 * Non-custodial address derivation from a merchant's WizardConnect xpub.
 *
 * The wallet delivers its RECEIVE xpub during the WizardConnect handshake
 * (protocol paths are named: 'receive' / 'change' / 'defi'). The dapp then
 * derives each payment-link address locally as a direct non-hardened child
 * of that xpub — the server never sees, stores, or needs the seed.
 *
 * This module is pure and offline: no network, no wallet state.
 */

/**
 * Validate a receive xpub string.
 * Rejects: empty/garbage, bad checksum, and — critically — anything that
 * decodes as a PRIVATE extended key. The server must never accept an xpriv.
 * @returns {{ network: string, node: object }} the decoded public node
 * @throws {Error} on any invalid input
 */
export function decodeReceiveXpub(xpub) {
  if (typeof xpub !== 'string' || !xpub.trim()) {
    throw new Error('xpub must be a non-empty string');
  }
  const decoded = decodeHdPublicKey(xpub.trim());
  if (typeof decoded === 'string') {
    // Covers: bad checksum, wrong version bytes (incl. xpriv), bad length.
    throw new Error(`Invalid receive xpub: ${decoded}`);
  }
  return decoded; // { network, node }
}

/**
 * Derive the cashaddr for a payment link from the merchant's receive xpub.
 * @param {string} xpub - merchant receive xpub (xpub… / tpub…)
 * @param {number} index - explicit derivation index (unique per link)
 * @param {'bchtest'|'bitcoincash'} prefix - cashaddr prefix for our network
 * @returns {string} cashaddr WITH prefix, e.g. 'bchtest:qq…'
 * @throws {Error} on invalid xpub or index
 */
export function deriveAddressFromXpub(xpub, index, prefix) {
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) {
    throw new Error('Address index must be a non-negative integer < 2^31');
  }
  if (prefix !== 'bchtest' && prefix !== 'bitcoincash') {
    throw new Error('prefix must be "bchtest" or "bitcoincash"');
  }
  const { node } = decodeReceiveXpub(xpub);
  const child = deriveHdPublicNodeChild(node, index);
  if (typeof child === 'string') {
    throw new Error(`Address derivation failed: ${child}`);
  }
  const payload = ripemd160.hash(sha256.hash(child.publicKey));
  const encoded = encodeCashAddress({ payload, prefix, type: 'p2pkh' });
  if (typeof encoded === 'string') {
    throw new Error(`Address encoding failed: ${encoded}`);
  }
  return encoded.address;
}
