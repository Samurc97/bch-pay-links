import { HDWallet, TestNetHDWallet } from 'mainnet-js';

/**
 * Merchant HD wallet (BIP44). Each payment link gets a FRESH receiving
 * address derived at an explicit deposit index, so payments to different
 * links never share an address.
 *
 * - chipnet (dev):  TestNetHDWallet  (mainnet-js "testnet" == chipnet)
 * - mainnet (demo): HDWallet
 *
 * Address derivation is fully offline; no network needed.
 */
let wallet = null;

export async function initWallet(seed, network) {
  const Cls = network === 'mainnet' ? HDWallet : TestNetHDWallet;
  wallet = await Cls.fromSeed(seed.trim());
  return wallet;
}

/** Fresh cashaddr for a payment link, derived at deposit index `index`. */
export function getFreshAddress(index) {
  if (!wallet) throw new Error('Wallet not initialized');
  if (!Number.isInteger(index) || index < 0) {
    throw new Error('Address index must be a non-negative integer');
  }
  return wallet.getDepositAddress(index);
}

/** cashaddr prefix expected on this network (bchtest:… / bitcoincash:…). */
export function addressPrefix(network) {
  return network === 'mainnet' ? 'bitcoincash:' : 'bchtest:';
}

/** Stop background watchers/timers so the process can exit cleanly. */
export async function stopWallet() {
  if (wallet && typeof wallet.stop === 'function') {
    await wallet.stop().catch(() => {});
  }
  wallet = null;
  try {
    const { disconnectProviders } = await import('mainnet-js');
    await disconnectProviders().catch(() => {});
  } catch { /* noop */ }
}
