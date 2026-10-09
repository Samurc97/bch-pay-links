import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { initWallet, stopWallet } from '../src/wallet.js';
import { LinkStore } from '../src/store.js';
import { MockChainProvider } from '../src/chain.js';
import { PaymentPoller } from '../src/poller.js';
import { createApp } from '../src/server.js';
import { demoTestXpub } from '../src/demo.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

let app, base, store, chain, poller;

test('setup: app with demo endpoints + static frontend', async () => {
  await initWallet(SEED, 'chipnet');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bchpay-front-'));
  store = new LinkStore(dir);
  chain = new MockChainProvider();
  poller = new PaymentPoller({ store, chain, intervalMs: 60_000, onPaid: async () => {} });
  const demo = {
    testXpub: () => demoTestXpub(),
    simulatePayment: (link) => {
      const txid = `demo_${crypto.randomBytes(16).toString('hex')}`;
      chain.credit(link.bchAddress, txid, link.amountSats);
      return txid;
    },
  };
  app = createApp({ store, network: 'chipnet', demo });
  await new Promise((r) => { const s = app.listen(0, () => { base = `http://127.0.0.1:${s.address().port}`; globalThis.__srv = s; r(); }); });
});

const post = (p, body) => fetch(`${base}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('GET / serves the demo frontend', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.ok(html.includes('BCH Pay Links'), 'page title present');
  assert.ok(html.includes('Pair wallet'), 'step 1 present');
  assert.ok(html.includes('Create payment link'), 'step 2 present');
  assert.ok(html.includes('Watch it confirm'), 'step 3 present');
});

test('GET /demo/test-xpub returns a tpub', async () => {
  const res = await fetch(`${base}/demo/test-xpub`);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.ok(j.xpub.startsWith('tpub'), 'demo xpub is a tpub');
  assert.equal(j.demoOnly, true);
});

test('POST /links/:id/simulate-payment flips the link to paid via the poller', async () => {
  const c = await post('/links', { amount: 0.002, currency: 'BCH', description: 'smoke' });
  assert.equal(c.status, 201);
  const link = await c.json();

  const s = await post(`/links/${link.id}/simulate-payment`, {});
  assert.equal(s.status, 200);
  const sj = await s.json();
  assert.equal(sj.ok, true);
  assert.ok(sj.txid.startsWith('demo_'));

  await poller.tick();
  const st = await (await fetch(`${base}/links/${link.id}`)).json();
  assert.equal(st.status, 'paid');
  assert.equal(st.txid, sj.txid);
});

test('POST /links/:id/simulate-payment 404s for unknown links', async () => {
  const r = await post('/links/nope/simulate-payment', {});
  assert.equal(r.status, 404);
});

test('demo endpoints are absent when no demo object is passed', async () => {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bchpay-front2-'));
  const app2 = createApp({ store: new LinkStore(dir2), network: 'chipnet' });
  await new Promise((r) => { const s = app2.listen(0, () => { globalThis.__srv2 = s; globalThis.__base2 = `http://127.0.0.1:${s.address().port}`; r(); }); });
  const r = await fetch(`${globalThis.__base2}/demo/test-xpub`);
  assert.equal(r.status, 404);
  await new Promise((r) => globalThis.__srv2.close(r));
});

test('teardown', async () => {
  poller.stop();
  await stopWallet();
  await new Promise((r) => globalThis.__srv.close(r));
  setTimeout(() => process.exit(0), 500).unref();
});
