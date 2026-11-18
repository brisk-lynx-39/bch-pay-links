/*
 * BCH Pay Links — app logic.
 *
 * Two views in one static page:
 *  - Create view (no query params): build a shareable payment link.
 *  - Pay view (?to=...): show the request, a BIP21 QR, live fiat conversion
 *    and a watch-only on-chain payment detector.
 *
 * Data sources (all public, CORS-enabled, no keys):
 *  - Prices: CoinGecko (primary) → Coinbase (fallback)
 *  - Chain data: Bitcore (primary) → Haskoin (fallback)
 * If every source fails, the page degrades to a static request with an
 * explorer link instead of breaking.
 *
 * Watch-only: nothing in this file can receive or use a private key or
 * seed phrase. It only reads public blockchain data.
 */
(function () {
  "use strict";
  const C = window.BCHCore;
  const $ = (sel) => document.querySelector(sel);

  const POLL_MS = 20000;
  const PRICE_REFRESH_MS = 60000;
  const FIAT_CURRENCIES = ["USD", "CNY", "EUR"];

  /* ---------------- small utilities ---------------- */

  async function fetchJSON(url, timeoutMs = 10000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function renderQR(el, text) {
    try {
      window.qrcode.stringToBytes = window.qrcode.stringToBytesFuncs["UTF-8"];
      const qr = window.qrcode(0, "M");
      qr.addData(text, "Byte");
      qr.make();
      el.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true });
      return true;
    } catch (e) {
      el.innerHTML = '<p style="color:#5b6f66;font-size:13px;padding:12px;text-align:center">' +
        "QR code unavailable — please copy the address below.</p>";
      return false;
    }
  }

  async function copyText(text, btn) {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
      ta.remove();
    }
    if (ok && btn) {
      const old = btn.textContent;
      btn.textContent = "Copied ✓";
      btn.classList.add("copied");
      setTimeout(() => { btn.textContent = old; btn.classList.remove("copied"); }, 1600);
    }
  }

  function showView(id) {
    for (const v of ["view-create", "view-pay", "view-error"]) {
      document.getElementById(v).classList.toggle("hidden", v !== id);
    }
  }

  function timeStr(d) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function explorerTxUrl(txid) {
    return "https://blockchair.com/bitcoin-cash/transaction/" + txid;
  }
  function explorerAddrUrl(bare) {
    return "https://blockchair.com/bitcoin-cash/address/" + bare;
  }

  /* ---------------- price service ---------------- */

  const PriceService = {
    cache: new Map(), // CUR -> { price, source, at }
    TTL: 45000,
    async getPrice(currency) {
      const cur = currency.toUpperCase();
      const hit = this.cache.get(cur);
      if (hit && Date.now() - hit.at < this.TTL) return hit;
      try {
        const j = await fetchJSON(
          "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash&vs_currencies=usd,cny,eur"
        );
        const row = (j && j["bitcoin-cash"]) || {};
        for (const c of FIAT_CURRENCIES) {
          const v = row[c.toLowerCase()];
          if (v > 0) this.cache.set(c, { price: v, source: "CoinGecko", at: Date.now() });
        }
        if (this.cache.has(cur)) return this.cache.get(cur);
        throw new Error("CoinGecko has no " + cur);
      } catch (e) {
        /* fall through to Coinbase */
      }
      const j = await fetchJSON("https://api.coinbase.com/v2/prices/BCH-" + cur + "/spot");
      const price = parseFloat(j && j.data && j.data.amount);
      if (!(price > 0)) throw new Error("Price unavailable for " + cur);
      const entry = { price, source: "Coinbase", at: Date.now() };
      this.cache.set(cur, entry);
      return entry;
    },
  };

  /* ---------------- chain watcher providers ---------------- */
  /*
   * Provider contract: poll() resolves to
   *   { confirmedSat, pendingSat, txids }
   * measured as *new* incoming value since the provider's baseline, which is
   * established silently on its first successful poll. "Confirmed" means the
   * output is in a block; "pending" means seen in the mempool only.
   */

  function makeBitcoreProvider(bareAddr) {
    return {
      name: "Bitcore",
      baseline: null,
      async poll() {
        const url = "https://api.bitcore.io/api/BCH/mainnet/address/" +
          encodeURIComponent(bareAddr) + "/txs?limit=50";
        const records = await fetchJSON(url);
        if (!Array.isArray(records)) throw new Error("Unexpected Bitcore response");
        const key = (r) => r.mintTxid + ":" + r.mintIndex;
        if (!this.baseline) {
          this.baseline = new Set(records.map(key));
          return { confirmedSat: 0, pendingSat: 0, txids: [] };
        }
        let confirmedSat = 0, pendingSat = 0;
        const txids = [];
        for (const r of records) {
          if (this.baseline.has(key(r)) || !(r.value > 0)) continue;
          if (r.mintHeight > 0) confirmedSat += r.value; else pendingSat += r.value;
          if (!txids.includes(r.mintTxid)) txids.push(r.mintTxid);
        }
        return { confirmedSat, pendingSat, txids };
      },
    };
  }

  function makeHaskoinProvider(bareAddr) {
    return {
      name: "Haskoin",
      baseline: null,
      async poll() {
        const base = "https://api.haskoin.com/bch/address/" + encodeURIComponent(bareAddr);
        const [bal, txs] = await Promise.all([
          fetchJSON(base + "/balance"),
          fetchJSON(base + "/transactions?limit=10"),
        ]);
        if (!bal || typeof bal.received !== "number") throw new Error("Unexpected Haskoin response");
        const list = Array.isArray(txs) ? txs : [];
        if (!this.baseline) {
          this.baseline = {
            received: bal.received,
            unconfirmed: bal.unconfirmed || 0,
            txids: new Set(list.map((t) => t.txid)),
          };
          return { confirmedSat: 0, pendingSat: 0, txids: [] };
        }
        const confirmedSat = Math.max(0, bal.received - this.baseline.received);
        const pendingSat = Math.max(0, (bal.unconfirmed || 0) - this.baseline.unconfirmed);
        const txids = list.filter((t) => !this.baseline.txids.has(t.txid)).map((t) => t.txid);
        return { confirmedSat, pendingSat, txids };
      },
    };
  }

  /* ---------------- CREATE VIEW ---------------- */

  function initCreateView() {
    showView("view-create");
    let currency = "BCH";
    let previewTimer = null;

    const addrInput = $("#addr");
    const amountInput = $("#amount");
    const addrError = $("#addr-error");
    const amountError = $("#amount-error");
    const preview = $("#amount-preview");

    document.querySelectorAll(".seg").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".seg").forEach((b) => b.classList.toggle("active", b === btn));
        currency = btn.dataset.cur;
        amountInput.placeholder = currency === "BCH" ? "0.05" : "25";
        schedulePreview();
      });
    });

    async function updatePreview() {
      const amt = C.parseAmountInput(amountInput.value);
      if (!(amt > 0)) { preview.textContent = ""; return; }
      try {
        if (currency === "BCH") {
          const p = await PriceService.getPrice("USD");
          preview.textContent = "≈ " + C.formatFiat(amt * p.price, "USD") +
            " at the live rate (" + p.source + ").";
        } else {
          const p = await PriceService.getPrice(currency);
          const bch = C.fiatToBCH(amt, p.price);
          preview.textContent = "≈ " + C.formatBCHAmount(bch) + " BCH at the live rate (" + p.source +
            "). The link stays in " + currency + " — the payer's page converts when opened.";
        }
      } catch (e) {
        preview.textContent = "";
      }
    }
    function schedulePreview() {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(updatePreview, 450);
    }
    amountInput.addEventListener("input", schedulePreview);

    $("#create-form").addEventListener("submit", (ev) => {
      ev.preventDefault();
      addrError.textContent = "";
      amountError.textContent = "";

      const v = C.validateAddress(addrInput.value);
      if (!v.valid) {
        addrError.textContent = v.error;
        addrInput.focus();
        return;
      }
      const amt = C.parseAmountInput(amountInput.value);
      if (!(amt > 0)) {
        amountError.textContent = "Enter an amount greater than zero.";
        amountInput.focus();
        return;
      }
      if (currency === "BCH" && amt > 21000000) {
        amountError.textContent = "That is more BCH than will ever exist.";
        amountInput.focus();
        return;
      }

      const base = location.origin + location.pathname;
      const req = { address: v.normalized, label: $("#label").value.trim(), memo: $("#memo").value.trim() };
      if (currency === "BCH") req.amountBCH = amt;
      else { req.fiatCurrency = currency; req.fiatAmount = amt; }

      let link;
      try {
        link = C.buildPayLink(base, req);
      } catch (e) {
        amountError.textContent = e.message;
        return;
      }
      $("#link-out").value = link;
      const open = $("#open-link");
      open.href = link;
      renderQR($("#link-qr"), link);
      const result = $("#create-result");
      result.classList.remove("hidden");
      result.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });

    $("#copy-link-btn").addEventListener("click", (ev) => {
      copyText($("#link-out").value, ev.currentTarget);
    });
  }

  /* ---------------- PAY VIEW ---------------- */

  function initPayView(req) {
    const v = C.validateAddress(req.address);
    if (!v.valid) {
      $("#error-text").textContent = v.error;
      showView("view-error");
      return;
    }
    showView("view-pay");

    const displayCurrency = req.fiat ? req.fiat.currency : "USD";
    const state = {
      price: null,          // { price, source, at }
      priceError: false,
      targetBCH: req.amountBCH != null ? req.amountBCH : null, // number | null (null = open amount)
      lastURI: null,
      amounts: { confirmedSat: 0, pendingSat: 0, txids: [] },
      providerName: null,
      lastChecked: null,
      everSucceeded: false,
    };

    $("#pay-label").textContent = req.label || "Payment request";
    document.title = (req.label || "Payment request") + " — BCH Pay Links";
    $("#pay-memo").textContent = req.memo || "";
    $("#pay-addr").textContent = v.normalized;
    $("#copy-addr-btn").addEventListener("click", (ev) => copyText(v.normalized, ev.currentTarget));

    function currentURI() {
      const opts = { label: req.label, message: req.memo };
      if (state.targetBCH != null) opts.amountBCH = state.targetBCH;
      try {
        return C.buildPaymentURI(v.normalized, opts);
      } catch (e) {
        return "bitcoincash:" + (v.kind === "cashaddr" ? v.bare : v.normalized);
      }
    }

    function renderAmounts() {
      const main = $("#pay-amount-main");
      const sub = $("#pay-amount-sub");
      const priceLine = $("#pay-price-line");
      if (req.fiat) {
        main.textContent = C.formatFiat(req.fiat.amount, req.fiat.currency);
        sub.textContent = state.targetBCH != null
          ? "≈ " + C.formatBCHAmount(state.targetBCH) + " BCH"
          : "Converting at the live rate…";
      } else if (req.amountBCH != null) {
        main.textContent = C.formatBCHAmount(req.amountBCH) + " BCH";
        sub.textContent = state.price
          ? "≈ " + C.formatFiat(req.amountBCH * state.price.price, displayCurrency)
          : "";
      } else {
        main.textContent = "Any amount";
        sub.textContent = "Send any amount of BCH to this address";
      }
      if (state.price) {
        priceLine.textContent = "1 BCH = " + C.formatFiat(state.price.price, displayCurrency) +
          " · " + state.price.source + " · updated " + timeStr(new Date(state.price.at)) +
          (req.fiat ? " · BCH amount updates with the live rate until paid" : "");
      } else if (state.priceError) {
        priceLine.textContent = "Live price unavailable right now — BCH amounts still work.";
      }
      const uri = currentURI();
      if (uri !== state.lastURI) {
        state.lastURI = uri;
        renderQR($("#pay-qr"), uri);
        $("#pay-wallet-btn").href = uri;
      }
    }

    async function refreshPrice() {
      try {
        const p = await PriceService.getPrice(displayCurrency);
        state.price = p;
        state.priceError = false;
        if (req.fiat) state.targetBCH = C.fiatToBCH(req.fiat.amount, p.price);
      } catch (e) {
        state.priceError = true;
      }
      renderAmounts();
      renderStatus();
    }

    /* ----- watcher ----- */
    const providers = [makeBitcoreProvider(v.bare)];
    if (v.kind === "cashaddr") providers.push(makeHaskoinProvider(v.bare));
    let activeProvider = 0;
    let failStreak = 0;

    function targetSat() {
      return state.targetBCH != null ? C.bchToSat(state.targetBCH) : null;
    }

    function renderStatus() {
      const card = $("#status-card");
      const title = $("#status-title");
      const detail = $("#status-detail");
      const meta = $("#status-meta");
      const txBox = $("#status-txs");
      const bar = $("#status-bar");
      const { confirmedSat, pendingSat, txids } = state.amounts;
      const target = targetSat();
      const total = confirmedSat + pendingSat;

      let cls, titleText, detailText;
      if (!state.everSucceeded) {
        cls = "error";
        titleText = "Live status unavailable";
        detailText = "We could not reach a blockchain data source. You can verify this address manually on an explorer — the watcher keeps retrying automatically.";
      } else if (target == null) {
        if (confirmedSat > 0) {
          cls = "received"; titleText = "Payment received";
          detailText = C.formatBCHFromSat(confirmedSat) + " BCH confirmed on-chain.";
        } else if (pendingSat > 0) {
          cls = "detected"; titleText = "Payment detected";
          detailText = C.formatBCHFromSat(pendingSat) + " BCH seen in the mempool, awaiting confirmation.";
        } else {
          cls = "waiting"; titleText = "Waiting for payment…";
          detailText = "This page watches the BCH blockchain and updates automatically.";
        }
      } else if (confirmedSat >= target) {
        cls = "received"; titleText = "Payment received";
        detailText = C.formatBCHFromSat(confirmedSat) + " BCH confirmed on-chain — the request is fully paid.";
      } else if (total >= target) {
        cls = "detected"; titleText = "Payment detected — awaiting confirmation";
        detailText = C.formatBCHFromSat(total) + " BCH is on its way. It counts as paid once confirmed in a block.";
      } else if (total > 0) {
        cls = "partial"; titleText = "Partial payment received";
        detailText = C.formatBCHFromSat(total) + " of " + C.formatBCHFromSat(target) +
          " BCH received — " + C.formatBCHFromSat(target - total) + " BCH still to go.";
      } else {
        cls = "waiting"; titleText = "Waiting for payment…";
        detailText = "Send " + C.formatBCHFromSat(target) +
          " BCH to the address above. This page updates automatically — no need to refresh.";
      }

      card.className = "status " + cls;
      title.textContent = titleText;
      detail.textContent = detailText;
      bar.style.width = target ? Math.min(100, (total / target) * 100) + "%" : (total > 0 ? "100%" : "0%");

      txBox.innerHTML = "";
      for (const txid of txids.slice(0, 3)) {
        const a = document.createElement("a");
        a.href = explorerTxUrl(txid);
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = "View transaction " + txid.slice(0, 16) + "…";
        txBox.appendChild(a);
      }
      if (!state.everSucceeded) {
        const a = document.createElement("a");
        a.href = explorerAddrUrl(v.bare);
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = "Check this address on Blockchair";
        txBox.appendChild(a);
      }

      meta.textContent = state.everSucceeded
        ? "Watching via " + state.providerName + " · Last checked " +
          (state.lastChecked ? timeStr(state.lastChecked) : "…") + " · Checks every ~20 seconds"
        : "Retrying automatically…";
    }

    async function tick() {
      if (document.hidden) return; // poll again on the next interval / when visible
      const provider = providers[activeProvider];
      try {
        const r = await provider.poll();
        failStreak = 0;
        state.everSucceeded = true;
        state.providerName = provider.name;
        state.amounts = r;
        state.lastChecked = new Date();
      } catch (e) {
        failStreak++;
        const nothingDetected = state.amounts.confirmedSat + state.amounts.pendingSat === 0;
        if (failStreak >= 2 && nothingDetected && activeProvider < providers.length - 1) {
          activeProvider++;
          failStreak = 0;
        }
      }
      renderStatus();
    }

    renderAmounts();
    renderStatus();
    refreshPrice();
    tick();
    setInterval(tick, POLL_MS);
    setInterval(refreshPrice, PRICE_REFRESH_MS);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
  }

  /* ---------------- boot ---------------- */

  document.addEventListener("DOMContentLoaded", () => {
    const req = C.parsePayLinkParams(location.search);
    if (req) initPayView(req);
    else initCreateView();
  });
})();
