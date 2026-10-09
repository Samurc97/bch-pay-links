import crypto from 'crypto';
import QRCode from 'qrcode';
import { useWebSocketImplementation } from 'nostr-tools/pool';
import NodeWebSocket from 'isomorphic-ws';
import { initiateDappRelay } from '@wizardconnect/core';
import { DappConnectionManager } from '@wizardconnect/dapp';

/**
 * The relay transport (nostr-tools SimplePool) surfaces async WebSocket
 * errors — e.g. the relay being unreachable — as unhandled 'error' events,
 * which would otherwise crash the whole API server. Contain them here: the
 * pool still sees the socket 'close' and applies its own reconnect policy.
 * This only affects nostr-tools pool sockets (the WizardConnect relay);
 * mainnet-js manages its own sockets separately.
 */
class RelaySafeWebSocket extends NodeWebSocket {
  constructor(url, protocols) {
    super(url, protocols);
    this.on('error', (err) => {
      console.warn('[wizardconnect] relay socket error (contained, pool will retry):', err && err.message);
    });
  }
}
useWebSocketImplementation(RelaySafeWebSocket);

/**
 * WizardConnect pairing sessions.
 *
 * Real flow (relay enabled):
 *   1. POST /merchants → createSession() calls initiateDappRelay(), which
 *      generates key-exchange credentials and a connection URI. The merchant
 *      scans the returned QR (WIZ://…) with a WizardConnect-compatible wallet.
 *   2. The wallet connects over the encrypted nostr relay and answers
 *      wallet_ready with its BIP32 xpubs (named paths: 'receive', 'change'…).
 *   3. The 'walletready' handler extracts the receive xpub and calls
 *      onPaired(merchantId, { xpub, changeXpub }) — the server stores ONLY
 *      the xpub. The seed never leaves the merchant's wallet.
 *   4. Payment-link addresses are later derived locally from that xpub
 *      (see src/xpub.js) — no further round-trips needed.
 *
 * Sandbox/manual mode (enableRelay=false, e.g. tests or WIZARDCONNECT_RELAY=false):
 *   no relay is opened; pairing completes via POST /merchants/:id/pair with
 *   the xpub. This is also the documented fallback when no live wallet/relay
 *   is reachable.
 *
 * Sessions live in memory (relay credentials must never touch disk) and
 * expire after PAIRING_TTL_MS; sweepExpired() cleans them up.
 */
export const PAIRING_TTL_MS = 15 * 60 * 1000;

export function createPairingManager({ enableRelay = true, onPaired }) {
  const sessions = new Map(); // sessionId -> { relay, manager, merchantId, expiresAt }

  async function createSession(merchantId) {
    const sessionId = crypto.randomBytes(8).toString('hex');
    const createdAt = Date.now();
    const expiresAt = new Date(createdAt + PAIRING_TTL_MS).toISOString();

    if (!enableRelay) {
      return {
        sessionId,
        mode: 'manual',
        qrUri: null,
        qrData: null,
        expiresAt,
        instructions:
          'Relay disabled (sandbox). Complete pairing by POSTing the wallet\'s ' +
          `receive xpub to /merchants/${merchantId}/pair as { "xpub": "<tpub…|xpub…>" }.`,
      };
    }

    const manager = new DappConnectionManager('BCH Pay Links', undefined, { session: false });
    let relay;
    try {
      relay = initiateDappRelay((payload) => {
        try {
          manager.updateConnection(payload.client, payload.status);
        } catch { /* relay state hiccup — keep waiting */ }
      });
    } catch (e) {
      throw new Error(`Could not initiate WizardConnect relay: ${e.message}`);
    }
    try {
      manager.attachRelay(relay);
    } catch { /* non-fatal */ }

    manager.on('walletready', () => {
      try {
        const paths = manager.getSessionPaths();
        const receive = paths.find((p) => p.name === 'receive');
        const change = paths.find((p) => p.name === 'change');
        if (!receive || !receive.xpub) {
          console.warn('[wizardconnect] wallet_ready without a receive xpub; ignoring');
          return;
        }
        Promise.resolve(
          onPaired(merchantId, { xpub: receive.xpub, changeXpub: change && change.xpub ? change.xpub : null })
        ).catch((e) => console.warn('[wizardconnect] onPaired failed:', e.message));
      } catch (e) {
        console.warn('[wizardconnect] walletready handler failed:', e.message);
      } finally {
        closeSession(sessionId);
      }
    });

    let qrData = null;
    try {
      qrData = await QRCode.toDataURL(relay.qrUri, { width: 320, margin: 2 });
    } catch (e) {
      console.warn('[wizardconnect] QR render failed:', e.message);
    }

    sessions.set(sessionId, {
      relay,
      manager,
      merchantId,
      expiresAt: createdAt + PAIRING_TTL_MS,
    });
    return { sessionId, mode: 'wizardconnect', qrUri: relay.qrUri, qrData, expiresAt };
  }

  function closeSession(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return;
    sessions.delete(sessionId);
    try { s.relay.cleanup(); } catch { /* ignore */ }
    try { s.manager.destroy(); } catch { /* ignore */ }
  }

  function sweepExpired() {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (s.expiresAt <= now) closeSession(id);
    }
  }

  return { createSession, closeSession, sweepExpired };
}
