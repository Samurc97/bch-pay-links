# BCH Pay Links

A REST API that lets merchants create **Bitcoin Cash payment links**: each link gets a
fresh on-chain address + QR code, a background poller detects the incoming BCH payment,
and the merchant gets a webhook callback. Built for the
[**BCH Blaze 2026**](https://dorahacks.io/hackathon/bchblaze2026/detail) hackathon
(Mainnet Track).

## How it works

1. `POST /links` with an amount (USD or BCH) → the API derives a **fresh receiving
   address** from the merchant's HD wallet (BIP44, explicit deposit index per link),
   converts USD→sats at the live CoinGecko rate, and returns a payment link with a
   QR code (`bchtest:`/`bitcoincash:` URI).
2. The customer pays to that address with any BCH wallet.
3. A background poller checks each pending address against a Fulcrum/Electrum
   server; when the received amount covers the invoice, the link is marked `paid`.
4. If the merchant provided a `webhookUrl`, the API POSTs a `payment.received`
   event to it.

## Live demo (for judges)

A one-page frontend at `/` walks through the whole flow with no terminal
needed — this is the live demo URL for the BCH Blaze 2026 submission.

```bash
# Full one-click demo (mock chain: no wallet, no real BCH, everything simulated)
USE_MOCK_CHAIN=true WIZARDCONNECT_RELAY=false POLL_INTERVAL_MS=5000 npm start
# → open http://localhost:3000
```

Click-through:

1. **Connect your wallet** — enter a merchant name, hit **Pair wallet**.
   Scan the pairing QR with a WizardConnect wallet, or hit
   **Simulate pairing** *(demo only)* to pair a test wallet in one click.
2. **Create payment link** — amount in USD or BCH + description →
   payment QR, `bch:` URI, amount in BCH/sats, expiry countdown.
3. **Watch it confirm** — the link polls to `PAID` with the txid once the
   poller sees the payment. Hit **Simulate payment** *(demo only)* to
   broadcast on the mock chain and watch it confirm live.

Buttons marked *demo only* call `/demo/*` endpoints, which exist **only**
when `USE_MOCK_CHAIN=true` and are never enabled against a real chain.

For a real-wallet run: `WIZARDCONNECT_RELAY=true` (default) shows the live
`WIZ://…` pairing QR; pay the link's address from any BCH wallet and the
poller detects it on chipnet (default Electrum: `chipnet.bch.ninja:50002`).

## Requirements

- Node.js 20+
- A BIP39 seed phrase for the merchant wallet (**dev seed in `.env.example` is the
  well-known test mnemonic — never use it with real funds**)

## Setup

```bash
npm install
cp .env.example .env
# edit .env: set MERCHANT_SEED (generate a fresh one for anything beyond chipnet)
npm start
```

Generate a fresh seed:

```bash
node -e "import('mainnet-js').then(async m => console.log((await m.TestNetHDWallet.newRandom()).getSeed()))"
```

## Environment variables

| Var | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `BCH_NETWORK` | `chipnet` | `chipnet` (dev) or `mainnet` (production demo) |
| `MERCHANT_SEED` | *(required)* | BIP39 mnemonic. **Never commit it.** |
| `ELECTRUM_HOST` / `ELECTRUM_PORT` | `chipnet.bch.ninja:50002` | Fulcrum/ElectrumX server for payment detection |
| `POLL_INTERVAL_MS` | `20000` | How often the poller checks pending links |
| `LINK_TTL_MINUTES` | `60` | Default payment-link lifetime |
| `USE_MOCK_CHAIN` | `false` | `true` = in-memory fake chain (tests, offline demos) |
| `DATA_DIR` | `./data` | Where `links.json` and `merchants.json` are persisted |
| `WIZARDCONNECT_RELAY` | `true` | `true` = live relay pairing QR (`WIZ://…`); `false` = manual xpub pairing only (tests, offline) |

## Merchants & WizardConnect (non-custodial)

Milestone 1 used a single server-side seed. **Milestone 2 makes the project
non-custodial**: each merchant connects their *own* wallet via
[WizardConnect](https://docs.riftenlabs.com/wizardconnect/) (the
wallet-connect protocol required by BCH Blaze 2026), and payment-link
addresses are derived from the merchant's **xpub** — the server never holds
any merchant seed.

### Pairing flow

```
Merchant's wallet                    BCH Pay Links API
       │                                      │
       │   1. POST /merchants {name}          │
       │ ───────────────────────────────────▶ │  creates merchant (status: pending)
       │                                      │  opens WizardConnect relay session
       │   2. pairing QR (WIZ://…)            │
       │ ◀─────────────────────────────────── │  merchant scans it with a
       │                                      │  WizardConnect-compatible wallet
       │   3. wallet_ready { xpub }           │
       │ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ▶ │  over the encrypted nostr relay
       │                                      │  → merchant status: paired
       │                                      │  → only the xpub is stored
       │                                      │
       │   4. POST /links { merchantId, … }   │
       │ ───────────────────────────────────▶ │  address derived from the
       │                                      │  merchant xpub (fresh index)
```

### API — merchants

**`POST /merchants`** — register + start pairing → `201`:

```json
{ "name": "Coffee Shop" }
```

```json
{
  "id": "m_9e6a441c26a2e029",
  "name": "Coffee Shop",
  "status": "pending",
  "pairing": {
    "mode": "wizardconnect",
    "qrUri": "WIZ://%3FP%3D…",
    "qrData": "data:image/png;base64,…",
    "expiresAt": "2026-10-09T16:31:00.000Z"
  }
}
```

**`POST /merchants/:id/pair`** — complete pairing with the wallet's receive
xpub (called automatically by the relay `wallet_ready` handler in production;
the same endpoint serves manual/API pairing):

```json
{ "xpub": "tpub…", "changeXpub": "tpub…" }
```

→ `200` with `status: "paired"`. Extended **private** keys (`xpriv`/`tprv`)
are rejected — the server must never receive one. `GET /merchants` and
`GET /merchants/:id` report status.

**`POST /links`** now accepts an optional `merchantId`: the address is derived
from that merchant's xpub at a per-merchant sequential index (409 if the
merchant isn't paired yet, 404 if unknown). Omitting `merchantId` keeps the
milestone-1 dev-seed behavior unchanged.

### Sandbox vs live wallet

|  | Sandbox / tests (`WIZARDCONNECT_RELAY=false`) | Live (`true`, default) |
|---|---|---|
| Pairing QR | manual-mode instructions | real `WIZ://…` relay QR |
| xpub delivery | `POST /merchants/:id/pair` | wallet `wallet_ready` over the relay |
| Address derivation | real libauth xpub→cashaddr (verified against mainnet-js) | same |
| Payment detection | mock chain or chipnet Electrum | chipnet Electrum / mainnet for the judged demo |

**Still needs a live wallet + chipnet to verify:** scanning the real QR with a
WizardConnect-compatible wallet, the end-to-end relay handshake
(`wallet_ready` → auto-pair), and deriving mainnet addresses from a real
mainnet xpub. The derivation math itself is unit-verified (see Testing).

### Security notes

- Only xpubs are stored (`data/merchants.json`); xprivs are rejected at the
  API boundary and in `decodeReceiveXpub`.
- Relay credentials live only in process memory and expire after 15 minutes
  (`PAIRING_TTL_MS`); pairing sessions are swept periodically.
- Relay socket errors are contained (see `src/wizardconnect.js`) so an
  unreachable relay can never crash the API server.

## API

### `POST /links` — create a payment link

```json
{ "amount": 5, "currency": "USD", "description": "Order #123", "webhookUrl": "https://…", "expiresInMinutes": 60 }
```

`currency` is `"USD"` (converted at the live CoinGecko BCH/USD rate, stored as
`rateUsed`) or `"BCH"`. Amounts below the 546-sat dust limit are rejected.

Response `201`:

```json
{
  "id": "9e6a441c26a2e029",
  "bchAddress": "bchtest:qp4w…",
  "amountSats": 1833382,
  "amountBch": 0.01833382,
  "paymentUri": "bchtest:qp4w…?amount=0.01833382",
  "qrData": "data:image/png;base64,…",
  "expiresAt": "2026-10-09T16:16:34.314Z",
  "status": "pending"
}
```

### `GET /links/:id` — link status

```json
{ "id": "…", "status": "pending|paid|expired", "txid": "…", "amountSats": 1833382, "bchAddress": "bchtest:…", … }
```

`txid`/`paidAt` appear once paid. `GET /links` lists all links (without QR payloads).
`GET /health` returns `{ ok, network, links }`.

### Webhook payload

```json
{ "event": "payment.received", "linkId": "…", "txid": "…", "amountSats": 1833382, "bchAddress": "bchtest:…", "paidAt": "…" }
```

## Chipnet vs mainnet

- **Develop on chipnet** (default): free test coins from the faucet at
  <https://tbch.googol.cash/>. In `mainnet-js`, the "testnet" network *is*
  chipnet (`wss://chipnet.bch.ninja:50004`); this project talks to the same
  network over plain Electrum TCP (`chipnet.bch.ninja:50002`).
- **Demo on mainnet**: set `BCH_NETWORK=mainnet`, a fresh `MERCHANT_SEED`, and a
  mainnet Electrum host. Fees are fractions of a cent; fund the merchant wallet
  with a few cents of BCH. The judged demo must broadcast at least one real
  mainnet transaction (BCH Blaze requirement).

> Note: some sandboxed/VPN networks block Electrum TCP+WebSocket ports. The
> payment poller is built behind a `ChainProvider` interface (`src/chain.js`):
> `ElectrumChainProvider` for real servers, `MockChainProvider` for tests and
> offline demos (`USE_MOCK_CHAIN=true`).

## Testing

```bash
npm test   # node --test, 30 tests across test/api.test.js + test/merchants.test.js
           # + test/frontend.test.js:
           # link creation, validation, unique addresses, mock payment
           # detection, underpayment guard, webhook delivery, expiry, 404s,
           # merchant registration/pairing, xpub validation (xpriv rejected),
           # per-merchant address derivation, backward compatibility,
           # static frontend serving, demo endpoints (present only in demo mode)
```

Live-verified in this environment: `POST /links` with USD fetched the real
CoinGecko rate (272.72 USD/BCH at test time) and derived a valid `bchtest`
address + QR; the full pending→paid→webhook cycle was exercised against the
mock chain.

## Project structure

```
src/
  index.js         entrypoint: wallet → stores → pairing → chain → poller → HTTP
  config.js        env-based configuration (no hardcoded secrets)
  wallet.js        HD wallet (mainnet-js), fresh address per link via HD index (dev mode)
  xpub.js          pure xpub → cashaddr derivation (libauth); xpriv rejected
  merchants.js     MerchantStore: merchant records + per-merchant address index
  wizardconnect.js WizardConnect pairing sessions (relay QR, wallet_ready → xpub)
  chain.js         ChainProvider: Electrum TCP + in-memory mock
  store.js         link storage (memory + links.json persistence)
  poller.js        payment detection loop + webhook dispatcher
  price.js         BCH/USD rate (CoinGecko, 60s cache)
  server.js        Express app: static frontend + /merchants*, POST /links
                   (merchantId?), GET /links/:id, /health, demo-only /demo/*
  demo.js          demo-only helpers (test xpub); wired in only with USE_MOCK_CHAIN=true
public/
  index.html       one-page demo frontend (no build step): pair → create link → watch confirm
test/
  api.test.js       integration tests, milestone 1 (mock chain)
  merchants.test.js WizardConnect pairing + xpub derivation tests
  frontend.test.js  static serving + demo endpoints smoke tests
```

## BCH Blaze 2026 submission checklist (Mainnet Track)

| Requirement | Status |
|---|---|
| Original project built during the hackathon | ✅ BCH Pay Links |
| ≥1 feature sending BCH mainnet transactions | ✅ payment links pay real on-chain addresses (chipnet-verified; mainnet = milestone 4) |
| Live demo via website link | ✅ one-page frontend at `/` (pair → create → confirm) |
| WizardConnect wallet integration | ✅ relay QR pairing + manual xpub pairing; server stores only xpubs |
| Public GitHub repo | ⬜ to publish |
| Attend ≥1 prep livestream (roll call) | ⬜ pending schedule |
| Confirm project in Telegram (t.me/bchblaze) | ⬜ to do |
| Submission window Nov 13–21, 2026 | ⬜ upcoming |
| Mainnet shakedown (≥1 real mainnet tx for judged demo) | ⬜ milestone 4 |

## Roadmap

- [x] **Milestone 1** — payment links, poller, webhooks (done, 10/10 tests).
- [x] **Milestone 2** — WizardConnect integration: merchants pair their own
  wallet by scanning a QR; links derive from the merchant xpub; the server
  holds no merchant seed (done, 23/23 tests).
- [x] **Milestone 3 — demo frontend**: one-page walkthrough served at `/`
  (pair via QR, create link, payment QR, live status polling, demo-only
  simulate buttons). 30/30 tests passing.
- [ ] **Milestone 4 — mainnet shakedown**: end-to-end payment on mainnet with
  real (tiny) BCH; judged demo must broadcast ≥1 real mainnet transaction.
