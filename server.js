// ============================================================================
// dukascopy-render — Exhaustion Reversal v2.2 backtest veri kaynagi
// ----------------------------------------------------------------------------
// Dukascopy'nin ucretsiz gecmis verisini, bugraapi ile AYNI formatta servis eder.
// Amac: yeni sembol arastirmasi (DE30, JP225, WTI, HK33 ...) icin backtest verisi.
// CANLI bugraapi'ye DOKUNMAZ — bu tamamen ayri, sadece arastirma servisi.
// ============================================================================

const express = require("express");
const cors = require("cors");
const { getHistoricalRates } = require("dukascopy-node");
const maps = require("./symbols.json");

// --- AG AYARI (Render Oregon -> Dukascopy Isvicre) ---------------------------
// Sorun: Node native fetch, host'u once IPv6'dan deniyor; Render'da IPv6 route
// olmayinca ~60sn takilip "fetch failed" veriyor (code: undefined). TLS degil, network.
// Cozum: IPv4'u zorla + makul timeout'lar. dukascopy-node global fetch kullandigi
// icin bu ayarlar onun internal cagrilarini da etkiler (kaynak: dist/index.js fetch()).
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first"); // built-in: tum DNS'i IPv4-once (zararsiz, DNS zaten IPv4)

// NOT: undici setGlobalDispatcher KALDIRILDI. Dayanagi (IPv6 sorunu) /diag ile curudu:
// DNS zaten IPv4 donuyor + Dukascopy'ye TCP443 153ms'de baglaniyor. Undici v6 override'i
// Node v26'da fetch'i takabilir; gereksiz oldugu icin cikartildi. Sorun fetch katmaninda.

const net = require("node:net");

const app = express();
app.use(cors()); // dev icin her yerden erisime izin ver

// Ham TCP connect testi (443). fetch/undici katmanindan bagimsiz, net sonuc verir:
// baglandi mi, yoksa ETIMEDOUT/ECONNREFUSED/ENETUNREACH mi.
function tcpProbe(host, port = 443, timeout = 12000) {
  return new Promise((resolve) => {
    const started = Date.now();
    let done = false;
    const sock = net.connect({ host, port });
    const finish = (r) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve({ host, port, ...r, ms: Date.now() - started });
    };
    sock.setTimeout(timeout);
    sock.once("connect", () => finish({ ok: true }));
    sock.once("timeout", () => finish({ ok: false, error: "TCP connect timeout" }));
    sock.once("error", (e) => finish({ ok: false, error: e.code || e.message }));
  });
}

const SYMBOL_MAP = maps.symbols; // "XAUUSD" -> "xauusd"
const INTERVAL_MAP = maps.intervals; // "1h" -> "h1"

// n-modu (son N mum) icin pencere hesabinda kullanilir: interval -> dakika
const INTERVAL_MINUTES = { m1: 1, m5: 5, m15: 15, m30: 30, h1: 60, h4: 240, d1: 1440 };

const PORT = process.env.PORT || 3000;
const START = Date.now();
const FETCH_TIMEOUT_MS = 90000; // 90 sn (Render cold-start + genis aralik icin)

// --- yardimcilar ------------------------------------------------------------

// timestamp(ms) -> "YYYY-MM-DDTHH:mm:ss" (UTC, bugraapi/twelvedata ile birebir)
function fmtDate(ts) {
  return new Date(ts).toISOString().slice(0, 19);
}

// Teshis probe'u: dukascopy-node retry sarmalayicisi gercek hatayi (err.cause) silebiliyor.
// Bir fetch hatasinda datafeed host'una tek dogrudan istek atip HAM ag hatasini logla.
async function probeDukascopy() {
  const url = "https://datafeed.dukascopy.com/";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    console.error(`  [probe] datafeed erisildi: HTTP ${r.status}`);
  } catch (e) {
    console.error("  [probe] datafeed HATASI:", (e && e.message) || e);
    if (e && e.cause) console.error("  [probe] cause:", e.cause); // ECONNREFUSED/ETIMEDOUT/ENETUNREACH...
  }
}

// dukascopy JSON satirlari -> bugraapi "values" formati (tum alanlar STRING)
function toValues(rows) {
  return rows.map((r) => ({
    datetime: fmtDate(r.timestamp),
    open: String(r.open),
    high: String(r.high),
    low: String(r.low),
    close: String(r.close),
    volume: String(r.volume ?? 0),
  }));
}

// --- health -----------------------------------------------------------------

app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: Math.floor((Date.now() - START) / 1000) });
});

// --- teshis: Render -> Dukascopy baglantisi gercekten var mi? ----------------
// datafeed.dukascopy.com'a ham TCP443 dener + kontrol icin github. DNS'i de gosterir.
app.get("/diag", async (req, res) => {
  let dnsInfo = null;
  try {
    dnsInfo = await dns.promises.lookup("datafeed.dukascopy.com", { all: true });
  } catch (e) {
    dnsInfo = { error: (e && e.message) || String(e) };
  }
  const dukascopy = await tcpProbe("datafeed.dukascopy.com", 443);
  const control = await tcpProbe("api.github.com", 443); // kontrol: Render disari cikabiliyor mu
  res.json({
    node: process.version,
    dns_datafeed: dnsInfo, // family:6 cikarsa IPv6 sorunu; IP'ler gorunur
    dukascopy_tcp443: dukascopy, // ok:true = ulasilabilir | error:ETIMEDOUT = IP blogu
    control_github_tcp443: control, // ok:true ama dukascopy timeout => Dukascopy Render'i blokluyor
  });
});

