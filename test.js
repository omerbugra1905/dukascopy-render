// ============================================================================
// Local test — `npm test`
// Cesitli sembolleri Dukascopy'den ceker, ilk 5 mumu bugraapi formatinda yazdirir.
// Server'i ayaga kaldirmadan calisir (dukascopy'yi dogrudan cagirir).
// NOT: Turkiye'den datafeed.dukascopy.com engelli olabilir -> timeout.
//      O durumda kod dogrudur, Render'da (yurtdisi) calisir.
// ============================================================================

const { getHistoricalRates } = require("dukascopy-node");
const maps = require("./symbols.json");

// Test edilecek semboller: XAUUSD (mevcutla karsilastirma) + yeni adaylar
const TEST_SYMBOLS = ["XAUUSD", "DE30", "WTI", "JP225"];
const INTERVAL = "1h";

function fmtDate(ts) {
  return new Date(ts).toISOString().slice(0, 19);
}

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

(async () => {
  const timeframe = maps.intervals[INTERVAL];
  const to = new Date();
  const from = new Date(to.getTime() - 10 * 24 * 60 * 60 * 1000); // son ~10 gun

  for (const sym of TEST_SYMBOLS) {
    const instrument = maps.symbols[sym];
    process.stdout.write(`\n=== ${sym} (${instrument}) ${INTERVAL} ===\n`);
    try {
      const data = await getHistoricalRates({
        instrument,
        dates: { from, to },
        timeframe,
        priceType: "bid",
        format: "json",
        volumes: true,
        retryCount: 2,
        useCache: false,
      });
      const values = toValues(data || []);
      console.log(`toplam ${values.length} mum, ilk 5:`);
      console.table(values.slice(0, 5));
    } catch (err) {
      console.log(`HATA: ${(err && err.message) || err}`);
    }
  }
})();
