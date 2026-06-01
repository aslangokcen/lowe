// ============================================================
//  Lôwe — Veri köprüsü yardımcıları
//  Kaynak: TradingView Scanner (BIST) — fiyat + hazır teknik
//  göstergeler + temel oranlar tek çağrıda. (Google Cloud IP'den
//  erişilebilir; Yahoo 429 sorununu çözer.)
//  NOT: Skorlar veriden üretilen TAHMİNİ göstergelerdir;
//  yatırım tavsiyesi değildir.
// ============================================================

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const SCAN_URL = "https://scanner.tradingview.com/turkey/scan";

// Scanner'dan cekecegimiz kolonlar (sira onemli)
const COLS = [
  "name", "description", "close", "change", "volume", "sector",
  "market_cap_basic", "price_earnings_ttm", "price_book_fq",
  "RSI", "EMA50", "EMA200", "MACD.macd", "MACD.signal",
  "average_volume_10d_calc", "return_on_equity", "net_margin", "debt_to_equity",
  "Perf.W", "Perf.1M", "Recommend.All", "currency",
];

async function scanPost(body) {
  const r = await fetch(SCAN_URL, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/json", Accept: "application/json", Origin: "https://www.tradingview.com", Referer: "https://www.tradingview.com/" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("scanner " + r.status);
  return r.json();
}

function rowToObj(d) {
  const o = {};
  COLS.forEach((c, i) => { o[c] = d[i]; });
  return o;
}

// ---- Tek hisse verisi ----
export async function tvStock(symbol) {
  const j = await scanPost({ symbols: { tickers: ["BIST:" + symbol] }, columns: COLS });
  const row = j?.data?.[0];
  if (!row) return null;
  return rowToObj(row.d);
}

// ---- BIST sembol arama ("THY" -> oneriler) ----
export async function searchBist(text) {
  const j = await scanPost({
    symbols: { query: { types: [] }, tickers: [] },
    columns: ["name", "description", "sector", "close", "change"],
    filter: [{ left: "name", operation: "match", right: text }],
    sort: { sortBy: "market_cap_basic", sortOrder: "desc" },
    range: [0, 15],
    markets: ["turkey"],
  });
  const out = [];
  for (const r of j?.data || []) {
    const d = r.d;
    out.push({ symbol: d[0], name: d[1] || "", sector: d[2] || "", price: d[3] ?? null, changePct: d[4] != null ? round(d[4]) : null });
  }
  return out;
}

// ---- Teknik skor (0-10) — hazir gostergelerden ----
export function technicalScoreFromTV(o) {
  const close = num(o.close), ema50 = num(o["EMA50"]), ema200 = num(o["EMA200"]);
  const r = num(o["RSI"]), macd = num(o["MACD.macd"]), sig = num(o["MACD.signal"]);
  const vol = num(o.volume), avgVol = num(o["average_volume_10d_calc"]);
  if (close == null || (ema50 == null && r == null && macd == null)) {
    return { score: null, detail: {}, reasons: ["Yetersiz teknik veri"] };
  }
  let pts = 0, max = 0; const reasons = [];
  // Trend EMA (35%)
  max += 3.5;
  if (ema50 != null) { if (close > ema50) { pts += 1.8; reasons.push("Fiyat EMA50 üzerinde"); } else reasons.push("Fiyat EMA50 altında"); }
  if (ema200 != null) { if (close > ema200) { pts += 1.7; reasons.push("Fiyat EMA200 üzerinde"); } else reasons.push("Fiyat EMA200 altında"); }
  // RSI (20%)
  max += 2;
  if (r != null) {
    if (r >= 45 && r <= 70) { pts += 2; reasons.push(`RSI ${r.toFixed(0)} sağlıklı`); }
    else if (r > 70) { pts += 0.6; reasons.push(`RSI ${r.toFixed(0)} aşırı alım`); }
    else if (r < 30) { pts += 0.4; reasons.push(`RSI ${r.toFixed(0)} aşırı satım`); }
    else { pts += 1; reasons.push(`RSI ${r.toFixed(0)}`); }
  }
  // MACD (25%)
  max += 2.5;
  if (macd != null && sig != null) {
    if (macd > sig) { pts += 2.5; reasons.push("MACD sinyal üzerinde (pozitif)"); }
    else reasons.push("MACD sinyal altında (negatif)");
  }
  // Hacim (20%)
  max += 2;
  if (avgVol && vol != null) {
    const ratio = vol / avgVol;
    if (ratio >= 1.2) { pts += 2; reasons.push(`Hacim ortalamanın %${((ratio - 1) * 100).toFixed(0)} üzerinde`); }
    else if (ratio >= 0.8) { pts += 1.2; reasons.push("Hacim ortalama civarında"); }
    else { pts += 0.5; reasons.push("Hacim ortalamanın altında"); }
  }
  if (max === 0) return { score: null, detail: {}, reasons: ["Yetersiz teknik veri"] };
  const score = Math.round((pts / max) * 10 * 10) / 10;
  return {
    score,
    detail: { rsi: r != null ? Math.round(r) : null, ema50: round(ema50), ema200: round(ema200), macd: round(macd), macdSignal: round(sig), volRatio: avgVol ? round(vol / avgVol) : null },
    reasons,
  };
}

// ---- Temel skor (0-10) ----
export function fundamentalScoreFromTV(o) {
  const pe = num(o["price_earnings_ttm"]);
  const pb = num(o["price_book_fq"]);
  const roe = num(o["return_on_equity"]);   // yuzde olarak gelir (15.4)
  const margin = num(o["net_margin"]);       // yuzde (12.5)
  const d2e = num(o["debt_to_equity"]);
  if (pe == null && pb == null && roe == null && margin == null) {
    return { score: null, detail: {}, reasons: ["Temel veri yetersiz"] };
  }
  let pts = 0, max = 0; const reasons = [];
  if (pe != null) { max += 2; if (pe > 0 && pe < 12) { pts += 2; reasons.push(`FK ${pe.toFixed(1)} cazip`); } else if (pe < 25) { pts += 1.3; reasons.push(`FK ${pe.toFixed(1)} makul`); } else if (pe >= 25) { pts += 0.5; reasons.push(`FK ${pe.toFixed(1)} yüksek`); } else reasons.push("FK negatif (zarar)"); }
  if (pb != null) { max += 1.5; if (pb > 0 && pb < 1.5) { pts += 1.5; reasons.push(`PD/DD ${pb.toFixed(2)} düşük`); } else if (pb < 3) { pts += 1; reasons.push(`PD/DD ${pb.toFixed(2)} makul`); } else { pts += 0.3; reasons.push(`PD/DD ${pb.toFixed(2)} yüksek`); } }
  if (roe != null) { max += 2; if (roe > 20) { pts += 2; reasons.push(`ROE %${roe.toFixed(0)} güçlü`); } else if (roe > 10) { pts += 1.3; reasons.push(`ROE %${roe.toFixed(0)} iyi`); } else if (roe > 0) { pts += 0.6; reasons.push(`ROE %${roe.toFixed(0)} zayıf`); } else reasons.push("ROE negatif"); }
  if (margin != null) { max += 2; if (margin > 15) { pts += 2; reasons.push(`Net marj %${margin.toFixed(0)} yüksek`); } else if (margin > 5) { pts += 1.3; reasons.push(`Net marj %${margin.toFixed(0)}`); } else if (margin > 0) { pts += 0.6; reasons.push(`Net marj %${margin.toFixed(0)} ince`); } else reasons.push("Net marj negatif"); }
  if (d2e != null) { max += 1.5; if (d2e < 0.5) { pts += 1.5; reasons.push("Borçluluk düşük"); } else if (d2e < 1.5) { pts += 1; reasons.push("Borçluluk makul"); } else { pts += 0.3; reasons.push("Borçluluk yüksek"); } }
  if (max === 0) return { score: null, detail: {}, reasons: ["Temel veri yetersiz"] };
  const score = Math.round((pts / max) * 10 * 10) / 10;
  return {
    score,
    detail: { pe: round(pe), pb: round(pb), roe: round(roe), margin: round(margin), debtToEquity: round(d2e), marketCap: num(o["market_cap_basic"]) },
    reasons,
  };
}

// ---- RSS ayristirma (haberler) ----
export function parseRss(xml, sourceName) {
  const items = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  for (const b of blocks.slice(0, 25)) {
    const title = pick(b, "title");
    const link = pick(b, "link");
    const date = pick(b, "pubDate");
    if (title) items.push({ title: decode(title), url: cleanUrl(link), date: date || "", source: sourceName });
  }
  return items;
}
function pick(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return "";
  let v = m[1].trim();
  v = v.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
  return v;
}
function cleanUrl(u) { return (u || "").replace(/<!\[CDATA\[|\]\]>/g, "").trim(); }
function decode(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#?\w+;/g, " ").trim();
}

function num(v) { return (v == null || v === "" || isNaN(v)) ? null : Number(v); }
function round(v) { return v == null ? null : Math.round(v * 100) / 100; }
