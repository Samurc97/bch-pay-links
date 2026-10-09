import { config } from './config.js';
import { initWallet } from './wallet.js';
import { LinkStore } from './store.js';
import { MerchantStore } from './merchants.js';
import { createPairingManager } from './wizardconnect.js';
import { ElectrumChainProvider, MockChainProvider } from './chain.js';
import { PaymentPoller, fireWebhook } from './poller.js';
import { createApp } from './server.js';
import { demoTestXpub } from './demo.js';
import crypto from 'node:crypto';

async function main() {
  // 1. Merchant HD wallet (offline derivation; seed from env only).
  //    Dev-mode fallback for POST /links without merchantId. Paired merchants
  //    use their own WizardConnect xpub — the server never holds their seed.
  await initWallet(config.merchantSeed(), config.network);
  console.log(`[bch-pay-links] network=${config.network} electrum=${config.electrumHost}:${config.electrumPort}`);

  // 2. Storage
  const store = new LinkStore(config.dataDir);
  const merchantStore = new MerchantStore(config.dataDir);

  // 3. WizardConnect pairing sessions (merchant-owned wallets, non-custodial)
  const pairing = createPairingManager({
    enableRelay: config.wizardRelay,
    onPaired: async (merchantId, { xpub, changeXpub }) => {
      const r = merchantStore.pair(merchantId, { xpub, changeXpub });
      if (r.error) console.warn(`[wizardconnect] auto-pair failed for ${merchantId}: ${r.error}`);
      else console.log(`[wizardconnect] merchant ${merchantId} paired via wallet`);
    },
  });
  if (config.wizardRelay) console.log('[bch-pay-links] WizardConnect relay pairing enabled');
  else console.log('[bch-pay-links] WizardConnect relay disabled (WIZARDCONNECT_RELAY=false); manual xpub pairing only');
  const sweepTimer = setInterval(() => pairing.sweepExpired(), 60_000);
  sweepTimer.unref();

  // 3. Chain access (real Electrum, or in-memory mock for offline dev/tests)
  const chain = config.useMockChain
    ? new MockChainProvider()
    : new ElectrumChainProvider(config.electrumHost, config.electrumPort);
  if (config.useMockChain) console.log('[bch-pay-links] using MOCK chain provider');

  // 4. Payment detection + webhooks
  const poller = new PaymentPoller({
    store,
    chain,
    intervalMs: config.pollIntervalMs,
    onPaid: (link) => fireWebhook(link),
  });
  poller.start();

  // 5. HTTP API
  // Demo-only endpoints (milestone 3): wired in only when the mock chain is
  // in use, so a judge can click through the full flow without a real
  // wallet or real BCH. Never enabled against a real chain.
  const demo = config.useMockChain
    ? {
        testXpub: () => demoTestXpub(),
        simulatePayment: (link) => {
          const txid = `demo_${crypto.randomBytes(16).toString('hex')}`;
          chain.credit(link.bchAddress, txid, link.amountSats);
          return txid;
        },
      }
    : null;
  const app = createApp({ store, merchantStore, pairing, network: config.network, demo });
  const server = app.listen(config.port, () => {
    console.log(`[bch-pay-links] listening on http://localhost:${config.port}`);
  });

  const shutdown = () => {
    console.log('\n[bch-pay-links] shutting down…');
    poller.stop();
    if (chain.close) chain.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[bch-pay-links] fatal:', e.message);
  process.exit(1);
});
