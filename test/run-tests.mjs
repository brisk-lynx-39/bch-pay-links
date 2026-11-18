/*
 * BCH Pay Links — test suite (Node 22, no dependencies).
 *
 *   NODE_USE_ENV_PROXY=1 node test/run-tests.mjs
 *
 * Sections:
 *  A. Core unit tests (cashaddr checksum, BIP21 URIs, links, amounts)
 *  B. QR generation for a sample payment URI (matrix dumped for the
 *     independent OpenCV decode check in test/decode-qr.py)
 *  C. Live API smoke tests (price + watcher data sources)
 *
 * The watcher diff logic in section C mirrors assets/app.js providers —
 * app.js is a browser script, so the small algorithms are re-implemented
 * here against the same live endpoints to prove the data supports them.
 */
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const C = require("../assets/core.js");
const qrcode = require("../assets/qrcode.js");

let passed = 0, failed = 0;
function check(name, cond, extra = "") {
  if (cond) { passed++; console.log("  PASS " + name); }
  else { failed++; console.log("  FAIL " + name + (extra ? " — " + extra : "")); }
}
function eq(name, a, b) { check(name, a === b, "got " + JSON.stringify(a) + ", want " + JSON.stringify(b)); }

// The CashAddr specification's own example address (legacy
// 1BpEi6DfDAUFd7GtittLSdBeYJvcoaVgGU) — a real, active mainnet address.
const GENESIS_CASH = "bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a";
const GENESIS_BARE = "qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a";
const GENESIS_HASH160 = "76a04053bda0a88bda5177b86a15c3b29f559873"; // from its on-chain scriptPubKey
const GENESIS_LEGACY = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";

/* ---------------- A. core unit tests ---------------- */
console.log("A. Core unit tests");

// CashAddr decoding is fully validated against known chain data.
const dec = C.decodeCashaddr(GENESIS_CASH);
eq("spec-example cashaddr type is P2PKH", dec.type, "P2PKH");
eq("spec-example cashaddr hash160 matches chain data", dec.hashHex, GENESIS_HASH160);
eq("encodeCashaddr round-trips the spec-example address",
  C.encodeCashaddr("bitcoincash", "P2PKH", GENESIS_HASH160), GENESIS_CASH);

check("bare cashaddr (no prefix) validates", C.validateAddress(GENESIS_BARE).valid);
check("uppercase cashaddr validates", C.validateAddress(GENESIS_CASH.toUpperCase()).valid);
eq("normalized form carries the prefix", C.validateAddress(GENESIS_BARE).normalized, GENESIS_CASH);

const mutated = GENESIS_CASH.slice(0, -1) + (GENESIS_CASH.endsWith("a") ? "q" : "a");
check("mutated address fails checksum", !C.validateAddress(mutated).valid);
check("mixed-case address rejected", !C.validateAddress("bitcoincash:Qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a").valid);
check("testnet prefix rejected", !C.validateAddress("bchtest:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a").valid);
check("garbage rejected", !C.validateAddress("send me your seed phrase").valid);
check("empty rejected", !C.validateAddress("").valid);

const legacy = C.validateAddress(GENESIS_LEGACY);
check("legacy address validates as legacy", legacy.valid && legacy.kind === "legacy");

// Amounts
eq("formatBCHFromSat(5593767221)", C.formatBCHFromSat(5593767221), "55.93767221");
eq("formatBCHFromSat(5000000)", C.formatBCHFromSat(5000000), "0.05");
eq("formatBCHFromSat(100000000)", C.formatBCHFromSat(100000000), "1");
eq("formatBCHFromSat(1)", C.formatBCHFromSat(1), "0.00000001");
eq("formatBCHAmount(0.1+0.2) is float-safe", C.formatBCHAmount(0.1 + 0.2), "0.3");
eq("fiatToBCH(25, 200)", C.fiatToBCH(25, 200), 0.125);
eq("parseAmountInput('25,50')", C.parseAmountInput("25,50"), 25.5);
check("parseAmountInput('abc') is NaN", Number.isNaN(C.parseAmountInput("abc")));

// BIP21 URI — exact string
eq("BIP21 URI with amount+label+message",
  C.buildPaymentURI(GENESIS_CASH, { amountBCH: 0.05, label: "Invoice #1042", message: "Logo design" }),
  "bitcoincash:" + GENESIS_BARE + "?amount=0.05&label=Invoice%20%231042&message=Logo%20design");
eq("BIP21 URI address-only",
  C.buildPaymentURI(GENESIS_BARE, {}), GENESIS_CASH);

// Pay link round-trip (fiat)
const link = C.buildPayLink("https://brisk-lynx-39.github.io/bch-pay-links/", {
  address: GENESIS_CASH, fiatCurrency: "USD", fiatAmount: 25, label: "Invoice #1042", memo: "Logo design",
});
const parsed = C.parsePayLinkParams(new URL(link).search);
check("fiat link round-trips address", parsed && C.validateAddress(parsed.address).valid);
eq("fiat link round-trips currency", parsed.fiat.currency, "USD");
eq("fiat link round-trips amount", parsed.fiat.amount, 25);
eq("fiat link round-trips label", parsed.label, "Invoice #1042");

