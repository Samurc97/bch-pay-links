import express from 'express';
import QRCode from 'qrcode';
import { getFreshAddress, addressPrefix } from './wallet.js';
import { deriveAddressFromXpub } from './xpub.js';
import { getBchUsdRate } from './price.js';

export const DUST_SATS = 546; // BCH dust limit

/** Public view of a merchant: xpubs are public by design; relay credentials never leave the pairing manager. */
function publicMerchant(m) {
  if (!m) return null;
  return {
    id: m.id,
    name: m.name,
    status: m.status,
    xpub: m.xpub,
    changeXpub: m.changeXpub,
    createdAt: m.createdAt,
    pairedAt: m.pairedAt,
    pairing: m.pairing
      ? {
          mode: m.pairing.mode,
          qrUri: m.pairing.qrUri || null,
          qrData: m.pairing.qrData || null,
          expiresAt: m.pairing.expiresAt || null,
          instructions: m.pairing.instructions || null,
        }
      : null,
  };
}

function bchUri(address, amountBch) {
  // BIP-21 style: scheme is the cashaddr prefix (bitcoincash: / bchtest:)
  const [scheme, addr] = address.split(':');
  return `${scheme}:${addr}?amount=${amountBch.toFixed(8)}`;
}

function toBaseUnits(amountBch) {
  return BigInt(Math.round(amountBch * 1e8));
}

