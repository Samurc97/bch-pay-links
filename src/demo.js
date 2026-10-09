import {
  deriveHdPrivateNodeFromBip39Mnemonic,
  deriveHdPath,
  deriveHdPublicNode,
  encodeHdPublicKey,
} from '@bitauth/libauth';

/**
 * Demo-only helpers. These exist solely so a hackathon judge can click
 * through the full pairing → payment flow without a real wallet or real BCH.
 *
 * They are wired into the HTTP API only when USE_MOCK_CHAIN=true (offline
 * demo mode). The tpub below is public key material — safe to share; the
 * server never exposes the seed it is derived from.
 */

// Well-known BIP39 test mnemonic ("abandon … about") — the same key the
// test suite uses. Testnet only; never use with real funds.
const DEMO_TEST_SEED =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** Receive-chain tpub (m/44'/0'/0'/0) for the demo test seed. */
export function demoTestXpub() {
  const recv = deriveHdPath(
    deriveHdPrivateNodeFromBip39Mnemonic(DEMO_TEST_SEED),
    "m/44'/0'/0'/0"
  );
  const enc = encodeHdPublicKey({ node: deriveHdPublicNode(recv), network: 'testnet' });
  return typeof enc === 'string' ? enc : enc.hdPublicKey;
}
