import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { decodeReceiveXpub } from './xpub.js';

/**
 * Merchant store. Each merchant pairs their OWN wallet via WizardConnect;
 * the server stores only the merchant's receive xpub (public!) — never a
 * seed or private key. Payment-link addresses are derived per merchant from
 * their xpub at an explicit per-merchant index.
 *
 * Merchant shape:
 * {
 *   id: 'm_<hex>', name, status: 'pending'|'paired',
 *   xpub, changeXpub, xpubNetwork, nextIndex,
 *   pairing: { sessionId, mode, qrUri, qrData, expiresAt } | null,
 *   createdAt, pairedAt
 * }
 *
 * NOTE: no secrets are stored here. Relay credentials live only in the
 * in-memory pairing manager (src/wizardconnect.js), never on disk.
 */
export class MerchantStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'merchants.json');
    this.merchants = new Map();
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const m of raw.merchants || []) this.merchants.set(m.id, m);
    } catch (e) {
      console.warn('[merchants] could not load merchants.json, starting fresh:', e.message);
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ merchants: [...this.merchants.values()] }, null, 2));
    } catch (e) {
      console.warn('[merchants] could not persist merchants.json:', e.message);
    }
  }

  create({ name }) {
    const id = 'm_' + crypto.randomBytes(8).toString('hex');
    const clean = typeof name === 'string' && name.trim() ? name.trim().slice(0, 120) : null;
    const m = {
      id,
      name: clean || `Merchant ${id.slice(2, 8)}`,
      status: 'pending',
      xpub: null,
      changeXpub: null,
      xpubNetwork: null,
      nextIndex: 0,
      pairing: null,
      createdAt: new Date().toISOString(),
      pairedAt: null,
    };
    this.merchants.set(id, m);
    this._save();
    return m;
  }

  get(id) {
    return this.merchants.get(id) || null;
  }

  all() {
    return [...this.merchants.values()];
  }

  setPairing(id, pairing) {
    const m = this.get(id);
    if (!m) return null;
    m.pairing = pairing;
    this._save();
    return m;
  }

  /**
   * Complete pairing by storing the merchant's receive xpub.
   * In production this is invoked by the WizardConnect wallet_ready handler;
   * the same entry point serves manual/API pairing (tests, offline demos).
   * Returns { merchant } or { error, message? }.
   */
  pair(id, { xpub, changeXpub }) {
    const m = this.get(id);
    if (!m) return { error: 'not_found' };
    if (m.status === 'paired') return { error: 'already_paired' };

    let decoded;
    try {
      decoded = decodeReceiveXpub(xpub); // throws on xpriv / garbage / bad checksum
    } catch (e) {
      return { error: 'invalid_xpub', message: e.message };
    }
    if (changeXpub !== undefined && changeXpub !== null && changeXpub !== '') {
      try {
        decodeReceiveXpub(changeXpub);
      } catch (e) {
        return { error: 'invalid_change_xpub', message: e.message };
      }
    }

    m.xpub = xpub.trim();
    m.changeXpub = changeXpub ? changeXpub.trim() : null;
    m.xpubNetwork = decoded.network || null; // informational only
    m.status = 'paired';
    m.pairedAt = new Date().toISOString();
    m.pairing = null; // pairing consumed
    this._save();
    return { merchant: m };
  }

  /** Reserve the next derivation index for this merchant's links. */
  claimIndex(id) {
    const m = this.get(id);
    if (!m) return null;
    const idx = m.nextIndex++;
    this._save();
    return idx;
  }
}
