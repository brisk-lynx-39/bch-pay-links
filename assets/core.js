/*
 * BCH Pay Links — core logic (no DOM, no network).
 * Shared by the browser app (window.BCHCore) and the Node test-suite
 * (module.exports). Everything here is pure and side-effect free.
 *
 * Security note: this module only ever handles PUBLIC addresses.
 * There is deliberately no code here that can accept, derive or
 * transmit a private key or seed phrase — the app is watch-only.
 */
(function (global, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.BCHCore = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  /* ------------------------------------------------------------------ *
   * CashAddr (BCH address format, https://github.com/bitcoincashorg)
   * ------------------------------------------------------------------ */
  const CASHADDR_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const CHARSET_VALUES = {};
  for (let i = 0; i < CASHADDR_CHARSET.length; i++) CHARSET_VALUES[CASHADDR_CHARSET[i]] = i;

  // CashAddr checksum generators (40-bit polymod, BigInt for exactness).
  const POLYMOD_GENERATORS = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];
  const HASH_SIZES = [20, 24, 28, 32, 40, 48, 56, 64]; // indexed by version-byte size bits

  function prefixExpand(prefix) {
    const out = [];
    for (const ch of prefix) out.push(ch.charCodeAt(0) & 31);
    out.push(0);
    return out;
  }

  function polymod(values) {
    let c = 1n;
    for (const d of values) {
      const c0 = c >> 35n;
      c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
      for (let i = 0; i < 5; i++) {
        if ((c0 >> BigInt(i)) & 1n) c ^= POLYMOD_GENERATORS[i];
      }
    }
    return c ^ 1n; // per the CashAddr spec, polymod includes this final XOR
  }

  function convertBits(data, fromBits, toBits, pad) {
    let acc = 0;
    let bits = 0;
    const out = [];
    const maxv = (1 << toBits) - 1;
    for (const v of data) {
      if (!Number.isInteger(v) || v < 0 || v >> fromBits !== 0) return null;
      acc = (acc << fromBits) | v;
      bits += fromBits;
      while (bits >= toBits) {
        bits -= toBits;
        out.push((acc >> bits) & maxv);
      }
    }
    if (pad) {
      if (bits > 0) out.push((acc << (toBits - bits)) & maxv);
    } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
      return null; // invalid padding
    }
    return out;
  }

  /**
   * Decode and fully validate a CashAddr string (checksum included).
   * Returns { prefix, type: 'P2PKH'|'P2SH', hashHex } or throws Error.
   */
  function decodeCashaddr(input) {
    if (typeof input !== "string") throw new Error("Address must be a string.");
    const addr = input.trim();
    if (addr !== addr.toLowerCase() && addr !== addr.toUpperCase()) {
      throw new Error("CashAddr must be all lowercase or all uppercase.");
    }
    const lower = addr.toLowerCase();
    let prefix = "bitcoincash";
    let payloadStr = lower;
    const colon = lower.lastIndexOf(":");
    if (colon !== -1) {
      prefix = lower.slice(0, colon);
      payloadStr = lower.slice(colon + 1);
    }
    if (prefix !== "bitcoincash") {
      throw new Error('Unsupported address prefix "' + prefix + '" (this tool is BCH mainnet only).');
    }
    if (payloadStr.length === 0) throw new Error("Address payload is empty.");
    const values = [];
    for (const ch of payloadStr) {
      const v = CHARSET_VALUES[ch];
      if (v === undefined) throw new Error('Invalid character "' + ch + '" in address.');
      values.push(v);
    }
    if (polymod(prefixExpand(prefix).concat(values)) !== 0n) {
      throw new Error("Address checksum is invalid — check for typos.");
    }
    const payload = convertBits(values.slice(0, -8), 5, 8, false);
    if (!payload || payload.length === 0) throw new Error("Address payload is malformed.");
    const version = payload[0];
    if (version & 0x80) throw new Error("Address version byte is invalid (reserved bit set).");
    const typeBits = (version >> 3) & 0x0f;
    const sizeBits = version & 0x07;
    const hash = payload.slice(1);
    if (hash.length !== HASH_SIZES[sizeBits]) {
      throw new Error("Address hash length does not match its version byte.");
    }
    const type = typeBits === 0 ? "P2PKH" : typeBits === 1 ? "P2SH" : "UNKNOWN(" + typeBits + ")";
    return {
      prefix,
      type,
      hashHex: hash.map((b) => b.toString(16).padStart(2, "0")).join(""),
    };
  }

  /** Encode a CashAddr from a hex hash (used by tests; handy for tooling). */
  function encodeCashaddr(prefix, type, hashHex) {
    const hash = [];
    for (let i = 0; i < hashHex.length; i += 2) hash.push(parseInt(hashHex.slice(i, i + 2), 16));
    const sizeBits = HASH_SIZES.indexOf(hash.length);
    if (sizeBits === -1) throw new Error("Unsupported hash length: " + hash.length);
    const typeBits = type === "P2PKH" ? 0 : type === "P2SH" ? 1 : null;
    if (typeBits === null) throw new Error("Unsupported address type: " + type);
    const version = (typeBits << 3) | sizeBits;
    const payloadValues = convertBits([version].concat(hash), 8, 5, true);
    const mod = polymod(prefixExpand(prefix).concat(payloadValues, [0, 0, 0, 0, 0, 0, 0, 0]));
    let out = prefix + ":";
    for (const v of payloadValues) out += CASHADDR_CHARSET[v];
    for (let i = 0; i < 8; i++) out += CASHADDR_CHARSET[Number((mod >> BigInt(5 * (7 - i))) & 31n)];
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Address validation (public addresses only)
   * ------------------------------------------------------------------ */
  const BASE58_CHARS = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

  function isLegacyFormat(addr) {
    // Format-level check for legacy base58 addresses (1... / 3...).
    if (typeof addr !== "string") return false;
    const a = addr.trim();
    if (a.length < 26 || a.length > 35) return false;
    if (a[0] !== "1" && a[0] !== "3") return false;
    for (const ch of a) if (!BASE58_CHARS.includes(ch)) return false;
    return true;
  }

  /**
   * Validate any BCH address this app can watch.
   * CashAddr is validated completely, including its checksum.
   * Returns { valid, kind, normalized, bare, error }.
   *  - normalized: display form (cashaddr carries the bitcoincash: prefix)
   *  - bare:       payload without prefix (what most APIs expect)
   */
  function validateAddress(input) {
    const raw = typeof input === "string" ? input.trim() : "";
    if (!raw) return { valid: false, error: "Enter a BCH address." };
    try {
      const decoded = decodeCashaddr(raw);
      const lower = raw.toLowerCase();
      const bare = lower.includes(":") ? lower.slice(lower.lastIndexOf(":") + 1) : lower;
      return {
        valid: true,
        kind: "cashaddr",
        addressType: decoded.type,
        normalized: "bitcoincash:" + bare,
        bare,
        error: null,
      };
    } catch (e) {
      if (isLegacyFormat(raw)) {
        return { valid: true, kind: "legacy", addressType: null, normalized: raw, bare: raw, error: null };
      }
      return { valid: false, kind: null, error: e.message };
    }
  }

  /* ------------------------------------------------------------------ *
   * Amounts (satoshi-exact where it matters)
   * ------------------------------------------------------------------ */
  const SAT_PER_BCH = 100000000;

  function bchToSat(bch) {
    return Math.round(bch * SAT_PER_BCH);
  }

  /** Format a satoshi integer as a trimmed BCH decimal string ("0.05", "1.25"). */
  function formatBCHFromSat(sat) {
    if (!Number.isFinite(sat)) return "0";
    const neg = sat < 0;
    const abs = Math.abs(Math.round(sat));
    const whole = Math.floor(abs / SAT_PER_BCH);
    const frac = abs % SAT_PER_BCH;
    let out = String(whole);
    if (frac > 0) out += "." + String(frac).padStart(8, "0").replace(/0+$/, "");
    return (neg ? "-" : "") + out;
  }

  /** Format a BCH float as a BIP21-safe decimal string (max 8 dp, no exponent). */
  function formatBCHAmount(bch) {
    return formatBCHFromSat(bchToSat(bch));
  }

  /** Parse a user-typed amount ("0.05", "25", "25,50") → Number or NaN. */
  function parseAmountInput(str) {
    if (typeof str !== "string") return NaN;
    const cleaned = str.trim().replace(/\s/g, "").replace(",", ".");
    if (!/^\d*(\.\d*)?$/.test(cleaned) || cleaned === "" || cleaned === ".") return NaN;
    return Number(cleaned);
  }

  /** Convert a fiat amount to BCH at a given price, rounded to the satoshi. */
  function fiatToBCH(fiatAmount, pricePerBCH) {
    if (!(pricePerBCH > 0) || !(fiatAmount > 0)) return NaN;
    return bchToSat(fiatAmount / pricePerBCH) / SAT_PER_BCH;
  }

  function formatFiat(amount, currency) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
    } catch {
      return amount.toFixed(2) + " " + currency;
    }
  }

  /* ------------------------------------------------------------------ *
   * BIP21 payment URIs and shareable pay links
   * ------------------------------------------------------------------ */

  /**
   * Build a BIP21-style BCH payment URI:
   *   bitcoincash:<address>?amount=<BCH>&label=<label>&message=<memo>
   */
  function buildPaymentURI(address, opts = {}) {
    const v = validateAddress(address);
    if (!v.valid) throw new Error(v.error);
    const addrPart = v.kind === "cashaddr" ? v.bare : v.normalized;
    const params = [];
    if (opts.amountBCH != null) {
      if (!(opts.amountBCH > 0) || opts.amountBCH > 21000000) throw new Error("Amount out of range.");
      params.push("amount=" + formatBCHAmount(opts.amountBCH));
    }
    if (opts.label) params.push("label=" + encodeURIComponent(String(opts.label).slice(0, 80)));
    if (opts.message) params.push("message=" + encodeURIComponent(String(opts.message).slice(0, 140)));
    return "bitcoincash:" + addrPart + (params.length ? "?" + params.join("&") : "");
  }

  /**
   * Build the shareable pay link for this app.
   * req: { address, amountBCH? , fiatCurrency?, fiatAmount?, label?, memo? }
   * Fiat requests stay fiat-denominated in the link so the payment page can
   * convert at the live rate when it is opened.
   */
  function buildPayLink(baseUrl, req) {
    const v = validateAddress(req.address);
    if (!v.valid) throw new Error(v.error);
    const url = new URL(baseUrl);
    url.search = "";
    url.searchParams.set("to", v.normalized);
    if (req.fiatCurrency && req.fiatAmount != null) {
      url.searchParams.set("cur", req.fiatCurrency.toUpperCase());
      url.searchParams.set("famt", String(req.fiatAmount));
    } else if (req.amountBCH != null) {
      url.searchParams.set("amount", formatBCHAmount(req.amountBCH));
    }
    if (req.label) url.searchParams.set("label", String(req.label).slice(0, 80));
    if (req.memo) url.searchParams.set("memo", String(req.memo).slice(0, 140));
    return url.toString();
  }

  /** Parse pay-link query params back into a request object (or null). */
  function parsePayLinkParams(search) {
    const p = typeof search === "string" ? new URLSearchParams(search) : search;
    const to = p.get("to");
    if (!to) return null;
    const req = {
      address: to,
      amountBCH: null,
      fiat: null,
      label: (p.get("label") || "").slice(0, 80),
      memo: (p.get("memo") || "").slice(0, 140),
    };
    const famt = parseAmountInput(p.get("famt") || "");
    const cur = (p.get("cur") || "").toUpperCase();
    if (cur && Number.isFinite(famt) && famt > 0) {
      req.fiat = { currency: cur, amount: famt };
    } else {
      const amt = parseAmountInput(p.get("amount") || "");
      if (Number.isFinite(amt) && amt > 0) req.amountBCH = amt;
    }
    return req;
  }

  return {
    // cashaddr
    decodeCashaddr,
    encodeCashaddr,
    // validation
    validateAddress,
    isLegacyFormat,
    // amounts
    SAT_PER_BCH,
    bchToSat,
    formatBCHFromSat,
    formatBCHAmount,
    parseAmountInput,
    fiatToBCH,
    formatFiat,
    // links & URIs
    buildPaymentURI,
    buildPayLink,
    parsePayLinkParams,
  };
});