// End-to-end chain: link → parsed request → live-price conversion → BIP21 URI
const bchAt200 = C.fiatToBCH(parsed.fiat.amount, 200);
eq("end-to-end URI at test price $200",
  C.buildPaymentURI(parsed.address, { amountBCH: bchAt200, label: parsed.label, message: parsed.memo }),
  "bitcoincash:" + GENESIS_BARE + "?amount=0.125&label=Invoice%20%231042&message=Logo%20design");

// BCH-denominated link round-trip
const link2 = C.buildPayLink("https://example.org/pay/", { address: GENESIS_CASH, amountBCH: 0.05 });
const parsed2 = C.parsePayLinkParams(new URL(link2).search);
eq("BCH link round-trips amount", parsed2.amountBCH, 0.05);
eq("BCH link has no fiat", parsed2.fiat, null);

/* ---------------- B. QR generation ---------------- */
console.log("B. QR generation");
const sampleURI = C.buildPaymentURI(GENESIS_CASH, { amountBCH: 0.05, label: "Invoice #1042", message: "Logo design" });
try {
  qrcode.stringToBytes = qrcode.stringToBytesFuncs["UTF-8"];
  const qr = qrcode(0, "M");
  qr.addData(sampleURI, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  const modules = [];
  for (let r = 0; r < n; r++) {
    const row = [];
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c) ? 1 : 0);
    modules.push(row);
  }
  check("QR matrix generated (" + n + "x" + n + ")", n > 0 && modules.length === n);
  fs.writeFileSync("/tmp/bchpay-qr.json", JSON.stringify({ uri: sampleURI, modules }));
  console.log("  (matrix dumped to /tmp/bchpay-qr.json for the OpenCV decode check)");
} catch (e) {
  check("QR generation does not throw", false, e.message);
}

/* ---------------- C. live API smoke tests ---------------- */
console.log("C. Live API smoke tests");
async function fetchJSON(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

// Price: CoinGecko primary, Coinbase fallback (same order as app.js)
try {
  let price = null, source = null;
  try {
    const j = await fetchJSON("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash&vs_currencies=usd,cny,eur");
    if (j["bitcoin-cash"]?.usd > 0) { price = j["bitcoin-cash"]; source = "CoinGecko"; }
  } catch { /* fall back */ }
  if (!price) {
    const j = await fetchJSON("https://api.coinbase.com/v2/prices/BCH-USD/spot");
    price = { usd: parseFloat(j.data.amount) };
    source = "Coinbase";
  }
  check("live BCH/USD price via " + source, price.usd > 0, "usd=" + price.usd);
  if (price.cny) check("live BCH/CNY price", price.cny > 0, "cny=" + price.cny);
} catch (e) {
  check("live price fetch", false, e.message);
}

// Watcher primary (Bitcore): baseline-diff must isolate the newest output.
try {
  const records = await fetchJSON(
    "https://api.bitcore.io/api/BCH/mainnet/address/" + GENESIS_BARE + "/txs?limit=50");
  check("Bitcore returns output records", Array.isArray(records) && records.length > 10,
    "count=" + (records && records.length));
  const key = (r) => r.mintTxid + ":" + r.mintIndex;
  const baseline = new Set(records.slice(1).map(key)); // pretend the newest output arrived after baseline
  let confirmedSat = 0, pendingSat = 0; const txids = [];
  for (const r of records) {
    if (baseline.has(key(r)) || !(r.value > 0)) continue;
    if (r.mintHeight > 0) confirmedSat += r.value; else pendingSat += r.value;
    if (!txids.includes(r.mintTxid)) txids.push(r.mintTxid);
  }
  eq("Bitcore diff isolates the newest output's value", confirmedSat + pendingSat, records[0].value);
  eq("Bitcore diff attributes the newest txid", txids[0], records[0].mintTxid);
} catch (e) {
  check("Bitcore watcher feed", false, e.message);
}

// Watcher fallback (Haskoin): balance + tx list shapes the app relies on.
try {
  const bal = await fetchJSON("https://api.haskoin.com/bch/address/" + GENESIS_BARE + "/balance");
  check("Haskoin balance has numeric received", typeof bal.received === "number" && bal.received > 0,
    "received=" + bal.received);
  const txs = await fetchJSON("https://api.haskoin.com/bch/address/" + GENESIS_BARE + "/transactions?limit=5");
  check("Haskoin tx list non-empty with txids", Array.isArray(txs) && txs.length > 0 && typeof txs[0].txid === "string");
} catch (e) {
  check("Haskoin watcher feed", false, e.message);
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
