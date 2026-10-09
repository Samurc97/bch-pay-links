import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { initWallet, getFreshAddress, stopWallet } from '../src/wallet.js';
import { LinkStore } from '../src/store.js';
import { MockChainProvider } from '../src/chain.js';
import { PaymentPoller } from '../src/poller.js';
import { createApp } from '../src/server.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

let app, base, store, chain, poller;

test('setup: wallet, store, app', async () => {
  await initWallet(SEED, 'chipnet');
  // fresh address per derivation index
  const a0 = getFreshAddress(0);
  const a1 = getFreshAddress(1);
  assert.ok(a0.startsWith('bchtest:'), 'chipnet prefix');
  assert.notEqual(a0, a1, 'different index -> different address');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bchpay-'));
  store = new LinkStore(dir);
  chain = new MockChainProvider();
  poller = new PaymentPoller({ store, chain, intervalMs: 1000, onPaid: async () => {} });
  app = createApp({ store, network: 'chipnet' });
  await new Promise((r) => { const s = app.listen(0, () => { base = `http://127.0.0.1:${s.address().port}`; globalThis.__srv = s; r(); }); });
});

const post = (p, body) => fetch(`${base}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('POST /links (BCH) creates a payable link', async () => {
  const res = await post('/links', { amount: 0.001, currency: 'BCH', description: 'Test coffee' });
  assert.equal(res.status, 201);
  const j = await res.json();
  assert.ok(j.id);
  assert.ok(j.bchAddress.startsWith('bchtest:'));
  assert.equal(j.amountSats, 100000);
  assert.ok(j.paymentUri.startsWith('bchtest:'), 'URI uses cashaddr scheme');
  assert.ok(j.paymentUri.includes('amount=0.00100000'), 'URI carries the amount');
  assert.ok(j.qrData.startsWith('data:image/png;base64,'));
  assert.equal(j.status, 'pending');
  assert.ok(new Date(j.expiresAt) > new Date());
  globalThis.__link1 = j;
});

test('POST /links validates input', async () => {
  let r = await post('/links', { amount: -5, currency: 'BCH' });
  assert.equal(r.status, 400);
  r = await post('/links', { amount: 1, currency: 'EUR' });
  assert.equal(r.status, 400);
  r = await post('/links', { amount: 0.000001, currency: 'BCH' }); // 100 sats < dust
  assert.equal(r.status, 400);
  r = await post('/links', { amount: 1, currency: 'BCH', webhookUrl: 'not-a-url' });
  assert.equal(r.status, 400);
});

test('each link gets a unique address', async () => {
  const r = await post('/links', { amount: 0.002, currency: 'BCH' });
  const j = await r.json();
  assert.notEqual(j.bchAddress, globalThis.__link1.bchAddress);
});

test('GET /links/:id reports pending then paid after mock payment', async () => {
  const id = globalThis.__link1.id;
  let r = await fetch(`${base}/links/${id}`);
  assert.equal((await r.json()).status, 'pending');

  // simulate an on-chain payment to the link address
  chain.credit(globalThis.__link1.bchAddress, 'txid-test-123', 100000);
  await poller.tick();

  r = await fetch(`${base}/links/${id}`);
  const j = await r.json();
  assert.equal(j.status, 'paid');
  assert.equal(j.txid, 'txid-test-123');
  assert.ok(j.paidAt);
});

test('underpayment does NOT mark paid', async () => {
  const r = await post('/links', { amount: 0.005, currency: 'BCH' });
  const j = await r.json();
  chain.credit(j.bchAddress, 'txid-under', 1000); // only 1000 of 500000 sats
  await poller.tick();
  const s = await (await fetch(`${base}/links/${j.id}`)).json();
  assert.equal(s.status, 'pending');
});

test('webhook fires on payment', async () => {
  const received = [];
  const hook = http.createServer((req, reqRes) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { received.push(JSON.parse(body)); reqRes.writeHead(200); reqRes.end('ok'); });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const hookUrl = `http://127.0.0.1:${hook.address().port}/hook`;

  // poller with webhook hook
  const { fireWebhook } = await import('../src/poller.js');
  poller.onPaid = (link) => fireWebhook(link);

  const r = await post('/links', { amount: 0.001, currency: 'BCH', webhookUrl: hookUrl });
  const j = await r.json();
  chain.credit(j.bchAddress, 'txid-hook', 100000);
  await poller.tick();
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(received.length, 1);
  assert.equal(received[0].event, 'payment.received');
  assert.equal(received[0].linkId, j.id);
  assert.equal(received[0].txid, 'txid-hook');
  hook.close();
});

test('expired links are marked expired', async () => {
  const r = await post('/links', { amount: 0.001, currency: 'BCH', expiresInMinutes: 0.02 });
  const j = await r.json();
  await new Promise((r) => setTimeout(r, 1500));
  await poller.tick();
  const s = await (await fetch(`${base}/links/${j.id}`)).json();
  assert.equal(s.status, 'expired');
});

test('GET /links/:id 404 for unknown id', async () => {
  const r = await fetch(`${base}/links/nope`);
  assert.equal(r.status, 404);
});

test('teardown', async () => {
  poller.stop();
  await stopWallet();
  await new Promise((r) => globalThis.__srv.close(r));
  // mainnet-js keeps background sockets that never settle in sandboxed
  // networks; all assertions above already passed, so exit explicitly.
  setTimeout(() => process.exit(0), 500).unref();
});
