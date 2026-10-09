import net from 'net';

/**
 * Chain access abstraction.
 *
 * Payment detection only needs two reads:
 *   - getAddressHistory(address) -> [{ txHash, height }]
 *   - getTransaction(txHash)     -> { txid, outputs: [{ address, valueSats }] }
 *
 * ElectrumChainProvider speaks the Electrum protocol over plain TCP
 * (Fulcrum/ElectrumX servers, e.g. chipnet.bch.ninja:50002).
 * MockChainProvider is an in-memory fake used by tests and local demos
 * when no chain server is reachable.
 */

const REQUEST_TIMEOUT_MS = 15000;

export class ElectrumChainProvider {
  constructor(host, port) {
    this.host = host;
    this.port = port;
    this.sock = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
    this.connecting = null;
  }

  async _connect() {
    if (this.sock && !this.sock.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const s = net.connect(this.port, this.host);
      const onErr = (e) => { this.connecting = null; reject(e); };
      s.once('connect', () => {
        s.removeListener('error', onErr);
        this.sock = s;
        s.on('data', (d) => this._onData(d));
        s.on('error', () => this._drop());
        s.on('close', () => this._drop());
        this.connecting = null;
        resolve();
      });
      s.once('error', onErr);
      setTimeout(() => onErr(new Error(`Electrum connect timeout ${this.host}:${this.port}`)), REQUEST_TIMEOUT_MS);
    });
    return this.connecting;
  }

  _drop() {
    for (const [, p] of this.pending) p.reject(new Error('Electrum connection lost'));
    this.pending.clear();
    this.sock = null;
  }

  _onData(d) {
    this.buf += d.toString('utf8');
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`Electrum error: ${JSON.stringify(msg.error)}`));
      else p.resolve(msg.result);
    }
  }

  async _request(method, params) {
    await this._connect();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Electrum request timeout: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.sock.write(JSON.stringify({ id, method, params }) + '\n', (err) => {
        if (err) { this.pending.delete(id); clearTimeout(timer); reject(err); }
      });
    });
  }

  async getAddressHistory(address) {
    const res = await this._request('blockchain.address.get_history', [address]);
    return (res || []).map((h) => ({ txHash: h.tx_hash, height: h.height }));
  }

  async getTransaction(txHash) {
    const tx = await this._request('blockchain.transaction.get', [txHash, true]);
    const outputs = (tx.vout || []).map((o) => ({
      address: o.scriptPubKey && o.scriptPubKey.addresses ? o.scriptPubKey.addresses[0] : null,
      valueSats: Math.round(parseFloat(o.value) * 1e8),
    }));
    return { txid: tx.txid || txHash, outputs };
  }

  close() {
    if (this.sock) this.sock.destroy();
    this.sock = null;
  }
}

/** In-memory fake chain for tests / offline demos. */
export class MockChainProvider {
  constructor() {
    this.txs = new Map(); // txid -> { outputs: [{address, valueSats}] }
    this.byAddress = new Map(); // address -> [txid]
  }

  /** Simulate an incoming payment. */
  credit(address, txid, valueSats) {
    if (!this.txs.has(txid)) {
      this.txs.set(txid, { txid, outputs: [] });
    }
    this.txs.get(txid).outputs.push({ address, valueSats });
    if (!this.byAddress.has(address)) this.byAddress.set(address, []);
    if (!this.byAddress.get(address).includes(txid)) this.byAddress.get(address).push(txid);
  }

  async getAddressHistory(address) {
    return (this.byAddress.get(address) || []).map((txHash) => ({ txHash, height: 1 }));
  }

  async getTransaction(txHash) {
    const tx = this.txs.get(txHash);
    if (!tx) throw new Error(`Unknown tx ${txHash}`);
    return tx;
  }
}
