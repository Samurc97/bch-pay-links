/**
 * Background poller: watches every pending link's address for incoming
 * BCH transactions. On payment -> marks link paid and fires the webhook.
 * On expiry (past expiresAt) -> marks link expired.
 *
 * Runs on a timer; each cycle is independent so one bad address never
 * blocks the rest.
 */
export class PaymentPoller {
  constructor({ store, chain, intervalMs, onPaid }) {
    this.store = store;
    this.chain = chain;
    this.intervalMs = intervalMs;
    this.onPaid = onPaid;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((e) =>
      console.error('[poller] tick failed:', e.message)), this.intervalMs);
    // run once immediately (async, don't block startup)
    this.tick().catch((e) => console.error('[poller] first tick failed:', e.message));
    console.log(`[poller] watching every ${this.intervalMs}ms`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      for (const link of this.store.pending()) {
        if (new Date(link.expiresAt).getTime() <= now) {
          this.store.update(link.id, { status: 'expired' });
          console.log(`[poller] link ${link.id} expired`);
          continue;
        }
        await this.checkLink(link).catch((e) =>
          console.error(`[poller] check ${link.id} failed:`, e.message));
      }
    } finally {
      this.running = false;
    }
  }

  async checkLink(link) {
    const history = await this.chain.getAddressHistory(link.bchAddress);
    for (const { txHash } of history) {
      const tx = await this.chain.getTransaction(txHash);
      const received = tx.outputs
        .filter((o) => o.address === link.bchAddress)
        .reduce((sum, o) => sum + o.valueSats, 0);
      if (received >= link.amountSats) {
        const updated = this.store.update(link.id, {
          status: 'paid',
          txid: tx.txid,
          paidAt: new Date().toISOString(),
        });
        console.log(`[poller] link ${link.id} PAID in ${tx.txid} (${received} sats)`);
        if (this.onPaid) {
          this.onPaid(updated).catch((e) =>
            console.error(`[poller] onPaid hook failed for ${link.id}:`, e.message));
        }
        return;
      }
    }
  }
}

/** POST the payment event to the merchant webhook URL (fire-and-forget). */
export async function fireWebhook(link) {
  if (!link.webhookUrl) return;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(link.webhookUrl, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'bch-pay-links/0.1' },
      body: JSON.stringify({
        event: 'payment.received',
        linkId: link.id,
        status: link.status,
        txid: link.txid,
        amountSats: link.amountSats,
        bchAddress: link.bchAddress,
        paidAt: link.paidAt,
      }),
    });
    console.log(`[webhook] ${link.webhookUrl} -> HTTP ${res.status}`);
  } catch (e) {
    console.error(`[webhook] ${link.webhookUrl} failed:`, e.message);
  } finally {
    clearTimeout(t);
  }
}
