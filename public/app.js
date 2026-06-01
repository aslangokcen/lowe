// ============================================================
//  Lôwe — Uygulama mantigi (Firebase Web SDK v12, modular)
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  EmailAuthProvider, reauthenticateWithCredential, updatePassword
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
import {
  getStorage, ref as storageRef, uploadBytesResumable, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-storage.js";
import {
  getFunctions, httpsCallable
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-functions.js";
import { firebaseConfig } from "./config.js";

const CONFIG_READY = firebaseConfig.apiKey && !String(firebaseConfig.apiKey).startsWith("BURAYA");
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const show = (el) => el && el.classList.remove("hidden");
const hide = (el) => el && el.classList.add("hidden");

const ROLE_LABELS = { admin: "Yönetici", manager: "Müdür", staff: "Personel", viewer: "İzleyici" };
const ROLE_CLASS = { admin: "role-admin", manager: "role-manager", staff: "role-staff", viewer: "role-viewer" };
const can = {
  write: (r) => ["admin", "manager", "staff"].includes(r),
  delete: (r) => ["admin", "manager"].includes(r),
  admin: (r) => r === "admin",
};

const BORSA_PRESETS = {
  "Varsayılan": { technical: 35, fundamental: 25, macro: 15, news: 15, risk: 10 },
  "Kısa vade": { technical: 50, fundamental: 10, macro: 15, news: 15, risk: 10 },
  "Orta vade": { technical: 30, fundamental: 35, macro: 15, news: 10, risk: 10 },
  "Temettü": { technical: 20, fundamental: 50, macro: 10, news: 10, risk: 10 },
  "Endeks yönlü": { technical: 35, fundamental: 10, macro: 35, news: 10, risk: 10 },
  "Defansif": { technical: 20, fundamental: 30, macro: 20, news: 10, risk: 20 },
};

let auth, db, storage, functions;
const FN_REGION = "europe-west3";
function callFn(name, data) { return httpsCallable(functions, name)(data || {}).then((r) => r.data); }
let currentUser = null, currentProfile = null;
let unsub = { content: null, users: null, settings: null, reports: null, borsaStocks: null, borsaCfg: null, borsaNews: null, docs: null };
let docsCache = [], docFilter = "";
let reportPendingFiles = [];
let reportsCache = [], reportFilter = "__all__";
let borsaStocks = [];
let borsaWeights = { technical: 35, fundamental: 25, macro: 15, news: 15, risk: 10 };
let borsaPreset = "Varsayılan";
let macroInfo = { macroScore: null, regime: "", note: "" };
let lastBorsaCode = "";

// ============================================================
function boot() {
  if (!CONFIG_READY) {
    hide($("#loading")); show($("#login-view")); show($("#config-warning"));
    $("#login-btn").disabled = true; return;
  }
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app); db = getFirestore(app); storage = getStorage(app);
  functions = getFunctions(app, FN_REGION);
  bindLogin(); bindAppShell();
  onAuthStateChanged(auth, handleAuthChange);
}

// ---------------- Auth ----------------
function bindLogin() {
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault(); hide($("#login-error"));
    const email = $("#login-email").value.trim(), password = $("#login-password").value;
    $("#login-btn").disabled = true; $("#login-btn").textContent = "Giriş yapılıyor…";
    try { await signInWithEmailAndPassword(auth, email, password); }
    catch (err) { loginError(authErrorMessage(err.code)); }
    finally { $("#login-btn").disabled = false; $("#login-btn").textContent = "Giriş Yap"; }
  });
}
function loginError(m) { const el = $("#login-error"); el.textContent = m; show(el); }
function authErrorMessage(code) {
  switch (code) {
    case "auth/invalid-email": return "Geçersiz e-posta adresi.";
    case "auth/user-disabled": return "Bu hesap devre dışı bırakılmış.";
    case "auth/user-not-found": case "auth/wrong-password": case "auth/invalid-credential": return "Kullanıcı adı veya şifre hatalı.";
    case "auth/too-many-requests": return "Çok fazla deneme. Biraz sonra tekrar deneyin.";
    case "auth/network-request-failed": return "Bağlantı hatası. İnternetinizi kontrol edin.";
    default: return "Giriş yapılamadı. (" + code + ")";
  }
}

async function handleAuthChange(user) {
  Object.values(unsub).forEach((fn) => fn && fn());
  unsub = { content: null, users: null, settings: null, reports: null, borsaStocks: null, borsaCfg: null, borsaNews: null, docs: null };
  if (!user) {
    currentUser = null; currentProfile = null;
    hide($("#loading")); hide($("#app-view")); show($("#login-view")); return;
  }
  currentUser = user;
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    if (!snap.exists() || snap.data().active !== true) {
      hide($("#loading")); await signOut(auth); show($("#login-view"));
      loginError("Hesabınız henüz etkin değil. Yöneticinizle görüşün."); return;
    }
    currentProfile = { id: user.uid, ...snap.data() };
    // Dosya yetkileri (Storage) jetondaki claim'lerden okunur.
    // Profil rolu ile jeton claim'i uyusmuyorsa jetonu tazele.
    try {
      const tr = await user.getIdTokenResult();
      if (tr.claims.role !== currentProfile.role || tr.claims.active !== (currentProfile.active === true)) {
        await user.getIdToken(true);
      }
    } catch {}
  } catch {
    hide($("#loading")); await signOut(auth); show($("#login-view"));
    loginError("Profil okunamadı. Yöneticinizle görüşün."); return;
  }
  enterApp();
}

// ---------------- Uygulama ----------------
function enterApp() {
  const role = currentProfile.role;
  $("#user-name").textContent = currentProfile.displayName || currentUser.email;
  const badge = $("#user-role");
  badge.textContent = ROLE_LABELS[role] || role;
  badge.className = "role-badge " + (ROLE_CLASS[role] || "");

  $$("[data-admin]").forEach((el) => el.classList.toggle("hidden", !can.admin(role)));
  $$("[data-can-write]").forEach((el) => el.classList.toggle("hidden", !can.write(role)));
  $$("[data-can-manage]").forEach((el) => el.classList.toggle("hidden", !can.delete(role)));

  hide($("#loading")); hide($("#login-view")); show($("#app-view"));
  switchTopTab("yonetim"); switchSubTab("icerik");

  listenContent(); listenSettings(); listenReports();
  listenBorsaStocks(); listenBorsaConfig(); listenBorsaNews(); listenDocs();
  if (can.admin(role)) listenUsers();
}

function bindAppShell() {
  $("#logout-btn").addEventListener("click", () => signOut(auth));
  $$(".nav-tab").forEach((t) => t.addEventListener("click", () => switchTopTab(t.dataset.tab)));
  $$("#panel-yonetim .subnav-tab").forEach((t) => t.addEventListener("click", () => switchSubTab(t.dataset.sub)));
  $$("#panel-borsa .subnav-tab").forEach((t) => t.addEventListener("click", () => switchBorsaSub(t.dataset.bsub)));

  $("#new-content-btn").addEventListener("click", () => openContentForm());
  $("#content-cancel").addEventListener("click", () => hide($("#content-form")));
  $("#content-form").addEventListener("submit", saveContent);
  $("#settings-form").addEventListener("submit", saveSettings);
  $("#new-report-btn").addEventListener("click", () => openReportForm());
  $("#report-cancel").addEventListener("click", () => hide($("#report-form")));
  $("#report-form").addEventListener("submit", saveReport);
  $("#report-files").addEventListener("change", (e) => { reportPendingFiles = Array.from(e.target.files || []); renderReportAttachPreview(); });

  // belgeler
  $("#doc-file-input").addEventListener("change", (e) => { uploadDocs(Array.from(e.target.files || [])); e.target.value = ""; });
  $("#doc-search").addEventListener("input", (e) => { docFilter = e.target.value.trim().toLowerCase(); renderDocs(); });
  const dz = $("#doc-dropzone");
  ["dragover", "dragenter"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => { if (can.write(currentProfile.role)) uploadDocs(Array.from(e.dataTransfer.files || [])); });
  $("#changepw-btn").addEventListener("click", () => { hide($("#pw-error")); $("#pw-form").reset(); show($("#pw-modal")); });
  $("#pw-cancel").addEventListener("click", () => hide($("#pw-modal")));
  $("#pw-form").addEventListener("submit", changePassword);

  // borsa
  $("#new-stock-btn").addEventListener("click", () => openStockForm());
  $("#stock-cancel").addEventListener("click", () => hide($("#stock-form")));
  $("#stock-form").addEventListener("submit", saveStock);
  $("#sd-close").addEventListener("click", () => hide($("#stock-modal")));
  $("#stock-modal").addEventListener("click", (e) => { if (e.target.id === "stock-modal") hide($("#stock-modal")); });
  $("#quick-add-btn").addEventListener("click", quickAddStock);
  bindSymbolSearch();
  $("#manual-scores-toggle").addEventListener("change", (e) => setManualMode(e.target.checked));
  $("#new-news-btn").addEventListener("click", () => openNewsForm());
  $("#news-cancel").addEventListener("click", () => hide($("#news-form")));
  $("#news-form").addEventListener("submit", saveNews);
  $("#news-refresh").addEventListener("click", () => loadMarketNews(true));
  $$(".news-tab").forEach((t) => t.addEventListener("click", () => switchNewsTab(t.dataset.newstab)));
  $("#weights-form").addEventListener("submit", saveWeights);
  ["#w-technical", "#w-fundamental", "#w-macro", "#w-news", "#w-risk"].forEach((s) => $(s).addEventListener("input", updateWeightSum));
  $("#macro-form").addEventListener("submit", saveMacro);
  $("#fx-refresh").addEventListener("click", fetchFX);

  // borsa: kod uretici
  $("#export-buttons").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-gen]"); if (!b) return;
    const s = readStrategy();
    const gen = { json: genJSON, python: genPython, pine: genPine, csharp: genCSharp }[b.dataset.gen];
    lastBorsaCode = gen ? gen(s) : "";
    $("#code-box").textContent = lastBorsaCode;
    $("#export-buttons").querySelectorAll("[data-gen]").forEach((x) => x.classList.toggle("active-gen", x === b));
  });
  $("#copy-code").addEventListener("click", async () => {
    const code = lastBorsaCode || $("#code-box").textContent;
    try { await navigator.clipboard.writeText(code); toast("Kod kopyalandı.", "success"); }
    catch { toast("Kopyalanamadı; metni elle seçip kopyalayın.", "error"); }
  });
}

