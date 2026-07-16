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

const app = express();
app.use(cors()); // dev icin her yerden erisime izin ver

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

    const msg = String((err && err.message) || err);
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