export function createApp({ store, network, merchantStore = null, pairing = null, demo = null }) {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  // Demo frontend (milestone 3): one-page judge walkthrough.
  // Served only as static files; the JSON API below is unchanged.
  app.use(express.static('public'));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, network, links: store.all().length });
  });

  // ---- Merchants (WizardConnect, non-custodial) ---------------------------
  // Registered only when a merchantStore is wired in.

  /**
   * POST /merchants — register a merchant and start WizardConnect pairing.
   * Body: { name? } → 201 { id, name, status:'pending', pairing:{ mode, qrUri, qrData, … } }
   * The merchant scans the QR with a WizardConnect-compatible wallet; the
   * wallet's receive xpub is then delivered over the encrypted relay.
   */
  app.post('/merchants', async (req, res) => {
    if (!merchantStore || !pairing) return res.status(503).json({ error: 'Merchant pairing not enabled' });
    try {
      const { name } = req.body || {};
      const merchant = merchantStore.create({ name });
      const session = await pairing.createSession(merchant.id);
      merchantStore.setPairing(merchant.id, {
        sessionId: session.sessionId,
        mode: session.mode,
        qrUri: session.qrUri,
        qrData: session.qrData,
        expiresAt: session.expiresAt,
        instructions: session.instructions || null,
      });
      res.status(201).json(publicMerchant(merchantStore.get(merchant.id)));
    } catch (e) {
      console.error('[api] POST /merchants failed:', e);
      res.status(500).json({ error: 'Internal error creating merchant' });
    }
  });

  /** GET /merchants — list merchants (light: no QR payloads). */
  app.get('/merchants', (_req, res) => {
    if (!merchantStore) return res.status(503).json({ error: 'Merchant pairing not enabled' });
    res.json(merchantStore.all().map((m) => ({ ...publicMerchant(m), pairing: m.pairing ? { ...publicMerchant(m).pairing, qrData: undefined } : null })));
  });

  /** GET /merchants/:id — merchant status + pairing info. */
  app.get('/merchants/:id', (req, res) => {
    if (!merchantStore) return res.status(503).json({ error: 'Merchant pairing not enabled' });
    const m = merchantStore.get(req.params.id);
    if (!m) return res.status(404).json({ error: 'Merchant not found' });
    res.json(publicMerchant(m));
  });

  /**
   * POST /merchants/:id/pair — complete pairing by submitting the wallet's
   * receive xpub. In production this is fed by the WizardConnect
   * wallet_ready handler; the same endpoint serves manual/API pairing
   * (tests, offline demos, wallets without relay support).
   * Body: { xpub, changeXpub? } — xpriv and malformed keys are rejected.
   */
  app.post('/merchants/:id/pair', (req, res) => {
    if (!merchantStore) return res.status(503).json({ error: 'Merchant pairing not enabled' });
    const existing = merchantStore.get(req.params.id);
    const sessionId = existing && existing.pairing ? existing.pairing.sessionId : null;
    const { xpub, changeXpub } = req.body || {};
    const result = merchantStore.pair(req.params.id, { xpub, changeXpub });
    if (result.error === 'not_found') return res.status(404).json({ error: 'Merchant not found' });
    if (result.error === 'already_paired') return res.status(409).json({ error: 'Merchant already paired' });
    if (result.error === 'invalid_xpub') return res.status(400).json({ error: 'Invalid receive xpub', detail: result.message });
    if (result.error === 'invalid_change_xpub') return res.status(400).json({ error: 'Invalid change xpub', detail: result.message });
    // Pairing consumed: release any live relay session for this merchant.
    if (pairing && sessionId) pairing.closeSession(sessionId);
    res.json(publicMerchant(result.merchant));
  });

  // ---- Demo-only endpoints (milestone 3) ----------------------------------
  // Registered ONLY when a `demo` object is passed — i.e. when the server
  // runs with USE_MOCK_CHAIN=true. They let a judge click through the full
  // flow without a real wallet or real BCH. Never enabled in production.
  if (demo) {
    /** GET /demo/test-xpub — public receive xpub for the demo test wallet. */
    app.get('/demo/test-xpub', (_req, res) => {
      try {
        res.json({ xpub: demo.testXpub(), demoOnly: true });
      } catch (e) {
        res.status(500).json({ error: 'Could not derive demo xpub', detail: e.message });
      }
    });

    /**
     * POST /links/:id/simulate-payment — credit the mock chain with the
     * link's exact amount so the poller flips it to `paid` on its next tick.
     * Returns the fake txid.
     */
    app.post('/links/:id/simulate-payment', (req, res) => {
      const link = store.get(req.params.id);
      if (!link) return res.status(404).json({ error: 'Link not found' });
      if (link.status === 'paid') return res.status(409).json({ error: 'Link already paid' });
      try {
        const txid = demo.simulatePayment(link);
        res.json({ ok: true, linkId: link.id, txid, demoOnly: true });
      } catch (e) {
        res.status(500).json({ error: 'Simulation failed', detail: e.message });
      }
    });
  }

  /**
   * POST /links — create a payment link.
   * Body: { amount, currency: "USD"|"BCH", description, webhookUrl?, expiresInMinutes?, merchantId? }
   *
   * merchantId (optional): when given, the receiving address is derived from
   * that merchant's paired WizardConnect xpub (non-custodial). When omitted,
   * the legacy single-merchant dev wallet (env seed) is used — backward
   * compatible with milestone 1.
   */
  app.post('/links', async (req, res) => {
    try {
      const { amount, currency, description, webhookUrl, expiresInMinutes, merchantId } = req.body || {};

      if (typeof amount !== 'number' || !isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: 'amount must be a positive number' });
      }
      if (!['USD', 'BCH'].includes(currency)) {
        return res.status(400).json({ error: 'currency must be "USD" or "BCH"' });
      }
      if (webhookUrl !== undefined && !(typeof webhookUrl === 'string' && /^https?:\/\//.test(webhookUrl))) {
        return res.status(400).json({ error: 'webhookUrl must be a valid http(s) URL' });
      }

      let amountSats, rateUsed = null, fiatAmount = null;
      if (currency === 'BCH') {
        amountSats = toBaseUnits(amount);
      } else {
        rateUsed = await getBchUsdRate().catch(() => null);
        if (!rateUsed) {
          return res.status(502).json({ error: 'Could not fetch BCH/USD rate; try currency "BCH"' });
        }
        fiatAmount = amount;
        amountSats = toBaseUnits(amount / rateUsed);
      }

      if (amountSats < BigInt(DUST_SATS)) {
        return res.status(400).json({ error: `Amount below dust limit (${DUST_SATS} sats)` });
      }
      if (amountSats > BigInt(Number.MAX_SAFE_INTEGER)) {
        return res.status(400).json({ error: 'Amount too large' });
      }

      // Receiving address: per-merchant xpub (WizardConnect, non-custodial)
      // or the legacy dev-seed wallet when no merchantId is given.
      let bchAddress, addressIndex, linkMerchantId = null;
      if (merchantId !== undefined && merchantId !== null) {
        if (!merchantStore) return res.status(503).json({ error: 'Merchant pairing not enabled' });
        const merchant = merchantStore.get(merchantId);
        if (!merchant) return res.status(404).json({ error: 'Merchant not found' });
        if (merchant.status !== 'paired' || !merchant.xpub) {
          return res.status(409).json({ error: 'Merchant wallet not paired yet' });
        }
        addressIndex = merchantStore.claimIndex(merchantId);
        try {
          bchAddress = deriveAddressFromXpub(
            merchant.xpub,
            addressIndex,
            network === 'mainnet' ? 'bitcoincash' : 'bchtest'
          );
        } catch (e) {
          return res.status(500).json({ error: 'Address derivation failed', detail: e.message });
        }
        linkMerchantId = merchant.id;
      } else {
        // Legacy dev mode: fresh address per link from the env-seed wallet
        // (explicit HD index -> deterministic, offline).
        addressIndex = store.claimIndex();
        bchAddress = getFreshAddress(addressIndex);
      }
      if (!bchAddress.startsWith(addressPrefix(network))) {
        return res.status(500).json({ error: 'Derived address has unexpected prefix' });
      }

      const ttlMin = Number.isFinite(expiresInMinutes) && expiresInMinutes > 0
        ? Math.min(expiresInMinutes, 60 * 24 * 7)
        : 60;
      const amountSatsNum = Number(amountSats);
      const amountBch = amountSatsNum / 1e8;
      const paymentUri = bchUri(bchAddress, amountBch);
      const qrData = await QRCode.toDataURL(paymentUri, { width: 320, margin: 2 });

      const link = store.create({
        merchantId: linkMerchantId,
        bchAddress,
        addressIndex,
        amountSats: amountSatsNum,
        amountBch,
        currency,
        fiatAmount,
        rateUsed,
        description: typeof description === 'string' ? description.slice(0, 280) : '',
        webhookUrl: webhookUrl || null,
        paymentUri,
        qrData,
        expiresAt: new Date(Date.now() + ttlMin * 60_000).toISOString(),
      });

      res.status(201).json({
        id: link.id,
        merchantId: link.merchantId || null,
        bchAddress: link.bchAddress,
        amountSats: link.amountSats,
        amountBch: link.amountBch,
        currency: link.currency,
        fiatAmount: link.fiatAmount,
        rateUsed: link.rateUsed,
        paymentUri: link.paymentUri,
        qrData: link.qrData,
        expiresAt: link.expiresAt,
        status: link.status,
      });
    } catch (e) {
      console.error('[api] POST /links failed:', e);
      res.status(500).json({ error: 'Internal error creating link' });
    }
  });

  /** GET /links/:id — link status (pending | paid | expired). */
  app.get('/links/:id', (req, res) => {
    const link = store.get(req.params.id);
    if (!link) return res.status(404).json({ error: 'Link not found' });
    const { qrData: _qr, ...rest } = link; // keep the status payload light
    res.json(rest);
  });

  /** GET /links — list all links (light payloads, no QR data). */
  app.get('/links', (_req, res) => {
    res.json(store.all().map(({ qrData: _qr, ...rest }) => rest));
  });

  return app;
}
