import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * Payment-link store. In-memory Map with JSON file persistence
 * (data/links.json, gitignored) so links survive restarts.
 *
 * Link shape:
 * {
 *   id, bchAddress, addressIndex, amountSats, currency, fiatAmount,
 *   rateUsed, description, webhookUrl, status: 'pending'|'paid'|'expired',
 *   txid, createdAt, expiresAt, paidAt
 * }
 */
export class LinkStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'links.json');
    this.links = new Map();
    this.nextIndex = 0;
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const l of raw.links || []) this.links.set(l.id, l);
      this.nextIndex = raw.nextIndex || this.links.size;
    } catch (e) {
      console.warn('[store] could not load links.json, starting fresh:', e.message);
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(
        this.file,
        JSON.stringify({ nextIndex: this.nextIndex, links: [...this.links.values()] }, null, 2)
      );
    } catch (e) {
      console.warn('[store] could not persist links.json:', e.message);
    }
  }

  /** Reserve the next HD derivation index for a new link. */
  claimIndex() {
    return this.nextIndex++;
  }

  create(link) {
    const id = crypto.randomBytes(8).toString('hex');
    const full = { id, status: 'pending', createdAt: new Date().toISOString(), ...link };
    this.links.set(id, full);
    this._save();
    return full;
  }

  get(id) {
    return this.links.get(id) || null;
  }

  update(id, patch) {
    const l = this.links.get(id);
    if (!l) return null;
    Object.assign(l, patch);
    this.links.set(id, l);
    this._save();
    return l;
  }

  pending() {
    return [...this.links.values()].filter((l) => l.status === 'pending');
  }

  all() {
    return [...this.links.values()];
  }
}
