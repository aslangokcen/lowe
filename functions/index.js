// ============================================================
//  Lôwe — Cloud Functions
//  1) syncRoleClaim: users/{uid} degisince rol/active claim'i yaz
//  2) Veri köprüsü (onCall): hisse arama, oto-veri/skor, haber, KAP
//     Tarayici CORS engelini asar; sadece giris yapmis kullanici cagirir.
// ============================================================
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import {
  searchBist, tvStock, technicalScoreFromTV, fundamentalScoreFromTV, parseRss,
} from "./lib.js";

initializeApp();
const db = getFirestore();
const REGION = "europe-west3";
const COMMON = { region: REGION, cors: true, memory: "256MiB", timeoutSeconds: 30 };

// ---- guvenlik: sadece giris yapmis aktif kullanici ----
function requireAuth(req) {
  if (!req.auth) throw new HttpsError("unauthenticated", "Giriş gerekli.");
  if (req.auth.token.active === false) throw new HttpsError("permission-denied", "Hesap etkin değil.");
}

// ---- basit Firestore onbellek ----
async function cached(key, ttlMs, producer) {
  const ref = db.collection("borsa_cache").doc(key);
  try {
    const snap = await ref.get();
    if (snap.exists) {
      const d = snap.data();
      if (d.at && Date.now() - d.at.toMillis() < ttlMs) return d.payload;
    }
  } catch { /* yoksa devam */ }
  const payload = await producer();
  try { await ref.set({ at: new Date(), payload }); } catch { /* yazilamazsa sorun degil */ }
  return payload;
}

// ============================================================
//  syncRoleClaim (mevcut)
// ============================================================
export const syncRoleClaim = onDocumentWritten(
  { document: "users/{uid}", region: REGION },
  async (event) => {
    const uid = event.params.uid;
    const after = event.data?.after?.data();
    if (!after) { try { await getAuth().setCustomUserClaims(uid, null); } catch {} return; }
    const role = after.role || "viewer";
    const active = after.active === true;
    try { await getAuth().getUser(uid); } catch { return; }
    await getAuth().setCustomUserClaims(uid, { role, active });
    console.log(`Claim guncellendi: ${uid} -> role=${role}, active=${active}`);
  }
);

// ============================================================
//  searchSymbols: "THY" -> BIST hisse onerileri
// ============================================================
export const searchSymbols = onCall(COMMON, async (req) => {
  requireAuth(req);
  const text = String(req.data?.text || "").trim();
  if (text.length < 2) return { results: [] };
  try {
    const results = await cached("search_" + text.toUpperCase(), 24 * 60 * 60 * 1000, () => searchBist(text));
    return { results };
  } catch (e) {
    throw new HttpsError("internal", "Arama yapılamadı: " + (e.message || ""));
  }
});

// ============================================================
//  stockData: ad, sektor, fiyat, OHLC -> teknik + temel skor
// ============================================================
export const stockData = onCall(COMMON, async (req) => {
  requireAuth(req);
  const symbol = String(req.data?.symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!symbol) throw new HttpsError("invalid-argument", "Sembol gerekli.");
  return cached("stock_" + symbol, 15 * 60 * 1000, async () => {
    const o = await tvStock(symbol);
    if (!o || o.close == null) throw new HttpsError("not-found", "Hisse bulunamadı: " + symbol);
    const tech = technicalScoreFromTV(o);
    const fund = fundamentalScoreFromTV(o);
    return {
      symbol,
      name: o.description || o.name || "",
      sector: o.sector || "",
      price: o.close != null ? Math.round(o.close * 100) / 100 : null,
      changePct: o.change != null ? Math.round(o.change * 100) / 100 : null,
      currency: o.currency || "TRY",
      scores: { technical: tech.score, fundamental: fund.score },
      detail: { technical: tech.detail, fundamental: fund.detail },
      reasons: { technical: tech.reasons, fundamental: fund.reasons },
      asOf: Date.now(),
    };
  });
});

// ============================================================
//  marketNews: genel Türkçe piyasa akışı (RSS)
// ============================================================
const NEWS_FEEDS = [
  { url: "https://www.bloomberght.com/rss", name: "BloombergHT" },
  { url: "https://www.bloomberght.com/borsa/rss", name: "BloombergHT Borsa" },
  { url: "https://feeds.bbci.co.uk/turkce/rss.xml", name: "BBC Türkçe" },
];
export const marketNews = onCall(COMMON, async (req) => {
  requireAuth(req);
  return cached("market_news", 20 * 60 * 1000, async () => {
    const all = [];
    for (const f of NEWS_FEEDS) {
      try {
        const r = await fetch(f.url, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!r.ok) continue;
        const xml = await r.text();
        all.push(...parseRss(xml, f.name));
      } catch { /* bir kaynak coktuyse digerleri devam */ }
    }
    // tarihe gore sirala (yeni once)
    all.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    return { items: all.slice(0, 40) };
  });
});

// ============================================================
//  stockNews: hisse-özel haber (Yahoo search news)
// ============================================================
export const stockNews = onCall(COMMON, async (req) => {
  requireAuth(req);
  const symbol = String(req.data?.symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const name = String(req.data?.name || "").trim();
  if (!symbol) return { items: [] };
  return cached("stocknews_" + symbol, 30 * 60 * 1000, async () => {
    // Google News RSS (Turkce) — hisse adi/sembol ile ara
    const q = encodeURIComponent(`${name || symbol} borsa hisse`);
    const url = `https://news.google.com/rss/search?q=${q}&hl=tr&gl=TR&ceid=TR:tr`;
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!r.ok) return { items: [] };
      const xml = await r.text();
      const items = parseRss(xml, "Google Haberler")
        .map((it) => ({ ...it, source: (it.title.split(" - ").pop() || "Haber").trim() }))
        .slice(0, 12);
      return { items };
    } catch { return { items: [] }; }
  });
});

// ============================================================
//  kapDisclosures: hisse-özel KAP bildirimleri
//  KAP'in acik uclari kirilgan; erisilemezse bos doner (UI bozulmaz)
// ============================================================
export const kapDisclosures = onCall(COMMON, async (req) => {
  requireAuth(req);
  const symbol = String(req.data?.symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const name = String(req.data?.name || "").trim();
  if (!symbol) return { items: [], available: false };
  return cached("kap_" + symbol, 30 * 60 * 1000, async () => {
    // KAP'in dogrudan API'si Cloud IP'lerinden engelli; KAP odakli haber
    // aramasi (Google News) ile resmi bildirimleri yakalariz.
    const q = encodeURIComponent(`${name || symbol} KAP bildirim`);
    const url = `https://news.google.com/rss/search?q=${q}&hl=tr&gl=TR&ceid=TR:tr`;
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!r.ok) return { items: [], available: false };
      const xml = await r.text();
      const items = parseRss(xml, "KAP / Haber")
        .filter((it) => /kap|bildir|temettü|sermaye|geri al|sözleşme|ihale|pay/i.test(it.title))
        .map((it) => ({ title: it.title, url: it.url, date: it.date, source: (it.title.split(" - ").pop() || "KAP").trim() }))
        .slice(0, 10);
      return { items, available: true };
    } catch {
      return { items: [], available: false };
    }
  });
});