function switchTopTab(name) {
  $$(".nav-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $$(".panel").forEach((p) => p.classList.remove("active"));
  $("#panel-" + name).classList.add("active");
}
function switchSubTab(name) {
  $$("#panel-yonetim .subnav-tab").forEach((t) => t.classList.toggle("active", t.dataset.sub === name));
  $$("#panel-yonetim .subpanel").forEach((p) => p.classList.remove("active"));
  $("#sub-" + name).classList.add("active");
}
function switchBorsaSub(name) {
  $$("#panel-borsa .subnav-tab").forEach((t) => t.classList.toggle("active", t.dataset.bsub === name));
  $$("#panel-borsa .subpanel").forEach((p) => p.classList.remove("active"));
  $("#bsub-" + name).classList.add("active");
  if (name === "rejim") fetchFX();
  if (name === "tumhisseler") renderScreener();
  if (name === "haberler") loadMarketNews();
}

// ---------------- Icerik ----------------
function listenContent() {
  const q = query(collection(db, "content"), orderBy("updatedAt", "desc"));
  unsub.content = onSnapshot(q, (snap) => {
    const el = $("#content-list"); el.innerHTML = "";
    if (snap.empty) { show($("#content-empty")); return; }
    hide($("#content-empty"));
    snap.forEach((d) => el.appendChild(renderContentItem(d.id, d.data())));
  }, (e) => toast("İçerik okunamadı: " + e.code, "error"));
}
function renderContentItem(id, data) {
  const role = currentProfile.role;
  const el = document.createElement("article"); el.className = "item";
  el.innerHTML = `
    <div class="item-head">
      <div>${data.category ? `<span class="item-cat">${esc(data.category)}</span>` : ""}
        <h3 class="item-title">${esc(data.title || "(başlıksız)")}</h3></div>
      <div class="item-actions"></div>
    </div>
    <div class="item-body">${esc(data.body || "")}</div>
    <div class="item-meta">Son güncelleme: ${fmtDate(data.updatedAt) || ""}${data.updatedByName ? " · " + esc(data.updatedByName) : ""}</div>`;
  const actions = el.querySelector(".item-actions");
  if (can.write(role)) { const b = button("Düzenle", "btn btn-ghost btn-sm"); b.onclick = () => openContentForm({ id, ...data }); actions.appendChild(b); }
  if (can.delete(role)) { const b = button("Sil", "btn btn-danger btn-sm"); b.onclick = () => removeContent(id, data.title); actions.appendChild(b); }
  return el;
}
function openContentForm(item = null) {
  $("#content-id").value = item?.id || ""; $("#content-title").value = item?.title || "";
  $("#content-category").value = item?.category || ""; $("#content-body").value = item?.body || "";
  show($("#content-form")); $("#content-title").focus();
}
async function saveContent(e) {
  e.preventDefault();
  const id = $("#content-id").value;
  const payload = { title: $("#content-title").value.trim(), category: $("#content-category").value.trim(), body: $("#content-body").value.trim(), updatedAt: serverTimestamp(), updatedBy: currentUser.uid, updatedByName: currentProfile.displayName || currentUser.email };
  try {
    if (id) await updateDoc(doc(db, "content", id), payload);
    else { payload.createdAt = serverTimestamp(); payload.createdBy = currentUser.uid; await addDoc(collection(db, "content"), payload); }
    hide($("#content-form")); toast("Kaydedildi.", "success");
  } catch (err) { toast(permError(err) || ("Kaydedilemedi: " + err.code), "error"); }
}
async function removeContent(id, title) {
  if (!confirm(`"${title || "Bu kayıt"}" silinsin mi? Geri alınamaz.`)) return;
  try { await deleteDoc(doc(db, "content", id)); toast("Silindi.", "success"); }
  catch (err) { toast(permError(err) || ("Silinemedi: " + err.code), "error"); }
}

// ---------------- Raporlar ----------------
function listenReports() {
  const q = query(collection(db, "reports"), orderBy("updatedAt", "desc"));
  unsub.reports = onSnapshot(q, (snap) => {
    reportsCache = []; snap.forEach((d) => reportsCache.push({ id: d.id, ...d.data() }));
    renderReports();
  }, (e) => toast("Raporlar okunamadı: " + e.code, "error"));
}
function renderReports() {
  const cats = [...new Set(reportsCache.map((r) => (r.category || "").trim()).filter(Boolean))].sort();
  const chips = $("#report-chips"); chips.innerHTML = "";
  const mk = (label, val) => { const b = document.createElement("button"); b.className = "chip" + (reportFilter === val ? " active" : ""); b.textContent = label; b.onclick = () => { reportFilter = val; renderReports(); }; return b; };
  chips.appendChild(mk("Tümü", "__all__"));
  cats.forEach((c) => chips.appendChild(mk(c, c)));
  chips.style.display = cats.length ? "flex" : "none";
  const list = $("#reports-list"); list.innerHTML = "";
  const items = reportsCache.filter((r) => reportFilter === "__all__" || (r.category || "").trim() === reportFilter);
  if (!items.length) { show($("#reports-empty")); return; }
  hide($("#reports-empty"));
  items.forEach((r) => list.appendChild(renderReportItem(r)));
}
function renderReportItem(r) {
  const role = currentProfile.role;
  const el = document.createElement("article"); el.className = "item";
  const hist = Array.isArray(r.history) ? r.history : [];
  el.innerHTML = `
    <div class="item-head">
      <div>${r.category ? `<span class="item-cat">${esc(r.category)}</span>` : ""}
        <h3 class="item-title">${esc(r.title || "(başlıksız)")}</h3></div>
      <div class="item-actions"></div>
    </div>
    <div class="item-body">${esc(r.body || "")}</div>
    ${Array.isArray(r.attachments) && r.attachments.length ? `<div class="attach-list">${r.attachments.map((a) => `<a class="attach-chip" href="${a.url}" target="_blank" rel="noopener">${fileIcon(a.type, a.name)} ${esc(a.name)}</a>`).join("")}</div>` : ""}
    <div class="item-meta">Son güncelleme: ${fmtDate(r.updatedAt) || ""}${r.updatedByName ? " · " + esc(r.updatedByName) : ""}</div>`;
  const actions = el.querySelector(".item-actions");
  if (can.write(role)) { const b = button("Düzenle", "btn btn-ghost btn-sm"); b.onclick = () => openReportForm(r); actions.appendChild(b); }
  if (can.delete(role)) { const b = button("Sil", "btn btn-danger btn-sm"); b.onclick = () => removeReport(r.id, r.title); actions.appendChild(b); }
  if (hist.length) {
    const det = document.createElement("details"); det.className = "history";
    const sum = document.createElement("summary"); sum.textContent = `Geçmiş (${hist.length})`; det.appendChild(sum);
    hist.forEach((h) => {
      const hi = document.createElement("div"); hi.className = "hist-item";
      hi.innerHTML = `<div class="hist-meta">${esc(h.at ? new Date(h.at).toLocaleString("tr-TR", { dateStyle: "medium", timeStyle: "short" }) : "")}${h.by ? " · " + esc(h.by) : ""}</div>
        <div class="hist-body"><strong>${esc(h.title || "")}</strong>\n${esc(h.body || "")}</div>`;
      det.appendChild(hi);
    });
    el.appendChild(det);
  }
  return el;
}
function openReportForm(r = null) {
  $("#report-id").value = r?.id || ""; $("#report-title").value = r?.title || "";
  $("#report-category").value = r?.category || ""; $("#report-body").value = r?.body || "";
  reportPendingFiles = []; $("#report-files").value = ""; renderReportAttachPreview();
  show($("#report-form")); $("#report-title").focus();
}
async function saveReport(e) {
  e.preventDefault();
  const id = $("#report-id").value;
  const title = $("#report-title").value.trim(), category = $("#report-category").value.trim(), body = $("#report-body").value.trim();
  const btn = e.submitter; if (btn) { btn.disabled = true; btn.textContent = reportPendingFiles.length ? "Yükleniyor…" : "Kaydediliyor…"; }
  try {
    let newAttachments = [];
    if (reportPendingFiles.length) newAttachments = await uploadReportFiles(reportPendingFiles);
    if (id) {
      const prev = reportsCache.find((x) => x.id === id) || {};
      const history = [{ title: prev.title || "", body: prev.body || "", at: new Date().toISOString(), by: prev.updatedByName || "" }, ...(Array.isArray(prev.history) ? prev.history : [])].slice(0, 20);
      const attachments = [...(Array.isArray(prev.attachments) ? prev.attachments : []), ...newAttachments];
      await updateDoc(doc(db, "reports", id), { title, category, body, history, attachments, updatedAt: serverTimestamp(), updatedBy: currentUser.uid, updatedByName: currentProfile.displayName || currentUser.email });
    } else {
      await addDoc(collection(db, "reports"), { title, category, body, history: [], attachments: newAttachments, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: currentUser.uid, updatedByName: currentProfile.displayName || currentUser.email });
    }
    reportPendingFiles = [];
    hide($("#report-form")); toast("Rapor kaydedildi.", "success");
  } catch (err) { toast(permError(err) || ("Kaydedilemedi: " + (err.code || err.message)), "error"); }
  finally { if (btn) { btn.disabled = false; btn.textContent = "Kaydet"; } }
}
async function removeReport(id, title) {
  if (!confirm(`"${title || "Bu rapor"}" silinsin mi? Geçmişiyle birlikte silinir.`)) return;
  try { await deleteDoc(doc(db, "reports", id)); toast("Rapor silindi.", "success"); }
  catch (err) { toast(permError(err) || ("Silinemedi: " + err.code), "error"); }
}

// ---------------- BORSA: hisseler & skor ----------------
function genelScore(s) {
  const w = borsaWeights;
  const tot = (w.technical + w.fundamental + w.macro + w.news + w.risk) || 100;
  const v = (n) => (n == null || n === "" ? 0 : +n);
  const g = (v(s.technical) * w.technical + v(s.fundamental) * w.fundamental + v(s.macro) * w.macro + v(s.news) * w.news + v(s.risk) * w.risk) / tot;
  return Math.round(g * 10) / 10;
}
function classify(g) {
  if (g >= 8.5) return { label: "Güçlü Alım Adayı", cls: "cls-strong" };
  if (g >= 7) return { label: "Alım Adayı", cls: "cls-buy" };
  if (g >= 6) return { label: "İzle", cls: "cls-watch" };
  if (g >= 4.5) return { label: "Nötr", cls: "cls-neutral" };
  if (g >= 3) return { label: "Riskli", cls: "cls-risk" };
  return { label: "Uzak Dur / Satış", cls: "cls-sell" };
}
function scoreColor(v) { return v >= 7 ? "sc-good" : v >= 5 ? "sc-mid" : "sc-bad"; }
function statCard(label, val) { return `<div class="stat-card"><div class="sc-label">${esc(label)}</div><div class="sc-val">${esc(String(val))}</div></div>`; }

function listenBorsaStocks() {
  const q = query(collection(db, "borsa_stocks"), orderBy("updatedAt", "desc"));
  unsub.borsaStocks = onSnapshot(q, (snap) => {
    borsaStocks = []; snap.forEach((d) => borsaStocks.push({ id: d.id, ...d.data() }));
    renderBorsaPanel(); renderStocks(); renderAlarms();
  }, (e) => toast("Hisseler okunamadı: " + e.code, "error"));
}
function listenBorsaConfig() {
  unsub.borsaCfg = onSnapshot(collection(db, "borsa_config"), (snap) => {
    snap.forEach((d) => {
      if (d.id === "weights" && d.data().weights) { borsaWeights = d.data().weights; borsaPreset = d.data().preset || "Özel"; }
      if (d.id === "macro") { macroInfo = { ...macroInfo, ...d.data() }; }
    });
    renderBorsaPanel(); renderStrategy(); renderRejimForm(); renderAlarms();
  }, () => {});
}

function renderBorsaPanel() {
  const rows = borsaStocks.map((s) => ({ ...s, genel: genelScore(s.scores || {}) })).sort((a, b) => b.genel - a.genel);
  const total = rows.length;
  const alim = rows.filter((r) => r.genel >= 7).length;
  const riskli = rows.filter((r) => r.genel < 4.5).length;
  const avg = total ? rows.reduce((a, r) => a + r.genel, 0) / total : 0;
  $("#borsa-cards").innerHTML =
    statCard("Hisse", total) + statCard("Alım Adayı (≥7)", alim) + statCard("Riskli (<4,5)", riskli) +
    statCard("Ort. Genel", avg.toFixed(1)) +
    statCard("Makro Durum", (macroInfo.macroScore != null ? macroInfo.macroScore : "—") + (macroInfo.regime ? " · " + macroInfo.regime : ""));
  const w = borsaWeights;
  $("#borsa-active-strategy").textContent = "Aktif strateji: " + (borsaPreset || "Özel") + " (" + w.technical + "/" + w.fundamental + "/" + w.macro + "/" + w.news + "/" + w.risk + ")";
  const t = $("#borsa-table");
  if (!total) { t.innerHTML = ""; show($("#borsa-empty")); return; }
  hide($("#borsa-empty"));
  let html = '<thead><tr><th>Hisse</th><th>Sektör</th><th>Tek</th><th>Tem</th><th>Mak</th><th>Hab</th><th>Risk</th><th>Genel</th><th>Sınıf</th></tr></thead><tbody>';
  rows.forEach((r) => {
    const c = classify(r.genel), s = r.scores || {};
    html += `<tr class="row-click" data-id="${r.id}"><td><b>${esc(r.symbol || "")}</b></td><td class="muted">${esc(r.sector || "")}</td>${scoreTd(s.technical)}${scoreTd(s.fundamental)}${scoreTd(s.macro)}${scoreTd(s.news)}${scoreTd(s.risk)}<td><b>${r.genel.toFixed(1)}</b></td><td><span class="cls-badge ${c.cls}">${c.label}</span></td></tr>`;
  });
  html += "</tbody>"; t.innerHTML = html;
  t.querySelectorAll("tr.row-click").forEach((tr) => {
    tr.addEventListener("click", () => { const st = borsaStocks.find((x) => x.id === tr.dataset.id); if (st) openStockDetail(st); });
  });
}
function scoreTd(v) { if (v == null || v === "") return '<td class="muted">—</td>'; return `<td><span class="sc-chip ${scoreColor(+v)}">${(+v).toFixed(1)}</span></td>`; }

function renderStocks() {
  const el = $("#stocks-list"); el.innerHTML = "";
  if (!borsaStocks.length) { el.innerHTML = '<div class="empty">Henüz hisse yok.</div>'; return; }
  const role = currentProfile.role;
  borsaStocks.forEach((s) => {
    const genel = genelScore(s.scores || {}), c = classify(genel), sc = s.scores || {};
    const a = document.createElement("article"); a.className = "item item-click";
    a.innerHTML = `
      <div class="item-head">
        <div><span class="item-cat">${esc(s.sector || "—")}</span>
          <h3 class="item-title">${esc(s.symbol || "")} <span class="muted" style="font-weight:500">${esc(s.name || "")}</span> <span class="chart-hint">📈 grafik</span></h3></div>
        <div class="item-actions"></div>
      </div>
      <div class="score-row">
        ${scoreMini("Teknik", sc.technical)}${scoreMini("Temel", sc.fundamental)}${scoreMini("Makro", sc.macro)}${scoreMini("Haber", sc.news)}${scoreMini("Risk", sc.risk)}
        <div class="genel-pill"><span>Genel</span><b>${genel.toFixed(1)}</b><span class="cls-badge ${c.cls}">${c.label}</span></div>
      </div>
      ${s.note ? `<div class="item-body">${esc(s.note)}</div>` : ""}
      <div class="item-meta">Son güncelleme: ${fmtDate(s.updatedAt) || ""}${s.updatedByName ? " · " + esc(s.updatedByName) : ""}</div>`;
    a.addEventListener("click", (e) => { if (e.target.closest(".item-actions")) return; openStockDetail(s); });
    const actions = a.querySelector(".item-actions");
    if (can.write(role)) { const b = button("Düzenle", "btn btn-ghost btn-sm"); b.onclick = (e) => { e.stopPropagation(); openStockForm(s); }; actions.appendChild(b); }
    if (can.delete(role)) { const b = button("Sil", "btn btn-danger btn-sm"); b.onclick = (e) => { e.stopPropagation(); removeStock(s.id, s.symbol); }; actions.appendChild(b); }
    el.appendChild(a);
  });
}
function renderAlarms() {
  const list = $("#alarms-list"); if (!list) return;
  const items = [];
  borsaStocks.forEach((st) => {
    const s = st.scores || {}, g = genelScore(s);
    const r = [];
    if ((s.technical ?? 0) >= 7.5) r.push("Teknik güçlü (" + (+s.technical).toFixed(1) + ")");
    if (s.technical != null && +s.technical < 4.5) r.push("Teknik zayıf (" + (+s.technical).toFixed(1) + ")");
    if ((s.fundamental ?? 0) >= 7.5) r.push("Temel güçlü");
    if (s.news != null && +s.news <= 3) r.push("Haber baskısı");
    if (s.risk != null && +s.risk < 4.5) r.push("Risk yüksek");
    if ((s.macro ?? 0) >= 7.5) r.push("Makro destekleyici");
    let sev, lvl, label;
    if (g < 3) { sev = "kritik"; lvl = 4; label = "Kritik / Satış uyarısı"; }
    else if (g < 4.5) { sev = "risk"; lvl = 3; label = "Risk uyarısı"; }
    else if (g >= 8.5) { sev = "guclu"; lvl = 3; label = "Güçlü Alım Adayı"; }
    else if (g >= 7) { sev = "sinyal"; lvl = 2; label = "Alım sinyali"; }
    else return;
    items.push({ symbol: st.symbol, sector: st.sector, g, sev, lvl, label, reasons: r });
  });
  const order = { kritik: 0, guclu: 1, sinyal: 2, risk: 3 };
  items.sort((a, b) => (order[a.sev] - order[b.sev]) || (b.g - a.g));
  $("#alarms-count").textContent = items.length ? items.length + " aktif alarm" : "";
  list.innerHTML = "";
  if (!items.length) { list.innerHTML = '<div class="empty">Aktif alarm yok. Hisse skorları girildikçe burada belirir.</div>'; return; }
  items.forEach((a) => {
    const el = document.createElement("article"); el.className = "alarm alarm-" + a.sev;
    el.innerHTML = `<div class="alarm-top"><span class="sev-badge sev-${a.sev}">Seviye ${a.lvl}</span>
      <b>${esc(a.symbol || "")}</b> <span class="muted">${esc(a.sector || "")}</span>
      <span class="alarm-genel">Genel ${a.g.toFixed(1)}</span></div>
      <div class="alarm-label">${esc(a.label)}</div>
      ${a.reasons.length ? `<div class="alarm-reasons">${a.reasons.map((x) => `<span>${esc(x)}</span>`).join("")}</div>` : ""}`;
    list.appendChild(el);
  });
}
function scoreMini(label, v) { const disp = (v == null || v === "") ? "—" : (+v).toFixed(1); const col = (v == null || v === "") ? "sc-mid" : scoreColor(+v); return `<div class="score-mini"><span>${label}</span><b class="sc-chip ${col}">${disp}</b></div>`; }

const MACRO_FIELDS = [
  { id: "usdtry", label: "USD/TRY" }, { id: "brent", label: "Brent" }, { id: "gold", label: "Altın" },
  { id: "sp500", label: "S&P 500" }, { id: "rate", label: "Faiz" }, { id: "vix", label: "VIX" },
  { id: "cds", label: "CDS" }, { id: "bist", label: "BIST100" },
];
let autoStockData = null;  // son cekilen otomatik veri (ad/sektor/skor)
function setManualMode(on) {
  $("#manual-scores-toggle").checked = on;
  ["#sc-technical", "#sc-fundamental"].forEach((s) => { $(s).readOnly = !on; });
  $("#stock-name").readOnly = !on;
  $("#stock-sector").readOnly = !on;
}
function openStockForm(s = null) {
  $("#stock-id").value = s?.id || ""; $("#stock-symbol").value = s?.symbol || ""; $("#stock-name").value = s?.name || ""; $("#stock-sector").value = s?.sector || "";
  const sc = s?.scores || {};
  $("#sc-technical").value = sc.technical ?? ""; $("#sc-fundamental").value = sc.fundamental ?? ""; $("#sc-macro").value = sc.macro ?? ""; $("#sc-news").value = sc.news ?? ""; $("#sc-risk").value = sc.risk ?? "";
  const ms = s?.macroSens || {};
  MACRO_FIELDS.forEach((m) => { const el = $("#ms-" + m.id); if (el) el.value = ms[m.id] ?? ""; });
  $("#stock-note").value = s?.note || "";
  autoStockData = null;
  setManualMode(s?.manualScores === true);
  hide($("#symbol-suggest")); hide($("#auto-status"));
  hide($("#stock-modal"));
  switchBorsaSub("hisseler");
  show($("#stock-form")); $("#stock-symbol").focus();
  // mevcut hisseyi duzenliyorsak skorlari tazele (manuel degilse)
  if (s?.symbol && s?.manualScores !== true) fetchAndFillStock(s.symbol, false);
}

// hisse verisini cek, ad/sektor/skorlari otomatik doldur
async function fetchAndFillStock(symbol, focusAfter = true) {
  const status = $("#auto-status");
  status.className = "auto-status"; status.textContent = "📡 " + symbol + " verisi alınıyor…"; show(status);
  try {
    const d = await callFn("stockData", { symbol });
    autoStockData = d;
    if (d.name) $("#stock-name").value = d.name;
    if (d.sector) $("#stock-sector").value = d.sector;
    const manual = $("#manual-scores-toggle").checked;
    if (!manual) {
      if (d.scores?.technical != null) $("#sc-technical").value = d.scores.technical;
      if (d.scores?.fundamental != null) $("#sc-fundamental").value = d.scores.fundamental;
    }
    const parts = [];
    if (d.price != null) parts.push("Fiyat " + d.price + " ₺");
    if (d.changePct != null) parts.push((d.changePct >= 0 ? "▲" : "▼") + " %" + Math.abs(d.changePct).toFixed(2));
    if (d.scores?.technical != null) parts.push("Teknik " + d.scores.technical);
    if (d.scores?.fundamental != null) parts.push("Temel " + d.scores.fundamental);
    status.className = "auto-status ok"; status.textContent = "✓ " + parts.join("  ·  ");
  } catch (err) {
    status.className = "auto-status err";
    status.textContent = "⚠️ Otomatik veri alınamadı (" + (err.message || err.code || "") + "). Bilgileri elle girebilirsiniz.";
    setManualMode(true);
  }
}

async function saveStock(e) {
  e.preventDefault();
  const id = $("#stock-id").value;
  const num = (sel) => { const x = $(sel).value; return x === "" ? null : Math.max(0, Math.min(10, +x)); };
  const msNum = (sel) => { const x = $(sel).value; return x === "" ? null : Math.max(-1, Math.min(1, +x)); };
  const macroSens = {};
  MACRO_FIELDS.forEach((m) => { const v = msNum("#ms-" + m.id); if (v != null) macroSens[m.id] = v; });
  const manual = $("#manual-scores-toggle").checked;
  const payload = {
    symbol: ($("#stock-symbol").value.trim() || "").toUpperCase(), name: $("#stock-name").value.trim(), sector: $("#stock-sector").value.trim(),
    scores: { technical: num("#sc-technical"), fundamental: num("#sc-fundamental"), macro: num("#sc-macro"), news: num("#sc-news"), risk: num("#sc-risk") },
    macroSens, manualScores: manual,
    price: autoStockData?.price ?? null, changePct: autoStockData?.changePct ?? null,
    autoDetail: autoStockData?.detail ?? null, autoReasons: autoStockData?.reasons ?? null,
    note: $("#stock-note").value.trim(), updatedAt: serverTimestamp(), updatedBy: currentUser.uid, updatedByName: currentProfile.displayName || currentUser.email,
  };
  try {
    if (id) await updateDoc(doc(db, "borsa_stocks", id), payload);
    else { payload.createdAt = serverTimestamp(); await addDoc(collection(db, "borsa_stocks"), payload); }
    hide($("#stock-form")); toast("Hisse kaydedildi.", "success");
  } catch (err) { toast(permError(err) || ("Kaydedilemedi: " + err.code), "error"); }
}
async function removeStock(id, sym) {
  if (!confirm(`"${sym || "Bu hisse"}" silinsin mi?`)) return;
  try { await deleteDoc(doc(db, "borsa_stocks", id)); toast("Silindi.", "success"); }
  catch (err) { toast(permError(err) || ("Silinemedi: " + err.code), "error"); }
}

// ---------------- BORSA: TradingView + hisse detay ----------------
let tvLoaded = null;
function loadTradingView() {
  if (tvLoaded) return tvLoaded;
  tvLoaded = new Promise((resolve) => {
    if (window.TradingView) return resolve();
    const s = document.createElement("script");
    s.src = "https://s3.tradingview.com/tv.js"; s.async = true;
    s.onload = () => resolve();
    document.head.appendChild(s);
  });
  return tvLoaded;
}
// BIST gecikmeli besleme: ucretsiz gomulu widget'larda BIST_DLY calisir
function tvSymbol(sym) { return "BIST_DLY:" + (sym || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }

const MACRO_LABEL = Object.fromEntries(MACRO_FIELDS.map((m) => [m.id, m.label]));
async function openStockDetail(s) {
  const sc = s.scores || {}, genel = genelScore(sc), c = classify(genel);
  $("#sd-title").textContent = (s.symbol || "") + (s.name ? "  ·  " + s.name : "");
  $("#sd-sub").textContent = (s.sector || "") + (s.updatedByName ? "  ·  " + s.updatedByName : "");
  $("#sd-genel").textContent = genel.toFixed(1);
  const cb = $("#sd-class"); cb.textContent = c.label; cb.className = "cls-badge " + c.cls;
  // skor satirlari
  const rows = [["Teknik", sc.technical], ["Temel", sc.fundamental], ["Makro", sc.macro], ["Haber", sc.news], ["Risk", sc.risk]];
  $("#sd-scores").innerHTML = rows.map(([lbl, v]) => {
    const disp = (v == null || v === "") ? "—" : (+v).toFixed(1);
    const col = (v == null || v === "") ? "sc-mid" : scoreColor(+v);
    const pct = (v == null || v === "") ? 0 : (+v) * 10;
    return `<div class="sd-score-row"><span class="sd-score-lbl">${lbl}</span>
      <div class="sd-bar"><i class="${col}" style="width:${pct}%"></i></div>
      <b class="sc-chip ${col}">${disp}</b></div>`;
  }).join("");
  // makro duyarlilik
  const ms = s.macroSens || {};
  const msKeys = Object.keys(ms);
  $("#sd-macro").innerHTML = msKeys.length
    ? `<div class="sd-section-t">Makro Duyarlılık</div><div class="ms-grid">` +
      msKeys.map((k) => {
        const v = ms[k], cls = v > 0 ? "ms-pos" : v < 0 ? "ms-neg" : "ms-zero";
        return `<span class="ms-chip ${cls}">${esc(MACRO_LABEL[k] || k)} <b>${v > 0 ? "+" : ""}${v}</b></span>`;
      }).join("") + `</div>`
    : `<div class="sd-section-t">Makro Duyarlılık</div><div class="muted small">Henüz girilmedi. “Düzenle” ile ekleyebilirsiniz.</div>`;
  let noteHtml = s.note ? `<div class="sd-section-t">Gerekçe</div><div class="sd-note-body">${esc(s.note)}</div>` : "";
  // otomatik analiz gerekceleri (varsa)
  const ar = s.autoReasons;
  if (ar && (ar.technical?.length || ar.fundamental?.length)) {
    noteHtml += `<div class="sd-section-t" style="margin-top:14px">Otomatik Analiz</div>`;
    if (ar.technical?.length) noteHtml += `<div class="auto-reasons"><b>Teknik:</b> ${ar.technical.map((x) => esc(x)).join(" · ")}</div>`;
    if (ar.fundamental?.length) noteHtml += `<div class="auto-reasons"><b>Temel:</b> ${ar.fundamental.map((x) => esc(x)).join(" · ")}</div>`;
  }
  $("#sd-note").innerHTML = noteHtml;
  // edit butonu
  $("#sd-edit").onclick = () => openStockForm(s);
  // haber + KAP (asenkron)
  $("#sd-news").innerHTML = '<div class="muted small">Yükleniyor…</div>';
  $("#sd-kap").innerHTML = '<div class="muted small">Yükleniyor…</div>';
  loadStockFeeds(s.symbol, s.name);
  show($("#stock-modal"));
  // grafik — TradingView resmi gomulu "Advanced Chart" widget'i (BIST gecikmeli)
  const host = $("#sd-tv"); host.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "tradingview-widget-container"; wrap.style.height = "100%"; wrap.style.width = "100%";
  const inner = document.createElement("div");
  inner.className = "tradingview-widget-container__widget"; inner.style.height = "100%"; inner.style.width = "100%";
  wrap.appendChild(inner);
  const tvScript = document.createElement("script");
  tvScript.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
  tvScript.type = "text/javascript"; tvScript.async = true;
  tvScript.innerHTML = JSON.stringify({
    symbol: tvSymbol(s.symbol), interval: "D", timezone: "Europe/Istanbul",
    theme: "light", style: "1", locale: "tr", autosize: true,
    hide_side_toolbar: true, allow_symbol_change: false, studies: ["STD;EMA"],
    backgroundColor: "rgba(255,255,255,1)",
  });
  wrap.appendChild(tvScript);
  host.appendChild(wrap);
}

// ---- hisse arama (autocomplete) ----
let searchTimer = null;
function bindSymbolSearch() {
  const inp = $("#stock-symbol"), box = $("#symbol-suggest");
  inp.addEventListener("input", () => {
    const text = inp.value.trim();
    clearTimeout(searchTimer);
    if (text.length < 2) { hide(box); return; }
    searchTimer = setTimeout(async () => {
      try {
        const { results } = await callFn("searchSymbols", { text });
        if (!results || !results.length) { box.innerHTML = '<div class="sg-empty">Sonuç yok</div>'; show(box); return; }
        box.innerHTML = results.map((r) =>
          `<div class="sg-item" data-sym="${esc(r.symbol)}"><b>${esc(r.symbol)}</b> <span class="muted">${esc(r.name || "")}</span>${r.price != null ? `<span class="sg-price">${r.price} ₺</span>` : ""}</div>`
        ).join("");
        box.querySelectorAll(".sg-item").forEach((it) => {
          it.addEventListener("click", () => {
            inp.value = it.dataset.sym; hide(box);
            fetchAndFillStock(it.dataset.sym);
          });
        });
        show(box);
      } catch { hide(box); }
    }, 320);
  });
  inp.addEventListener("blur", () => setTimeout(() => hide(box), 200));
  inp.addEventListener("change", () => { const v = inp.value.trim().toUpperCase(); if (v.length >= 3) fetchAndFillStock(v); });
}

// ---- hisse detay: haber + KAP yukle ----
async function loadStockFeeds(symbol, name) {
  callFn("stockNews", { symbol, name }).then((r) => {
    const el = $("#sd-news");
    if (!r.items || !r.items.length) { el.innerHTML = '<div class="muted small">Haber bulunamadı.</div>'; return; }
    el.innerHTML = r.items.map((n) => feedItem(n)).join("");
  }).catch(() => { $("#sd-news").innerHTML = '<div class="muted small">Haber alınamadı.</div>'; });

  callFn("kapDisclosures", { symbol, name }).then((r) => {
    const el = $("#sd-kap");
    if (!r.available) { el.innerHTML = '<div class="muted small">KAP bağlantısı şu an kullanılamıyor.</div>'; return; }
    if (!r.items || !r.items.length) { el.innerHTML = '<div class="muted small">Son 30 günde KAP bildirimi yok.</div>'; return; }
    el.innerHTML = r.items.map((n) => feedItem(n)).join("");
  }).catch(() => { $("#sd-kap").innerHTML = '<div class="muted small">KAP alınamadı.</div>'; });
}
function feedItem(n) {
  const d = n.date ? new Date(n.date) : null;
  const dateStr = d && !isNaN(d) ? d.toLocaleDateString("tr-TR", { day: "2-digit", month: "short" }) : "";
  return `<a class="feed-item" href="${esc(n.url || "#")}" target="_blank" rel="noopener">
    <div class="feed-title">${esc(n.title || "")}</div>
    <div class="feed-meta">${esc(n.source || "")}${dateStr ? " · " + dateStr : ""}</div></a>`;
}

// ---- Haberler sekmesi: genel canli akis ----
let marketNewsLoaded = false;
function switchNewsTab(name) {
  $$(".news-tab").forEach((t) => t.classList.toggle("active", t.dataset.newstab === name));
  $("#newssub-canli").classList.toggle("hidden", name !== "canli");
  $("#newssub-manuel").classList.toggle("hidden", name !== "manuel");
}
async function loadMarketNews(force = false) {
  if (marketNewsLoaded && !force) return;
  marketNewsLoaded = true;
  const list = $("#live-news-list"), empty = $("#live-news-empty");
  empty.textContent = "Haber yükleniyor…"; show(empty); list.innerHTML = "";
  try {
    const { items } = await callFn("marketNews", {});
    if (!items || !items.length) { empty.textContent = "Haber bulunamadı."; return; }
    hide(empty);
    list.innerHTML = items.map((n) => {
      const d = n.date ? new Date(n.date) : null;
      const dateStr = d && !isNaN(d) ? d.toLocaleString("tr-TR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
      return `<a class="news-card" href="${esc(n.url || "#")}" target="_blank" rel="noopener">
        <div class="news-card-title">${esc(n.title || "")}</div>
        <div class="news-card-meta"><span class="news-src">${esc(n.source || "")}</span>${dateStr ? " · " + dateStr : ""}</div></a>`;
    }).join("");
  } catch (err) {
    empty.textContent = "Haber akışı alınamadı: " + (err.message || err.code || "");
  }
}

// ---------------- BORSA: Tum Hisseler (screener) ----------------
let screenerLoaded = false;
function renderScreener() {
  if (screenerLoaded) return;
  const host = $("#tv-screener"); if (!host) return;
  screenerLoaded = true;
  host.innerHTML = "";
  const s = document.createElement("script");
  s.src = "https://s3.tradingview.com/external-embedding/embed-widget-screener.js";
  s.async = true; s.type = "text/javascript";
  s.innerHTML = JSON.stringify({
    width: "100%", height: 600, defaultColumn: "overview", defaultScreen: "general",
    market: "turkey", showToolbar: true, colorTheme: "light", locale: "tr", isTransparent: true,
  });
  const wrap = document.createElement("div"); wrap.className = "tradingview-widget-container";
  const inner = document.createElement("div"); inner.className = "tradingview-widget-container__widget";
  wrap.appendChild(inner); wrap.appendChild(s); host.appendChild(wrap);
}
async function quickAddStock() {
  const sym = ($("#quick-symbol").value.trim() || "").toUpperCase();
  if (!sym) { toast("Sembol girin (örn. ASELS).", "error"); return; }
  if (borsaStocks.some((x) => (x.symbol || "").toUpperCase() === sym)) { toast(sym + " zaten takip listenizde.", "error"); return; }
  const btn = $("#quick-add-btn"); btn.disabled = true; btn.textContent = "Veri alınıyor…";
  try {
    let d = null;
    try { d = await callFn("stockData", { symbol: sym }); } catch { /* veri yoksa bos eklenir */ }
    await addDoc(collection(db, "borsa_stocks"), {
      symbol: sym,
      name: d?.name || "",
      sector: d?.sector || $("#quick-sector").value.trim(),
      scores: { technical: d?.scores?.technical ?? null, fundamental: d?.scores?.fundamental ?? null },
      macroSens: {}, manualScores: false,
      price: d?.price ?? null, changePct: d?.changePct ?? null,
      autoDetail: d?.detail ?? null, autoReasons: d?.reasons ?? null, note: "",
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: currentUser.uid, updatedByName: currentProfile.displayName || currentUser.email,
    });
    $("#quick-symbol").value = ""; $("#quick-sector").value = "";
    toast(sym + (d?.name ? " (" + d.name + ")" : "") + " eklendi" + (d?.scores?.technical != null ? ` — Teknik ${d.scores.technical}, Temel ${d.scores.fundamental ?? "—"}` : "") + ".", "success");
  } catch (err) { toast(permError(err) || ("Eklenemedi: " + err.code), "error"); }
  finally { btn.disabled = false; btn.textContent = "+ Takip Listeme Ekle"; }
}

// ---------------- BORSA: strateji ----------------
function fillWeights(w) { $("#w-technical").value = w.technical; $("#w-fundamental").value = w.fundamental; $("#w-macro").value = w.macro; $("#w-news").value = w.news; $("#w-risk").value = w.risk; }
function readWeights() { return { technical: +$("#w-technical").value || 0, fundamental: +$("#w-fundamental").value || 0, macro: +$("#w-macro").value || 0, news: +$("#w-news").value || 0, risk: +$("#w-risk").value || 0 }; }
function updateWeightSum() { const w = readWeights(); const s = w.technical + w.fundamental + w.macro + w.news + w.risk; const el = $("#w-sum"); el.textContent = "Toplam: " + s + "%"; el.style.color = s === 100 ? "var(--text-soft)" : "var(--danger)"; }
function renderStrategy() {
  const chips = $("#preset-chips"); chips.innerHTML = "";
  Object.keys(BORSA_PRESETS).forEach((name) => {
    const b = document.createElement("button"); b.className = "chip" + (borsaPreset === name ? " active" : ""); b.textContent = name;
    b.onclick = () => { fillWeights(BORSA_PRESETS[name]); borsaPreset = name; chips.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c.textContent === name)); updateWeightSum(); };
    chips.appendChild(b);
  });
  fillWeights(borsaWeights); updateWeightSum();
}
async function saveWeights(e) {
  e.preventDefault();
  const w = readWeights(); const s = w.technical + w.fundamental + w.macro + w.news + w.risk;
  if (s !== 100) { toast("Ağırlık toplamı 100 olmalı (şu an " + s + ").", "error"); return; }
  try { await setDoc(doc(db, "borsa_config", "weights"), { weights: w, preset: borsaPreset, updatedAt: serverTimestamp() }, { merge: true }); toast("Ağırlıklar kaydedildi.", "success"); }
  catch (err) { toast(permError(err) || ("Kaydedilemedi: " + err.code), "error"); }
}

// ---------------- BORSA: piyasa rejimi ----------------
function renderRejimForm() {
  if (macroInfo.macroScore != null) $("#macro-score").value = macroInfo.macroScore;
  $("#macro-regime").value = macroInfo.regime || "";
  $("#macro-note").value = macroInfo.note || "";
}
async function saveMacro(e) {
  e.preventDefault();
  const payload = { macroScore: $("#macro-score").value === "" ? null : +$("#macro-score").value, regime: $("#macro-regime").value.trim(), note: $("#macro-note").value.trim(), updatedAt: serverTimestamp() };
  try { await setDoc(doc(db, "borsa_config", "macro"), payload, { merge: true }); toast("Makro kaydedildi.", "success"); }
  catch (err) { toast(permError(err) || ("Kaydedilemedi: " + err.code), "error"); }
}
async function fetchFX() {
  const box = $("#fx-box"); if (!box) return;
  box.innerHTML = '<div class="muted small">Kurlar yükleniyor…</div>';
  try {
    const r = await fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=TRY,EUR");
    const j = await r.json();
    const usdtry = j.rates.TRY, eurtry = j.rates.TRY / j.rates.EUR;
    box.innerHTML = statCard("USD/TRY", usdtry.toFixed(4)) + statCard("EUR/TRY", eurtry.toFixed(4)) + statCard("Güncelleme", j.date);
  } catch { box.innerHTML = '<div class="muted small">Kur verisi alınamadı (bağlantı).</div>'; }
}

// ---------------- BORSA: strateji uretici & export ----------------
function readStrategy() {
  const n = (id) => { const v = $(id).value; return v === "" ? null : +v; };
  const c = (id) => $(id).checked;
  return {
    strategy_name: ($("#b-name").value.trim() || "Lowe_BIST_Strategy"),
    market: "BIST", timeframe: "1D",
    weights: { ...borsaWeights },
    entry_rules: {
      technical_score_min: n("#b-tech-min"), fundamental_score_min: n("#b-fund-min"),
      macro_score_min: n("#b-macro-min"), news_score_min: n("#b-news-min"),
      price_above_ema50: c("#b-ema50"), price_above_ema200: c("#b-ema200"),
      rsi_min: n("#b-rsi-min"), rsi_max: n("#b-rsi-max"),
      macd_above_signal: c("#b-macd"), volume_above_average_ratio: n("#b-vol"),
    },
    exit_rules: {
      price_below_ema50: c("#b-exit-ema50"), macd_below_signal: c("#b-exit-macd"),
      news_score_below: n("#b-news-exit"), macro_score_below: n("#b-macro-exit"),
      stop_loss_percent: n("#b-stop"), take_profit_percent: n("#b-tp"), trailing_stop_percent: n("#b-trail"),
    },
    risk_rules: {
      max_position_percent: n("#b-maxpos"), max_open_positions: n("#b-maxopen"),
      max_sector_percent: n("#b-maxsector"), min_daily_volume_try: n("#b-minvol"), avoid_if_vix_high: c("#b-avoidvix"),
    },
  };
}
function genJSON(s) { return JSON.stringify(s, null, 2); }
function genPython(s) {
  return `# Lôwe — ${s.strategy_name} (otomatik üretildi)
# Teknik+Temel+Makro+Haber skorları Lôwe sisteminden gelir.
# Veri sütunları: close, ema50, ema200, rsi, macd, macd_signal, volume, volume_avg20,
#                 technical_score, fundamental_score, macro_score, news_score
import pandas as pd

STRATEGY = ${JSON.stringify(s, null, 2)}

def check_entry(row, s=STRATEGY):
    e = s["entry_rules"]
    if row["technical_score"]   < e["technical_score_min"]:   return False
    if row["fundamental_score"] < e["fundamental_score_min"]: return False
    if row["macro_score"]       < e["macro_score_min"]:       return False
    if row["news_score"]        < e["news_score_min"]:        return False
    if e["price_above_ema50"]  and not (row["close"] > row["ema50"]):     return False
    if e["price_above_ema200"] and not (row["close"] > row["ema200"]):    return False
    if not (e["rsi_min"] <= row["rsi"] <= e["rsi_max"]):                  return False
    if e["macd_above_signal"]  and not (row["macd"] > row["macd_signal"]): return False
    if row["volume"] < e["volume_above_average_ratio"] * row["volume_avg20"]: return False
    return True

def check_exit(row, entry_price, s=STRATEGY):
    x = s["exit_rules"]
    if x["price_below_ema50"] and row["close"] < row["ema50"]:      return True
    if x["macd_below_signal"] and row["macd"] < row["macd_signal"]: return True
    if row["news_score"]  < x["news_score_below"]:  return True
    if row["macro_score"] < x["macro_score_below"]: return True
    change = (row["close"] - entry_price) / entry_price * 100
    if change <= -x["stop_loss_percent"]:   return True
    if change >=  x["take_profit_percent"]: return True
    return False

def backtest(df):
    pos, entry, trades = False, 0.0, []
    for _, row in df.iterrows():
        if not pos and check_entry(row):
            pos, entry = True, row["close"]
        elif pos and check_exit(row, entry):
            trades.append({"giris": entry, "cikis": row["close"], "getiri_%": (row["close"]-entry)/entry*100})
            pos = False
    return pd.DataFrame(trades)
`;
}
function genPine(s) {
  const e = s.entry_rules, x = s.exit_rules;
  const L = [];
  if (e.price_above_ema50) L.push("close > ema50");
  if (e.price_above_ema200) L.push("close > ema200");
  L.push(`rsi >= ${e.rsi_min} and rsi <= ${e.rsi_max}`);
  if (e.macd_above_signal) L.push("macdLine > signalLine");
  L.push(`volume >= ${e.volume_above_average_ratio} * volAvg`);
  const X = [];
  if (x.price_below_ema50) X.push("close < ema50");
  if (x.macd_below_signal) X.push("macdLine < signalLine");
  return `//@version=5
// Lôwe — ${s.strategy_name}
// NOT: Pine yalnizca TEKNIK kurallari uretir. Temel/Makro/Haber skorlari
// Lôwe sisteminde hesaplanir; webhook ile birlestirebilirsiniz.
strategy("${s.strategy_name}", overlay=true, initial_capital=100000, default_qty_type=strategy.percent_of_equity, default_qty_value=${s.risk_rules.max_position_percent})

ema50  = ta.ema(close, 50)
ema200 = ta.ema(close, 200)
rsi    = ta.rsi(close, 14)
[macdLine, signalLine, _h] = ta.macd(close, 12, 26, 9)
volAvg = ta.sma(volume, 20)

longCond = ${L.join(" and ")}
exitCond = ${X.length ? X.join(" or ") : "false"}

if longCond and strategy.position_size == 0
    strategy.entry("Long", strategy.long)
if exitCond and strategy.position_size > 0
    strategy.close("Long", comment="Cikis")

strategy.exit("SL/TP", "Long", stop = strategy.position_avg_price * (1 - ${x.stop_loss_percent} / 100.0), limit = strategy.position_avg_price * (1 + ${x.take_profit_percent} / 100.0))

alertcondition(longCond, title="Lôwe Alim",  message="${s.strategy_name}: alim sinyali")
alertcondition(exitCond, title="Lôwe Cikis", message="${s.strategy_name}: cikis sinyali")
`;
}
function genCSharp(s) {
  const e = s.entry_rules, x = s.exit_rules, r = s.risk_rules;
  const cls = (s.strategy_name || "LoweStrategy").replace(/[^A-Za-z0-9_]/g, "_");
  return `// Lôwe — ${s.strategy_name} (MatriksIQ C# sablonu)
// NOT: Gosterge cagrilarini MatriksIQ API'nize gore uyarlayin.
// Temel/Makro/Haber skorlari Lôwe sisteminden parametre olarak beslenir.
using Matriks.Lean.Algotrader.AlgoBase;
using Matriks.Lean.Algotrader.Models;

public class ${cls} : MatriksAlgo
{
    decimal TechnicalMin = ${e.technical_score_min}m, FundamentalMin = ${e.fundamental_score_min}m, MacroMin = ${e.macro_score_min}m, NewsMin = ${e.news_score_min}m;
    int RsiMin = ${e.rsi_min}, RsiMax = ${e.rsi_max};
    decimal VolRatio = ${e.volume_above_average_ratio}m;
    decimal StopLossPct = ${x.stop_loss_percent}m, TakeProfitPct = ${x.take_profit_percent}m, TrailingPct = ${x.trailing_stop_percent}m;
    decimal MaxPositionPct = ${r.max_position_percent}m;

    public override void OnInit() { /* sembol, periyot ve gosterge tanimlari */ }

    public override void OnDataUpdate(BarDataEventArgs barData)
    {
        // var ema50=...; var ema200=...; var rsi=...; var macd=...; var signal=...; var volAvg=...;
        // Lôwe skorlari (dis kaynak): technicalScore, fundamentalScore, macroScore, newsScore
        bool entry =
            ${e.price_above_ema50 ? "close > ema50 &&" : ""}
            ${e.price_above_ema200 ? "close > ema200 &&" : ""}
            ${e.macd_above_signal ? "macd > signal &&" : ""}
            rsi >= RsiMin && rsi <= RsiMax &&
            volume >= VolRatio * volAvg;
            // && technicalScore >= TechnicalMin && fundamentalScore >= FundamentalMin
            // && macroScore >= MacroMin && newsScore >= NewsMin

        bool exit =
            ${x.price_below_ema50 ? "close < ema50 ||" : ""}
            ${x.macd_below_signal ? "macd < signal ||" : ""}
            false;

        // if (entry && !HasPosition) SendMarketOrder(Symbol, Quantity, OrderSide.Buy);
        // if (exit  &&  HasPosition) SendMarketOrder(Symbol, Quantity, OrderSide.Sell);
    }
}
`;
}

// ---------------- BORSA: haberler ----------------
let borsaNewsCache = [];
function confOf(src) { return src === "KAP" ? 1.0 : src === "Haber" ? 0.6 : 0.3; }
function recencyOf(dateStr) {
  if (!dateStr) return 1.0;
  const days = (Date.now() - new Date(dateStr).getTime()) / 86400000;
  if (days <= 1) return 1.0; if (days <= 7) return 0.7; if (days <= 30) return 0.4; return 0.2;
}
function newsScore(n) {
  const dir = n.sentiment === "positive" ? 1 : n.sentiment === "negative" ? -1 : 0;
  return Math.round(dir * (n.importance || 0) * confOf(n.source) * recencyOf(n.date) * 10) / 10;
}
function listenBorsaNews() {
  const q = query(collection(db, "borsa_news"), orderBy("date", "desc"));
  unsub.borsaNews = onSnapshot(q, (snap) => {
    borsaNewsCache = []; snap.forEach((d) => borsaNewsCache.push({ id: d.id, ...d.data() }));
    renderNews();
  }, (e) => toast("Haberler okunamadı: " + e.code, "error"));
}
function renderNews() {
  const el = $("#news-list"); if (!el) return; el.innerHTML = "";
  if (!borsaNewsCache.length) { show($("#news-empty")); return; }
  hide($("#news-empty"));
  borsaNewsCache.forEach((n) => el.appendChild(renderNewsItem(n.id, n)));
}
function renderNewsItem(id, n) {
  const role = currentProfile.role, sc = newsScore(n);
  const dirCls = sc > 0 ? "sc-good" : sc < 0 ? "sc-bad" : "sc-mid";
  const strength = Math.abs(sc) >= 3.5 ? "Güçlü" : Math.abs(sc) >= 2 ? "Orta" : Math.abs(sc) > 0 ? "Zayıf" : "Nötr";
  const lowConf = confOf(n.source) < 0.5;
  const el = document.createElement("article"); el.className = "item";
  el.innerHTML = `<div class="item-head"><div>
      <span class="item-cat">${esc(n.source || "")}${n.symbol ? " · " + esc(n.symbol) : ""}${n.event ? " · " + esc(n.event) : ""}</span>
      <h3 class="item-title">${esc(n.title || "")}</h3></div>
      <div class="item-actions"></div></div>
    ${n.body ? `<div class="item-body">${esc(n.body)}</div>` : ""}
    <div class="news-meta">
      <span class="sc-chip ${dirCls}">Skor ${sc.toFixed(1)}</span>
      <span class="news-tag">${strength}</span>
      ${lowConf ? '<span class="news-tag warn">doğrulanmamış</span>' : ""}
      <span class="muted">${esc(n.date || "")}${n.updatedByName ? " · " + esc(n.updatedByName) : ""}</span>
    </div>`;
  const actions = el.querySelector(".item-actions");
  if (can.write(role)) { const b = button("Düzenle", "btn btn-ghost btn-sm"); b.onclick = () => openNewsForm({ id, ...n }); actions.appendChild(b); }
  if (can.delete(role)) { const b = button("Sil", "btn btn-danger btn-sm"); b.onclick = () => removeNews(id, n.title); actions.appendChild(b); }
  return el;
}
function openNewsForm(n = null) {
  $("#news-id").value = n?.id || ""; $("#news-symbol").value = n?.symbol || ""; $("#news-source").value = n?.source || "KAP"; $("#news-event").value = n?.event || "";
  $("#news-title").value = n?.title || ""; $("#news-sentiment").value = n?.sentiment || "positive"; $("#news-importance").value = n?.importance ?? 3;
  $("#news-date").value = n?.date || new Date().toISOString().slice(0, 10); $("#news-body").value = n?.body || "";
  show($("#news-form")); $("#news-title").focus();
}
async function saveNews(e) {
  e.preventDefault();
  const id = $("#news-id").value;
  const payload = {
    symbol: ($("#news-symbol").value.trim() || "").toUpperCase(), source: $("#news-source").value, event: $("#news-event").value.trim(),
    title: $("#news-title").value.trim(), sentiment: $("#news-sentiment").value, importance: +$("#news-importance").value || 0,
    date: $("#news-date").value || new Date().toISOString().slice(0, 10), body: $("#news-body").value.trim(),
    updatedAt: serverTimestamp(), updatedBy: currentUser.uid, updatedByName: currentProfile.displayName || currentUser.email,
  };
  try {
    if (id) await updateDoc(doc(db, "borsa_news", id), payload);
    else { payload.createdAt = serverTimestamp(); await addDoc(collection(db, "borsa_news"), payload); }
    hide($("#news-form")); toast("Haber kaydedildi.", "success");
  } catch (err) { toast(permError(err) || ("Kaydedilemedi: " + err.code), "error"); }
}
async function removeNews(id, title) {
  if (!confirm(`"${title || "Bu haber"}" silinsin mi?`)) return;
  try { await deleteDoc(doc(db, "borsa_news", id)); toast("Silindi.", "success"); }
  catch (err) { toast(permError(err) || ("Silinemedi: " + err.code), "error"); }
}

// ---------------- BELGELER (Cloud Storage) ----------------
const MAX_UPLOAD = 25 * 1024 * 1024;
function fileIcon(type, name) {
  const n = (name || "").toLowerCase();
  if ((type || "").startsWith("image/")) return "🖼️";
  if (n.endsWith(".pdf")) return "📄";
  if (/\.(xlsx|xls|csv)$/.test(n)) return "📊";
  if (/\.(doc|docx)$/.test(n)) return "📝";
  if (/\.(ppt|pptx)$/.test(n)) return "📑";
  return "📎";
}
function fmtSize(b) {
  if (b == null) return "";
  if (b < 1024) return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(0) + " KB";
  return (b / 1048576).toFixed(1) + " MB";
}
function listenDocs() {
  const q = query(collection(db, "documents"), orderBy("createdAt", "desc"));
  unsub.docs = onSnapshot(q, (snap) => {
    docsCache = []; snap.forEach((d) => docsCache.push({ id: d.id, ...d.data() }));
    renderDocs();
  }, (e) => toast("Belgeler okunamadı: " + e.code, "error"));
}
function renderDocs() {
  const el = $("#docs-list"); if (!el) return; el.innerHTML = "";
  const items = docsCache.filter((d) => !docFilter || (d.name || "").toLowerCase().includes(docFilter));
  if (!items.length) { show($("#docs-empty")); return; }
  hide($("#docs-empty"));
  const role = currentProfile.role;
  items.forEach((d) => {
    const a = document.createElement("article"); a.className = "doc-item";
    a.innerHTML = `
      <div class="doc-main">
        <span class="doc-ic">${fileIcon(d.type, d.name)}</span>
        <div class="doc-info">
          <div class="doc-name">${esc(d.name || "")}</div>
          <div class="doc-meta">${fmtSize(d.size)}${d.uploadedByName ? " · " + esc(d.uploadedByName) : ""}${d.createdAt ? " · " + (fmtDate(d.createdAt) || "") : ""}</div>
        </div>
      </div>
      <div class="doc-actions"></div>`;
    a.querySelector(".doc-main").onclick = () => previewDoc(d);
    const acts = a.querySelector(".doc-actions");
    const dl = document.createElement("a"); dl.className = "btn btn-ghost btn-sm"; dl.textContent = "İndir"; dl.href = d.url; dl.target = "_blank"; dl.rel = "noopener";
    acts.appendChild(dl);
    if (can.delete(role)) { const b = button("Sil", "btn btn-danger btn-sm"); b.onclick = (e) => { e.stopPropagation(); removeDoc(d); }; acts.appendChild(b); }
    el.appendChild(a);
  });
}
function previewDoc(d) {
  const box = $("#doc-preview");
  const t = d.type || "", n = (d.name || "").toLowerCase();
  let inner;
  if (t.startsWith("image/")) {
    inner = `<img src="${d.url}" alt="${esc(d.name)}" class="preview-img" />`;
  } else if (n.endsWith(".pdf") || t === "application/pdf") {
    inner = `<iframe src="${d.url}" class="preview-frame" title="${esc(d.name)}"></iframe>`;
  } else {
    inner = `<div class="preview-placeholder"><div style="font-size:2.4rem">${fileIcon(t, d.name)}</div>
      <div style="margin:10px 0 4px;font-weight:600">${esc(d.name)}</div>
      <div class="muted small">Bu dosya türü tarayıcıda önizlenemiyor.</div>
      <a class="btn btn-primary btn-sm" style="margin-top:12px" href="${d.url}" target="_blank" rel="noopener">İndir / Aç</a></div>`;
  }
  box.innerHTML = `<div class="preview-head"><b>${esc(d.name)}</b><span class="muted small">${fmtSize(d.size)}</span></div>${inner}`;
}
async function uploadDocs(files) {
  if (!files.length) return;
  if (!can.write(currentProfile.role)) { toast("Yükleme yetkiniz yok.", "error"); return; }
  const prog = $("#doc-progress"); show(prog);
  for (const file of files) {
    if (file.size > MAX_UPLOAD) { toast(`"${file.name}" 25 MB sınırını aşıyor.`, "error"); continue; }
    const safe = file.name.replace(/[^\w.\-() ]+/g, "_");
    const path = `uploads/documents/${Date.now()}_${safe}`;
    const row = document.createElement("div"); row.className = "up-row";
    row.innerHTML = `<span>${esc(file.name)}</span><div class="up-bar"><i></i></div>`;
    prog.appendChild(row);
    const bar = row.querySelector("i");
    try {
      const url = await new Promise((resolve, reject) => {
        const task = uploadBytesResumable(storageRef(storage, path), file, { contentType: file.type });
        task.on("state_changed",
          (s) => { bar.style.width = Math.round((s.bytesTransferred / s.totalBytes) * 100) + "%"; },
          reject,
          async () => resolve(await getDownloadURL(task.snapshot.ref)));
      });
      await addDoc(collection(db, "documents"), {
        name: file.name, size: file.size, type: file.type || "", path, url,
        createdAt: serverTimestamp(), uploadedBy: currentUser.uid, uploadedByName: currentProfile.displayName || currentUser.email,
      });
      row.remove();
    } catch (err) {
      row.querySelector("span").textContent = `✗ ${file.name} (${err.code || err.message})`;
      toast(permError(err) || ("Yüklenemedi: " + (err.code || "")), "error");
    }
  }
  setTimeout(() => { if (!prog.querySelector(".up-row")) hide(prog); }, 600);
  toast("Yükleme tamamlandı.", "success");
}
async function removeDoc(d) {
  if (!confirm(`"${d.name}" silinsin mi?`)) return;
  try {
    if (d.path) { try { await deleteObject(storageRef(storage, d.path)); } catch {} }
    await deleteDoc(doc(db, "documents", d.id));
    toast("Silindi.", "success");
  } catch (err) { toast(permError(err) || ("Silinemedi: " + err.code), "error"); }
}

// rapor ekleri (Storage'a yuklenip rapora baglanir)
function renderReportAttachPreview() {
  const el = $("#report-attach-list"); el.innerHTML = "";
  reportPendingFiles.forEach((f) => {
    const s = document.createElement("span"); s.className = "attach-chip"; s.textContent = `${fileIcon(f.type, f.name)} ${f.name}`; el.appendChild(s);
  });
}
async function uploadReportFiles(files) {
  const out = [];
  for (const file of files) {
    if (file.size > MAX_UPLOAD) { toast(`"${file.name}" 25 MB sınırını aşıyor, atlandı.`, "error"); continue; }
    const safe = file.name.replace(/[^\w.\-() ]+/g, "_");
    const path = `uploads/reports/${Date.now()}_${safe}`;
    const task = uploadBytesResumable(storageRef(storage, path), file, { contentType: file.type });
    const url = await new Promise((res, rej) => task.on("state_changed", null, rej, async () => res(await getDownloadURL(task.snapshot.ref))));
    out.push({ name: file.name, size: file.size, type: file.type || "", path, url });
  }
  return out;
}

// ---------------- Kullanicilar ----------------
function listenUsers() {
  const q = query(collection(db, "users"), orderBy("displayName"));
  unsub.users = onSnapshot(q, (snap) => {
    const el = $("#users-list"); el.innerHTML = "";
    snap.forEach((d) => el.appendChild(renderUserRow(d.id, d.data())));
  }, (e) => toast("Kullanıcılar okunamadı: " + e.code, "error"));
}
function renderUserRow(id, data) {
  const el = document.createElement("div"); el.className = "user-row";
  const isSelf = id === currentUser.uid;
  el.innerHTML = `
    <div class="u-info"><div class="u-name">${esc(data.displayName || "(isimsiz)")} ${isSelf ? "<span class='muted small'>(siz)</span>" : ""}</div>
      <div class="u-email">${esc(data.email || "")}</div></div>
    <select class="role-select" ${isSelf ? "disabled" : ""}>
      ${Object.keys(ROLE_LABELS).map((r) => `<option value="${r}" ${data.role === r ? "selected" : ""}>${ROLE_LABELS[r]}</option>`).join("")}</select>
    <label class="switch"><input type="checkbox" class="active-toggle" ${data.active ? "checked" : ""} ${isSelf ? "disabled" : ""}/> Etkin</label>
    <button class="btn btn-ghost btn-sm save-user" ${isSelf ? "disabled" : ""}>Kaydet</button>`;
  el.querySelector(".save-user").onclick = async () => {
    try { await updateDoc(doc(db, "users", id), { role: el.querySelector(".role-select").value, active: el.querySelector(".active-toggle").checked }); toast("Kullanıcı güncellendi.", "success"); }
    catch (err) { toast(permError(err) || ("Güncellenemedi: " + err.code), "error"); }
  };
  return el;
}

// ---------------- Ayarlar ----------------
function listenSettings() {
  unsub.settings = onSnapshot(doc(db, "settings", "site"), (snap) => {
    const title = (snap.exists() ? snap.data().title : "") || "Lôwe";
    $("#site-title").textContent = title; $("#settings-title").value = title; document.title = title;
  }, () => {});
}
async function saveSettings(e) {
  e.preventDefault();
  try { await setDoc(doc(db, "settings", "site"), { title: $("#settings-title").value.trim(), updatedAt: serverTimestamp() }, { merge: true }); toast("Ayarlar kaydedildi.", "success"); }
  catch (err) { toast(permError(err) || ("Kaydedilemedi: " + err.code), "error"); }
}

// ---------------- Sifre ----------------
async function changePassword(e) {
  e.preventDefault();
  const cur = $("#pw-current").value, n1 = $("#pw-new").value, n2 = $("#pw-new2").value;
  const err = $("#pw-error"); hide(err);
  if (n1 !== n2) { err.textContent = "Yeni şifreler eşleşmiyor."; show(err); return; }
  if (n1.length < 6) { err.textContent = "Yeni şifre en az 6 karakter olmalı."; show(err); return; }
  try {
    await reauthenticateWithCredential(currentUser, EmailAuthProvider.credential(currentUser.email, cur));
    await updatePassword(currentUser, n1);
    hide($("#pw-modal")); toast("Şifreniz güncellendi.", "success");
  } catch (e2) {
    let m = "Şifre değiştirilemedi.";
    if (e2.code === "auth/wrong-password" || e2.code === "auth/invalid-credential") m = "Mevcut şifre hatalı.";
    else if (e2.code === "auth/weak-password") m = "Yeni şifre çok zayıf.";
    err.textContent = m; show(err);
  }
}

// ---------------- Yardimcilar ----------------
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function button(t, c) { const b = document.createElement("button"); b.className = c; b.textContent = t; return b; }
function fmtDate(ts) { if (!ts || !ts.toDate) return null; try { return ts.toDate().toLocaleString("tr-TR", { dateStyle: "medium", timeStyle: "short" }); } catch { return null; } }
function permError(err) { return (err && err.code === "permission-denied") ? "Bu işlem için yetkiniz yok." : null; }
let toastTimer;
function toast(msg, type = "") { const el = $("#toast"); el.textContent = msg; el.className = "toast " + (type ? "toast-" + type : ""); show(el); clearTimeout(toastTimer); toastTimer = setTimeout(() => hide(el), 3200); }

boot();
