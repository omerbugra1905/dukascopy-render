# dukascopy-render

**Exhaustion Reversal v2.2** backtest araştırması için **ayrı** bir veri servisi.
Dukascopy'nin ücretsiz geçmiş verisini, canlı `bugraapi.onrender.com` ile **birebir aynı
formatta** servis eder — böylece backtest scriptleri değişmeden çalışır.

> ⚠️ Bu servis **canlı `bugraapi`'ye dokunmaz**. Tamamen ayrı, sadece yeni sembol
> araştırması (DE30, JP225, WTI, HK33, RUSSELL ...) için. Canlıya alınmaz.

## Ne yapar

- `dukascopy-node` ile Dukascopy'den H1/H4/M15... geçmiş mum verisi çeker
- Bilinen sembol adını (ör. `NDX`) Dukascopy ID'sine (`usatechidxusd`) çevirir
- Cevabı `{"values":[{datetime,open,high,low,close,volume}, ...]}` formatında döner
- Sunucu tarafında (Render = yurtdışı) çalıştığı için **Türkiye ISP bloğundan etkilenmez**
  (Dukascopy alan adları TR'de engelli; Render'dan çekince sorun olmaz)

## Neden ayrı servis

- `bugraapi`: canlı, tvdatafeed → OANDA, 3 sembol (XAUUSD, NDX, XAGUSD)
- `dukascopy-render`: araştırma, sembol limiti yok, NDX 1990'a kadar geçmiş
- Akademik dayanak: ABD-dışı endekslerde reversal edge'i kalıcı (Jacobs-Müller 2020)

## Kurulum (local test)

```bash
cd dukascopy-render
npm install
npm test          # cesitli sembolleri ceker, ilk 5 mumu yazdirir
npm start         # http://localhost:3000
```

Test çağrısı:

```bash
curl "http://localhost:3000/candles/XAUUSD/1h?n=5"
curl "http://localhost:3000/candles/DE30/1h?from=2025-01-01&to=2025-02-01"
curl "http://localhost:3000/health"
```

> **Not:** Local test Türkiye'den `datafeed.dukascopy.com` engelli olduğu için
> **timeout** verebilir. Bu bir kod hatası değildir — servis Render'da (yurtdışı)
> çalışır. Endpoint/format/hata yönetimi yine de lokalde doğrulanabilir.

## Deploy (GitHub → Render)

1. Repoyu GitHub'a push et (ör. `omerbugra1905/dukascopy-render`)
2. Render dashboard → **New → Web Service**
3. GitHub hesabını bağla, `dukascopy-render` reposunu seç
4. Ayarlar otomatik gelir (`render.yaml`): Build `npm install`, Start `node server.js`, Plan **Free**
5. **Create Web Service** → birkaç dakikada `https://dukascopy-render-XXXX.onrender.com`
6. Test: `https://<servis-url>/candles/XAUUSD/1h?n=5`

> Free plan inaktifken uykuya geçer; ilk istek ~30-50 sn gecikebilir (cold start).
> Backtest için sorun değil.

## Endpoint

| Endpoint | Açıklama |
|---|---|
| `GET /candles/:symbol/:interval?n=5000` | Son N mum |
| `GET /candles/:symbol/:interval?from=YYYY-MM-DD&to=YYYY-MM-DD` | Tarih aralığı |
| `GET /health` | `{"status":"ok","uptime":...}` |
| `GET /` | Kullanım + desteklenen sembol/interval listesi |

**Hata kodları:** bilinmeyen sembol/interval → `400`, timeout → `504`, Dukascopy hatası → `500`.

## Desteklenen semboller

Mapping `symbols.json` içinde — yeni sembol eklemek için oraya satır ekle, kod değişmez.

| İsim | Dukascopy ID | Açıklama |
|---|---|---|
| XAUUSD | xauusd | Altın (mevcut) |
| XAGUSD | xagusd | Gümüş (mevcut) |
| NDX | usatechidxusd | Nasdaq 100 (mevcut) |
| DE30 | deuidxeur | DAX 40 |
| JP225 | jpnidxjpy | Nikkei 225 |
| HK33 | hkgidxhkd | Hang Seng |
| WTI | lightcmdusd | Ham petrol (WTI) |
| BRENT | brentcmdusd | Brent petrol |
| COPPER | coppercmdusd | Bakır |
| XPTUSD | xptcmdusd | Platin |
| XPDUSD | xpdcmdusd | Paladyum |
| RUSSELL | ussc2000idxusd | Russell 2000 (US Small Cap 2000) |

## Interval'lar

`1m → m1`, `5m → m5`, `15m → m15`, `1h → h1`, `4h → h4`, `1d → d1`

## Uyarı — hacim

Dukascopy'de hacim = broker **tick volume** (gerçek borsa hacmi değil). Senin
"hacim patlaması" tetikleyicin oran-bazlı (2. yarı / 1. yarı) olduğu için ölçek
önemsiz; ama yeni sembolde tetikleyicinin EV katkısını **OOS'ta doğrula**.