// --- teshis 2: GERCEK fetch (retryCount:0 -> ham hata cause'u korunur) --------
// dukascopy-node'un fetch'i tek dosyada ne yapiyor: veri mi donuyor, hangi hata mi?
app.get("/diag2", async (req, res) => {
  const to = new Date();
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000); // son 24 saat
  const out = { node: process.version };
  for (const [name, instrument] of [["XAUUSD", "xauusd"], ["DE30", "deuidxeur"]]) {
    const t0 = Date.now();
    try {
      const data = await getHistoricalRates({
        instrument, dates: { from, to }, timeframe: "h1",
        format: "json", volumes: true, retryCount: 0, useCache: false,
      });
      out[name] = { ok: true, candles: (data || []).length, sample: (data || [])[0] || null, ms: Date.now() - t0 };
    } catch (e) {
      out[name] = {
        ok: false, ms: Date.now() - t0,
        message: e && e.message, name: e && e.name, code: e && e.code,
        cause: e && e.cause ? { code: e.cause.code, message: e.cause.message, errno: e.cause.errno, syscall: e.cause.syscall } : null,
        validationErrors: (e && e.validationErrors) || null,
      };
    }
  }
  res.json(out);
});

// --- kok: kisa kullanim bilgisi --------------------------------------------

app.get("/", (req, res) => {
  res.json({
    service: "dukascopy-render",
    usage: "/candles/:symbol/:interval?n=5000  ||  ?from=YYYY-MM-DD&to=YYYY-MM-DD",
    symbols: Object.keys(SYMBOL_MAP),
    intervals: Object.keys(INTERVAL_MAP),
  });
});

// --- ana endpoint: /candles/:symbol/:interval -------------------------------

app.get("/candles/:symbol/:interval", async (req, res) => {
  console.log(`Request: ${req.originalUrl}`); // gelen her istegi logla

  const symRaw = String(req.params.symbol).toUpperCase();
  const tfRaw = String(req.params.interval).toLowerCase();

  // sembol / interval dogrulama
  const instrument = SYMBOL_MAP[symRaw];
  if (!instrument) {
    return res.status(400).json({ error: "unknown symbol", symbol: symRaw, supported: Object.keys(SYMBOL_MAP) });
  }
  const timeframe = INTERVAL_MAP[tfRaw];
  if (!timeframe) {
    return res.status(400).json({ error: "unknown interval", interval: tfRaw, supported: Object.keys(INTERVAL_MAP) });
  }

  // tarih araligi: ya from/to ver, ya da n (son N mum) iste
  let from, to;
  let n = null;
  if (req.query.from || req.query.to) {
    from = new Date(req.query.from);
    to = req.query.to ? new Date(req.query.to) : new Date();
    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      return res.status(400).json({ error: "invalid date", hint: "from/to = YYYY-MM-DD" });
    }
  } else {
    n = parseInt(req.query.n, 10) || 5000;
    to = new Date();
    // Hafta sonu/tatil bosluklari nedeniyle N mum icin takvim penceresini genis al,
    // veriyi cektikten sonra son N mumu kes. FUDGE ~1.8 => piyasa kapali saatleri telafi.
    const minutes = INTERVAL_MINUTES[timeframe] || 60;
    const spanMs = n * minutes * 60000 * 1.8;
    from = new Date(to.getTime() - spanMs);
  }

  // 30sn timeout: dukascopy takilirsa 504 don
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("__timeout__")), FETCH_TIMEOUT_MS)
  );

  // Dukascopy fetch basliyor
  console.log(`Fetching ${instrument} ${timeframe} from Dukascopy...`);
  const t0 = Date.now();

  try {
    const data = await Promise.race([
      getHistoricalRates({
        instrument,
        dates: { from, to },
        timeframe,
        priceType: "bid",
        format: "json",
        volumes: true,
        retryCount: 3,
        useCache: false,
      }),
      timeout,
    ]);

    let values = toValues(data || []);
    if (n && values.length > n) values = values.slice(-n); // son N mum

    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`Success: ${values.length} candles received in ${secs}s`);
    res.json({ values });
  } catch (err) {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    // DETAYLI hata dokumu — Render loglarinda gorunsun
    console.error("Dukascopy full error:", err);
    console.error(`  message: ${err && err.message}`);
    console.error(`  code:    ${err && err.code}`);
    console.error(`  stack:   ${err && err.stack}`);
    // native fetch gercek sebebi err.cause icinde saklar (varsa)
    if (err && err.cause) {
      console.error("  cause:", err.cause);
      console.error(`  cause.code: ${err.cause.code}  errno: ${err.cause.errno}  address: ${err.cause.address || ""} family: ${err.cause.family || ""}`);
    }

    const msg = String((err && err.message) || err);
    // "fetch failed" (cause silinmis) ise dogrudan probe ile ham ag hatasini yakala
    if (msg === "fetch failed" || (msg.includes("fetch") && !(err && err.cause))) {
      await probeDukascopy();
    }
    if (msg === "__timeout__") {
      console.error(`  -> ${FETCH_TIMEOUT_MS / 1000}s timeout asildi (${secs}s sonra)`);
      return res.status(504).json({ error: "timeout", detail: `${FETCH_TIMEOUT_MS / 1000}s asildi` });
    }
    // Dukascopy tarafindaki hata (gecersiz ID, feed erisilemez vb.)
    return res.status(500).json({ error: "dukascopy error", detail: msg, code: (err && err.code) || null });
  }
});

app.listen(PORT, () => {
  console.log(`dukascopy-render calisiyor -> http://localhost:${PORT}`);
});
