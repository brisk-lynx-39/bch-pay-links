# BCH Pay Links

**Shareable Bitcoin Cash payment requests with a QR code, live fiat conversion, and live on-chain payment detection — 100% client-side and watch-only.**

🔗 Turn any BCH address into a payment page like:

```
https://your-host.example/?to=bitcoincash:q…&famt=25&cur=USD&label=Invoice%20%231042
```

The payer opens the link, scans the QR with any BCH wallet, pays — and the page itself confirms the payment on the Bitcoin Cash blockchain, live. No sign-up, no backend, no custody, no fees.

> Built for the **BCH BLAZE 2026** hackathon (Bitcoin Cash ecosystem, Mainnet Track). The app runs entirely against **BCH mainnet** with real addresses.

---

## The problem

Getting paid in Bitcoin Cash today is clunky:

- You paste a raw address into a chat and hope the payer copies it correctly and sends the right amount.
- If you price in USD or CNY, someone has to do exchange-rate math — and guess whose rate, at what moment.
- After paying, the payer screenshots a wallet screen; you refresh a block explorer by hand to check whether the money actually arrived, and whether it confirmed.

Invoices, freelance payments, donations and in-person sales all hit the same friction. Existing payment-link tools solve this with a custodial backend and an account — giving up the permissionless point of BCH.

## How it works

**Create** — Enter your own public BCH address (CashAddr, checksum-validated in the browser), an amount in **BCH, USD or CNY**, and an optional label/memo. The app generates a shareable link (and a QR of the link). Fiat-denominated links stay in fiat: conversion happens live when the page is opened, so the payer always sees a current rate.

**Pay** — The payment page renders a standard **BIP21 `bitcoincash:` QR** any wallet can scan, the address with one-tap copy, a “Pay with a BCH wallet” button, and both amounts (fiat ↔ BCH) with the live price and its source.

**Confirm** — The page watches the blockchain itself. Every ~20 seconds it polls a public indexer, diffs new outputs to the address against the moment the page loaded, and walks through clear states:

`Waiting → Partial payment → Detected (awaiting confirmation) → Payment received ✓`

with a progress bar, amounts received/remaining, and links to the actual transactions. No refresh, no explorer-hunting.

## Features

- 🔗 **Payment links & QR codes** — for the link itself and for the BIP21 wallet payment
- ✅ **Full CashAddr validation** — real checksum verification (polymod) implemented from the spec, not a regex; legacy addresses accepted too
- 💱 **Live fiat conversion** — CoinGecko primary, Coinbase fallback; the BCH amount on fiat requests updates with the rate until paid
- 👀 **Live payment watcher** — Bitcore primary, Haskoin fallback; distinguishes mempool-detected vs block-confirmed, partial vs full payment
- 🛟 **Graceful degradation** — every data source has a fallback; if all are unreachable the page falls back to a static request with an explorer link instead of breaking
- 📱 **Mobile-first, zero build** — plain HTML/CSS/JS, no framework, no bundler, no tracking; works from any static host
- 🔒 **Watch-only by design** — see the security model below

## Security model — watch-only

This is the core design constraint:

- The app **never asks for, accepts, stores or transmits private keys or seed phrases.** There is no code path that could handle one — the only inputs are a *public* address, an amount and text labels.
- A BCH address is public information; sharing it (and watching it) cannot put funds at risk.
- All blockchain and price data comes from public, read-only APIs over HTTPS. Nothing is signed, nothing is broadcast, no wallet is connected.
- The UI says this out loud on both pages, including an anti-phishing note on the payment page: *no legitimate payment ever requires entering a seed phrase to “confirm” it.*

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | Vanilla HTML/CSS/JS — no framework, no build step |
| QR codes | [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4 (MIT), **vendored locally** so the demo works offline |
| Address logic | Hand-rolled CashAddr codec (decode + checksum + encode) in `assets/core.js` |
| Prices | CoinGecko simple-price API → Coinbase spot API (both keyless, CORS-enabled) |
| Chain data | Bitcore API (`api.bitcore.io`, per-output records) → Haskoin API (`api.haskoin.com`, balance/tx deltas) |
| Hosting | Any static host — GitHub Pages, Netlify, IPFS, a USB stick |

## Run it / deploy it

No build step. Either:

```bash
# Local
python3 -m http.server 8000
# → http://localhost:8000
```

…or deploy the whole folder to any static host. For **GitHub Pages**: push this repo, then *Settings → Pages → Deploy from branch → main / (root)*.

Try a live payment page (spec example address, watch-only):

```
./?to=bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a&amount=0.05&label=Invoice%20%231042
```

## Project layout

```
.
├── index.html            # create view + pay view + error view
├── assets/
│   ├── style.css         # all styling (mobile-first)
│   ├── core.js           # pure logic: CashAddr, BIP21, links, amounts (UMD — also used by tests)
│   ├── app.js            # UI, price service, chain watcher with provider fallback
│   └── qrcode.js         # vendored qrcode-generator 1.4.4 (MIT, © Kazuhiko Arase)
├── test/
│   ├── run-tests.mjs     # 37 checks: unit tests + QR generation + live API smoke tests
│   └── decode-qr.py      # independent check: decodes the generated QR with OpenCV
└── LICENSE               # MIT
```

## Tests

```bash
NODE_USE_ENV_PROXY=1 node test/run-tests.mjs   # unit + live API smoke tests
python3 test/decode-qr.py                      # optional: OpenCV decode of the QR (needs opencv-python-headless)
```

Highlights: the CashAddr codec is verified against the specification's example address and its on-chain hash; the QR code is decoded by an independent library to prove it scans to the exact BIP21 URI; the watcher's baseline-diff is exercised against live mainnet data.

## Known limitations

- The watcher detects payments made **after the payment page is opened** (the natural flow: the payer opens the page, then pays). Payments sent before the page loads can be verified via the explorer link shown on the page.
- Free public APIs are rate-limited; polling is deliberately gentle (~20 s) and the provider fallback absorbs single-source outages.
- Fiat rates are indicative spot prices for display and amount-setting — the chain itself only ever moves BCH.

## License

MIT — see [LICENSE](LICENSE). The vendored QR library is MIT, © Kazuhiko Arase.

---

*Built for **BCH BLAZE 2026** — a new, open-source project created during the event window. Solo entry by [@brisk-lynx-39](https://github.com/brisk-lynx-39).*
