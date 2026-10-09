import test from 'node:test';
import assert from 'node:assert/strict';
import { initWallet, getFreshAddress, stopWallet } from '../src/wallet.js';
import { LinkStore } from '../src/store.js';
import { MerchantStore } from '../src/merchants.js';
import { createPairingManager } from '../src/wizardconnect.js';
import { decodeReceiveXpub, deriveAddressFromXpub } from '../src/xpub.js';
import { MockChainProvider } from '../src/chain.js';
import { PaymentPoller } from '../src/poller.js';
import { createApp } from '../src/server.js';
import {
  deriveHdPrivateNodeFromBip39Mnemonic,
  deriveHdPath,
  deriveHdPublicNode,
  encodeHdPublicKey,
  encodeHdPrivateKey,
} from '@bitauth/libauth';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** Receive-chain tpub for the test seed (m/44'/0'/0'/0 — mainnet-js receive path). */
function testReceiveTpub() {
  const recv = deriveHdPath(deriveHdPrivateNodeFromBip39Mnemonic(TEST_SEED), "m/44'/0'/0'/0");
  const pub = deriveHdPublicNode(recv);
  const enc = encodeHdPublicKey({ node: pub, network: 'testnet' });
  return typeof enc === 'string' ? enc : enc.hdPublicKey;
}

/** xpriv at the same path — must ALWAYS be rejected. */
function testXpriv() {
  const recv = deriveHdPath(deriveHdPrivateNodeFromBip39Mnemonic(TEST_SEED), "m/44'/0'/0'/0");
  const enc = encodeHdPrivateKey({ node: recv, network: 'testnet' });
  return typeof enc === 'string' ? enc : enc.hdPrivateKey;
}

let app, base, store, merchantStore, chain, poller, pairing;
let merchantId, merchantXpub, expectedAddr0, expectedAddr1;

test('setup: wallet, stores, pairing (relay disabled), app', async () => {
  await initWallet(TEST_SEED, 'chipnet');
  expectedAddr0 = getFreshAddress(0);
  expectedAddr1 = getFreshAddress(1);
  merchantXpub = testReceiveTpub();
  assert.ok(merchantXpub.startsWith('tpub'), 'test xpub is a tpub');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bchpay-m-'));
  store = new LinkStore(dir);
  merchantStore = new MerchantStore(dir);
  chain = new MockChainProvider();
  poller = new PaymentPoller({ store, chain, intervalMs: 1000, onPaid: async () => {} });
  pairing = createPairingManager({ enableRelay: false, onPaired: async () => {} });
  app = createApp({ store, merchantStore, pairing, network: 'chipnet' });
  await new Promise((r) => { const s = app.listen(0, () => { base = `http://127.0.0.1:${s.address().port}`; globalThis.__srv2 = s; r(); }); });
});

const post = (p, body) => fetch(`${base}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('POST /merchants creates a pending merchant with pairing info', async () => {
  const res = await post('/merchants', { name: 'Test Coffee' });
  assert.equal(res.status, 201);
  const j = await res.json();
  assert.ok(j.id.startsWith('m_'), 'merchant id prefix');
  assert.equal(j.name, 'Test Coffee');
  assert.equal(j.status, 'pending');
  assert.equal(j.xpub, null);
  assert.equal(j.pairing.mode, 'manual', 'relay disabled in tests -> manual mode');
  assert.ok(j.pairing.instructions.includes('/pair'), 'manual instructions mention /pair');
  merchantId = j.id;
});

test('GET /merchants lists merchants', async () => {
  const r = await fetch(`${base}/merchants`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.some((m) => m.id === merchantId));
});

test('POST /merchants/:id/pair rejects garbage, xpriv, unknown merchant', async () => {
  let r = await post(`/merchants/${merchantId}/pair`, { xpub: 'not-a-key' });
  assert.equal(r.status, 400);
  r = await post(`/merchants/${merchantId}/pair`, { xpub: testXpriv() });
  assert.equal(r.status, 400, 'xpriv must be rejected');
  r = await post('/merchants/m_unknown/pair', { xpub: merchantXpub });
  assert.equal(r.status, 404);
  // still pending after failed attempts
  const s = await (await fetch(`${base}/merchants/${merchantId}`)).json();
  assert.equal(s.status, 'pending');
});

test('POST /merchants/:id/pair with valid xpub pairs the merchant', async () => {
  const r = await post(`/merchants/${merchantId}/pair`, { xpub: merchantXpub });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.status, 'paired');
  assert.equal(j.xpub, merchantXpub);
  assert.ok(j.pairedAt);
  assert.equal(j.pairing, null, 'pairing consumed');
});

test('re-pairing an already paired merchant is rejected', async () => {
  const r = await post(`/merchants/${merchantId}/pair`, { xpub: merchantXpub });
  assert.equal(r.status, 409);
});

test('POST /links with merchantId derives from the merchant xpub', async () => {
  const r = await post('/links', { amount: 0.001, currency: 'BCH', merchantId });
  assert.equal(r.status, 201);
  const j = await r.json();
  assert.equal(j.merchantId, merchantId);
  assert.equal(j.bchAddress, expectedAddr0, 'address derived from merchant xpub at index 0');
  assert.ok(j.paymentUri.startsWith('bchtest:'));
});

test('each merchant link gets the next unique address', async () => {
  const r = await post('/links', { amount: 0.002, currency: 'BCH', merchantId });
  const j = await r.json();
  assert.equal(j.bchAddress, expectedAddr1, 'sequential per-merchant index');
});

test('POST /links rejects unknown or unpaired merchants', async () => {
  let r = await post('/links', { amount: 0.001, currency: 'BCH', merchantId: 'm_nope' });
  assert.equal(r.status, 404);
  const m2 = await (await post('/merchants', { name: 'Unpaired' })).json();
  r = await post('/links', { amount: 0.001, currency: 'BCH', merchantId: m2.id });
  assert.equal(r.status, 409, 'unpaired merchant cannot receive links');
});

test('POST /links without merchantId keeps legacy dev-wallet behavior', async () => {
  const r = await post('/links', { amount: 0.001, currency: 'BCH' });
  assert.equal(r.status, 201);
  const j = await r.json();
  assert.equal(j.merchantId, null);
  assert.ok(j.bchAddress.startsWith('bchtest:'));
});

test('xpub unit: decode/derive guards', () => {
  assert.throws(() => decodeReceiveXpub(testXpriv()), /Invalid receive xpub/);
  assert.throws(() => decodeReceiveXpub(''), /non-empty/);
  assert.throws(() => decodeReceiveXpub('xpub661MyMwAqRbcFtXgS5sYJABqqG9YLm9Qxo2C4Z8x8x8x8'), /Invalid receive xpub/);
  assert.throws(() => deriveAddressFromXpub(merchantXpub, -1, 'bchtest'), /non-negative/);
  assert.throws(() => deriveAddressFromXpub(merchantXpub, 0, 'nope'), /prefix/);
  // mainnet prefix works too
  const mainAddr = deriveAddressFromXpub(merchantXpub, 3, 'bitcoincash');
  assert.ok(mainAddr.startsWith('bitcoincash:'));
});

test('merchant payment is detected by the poller', async () => {
  const r = await post('/links', { amount: 0.001, currency: 'BCH', merchantId });
  const j = await r.json();
  chain.credit(j.bchAddress, 'txid-merchant-1', 100000);
  await poller.tick();
  const s = await (await fetch(`${base}/links/${j.id}`)).json();
  assert.equal(s.status, 'paid');
  assert.equal(s.txid, 'txid-merchant-1');
  assert.equal(s.merchantId, merchantId);
});

test('teardown', async () => {
  poller.stop();
  await stopWallet();
  await new Promise((r) => globalThis.__srv2.close(r));
  setTimeout(() => process.exit(0), 500).unref();
});
