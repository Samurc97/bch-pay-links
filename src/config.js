import 'dotenv/config';

/**
 * Central configuration, all from environment variables.
 * No secrets are hardcoded anywhere in the codebase.
 */
function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name} (see .env.example)`);
  return v;
}

const NETWORK = (process.env.BCH_NETWORK || 'chipnet').toLowerCase();
if (!['chipnet', 'mainnet'].includes(NETWORK)) {
  throw new Error(`BCH_NETWORK must be "chipnet" or "mainnet", got "${NETWORK}"`);
}

const DEFAULT_ELECTRUM = NETWORK === 'mainnet'
  ? { host: 'fulcrum.pat.mn', port: 50002 }   // example Fulcrum server; override via env
  : { host: 'chipnet.bch.ninja', port: 50002 };

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  network: NETWORK,                       // 'chipnet' (dev) | 'mainnet' (production/demo)
  merchantSeed: () => required('MERCHANT_SEED'), // BIP39 mnemonic, NEVER commit
  electrumHost: process.env.ELECTRUM_HOST || DEFAULT_ELECTRUM.host,
  electrumPort: parseInt(process.env.ELECTRUM_PORT || String(DEFAULT_ELECTRUM.port), 10),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '20000', 10),
  linkTtlMinutes: parseInt(process.env.LINK_TTL_MINUTES || '60', 10),
  useMockChain: process.env.USE_MOCK_CHAIN === 'true',
  dataDir: process.env.DATA_DIR || './data',
  wizardRelay: process.env.WIZARDCONNECT_RELAY !== 'false', // 'false' = manual xpub pairing only (tests, offline)
};
