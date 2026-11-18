/* Instagram Reels Analyzer: list a profile's reels with view counts, analyse the
 * distribution, pick reels and download them into one collection folder.
 * DOM is built with createElement/textContent only. */
"use strict";

const St = PD.stats;
const S = PD.STATUS;
const t = PD.t;
const $ = (id) => document.getElementById(id);
const SVGNS = "http://www.w3.org/2000/svg";

const state = {
  data: null, // helper result
  rows: [], // reels with derived fields
  stats: null,
  scale: "linear",
  groupOutliers: true,
  filter: null, // {kind: "views" | "date", from, to}
  interval: null, // activity chart bucket size in days (null = automatic)
  viewsLine: "median", // activity chart line: "median" | "total" | "off"
  heatMode: "posts", // "When do they post?" grid: "posts" | "perf"
  activity: null, // PD.stats.postingStats result
  // table: "strong" | "viral" | "winner" | "engaged" (statistical groups) | "mean" | "custom" | "all"
  threshold: "mean",
  custom: "", // typed custom threshold, e.g. "10K"
  sort: "views",
  selected: new Set(), // codes
  jobs: new Map(), // code -> jobId
  jobById: new Map(), // jobId -> job
  settings: Object.assign({}, PD.DEFAULT_SETTINGS),
  helperOk: false,
};

// ------------------------------------------------------------------ helpers
function el(tag, attrs, children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(children || [])) if (c) n.appendChild(c);
  return n;
}
function svg(tag, attrs, text) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
}
function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: { message: chrome.runtime.lastError.message } });
      else resolve(res || { ok: false, error: { message: t("err_UNKNOWN") } });
    });
  });
}
const fmt = (n) => (typeof n === "number" && isFinite(n) ? n.toLocaleString() : "–");
const cmp = St.compact;
const pct = (x) => (isFinite(x) ? `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%` : "–");
function today() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function rangeLabel(from, to) {
  return to === Infinity ? `≥ ${cmp(from)}` : `${cmp(from)} – ${cmp(to)}`;
}
function i18nize() {
  for (const n of document.querySelectorAll("[data-i18n]")) n.textContent = t(n.dataset.i18n);
  for (const n of document.querySelectorAll("[data-i18n-aria]")) n.setAttribute("aria-label", t(n.dataset.i18nAria));
  for (const n of document.querySelectorAll("[data-i18n-title]")) n.title = t(n.dataset.i18nTitle);
  document.documentElement.lang = chrome.i18n.getUILanguage();
}
function showError(text) {
  $("errorBox").hidden = !text;
  $("errorBox").textContent = text || "";
}
function setActionMsg(text, kind) {
  $("actionMsg").textContent = text || "";
  $("actionMsg").className = "small action-msg" + (kind ? " " + kind : "");
}

// ------------------------------------------------------------------ settings / helper
async function loadSettings() {
  const r = await chrome.storage.local.get("settings");
  state.settings = Object.assign({}, PD.DEFAULT_SETTINGS, r.settings || {});
  $("cookieNotice").hidden = !!state.settings.useBrowserCookies;
}
async function enableCookies() {
  // Explicit user click: allow the local helper to read Chrome's login.
  const r = await chrome.storage.local.get("settings");
  const s = Object.assign({}, PD.DEFAULT_SETTINGS, r.settings || {}, { useBrowserCookies: true });
  await chrome.storage.local.set({ settings: s });
  await loadSettings();
}
async function refreshHelper() {
  const res = await send({ type: "helperStatus", force: true });
  const st = res.ok ? res.data : { ok: false };
  state.helperOk = !!st.ok;
  const b = $("helperBadge");
  const old = st.ok ? PD.helperOutdated(st.info) : "";
  b.textContent = !st.ok ? t("helper_missing") : old ? t("helper_outdated_short") : t("helper_ok");
  b.className = "badge " + (!st.ok ? "bad" : old ? "warn" : "ok");
  b.title = old ? t("helper_outdated", [old, chrome.runtime.getManifest().version]) : "";
  updateActionBar();
}

// ------------------------------------------------------------------ fetching
async function analyze(e) {
  e.preventDefault();
  showError("");
  const profile = $("profileInput").value.trim();
  if (!profile) {
    showError(t("an_err_profile"));
    return;
  }
  if (!state.settings.useBrowserCookies) {
    $("cookieNotice").hidden = false;
    showError(t("an_err_login_setting"));
    return;
  }
  $("fetchBtn").disabled = true;
  $("progressBox").hidden = false;
  $("progressText").textContent = t("an_fetching", ["0"]);
  $("progressFill").className = "fill indet";
  const limit = parseInt($("limitSelect").value, 10);
  const res = await send({ type: "listReels", profile, limit });
  $("fetchBtn").disabled = false;
  $("progressBox").hidden = true;
  if (!res.ok) {
    showError(`${res.error.message}${res.error.detail ? "\n" + res.error.detail : ""}`);
    return;
  }
  try {
    history.replaceState(null, "", `?u=${encodeURIComponent(res.data.username)}`);
  } catch (_e) { /* ignore */ }
  saveCache(res.data);
  load(res.data, null);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "reelsProgress") return;
  const m = /^reels:(\d+)/.exec(msg.text || "");
  const d = /^details:(\d+)\/(\d+)/.exec(msg.text || "");
  if (m) $("progressText").textContent = t("an_fetching", [m[1]]);
  if (d) $("progressText").textContent = t("an_fetching_details", [d[1], d[2]]);
  if (msg.percent != null) {
    $("progressFill").className = "fill";
    $("progressFill").style.width = Math.max(2, Math.min(100, msg.percent)) + "%";
  }
});

// ------------------------------------------------------------------ data model
// ------------------------------------------------------------------ local cache (no extra Instagram requests)
const CACHE_KEY = "reelsCache";
const CACHE_MAX_PROFILES = 8;

async function saveCache(data) {
  try {
    const r = await chrome.storage.local.get(CACHE_KEY);
    const cache = r[CACHE_KEY] || {};
    // thumbnails are signed, short-lived URLs: not worth keeping
    const slim = Object.assign({}, data, { reels: data.reels.map((x) => Object.assign({}, x, { thumbnail: "" })) });
    cache[data.username.toLowerCase()] = { at: Date.now(), data: slim };
    const keys = Object.keys(cache).sort((a, b) => cache[b].at - cache[a].at);
    for (const k of keys.slice(CACHE_MAX_PROFILES)) delete cache[k];
    await chrome.storage.local.set({ [CACHE_KEY]: cache });
  } catch (_e) { /* storage full: just skip caching */ }
}

async function loadCache(profile) {
  const name = String(profile || "").replace(/^@/, "").replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").split(/[/?#]/)[0].toLowerCase();
  if (!name) return null;
  const r = await chrome.storage.local.get(CACHE_KEY);
  return (r[CACHE_KEY] || {})[name] || null;
}

function load(data, cachedAt) {
  const note = $("cacheNote");
  note.hidden = !cachedAt;
  if (cachedAt) note.textContent = t("an_cached", [new Date(cachedAt).toLocaleString()]);
  state.data = data;
  state.openCode = null; // a new profile closes the details panel
  $("drawer").hidden = true;
  state.filter = null;
  state.selected.clear();
  // "now" = when the data was fetched, so a cached result keeps its own frame of reference
  state.now = cachedAt || Date.now();
  state.allRows = data.reels.map((r, i) => {
    const er = r.views ? ((r.likes || 0) + (r.comments || 0)) / r.views : null;
    // ER = like rate + comment rate; commentShare = the part of the engagement that is comments
    const likeRate = r.views && r.likes != null ? r.likes / r.views : null;
    const commentRate = r.views && r.comments != null ? r.comments / r.views : null;
    const engTotal = (r.likes || 0) + (r.comments || 0);
    const commentShare = engTotal && r.likes != null && r.comments != null ? r.comments / engTotal : null;
    // Instagram's reels-tab API has no date any more; the shortcode encodes the post time
    const ts = (r.taken_at ? Date.parse(r.taken_at) || 0 : 0) || St.codeTime(r.code);
    // views per day since posting: shows what is selling *now*, not what went viral a year ago
    const vpd = r.views != null && ts ? r.views / Math.max(1, (state.now - ts) / St.DAY) : null;
    return Object.assign({}, r, {
      order: i, // position in the profile (newest first)
      score: null, // views vs. what is typical for this profile at that time (set below)
      perf: null,
      er,
      likeRate,
      commentRate,
      commentShare,
      ts,
      vpd,
    });
  });
  // whole-history classification: only for the dots on the timeline strip
  const whole = St.performance(state.allRows, state.now);
  state.allRows.forEach((r, i) => (r.wholeTier = whole.items[i] ? whole.items[i].tier : null));
  state.periods = St.activePeriods(state.allRows.map((r) => r.ts));
  state.range = null; // {from, to} in ms (local day boundaries); null = everything
  $("collectionInput").value = `${data.username}_reels_${today()}`;
  $("results").hidden = false;
  $("actionBar").hidden = false;
  renderProfile();
  renderRangeBar();
  applyRange();
}

/**
 * Restrict the analysis to the selected date range and recompute everything from it:
 * statistics, viral / strong / winner (baselines and spread of that period only),
 * histogram, activity and table.
 */
function applyRange() {
  const rg = state.range;
  state.rows = rg ? state.allRows.filter((r) => !r.ts || (r.ts >= rg.from && r.ts < rg.to)) : state.allRows.slice();
  // the activity view ends where the selected range ends (a past period is not "dormant until today")
  state.windowEnd = rg ? Math.min(state.now, rg.to - 1) : state.now; // -1 ms: last moment of the last day
  state.filter = null;
  const keep = new Set(state.rows.map((r) => r.code));
  for (const c of [...state.selected]) if (!keep.has(c)) state.selected.delete(c);
  state.stats = St.summarize(state.rows.map((r) => r.views).filter((v) => typeof v === "number"));
  state.perf = St.performance(state.rows, state.now);
  state.rows.forEach((r, i) => {
    r.perf = state.perf.items[i];
    r.score = r.perf ? r.perf.ratio : null;
    r.erAdj = r.perf ? r.perf.erVsExpected : null;
    r.rank = null;
  });
  state.activity = St.postingStats(state.rows.map((r) => r.ts), state.windowEnd);
  state.interval = null; // pick a readable interval for this range again
  const rank = state.rows.filter((r) => r.views != null).sort((a, b) => b.views - a.views);
  rank.forEach((r, i) => (r.rank = i + 1));
  updateRangeLabel();
  renderCards();
  renderChart();
  renderInsights();
  renderActivity();
  renderTable();
  updateActionBar();
}

// ------------------------------------------------------------------ date range bar (timeline brush)
const RB = { CH: 64, AX: 20 }; // chart height and axis height, px

/** Day index <-> timestamp for the brush (one step = one local calendar day). */
function rangeDays() {
  const ts = state.allRows.map((r) => r.ts).filter((x) => x > 0);
  if (ts.length < 2) return null;
  const start = St.dayStart(Math.min(...ts));
  const end = St.addDays(St.dayStart(Math.max(state.now, ...ts)), 1);
  return { start, end, n: Math.max(1, Math.round((end - start) / St.DAY)) };
}
const dayToTs = (rd, i) => St.addDays(rd.start, i);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function renderRangeBar() {
  const card = $("rangeCard");
  const rd = (state.rangeDays = rangeDays());
  card.hidden = !rd || rd.n < 3;
  if (card.hidden) return;
  state.sel = { a: 0, b: rd.n }; // selected days [a, b)
  state.rbCurve = activityCurve(rd);
  drawRangeStrip();
  renderRangeChips();
  updateRangeVisual();
}

/**
 * Posting activity as a smooth curve (posts per day): a Gaussian kernel over the post
 * times, sampled at 240 points. Bandwidth ~1% of the history (at least 0.6 days), so
 * busy weeks rise as hills and pauses lie flat on the baseline.
 */
function activityCurve(rd) {
  const ts = state.allRows.map((r) => r.ts).filter((x) => x > 0);
  const span = rd.end - rd.start;
  const h = Math.max(0.6 * St.DAY, span / 90);
  const N = 240;
  const ys = [];
  for (let i = 0; i <= N; i++) {
    const tt = rd.start + (span * i) / N;
    let s = 0;
    for (const x of ts) {
      const d = (tt - x) / h;
      if (d > -4 && d < 4) s += Math.exp(-0.5 * d * d);
    }
    ys.push((s / (h * Math.sqrt(2 * Math.PI))) * St.DAY);
  }
  return { ys, N, max: Math.max(...ys, 1e-9) };
}

/** The timeline, drawn at the real pixel width: grey curve + the same curve in colour clipped to the selection. */
function drawRangeStrip() {
  const rd = state.rangeDays;
  const strip = $("rbStrip");
  if (!rd || $("rangeCard").hidden || !state.rbCurve) return;
  const W = Math.max(280, Math.round(strip.clientWidth || 1000));
  const { CH, AX } = RB;
  const H = CH + AX;
  const x = (ts) => ((ts - rd.start) / (rd.end - rd.start)) * W;
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: "rb-svg", "aria-hidden": "true" });
  const defs = svg("defs");
  const grad = svg("linearGradient", { id: "rbGrad", x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.append(svg("stop", { offset: "0%", class: "rb-g1" }), svg("stop", { offset: "100%", class: "rb-g2" }));
  const clip = svg("clipPath", { id: "rbClip" });
  clip.append(svg("rect", { id: "rbClipRect", x: 0, y: 0, width: W, height: CH }));
  defs.append(grad, clip);
  root.append(defs);

  // pauses: a soft band and a label pill
  const P = state.periods;
  const lastTs = Math.max(...state.allRows.map((r) => r.ts || 0));
  const quiet = P.pauses.map((p) => ({ from: p.from, to: p.to, days: p.days }));
  if ((state.now - lastTs) / St.HOUR >= P.pauseHours) quiet.push({ from: lastTs, to: state.now, days: (state.now - lastTs) / St.DAY, open: true });
  for (const q of quiet) {
    const x1 = x(q.from);
    const w = Math.max(1, x(q.to) - x1);
    root.append(svg("rect", { class: "rb-pause", x: x1, y: 0, width: w, height: CH, rx: 4 }));
    const label = t(q.open ? "an_rb_quiet" : "an_rb_paused", [String(Math.round(q.days))]);
    const lw = label.length * 6 + 16;
    if (w > lw + 8) {
      const cx = x1 + w / 2;
      root.append(svg("rect", { class: "rb-pill", x: cx - lw / 2, y: CH / 2 - 10, width: lw, height: 20, rx: 10 }));
      root.append(svg("text", { class: "rb-plabel", x: cx, y: CH / 2 + 4, "text-anchor": "middle" }, label));
    }
  }

  // activity curve
  const c = state.rbCurve;
  const top = 8;
  const pts = c.ys.map((y, i) => [(i / c.N) * W, CH - 1 - (y / c.max) * (CH - top - 1)]);
  const line = "M" + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("L");
  const area = `${line}L${W},${CH}L0,${CH}Z`;
  root.append(svg("path", { class: "rb-area-base", d: area }), svg("path", { class: "rb-line-base", d: line }));
  const sel = svg("g", { "clip-path": "url(#rbClip)" });
  sel.append(svg("path", { class: "rb-area", d: area }), svg("path", { class: "rb-line", d: line }));
  root.append(sel);

  // viral reels: a thin gold tick each on the baseline (grey outside the selection)
  for (const r of state.allRows) {
    if (r.wholeTier !== "viral" || !r.ts) continue;
    const xx = x(r.ts).toFixed(1);
    root.append(svg("line", { class: "rb-rug-base", x1: xx, x2: xx, y1: CH - 9, y2: CH - 2 }));
    sel.append(svg("line", { class: "rb-rug", x1: xx, x2: xx, y1: CH - 9, y2: CH - 2 }));
  }
  root.append(svg("line", { class: "rb-base", x1: 0, x2: W, y1: CH - 0.5, y2: CH - 0.5 }));

  // axis: Mondays for short histories, 1st of the month for long ones, >= ~70 px apart
  const ticks = [];
  if (rd.n <= 75) {
    for (let d = rd.start; d < rd.end; d = St.addDays(d, 1)) if (St.weekdayMon(d) === 0) ticks.push([d, dateShort(d)]);
  } else {
    const first = new Date(rd.start);
    for (const m = new Date(first.getFullYear(), first.getMonth() + 1, 1); m.getTime() < rd.end; m.setMonth(m.getMonth() + 1)) {
      ticks.push([m.getTime(), monthLabel(m.getTime())]);
    }
  }
  const every = Math.max(1, Math.ceil(ticks.length / Math.max(1, W / 70)));
  ticks.forEach(([tt, label], i) => {
    if (i % every) return;
    const xx = x(tt);
    root.append(svg("line", { class: "rb-tick", x1: xx, x2: xx, y1: CH, y2: CH + 4 }));
    if (xx > 14 && xx < W - 30) root.append(svg("text", { class: "rb-tlabel", x: xx, y: CH + 15, "text-anchor": "middle" }, label));
  });

  strip.replaceChildren(root);
  state.rbW = W;
  updateRangeVisual();
}

/** Quick picks: All, last 30 / 90 days, each active period. */
function renderRangeChips() {
  const box = $("rbChips");
  box.replaceChildren();
  const rd = state.rangeDays;
  const chip = (label, title, from, to) => {
    const b = el("button", { type: "button", class: "chipbtn", text: label, title: title || "" });
    b.dataset.from = String(from);
    b.dataset.to = String(to);
    b.addEventListener("click", () => setRangeDays(from, to));
    box.append(b);
  };
  chip(t("an_rb_all"), "", 0, rd.n);
  for (const d of [30, 90]) if (rd.n > d + 3) chip(t("an_rb_last_days", [String(d)]), "", rd.n - d, rd.n);
  const ps = state.periods.periods;
  if (ps.length > 1) {
    for (const { p, i } of ps.map((p, i) => ({ p, i })).slice(-6)) {
      const from = Math.round((St.dayStart(p.from) - rd.start) / St.DAY);
      const to = Math.round((St.addDays(St.dayStart(p.to), 1) - rd.start) / St.DAY);
      chip(t("an_rb_period", [String(i + 1), `${dateShort(p.from)} – ${dateShort(p.to)}`, String(p.n)]), t("an_rb_period_tip"), from, to);
    }
  }
}

function setRangeDays(from, to) {
  state.sel = { a: from, b: to };
  commitRange(0);
}
function setSel(a, b, delay) {
  state.sel = { a, b };
  commitRange(delay);
}

/** Move the window, handles, colour clip, labels and chip states to state.sel. */
function updateRangeVisual() {
  const rd = state.rangeDays;
  const s = state.sel;
  if (!rd || !s) return;
  const pa = (s.a / rd.n) * 100;
  const pb = (s.b / rd.n) * 100;
  $("rbWindow").style.left = `${pa}%`;
  $("rbWindow").style.width = `${pb - pa}%`;
  $("rbHandleA").style.left = `${pa}%`;
  $("rbHandleB").style.left = `${pb}%`;
  $("rb").classList.toggle("full", s.a === 0 && s.b === rd.n);
  const cr = document.getElementById("rbClipRect");
  if (cr && state.rbW) {
    cr.setAttribute("x", String((s.a / rd.n) * state.rbW));
    cr.setAttribute("width", String(((s.b - s.a) / rd.n) * state.rbW));
  }
  const from = dayToTs(rd, s.a);
  const to = dayToTs(rd, s.b);
  for (const [id, v, ts] of [["rbHandleA", s.a, from], ["rbHandleB", s.b, St.addDays(to, -1)]]) {
    const h = $(id);
    h.setAttribute("aria-valuemin", "0");
    h.setAttribute("aria-valuemax", String(rd.n));
    h.setAttribute("aria-valuenow", String(v));
    h.setAttribute("aria-valuetext", dateLong(ts));
  }
  const n = state.allRows.filter((r) => r.ts >= from && r.ts < to).length;
  $("rbFromLabel").textContent = dateLong(from);
  $("rbToLabel").textContent = dateLong(St.addDays(to, -1));
  $("rbLabel").textContent = t("an_rb_label2", [String(s.b - s.a), String(n)]);
  for (const c of $("rbChips").children) c.classList.toggle("on", Number(c.dataset.from) === s.a && Number(c.dataset.to) === s.b);
}

let rangeTimer = 0;
/** Recompute the analysis for state.sel (debounced while dragging). */
function commitRange(delay) {
  updateRangeVisual();
  clearTimeout(rangeTimer);
  rangeTimer = setTimeout(() => {
    const rd = state.rangeDays;
    const { a, b } = state.sel;
    const next = a === 0 && b === rd.n ? null : { from: dayToTs(rd, a), to: dayToTs(rd, b) };
    const cur = state.range;
    if ((!next && !cur) || (next && cur && next.from === cur.from && next.to === cur.to)) return;
    state.range = next;
    applyRange();
  }, delay || 0);
}

function updateRangeLabel() {
  $("rbReset").hidden = !state.range;
  $("rbCount").textContent = state.range ? t("an_rb_count", [String(state.rows.length), String(state.allRows.length)]) : "";
}

/** Pointer + keyboard interaction for the brush. */
function initBrush() {
  const rb = $("rb");
  let drag = null;
  const rect = () => $("rbStrip").getBoundingClientRect();
  const dayAt = (clientX) => {
    const r = rect();
    return Math.round(clamp((clientX - r.left) / r.width, 0, 1) * state.rangeDays.n);
  };
  rb.addEventListener("pointerdown", (e) => {
    if (!state.rangeDays || e.button !== 0) return;
    const n = state.rangeDays.n;
    const { a, b } = state.sel;
    const d = dayAt(e.clientX);
    let mode;
    if (e.target.closest("#rbHandleA")) mode = "a";
    else if (e.target.closest("#rbHandleB")) mode = "b";
    else if (e.target.closest("#rbWindow") && !(a === 0 && b === n)) mode = "pan";
    else {
      // click elsewhere: the nearest handle jumps there and keeps following the pointer
      mode = Math.abs(d - a) <= Math.abs(d - b) ? "a" : "b";
      if (mode === "a") setSel(Math.min(d, b - 1), b, 250);
      else setSel(a, Math.max(d, a + 1), 250);
    }
    drag = { mode, x0: e.clientX, a0: state.sel.a, b0: state.sel.b };
    rb.setPointerCapture(e.pointerId);
    rb.classList.add("dragging");
    $("rbHover").hidden = true;
    e.preventDefault();
  });
  rb.addEventListener("pointermove", (e) => {
    if (!state.rangeDays) return;
    const n = state.rangeDays.n;
    if (!drag) return showHover(e.clientX);
    const d = dayAt(e.clientX);
    if (drag.mode === "a") setSel(Math.min(d, state.sel.b - 1), state.sel.b, 250);
    else if (drag.mode === "b") setSel(state.sel.a, Math.max(d, state.sel.a + 1), 250);
    else {
      const w = drag.b0 - drag.a0;
      const a = clamp(drag.a0 + Math.round(((e.clientX - drag.x0) / rect().width) * n), 0, n - w);
      setSel(a, a + w, 250);
    }
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    rb.classList.remove("dragging");
    commitRange(0);
  };
  rb.addEventListener("pointerup", end);
  rb.addEventListener("pointercancel", end);
  rb.addEventListener("pointerleave", () => ($("rbHover").hidden = true));

  for (const [id, which] of [["rbHandleA", "a"], ["rbHandleB", "b"]]) {
    $(id).addEventListener("keydown", (e) => {
      const n = state.rangeDays.n;
      let { a, b } = state.sel;
      const steps = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -30, PageUp: 30 };
      let v;
      if (e.key === "Home") v = 0;
      else if (e.key === "End") v = n;
      else if (e.key in steps) v = (which === "a" ? a : b) + steps[e.key] * (e.shiftKey && Math.abs(steps[e.key]) === 1 ? 7 : 1);
      else return;
      e.preventDefault();
      if (which === "a") a = clamp(v, 0, b - 1);
      else b = clamp(v, a + 1, n);
      setSel(a, b, 300);
    });
  }
}

/** Hover guide: the day under the pointer and how many reels were posted that day. */
function showHover(clientX) {
  const rd = state.rangeDays;
  const r = $("rbStrip").getBoundingClientRect();
  const f = clamp((clientX - r.left) / r.width, 0, 1);
  const day = Math.min(rd.n - 1, Math.floor(f * rd.n));
  const from = dayToTs(rd, day);
  const to = dayToTs(rd, day + 1);
  const n = state.allRows.filter((x) => x.ts >= from && x.ts < to).length;
  const box = $("rbHover");
  box.hidden = false;
  box.style.left = `${f * 100}%`;
  $("rbHoverText").textContent = `${weekdayName(St.weekdayMon(from))} ${dateLong(from)} · ${t("an_reels_count", [String(n)])}`;
  box.classList.toggle("flip", f > 0.8);
}

// ------------------------------------------------------------------ profile + cards
function renderProfile() {
  const d = state.data;
  const p = d.profile || {};
  $("profileName").textContent = `@${d.username}${p.is_verified ? " ✓" : ""}`;
  const parts = [];
  if (p.full_name) parts.push(p.full_name);
  if (p.followers != null) parts.push(t("an_followers", [cmp(p.followers)]));
  parts.push(t("an_reels_analyzed", [String(d.count)]));
  $("profileMeta").textContent = parts.join(" · ");
  const notes = [];
  if (d.truncated) notes.push(t("an_note_truncated", [String(d.count)]));
  if (d.missing_views) notes.push(t("an_note_missing", [String(d.missing_views)]));
  $("profileNote").textContent = notes.join(" ");
}

function renderCards() {
  const s = state.stats;
  const box = $("cards");
  box.replaceChildren();
  if (!s.n) {
    box.append(el("div", { class: "stat" }, [el("div", { class: "k", text: t("an_no_views") })]));
    return;
  }
  const card = (k, v, sub, title) => box.append(el("div", { class: "stat", title: title || "" }, [
    el("div", { class: "k", text: k }), el("div", { class: "v", text: v }), sub ? el("div", { class: "s", text: sub }) : null,
  ]));
  card(t("an_stat_total"), cmp(s.sum), t("an_stat_reels", [String(s.n)]));
  card(t("an_mean"), cmp(s.mean), fmt(Math.round(s.mean)), t("an_tip_mean"));
  card(t("an_median"), cmp(s.median), fmt(Math.round(s.median)), t("an_tip_median"));
  card(t("an_stat_typical"), `${cmp(s.p25)} – ${cmp(s.p75)}`, t("an_stat_typical_sub"), t("an_tip_typical"));
  card("P90", cmp(s.p90), t("an_stat_p90_sub"), t("an_tip_p90"));
  card(t("an_stat_range"), `${cmp(s.min)} – ${cmp(s.max)}`, "min – max");
  const p = state.perf;
  if (p && p.enough) {
    const mult = (x) => `${x.toFixed(1)}×`;
    card(t("an_stat_viral"), String(p.nViral), t("an_stat_viral_sub", [mult(p.viralMult)]), t("an_tip_viral"));
    card(t("an_stat_strong"), String(p.nStrong), t("an_stat_strong_sub", [mult(p.strongMult)]), t("an_tip_strong"));
    if (p.er0 != null) {
      card(t("an_stat_winner"), String(p.nWinner), t("an_stat_winner_sub"), t("an_tip_winner"));
      card(t("an_stat_high_er"), String(p.nHighEr), t("an_stat_high_er_sub", [String(p.nTalk)]), t("an_tip_high_er"));
    }
  }
  card(t("an_stat_top10"), pct(s.top10Share), t("an_stat_top10_sub", [String(s.top10Count)]), t("an_tip_top10"));
  const ers = state.rows.map((r) => r.er).filter((x) => x != null).sort((a, b) => a - b);
  if (ers.length) card(t("an_stat_er"), pct(St.quantile(ers, 0.5)), t("an_stat_er_sub"), t("an_tip_er"));
  // where the engagement comes from, profile-wide (sums, so big reels weigh in proportionally)
  const mix = state.rows.filter((r) => r.views && r.likes != null && r.comments != null);
  const sumL = mix.reduce((a, r) => a + r.likes, 0);
  const sumC = mix.reduce((a, r) => a + r.comments, 0);
  if (sumL + sumC > 0) {
    const sumV = mix.reduce((a, r) => a + r.views, 0);
    const perComment = sumC ? Math.round(sumL / sumC) : null;
    const likeShare = sumL / (sumL + sumC);
    card(t("an_stat_mix"), `${likeShare > 0.99 ? (likeShare * 100).toFixed(1) + "%" : pct(likeShare)} · ${pctFine(1 - likeShare)}`,
      perComment != null ? t("an_stat_mix_sub", [String(perComment)]) : "", t("an_tip_mix"));
    card(t("an_stat_rates"), `${pctFine(sumL / sumV)} · ${pctFine(sumC / sumV)}`, t("an_stat_rates_sub"), t("an_tip_rates"));
  }
  renderMethod();
}

/** "How is this calculated?": the numbers for this profile, in plain words. */
function renderMethod() {
  const box = $("methodBody");
  box.replaceChildren();
  const p = state.perf;
  if (!p || !p.enough) {
    box.append(el("p", { text: t("an_method_few") }));
    return;
  }
  const para = (key, subs) => box.append(el("p", { text: t(key, subs) }));
  para("an_method_why");
  para(p.local ? "an_method_baseline_local" : "an_method_baseline_global");
  para("an_method_tiers", [p.sigma.toFixed(2), `${p.strongMult.toFixed(1)}×`, `${p.viralMult.toFixed(1)}×`]);
  para("an_method_tail", [pct(p.viralRate)]);
  if (p.erSlope != null) para("an_method_eng", [p.erSlope.toFixed(2), p.crSlope.toFixed(2)]);
  if (state.rows.some((r) => !r.taken_at && r.ts)) para("an_method_dates");
  para("an_method_new");
}

// ------------------------------------------------------------------ histogram
function currentBins() {
  const views = state.rows.map((r) => r.views).filter((v) => typeof v === "number");
  return state.scale === "log" ? St.logBins(views) : St.linearBins(views, state.stats, state.groupOutliers);
}

/** x position of a value inside the drawn bins (handles log and overflow bins). */
function xOf(value, bins, x0, bw) {
  for (let i = 0; i < bins.length; i++) {
    const b = bins[i];
    if (value >= b.from && (value < b.to || i === bins.length - 1)) {
      if (b.to === Infinity) return x0 + i * bw + bw / 2;
      const f = bins.log
        ? (Math.log(Math.max(value, 1)) - Math.log(b.from)) / (Math.log(b.to) - Math.log(b.from))
        : (value - b.from) / (b.to - b.from);
      return x0 + (i + Math.max(0, Math.min(1, f))) * bw;
    }
  }
  return value < (bins[0] || {}).from ? x0 : x0 + bins.length * bw;
}

function renderChart() {
  const wrap = $("chartWrap");
  wrap.replaceChildren();
  const s = state.stats;
  if (!s || !s.n) return;
  const bins = currentBins();
  const W = 900;
  const H = 320;
  const m = { l: 44, r: 12, t: 26, b: 64 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const maxC = Math.max(...bins.map((b) => b.count), 1);
  const yStep = St.niceStep(maxC, 5) < 1 ? 1 : Math.max(1, Math.round(St.niceStep(maxC, 5)));
  const yMax = Math.ceil(maxC / yStep) * yStep;
  const bw = pw / bins.length;
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": t("an_distribution") });

  // y grid + labels (number of reels)
  for (let y = 0; y <= yMax; y += yStep) {
    const yy = m.t + ph - (y / yMax) * ph;
    root.append(svg("line", { class: "grid", x1: m.l, x2: W - m.r, y1: yy, y2: yy }));
    root.append(svg("text", { class: "axis", x: m.l - 6, y: yy + 4, "text-anchor": "end" }, String(y)));
  }
  root.append(svg("text", { class: "axis", x: 4, y: 14 }, t("an_axis_y")));

  // bars
  const labelEvery = Math.ceil(bins.length / 14);
  bins.forEach((b, i) => {
    const h = (b.count / yMax) * ph;
    const x = m.l + i * bw + 2;
    const y = m.t + ph - h;
    const active = !state.filter || state.filter.kind !== "views" || (state.filter.from === b.from && state.filter.to === b.to);
    const rect = svg("rect", {
      class: "bin" + (active ? "" : " dim"), x, y, width: Math.max(1, bw - 4), height: Math.max(b.count ? 2 : 0, h),
      rx: 3, tabindex: b.count ? "0" : "-1", role: "button",
      "aria-label": `${rangeLabel(b.from, b.to)}: ${b.count}`,
    });
    rect.append(svg("title", {}, `${rangeLabel(b.from, b.to)} ${t("an_views_word")}\n${t("an_reels_count", [String(b.count)])}`));
    const pick = () => {
      if (!b.count) return;
      const same = state.filter && state.filter.kind === "views" && state.filter.from === b.from && state.filter.to === b.to;
      state.filter = same ? null : { kind: "views", from: b.from, to: b.to };
      renderChart();
      renderActivityChart();
      renderTable();
    };
    rect.addEventListener("click", pick);
    rect.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        pick();
      }
    });
    root.append(rect);
    if (b.count) root.append(svg("text", { class: "count", x: x + (bw - 4) / 2, y: y - 4, "text-anchor": "middle" }, String(b.count)));
    if (i % labelEvery === 0 || b.to === Infinity) {
      const lx = m.l + i * bw;
      const label = b.to === Infinity ? `≥${cmp(b.from)}` : cmp(b.from);
      root.append(svg("text", { class: "axis", x: lx + 2, y: m.t + ph + 14, transform: `rotate(35 ${lx + 2} ${m.t + ph + 14})` }, label));
    }
  });
  const last = bins[bins.length - 1];
  if (last && last.to !== Infinity) {
    const lx = m.l + bins.length * bw;
    root.append(svg("text", { class: "axis", x: lx, y: m.t + ph + 14, transform: `rotate(35 ${lx} ${m.t + ph + 14})` }, cmp(last.to)));
  }
  root.append(svg("text", { class: "axis", x: m.l + pw / 2, y: H - 4, "text-anchor": "middle" },
    state.scale === "log" ? t("an_axis_x_log") : t("an_axis_x", [cmp(bins.step || 0)])));

  // mean & median lines (+ the approximate viral line: typical views x viral multiplier)
  const lines = [["median", s.median, t("an_median")], ["mean", s.mean, t("an_mean")]];
  const p = state.perf;
  if (p && p.enough) {
    const v = p.typicalViews * p.viralMult;
    const lastBin = bins[bins.length - 1];
    if (v <= s.max && (lastBin.to === Infinity || v < lastBin.to)) lines.push(["viral", v, t("an_viral_line")]);
  }
  for (const [cls, value, label] of lines) {
    const x = xOf(value, bins, m.l, bw);
    root.append(svg("line", { class: `vline ${cls}`, x1: x, x2: x, y1: m.t - 6, y2: m.t + ph }));
    const anchor = x > W - 140 ? "end" : "start";
    const ly = cls === "mean" ? m.t - 10 : cls === "viral" ? m.t + 18 : m.t + 4;
    root.append(svg("text", { class: `vlabel ${cls}`, x: x + (anchor === "end" ? -4 : 4), y: ly, "text-anchor": anchor },
      `${label}: ${cmp(value)}`));
  }
  wrap.append(root);
}

/**
 * Short visual facts instead of sentences: icon + a few words; the full explanation is the
 * tooltip. Facts that point at reels are clickable and filter the table.
 */
function fact(icon, text, opts) {
  opts = opts || {};
  const node = el(opts.onClick ? "button" : "span", {
    class: "fact" + (opts.tone ? " " + opts.tone : ""), title: opts.title || "", type: opts.onClick ? "button" : null,
  }, [el("span", { class: "fact-i", text: icon }), el("span", { text })]);
  if (opts.onClick) node.addEventListener("click", opts.onClick);
  return node;
}

/** Show a group of reels in the table (used by the clickable facts). */
function showInTable(threshold) {
  state.threshold = threshold;
  $("thresholdSelect").value = threshold;
  state.filter = null;
  renderTable();
  $("reelTable").closest(".card").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderInsights() {
  const s = state.stats;
  const box = $("insights");
  box.replaceChildren();
  if (!s || !s.n) return;
  const add = (...a) => box.append(fact(...a));
  add("📦", t("f_typical", [cmp(s.p25), cmp(s.p75)]), { title: t("an_ins_typical", [cmp(s.p25), cmp(s.p75)]) });
  const p = state.perf;
  if (p && p.enough) {
    if (p.nViral) {
      add("🚀", t("f_viral", [String(p.nViral), pct(p.viralShare)]), {
        tone: "viral", onClick: () => showInTable("viral"),
        title: t("an_ins_viral", [String(p.nViral), `${p.viralMult.toFixed(1)}×`, pct(p.viralShare)])
          + (p.nViralLowEr ? "\n" + t("an_ins_viral_low_er", [String(p.nViralLowEr)]) : ""),
      });
    } else add("🚀", t("f_no_viral"), { title: t("an_ins_no_viral") });
    if (p.nWinner) add("🏆", t("f_winners", [String(p.nWinner)]), { tone: "win", onClick: () => showInTable("winner"), title: t("an_ins_winner", [String(p.nWinner)]) });
    if (p.nTalk) add("💬", t("f_talk", [String(p.nTalk)]), { onClick: () => showInTable("engaged"), title: t("an_ins_talk", [String(p.nTalk)]) });
    if (p.nRising) add("🌱", t("f_rising", [String(p.nRising)]), { tone: "good", onClick: () => showInTable("rising"), title: t("an_ins_rising", [String(p.nRising)]) });
  }
  add("🎯", t("f_top10", [pct(s.top10Share)]), {
    title: t("an_ins_top10", [String(s.top10Count), pct(s.top10Share)]) + (s.cv > 1.5 ? "\n" + t("an_ins_volatile") : s.cv < 0.5 ? "\n" + t("an_ins_stable") : ""),
  });
  // newer half vs older half of the reels
  const withViews = state.rows.filter((r) => r.views != null);
  if (withViews.length >= 10) {
    const half = Math.floor(withViews.length / 2);
    const recent = St.summarize(withViews.slice(0, half).map((r) => r.views)).median; // newest first
    const older = St.summarize(withViews.slice(half).map((r) => r.views)).median;
    if (older > 0) {
      const ch = recent / older - 1;
      if (Math.abs(ch) >= 0.2) {
        add(ch > 0 ? "📈" : "📉", t("f_trend", [`${ch > 0 ? "+" : "−"}${pct(Math.abs(ch))}`]), {
          tone: ch > 0 ? "good" : "bad", title: t(ch > 0 ? "an_ins_trend_up" : "an_ins_trend_down", [pct(Math.abs(ch))]),
        });
      }
    }
  }
}

// ------------------------------------------------------------------ posting activity
const LANG = (() => {
  try {
    return chrome.i18n.getUILanguage();
  } catch (_e) {
    return undefined;
  }
})();
// Numeric dates (21.04.2026): Chrome's month names for some UI languages (e.g. az) come out as "M04".
const p2 = (x) => String(x).padStart(2, "0");
function dateShort(ts, withYear) {
  const d = new Date(ts);
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}${withYear ? "." + d.getFullYear() : ""}`;
}
function dateLong(ts) {
  return dateShort(ts, true);
}
function monthLabel(ts) {
  const d = new Date(ts);
  return `${p2(d.getMonth() + 1)}.${d.getFullYear()}`;
}
/** Weekday name, Monday = 0 (2024-01-01 was a Monday). */
function weekdayName(i, long) {
  const names = t(long ? "an_weekdays_long" : "an_weekdays_short").split(",");
  return names.length === 7 ? names[i] : new Date(2024, 0, 1 + i).toLocaleDateString(LANG, { weekday: long ? "long" : "short" });
}
/** Hours as a readable duration: 45 min / 6.5 hours / 3.2 days. */
function dur(hours) {
  if (hours == null || !isFinite(hours)) return "–";
  if (hours < 1) return t("an_dur_min", [String(Math.max(1, Math.round(hours * 60)))]);
  if (hours < 48) return t("an_dur_hours", [hours < 10 ? hours.toFixed(1) : String(Math.round(hours))]);
  const d = hours / 24;
  return t("an_dur_days", [d < 10 ? d.toFixed(1) : String(Math.round(d))]);
}
/** Small rates: 0.43 / 2.1 / 15 */
function rate(x) {
  if (!isFinite(x)) return "–";
  return x < 1 ? x.toFixed(2) : x < 10 ? x.toFixed(1) : String(Math.round(x));
}
const hourRange = (h) => `${String(h).padStart(2, "0")}:00–${String((h + 1) % 24).padStart(2, "0")}:00`;
function median(values) {
  const v = values.filter((x) => typeof x === "number").sort((a, b) => a - b);
  return v.length ? St.quantile(v, 0.5) : null;
}
function dateRangeLabel(from, to) {
  const lastDay = St.addDays(to, -1);
  return St.dayStart(from) === St.dayStart(lastDay) ? dateLong(from) : `${dateShort(from)} – ${dateLong(lastDay)}`;
}

function renderActivity() {
  const a = state.activity;
  $("activityCard").hidden = !a || a.n < 2;
  if ($("activityCard").hidden) return;
  if (!state.interval) state.interval = St.autoInterval(a.spanDays);
  for (const b of $("intervalSeg").children) b.classList.toggle("on", Number(b.dataset.days) === state.interval);
  $("activityRange").textContent = t("an_act_range", [dateLong(a.first), dateLong(state.windowEnd), String(a.spanDays), String(a.n)]);
  renderActivityCards();
  renderActivityChart();
  renderWhatWorks(); // before the heatmap: it outlines the best window
  renderHeatmap();
  renderActivityInsights();
}

function renderActivityCards() {
  const a = state.activity;
  const box = $("activityCards");
  box.replaceChildren();
  const card = (k, v, sub, title) => box.append(el("div", { class: "stat", title: title || "" }, [
    el("div", { class: "k", text: k }), el("div", { class: "v", text: v }), sub ? el("div", { class: "s", text: sub }) : null,
  ]));
  card(t("an_act_per1"), rate(a.perDay), t("an_act_posts"));
  card(t("an_act_per3"), rate(a.per3), t("an_act_posts"));
  card(t("an_act_per7"), rate(a.per7), t("an_act_posts"));
  card(t("an_act_per30"), rate(a.per30), t("an_act_posts"));
  card(t("an_act_gap_mean"), dur(a.meanGap), t("an_act_gap_median", [dur(a.medianGap)]), t("an_tip_gap"));
  if (a.maxGap) card(t("an_act_gap_max"), dur(a.maxGap.hours), `${dateShort(a.maxGap.from)} – ${dateShort(a.maxGap.to)}`);
  card(t("an_act_last"), t("an_act_ago", [dur(a.sinceLastDays * 24)]), dateLong(a.last));
  card(t("an_act_active"), pct(a.activeShare), t("an_act_active_sub", [String(a.activeDays), String(a.spanDays)]), t("an_tip_active"));
  card(t("an_act_max_day"), String(a.maxPerDay), t("an_act_posts"));
}

function renderActivityChart() {
  const wrap = $("activityWrap");
  wrap.replaceChildren();
  const a = state.activity;
  if (!a || a.n < 2) return;
  const bins = St.activityBins(state.rows.map((r) => r.ts), state.interval, state.windowEnd);
  for (const b of bins) {
    const v = b.items.map((i) => state.rows[i].views).filter((x) => typeof x === "number");
    b.medViews = median(v);
    b.totViews = v.length ? v.reduce((s, x) => s + x, 0) : b.count ? null : 0; // an empty interval brought 0 views
  }
  // line on the right axis: median views (a typical reel) or total views (all reels together) of each interval
  const mode = state.viewsLine;
  const lineVal = (b) => (mode === "total" ? b.totViews : b.medViews);
  const line = mode !== "off" && bins.some((b) => lineVal(b) != null);
  $("viewsLegend").hidden = !line;
  $("viewsLegendText").textContent = t(mode === "total" ? "an_act_legend_total" : "an_act_legend_line");
  const tipViews = (b) => [
    b.medViews != null ? t("an_act_tip_views", [cmp(b.medViews)]) : null,
    b.totViews ? t("an_act_tip_total", [cmp(b.totViews)]) : null,
  ].filter(Boolean);

  const m = { l: 44, r: line ? 56 : 12, t: 24, b: 62 };
  const W = Math.max(900, m.l + m.r + bins.length * 7); // many 1-day bars: scroll instead of squashing
  const H = 300;
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const maxC = Math.max(...bins.map((b) => b.count), 1);
  const yStep = Math.max(1, Math.round(St.niceStep(maxC, 5)));
  const yMax = Math.ceil(maxC / yStep) * yStep;
  const maxV = Math.max(...bins.map((b) => lineVal(b) || 0), 1);
  const vStep = St.niceStep(maxV, 5);
  const vMax = Math.ceil(maxV / vStep) * vStep;
  const bw = pw / bins.length;
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": t("an_activity") });
  if (W > 900) root.style.minWidth = `${W}px`;

  for (let y = 0; y <= yMax; y += yStep) {
    const yy = m.t + ph - (y / yMax) * ph;
    root.append(svg("line", { class: "grid", x1: m.l, x2: W - m.r, y1: yy, y2: yy }));
    root.append(svg("text", { class: "axis", x: m.l - 6, y: yy + 4, "text-anchor": "end" }, String(y)));
  }
  root.append(svg("text", { class: "axis", x: 4, y: 14 }, t("an_act_axis_y")));
  if (line) {
    for (let v = 0; v <= vMax; v += vStep) {
      const yy = m.t + ph - (v / vMax) * ph;
      root.append(svg("text", { class: "axis views", x: W - m.r + 6, y: yy + 4 }, cmp(v)));
    }
    root.append(svg("text", { class: "axis views", x: W - 4, y: 14, "text-anchor": "end" }, t(mode === "total" ? "an_act_axis_total" : "an_act_axis_y2")));
  }

  const monthly = state.interval >= 30;
  const multiYear = new Date(bins[0].from).getFullYear() !== new Date(state.windowEnd).getFullYear();
  const labelEvery = Math.max(1, Math.ceil(bins.length / 16));
  bins.forEach((b, i) => {
    const h = (b.count / yMax) * ph;
    const x = m.l + i * bw + (bw > 6 ? 2 : 0.5);
    const y = m.t + ph - h;
    const f = state.filter;
    const active = !f || f.kind !== "date" || (f.from === b.from && f.to === b.to);
    const rect = svg("rect", {
      class: "abin" + (active ? "" : " dim"), x, y, width: Math.max(1, bw - (bw > 6 ? 4 : 1)), height: Math.max(b.count ? 2 : 0, h),
      rx: bw > 6 ? 3 : 0, tabindex: b.count ? "0" : "-1", role: "button",
      "aria-label": `${dateRangeLabel(b.from, b.to)}: ${b.count}`,
    });
    const tip = [dateRangeLabel(b.from, b.to), t("an_reels_count", [String(b.count)])];
    tip.push(...tipViews(b));
    rect.append(svg("title", {}, tip.join("\n")));
    const pick = () => {
      if (!b.count) return;
      const same = f && f.kind === "date" && f.from === b.from && f.to === b.to;
      state.filter = same ? null : { kind: "date", from: b.from, to: b.to };
      renderChart();
      renderActivityChart();
      renderTable();
    };
    rect.addEventListener("click", pick);
    rect.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        pick();
      }
    });
    root.append(rect);
    if (b.count && bw >= 14) root.append(svg("text", { class: "count", x: x + (bw - 4) / 2, y: y - 4, "text-anchor": "middle" }, String(b.count)));
    if (i % labelEvery === 0) {
      const lx = m.l + i * bw;
      const label = monthly ? monthLabel(b.from) : dateShort(b.from, multiYear && (i === 0 || new Date(b.from).getMonth() === 0));
      root.append(svg("text", { class: "axis", x: lx + 2, y: m.t + ph + 14, transform: `rotate(35 ${lx + 2} ${m.t + ph + 14})` }, label));
    }
  });

  if (line) {
    const pts = bins
      .map((b, i) => (lineVal(b) == null ? null : [m.l + i * bw + bw / 2, m.t + ph - (lineVal(b) / vMax) * ph, b]))
      .filter(Boolean);
    root.append(svg("polyline", { class: "vline-views", points: pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ") }));
    if (pts.length <= 120) {
      for (const [px, py, b] of pts) {
        const c = svg("circle", { class: "vdot", cx: px, cy: py, r: 3.5 });
        c.append(svg("title", {}, [dateRangeLabel(b.from, b.to), ...tipViews(b)].join("\n")));
        root.append(c);
      }
    }
  }
  wrap.append(root);
}

/**
 * Weekday x hour grid. "posts" mode: how often they post at that time. "perf" mode: how well
 * reels posted at that time did, as the median "vs typical" ratio (the profile's level at the
 * time is already factored out, so a growing account doesn't make late hours look better).
 * The extra row / column summarise each hour / weekday, where there is more data per cell.
 */
const HEAT_HOURS = [...Array(24).keys()].map((i) => (i + 12) % 24); // 12, 13 … 23, 0, 1 … 11

// ------------------------------------------------------------------ "What works" (timing + pace)
// Same groupings and statistics as the Compare stores page (PD.stats.groupEffect): every reel's
// "vs typical" ratio, grouped by 3-hour window, weekday, posts that day / week, gap before it.
const WW_WINDOWS = [12, 15, 18, 21, 0, 3, 6, 9]; // same order as the heatmap (midnight in the middle)
const p2h = (h) => String(h).padStart(2, "0");
const WW_DIMS = {
  window: { icon: "⏰", title: "ww_time", order: WW_WINDOWS, label: (w) => `${p2h(w)}–${p2h((w + 3) % 24)}` },
  weekday: { icon: "📅", title: "ww_day", order: [0, 1, 2, 3, 4, 5, 6], label: (w) => weekdayName(w, true) },
  perDay: { icon: "🔁", title: "ww_per_day", order: St.BUCKETS.perDay.order, label: (g) => t("ww_per_day_v", [g]) },
  perWeek: { icon: "📆", title: "ww_per_week", order: St.BUCKETS.perWeek.order, label: (g) => t("ww_per_week_v", [g]) },
  gap: { icon: "⏱", title: "ww_gap", order: St.BUCKETS.gap.order, label: (g) => g },
};

/** For every reel in range (with a score, not still growing): its group in each dimension. */
function wwItems() {
  const allTs = state.allRows.map((r) => r.ts).filter((x) => x > 0).sort((a, b) => a - b);
  const perDay = new Map();
  for (const x of allTs) perDay.set(St.dayStart(x), (perDay.get(St.dayStart(x)) || 0) + 1);
  const out = [];
  for (const r of state.rows) {
    if (!r.ts || r.score == null || !r.perf || r.perf.isNew) continue;
    const d = new Date(r.ts);
    let week = 0;
    let prev = null;
    for (const x of allTs) {
      if (x > r.ts - 7 * St.DAY && x <= r.ts) week++;
      if (x < r.ts) prev = x;
    }
    out.push({
      ratio: r.score,
      window: St.BUCKETS.window.of(d.getHours()),
      weekday: St.weekdayMon(r.ts),
      perDay: St.BUCKETS.perDay.of(perDay.get(St.dayStart(r.ts)) || 1),
      perWeek: St.BUCKETS.perWeek.of(week),
      gap: prev ? St.BUCKETS.gap.of((r.ts - prev) / St.HOUR) : null,
    });
  }
  return out;
}

function renderWhatWorks() {
  const items = wwItems();
  const tiles = $("wwTiles");
  tiles.replaceChildren();
  $("wwChart").replaceChildren();
  state.wwEffects = {};
  for (const [key, dim] of Object.entries(WW_DIMS)) {
    state.wwEffects[key] = St.groupEffect(items.map((it) => ({ group: it[key], ratio: it.ratio })));
  }
  $("wwNote").textContent = t("ww_note", [String(items.length)]);
  if (!state.wwDim) state.wwDim = "window";
  for (const [key, dim] of Object.entries(WW_DIMS)) {
    const node = PD.effectsUI.tile(dim.icon, dim.title, state.wwEffects[key], dim.label, () => {
      state.wwDim = key;
      renderWhatWorks();
    });
    node.classList.toggle("on", state.wwDim === key);
    tiles.append(node);
  }
  const dim = WW_DIMS[state.wwDim];
  $("wwChart").append(PD.effectsUI.bars(state.wwEffects[state.wwDim], { order: dim.order, label: dim.label }));
  // the best time window is also outlined on the heatmap
  const best = St.bestEffect(state.wwEffects.window);
  state.bestWindow = best ? best.group : null;
}

// ------------------------------------------------------------------ CSV export (timing + performance)
/*
 * One row per reel ("tidy" data): several stores' files can be stacked and pivoted any way
 * (by hour, weekday, posting frequency). Raw views are not comparable between a big and a small
 * store; vs_typical / z_score / tier are relative to the store itself, so they are.
 * Format "excel": ";" separator and decimal comma (Excel with Azerbaijani / Russian / Turkish /
 * most European regional settings); "standard": "," and decimal point (Google Sheets, Python).
 */
const CSV_COLUMNS = [
  "store", "followers", "reel_code", "url",
  "posted_date", "posted_time", "weekday", "hour", "hour_utc", "timezone",
  "age_days", "is_new",
  "views", "likes", "comments", "engagement_pct", "like_pct", "comment_pct", "likes_per_comment", "views_per_day",
  "vs_typical", "z_score", "tier", "winner", "er_vs_expected_pct",
  "posts_same_day", "posts_last_7_days", "hours_since_prev_post",
  "duration_s",
];

function csvFormat() {
  try {
    return localStorage.getItem("csvFormat") === "standard" ? "standard" : "excel";
  } catch (_e) {
    return "excel";
  }
}

function exportCsv() {
  const fmt = csvFormat();
  const sep = fmt === "excel" ? ";" : ",";
  const num = (x, digits) => {
    if (x == null || !isFinite(x)) return "";
    const s = digits == null ? String(Math.round(x)) : x.toFixed(digits);
    return fmt === "excel" ? s.replace(".", ",") : s;
  };
  // quote only when needed (the separator, a quote or a line break): "388,2" must stay a number
  const cell = (v) => {
    const s = v == null ? "" : String(v);
    return s.includes(sep) || /["\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const p2 = (x) => String(x).padStart(2, "0");
  const tzOf = (d) => {
    const m = -d.getTimezoneOffset();
    return `UTC${m >= 0 ? "+" : "-"}${p2(Math.floor(Math.abs(m) / 60))}:${p2(Math.abs(m) % 60)}`;
  };

  // posting frequency from ALL analyzed reels (not only the selected range), so the counts near
  // the edges of the range are still correct
  const allTs = state.allRows.map((r) => r.ts).filter((x) => x > 0).sort((a, b) => a - b);
  const perDay = new Map();
  for (const x of allTs) perDay.set(St.dayStart(x), (perDay.get(St.dayStart(x)) || 0) + 1);
  const countBetween = (from, to) => {
    let n = 0;
    for (const x of allTs) if (x > from && x <= to) n++;
    return n;
  };

  const rows = state.rows.filter((r) => r.ts).slice().sort((a, b) => a.ts - b.ts);
  const store = state.data.username;
  const followers = (state.data.profile || {}).followers;
  const lines = [CSV_COLUMNS.join(sep)];
  for (const r of rows) {
    const d = new Date(r.ts);
    const pf = r.perf;
    const prev = allTs.filter((x) => x < r.ts).pop();
    const det = (details.get(r.code) || {}).data;
    const dur = (det && det.duration) || r.duration;
    const vals = {
      store, followers: num(followers), reel_code: r.code, url: r.url,
      posted_date: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`,
      posted_time: `${p2(d.getHours())}:${p2(d.getMinutes())}`,
      weekday: weekdayName(St.weekdayMon(r.ts), true),
      hour: d.getHours(), hour_utc: d.getUTCHours(), timezone: tzOf(d),
      age_days: num((state.now - r.ts) / St.DAY, 1),
      is_new: pf && pf.isNew ? "yes" : "no",
      views: num(r.views), likes: num(r.likes), comments: num(r.comments),
      engagement_pct: r.er != null ? num(r.er * 100, 3) : "",
      like_pct: r.likeRate != null ? num(r.likeRate * 100, 3) : "",
      comment_pct: r.commentRate != null ? num(r.commentRate * 100, 4) : "",
      likes_per_comment: r.likes != null && r.comments ? num(r.likes / r.comments, 1) : "",
      views_per_day: num(r.vpd),
      vs_typical: pf ? num(pf.ratio, 2) : "",
      z_score: pf ? num(pf.z, 2) : "",
      tier: pf ? pf.tier : "",
      winner: pf ? (pf.winner ? "yes" : "no") : "",
      er_vs_expected_pct: pf && pf.erVsExpected != null ? num((pf.erVsExpected - 1) * 100, 1) : "",
      posts_same_day: perDay.get(St.dayStart(r.ts)) || 1,
      posts_last_7_days: countBetween(r.ts - 7 * St.DAY, r.ts),
      hours_since_prev_post: prev ? num((r.ts - prev) / St.HOUR, 1) : "",
      duration_s: dur ? num(dur, 1) : "",
    };
    lines.push(CSV_COLUMNS.map((c) => cell(vals[c])).join(sep));
  }
  // BOM: Excel then reads the UTF-8 text (store names, captions) correctly
  const blob = new Blob(["﻿" + lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
  const range = state.range ? `_${dateKey(state.range.from)}_to_${dateKey(state.range.to - 1)}` : "";
  const a = el("a", { href: URL.createObjectURL(blob), download: `${store}_reels${range}_${today()}.csv` });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
  setActionMsg(t("an_csv_done", [String(rows.length), fmt === "excel" ? "Excel (;)" : "Standard (,)"]), "ok");
}

function dateKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function renderHeatmap() {
  const box = $("heatmap");
  box.replaceChildren();
  const perfMode = state.heatMode === "perf";
  $("heatLegendPosts").hidden = perfMode;
  $("heatLegendPerf").hidden = !perfMode;
  const cell = () => ({ n: 0, views: [], ratios: [] });
  const g = Array.from({ length: 7 }, () => Array.from({ length: 24 }, cell));
  const byDay = Array.from({ length: 7 }, cell);
  const byHour = Array.from({ length: 24 }, cell);
  for (const r of state.rows) {
    if (!r.ts) continue;
    const w = St.weekdayMon(r.ts);
    const h = new Date(r.ts).getHours();
    for (const c of [g[w][h], byDay[w], byHour[h]]) {
      c.n++;
      if (r.views != null) c.views.push(r.views);
      if (r.score != null) c.ratios.push(r.score);
    }
  }
  const maxN = Math.max(1, ...g.map((row) => Math.max(...row.map((c) => c.n))));

  /** Paint one cell: posts mode = purple by count; perf mode = green above / red below typical. */
  const paint = (node, c, summary) => {
    if (!c.n) return;
    if (!perfMode) {
      node.classList.add("on");
      if (!summary) node.style.opacity = String(0.18 + 0.82 * (c.n / maxN));
      return;
    }
    const mr = median(c.ratios);
    if (mr == null) return;
    // log2 scale: 1x = neutral, 4x = full green, 1/4x = full red
    const s = Math.max(-1, Math.min(1, Math.log2(mr) / 2));
    const pctMix = Math.round(18 + Math.abs(s) * 72);
    node.style.background = `color-mix(in srgb, ${s >= 0 ? "var(--ok)" : "var(--err)"} ${pctMix}%, var(--soft))`;
    if (c.n === 1 && !summary) node.classList.add("thin"); // a single reel is an anecdote, not a pattern
  };
  const tipOf = (label, c) => {
    const lines = [label, t("an_reels_count", [String(c.n)])];
    const mr = median(c.ratios);
    if (mr != null) lines.push(t("an_heat_tip_ratio", [`${mr.toFixed(1)}×`]));
    const mv = median(c.views);
    if (mv != null) lines.push(t("an_act_tip_views", [cmp(mv)]));
    if (perfMode && c.n === 1) lines.push(t("an_heat_tip_single"));
    return lines.join("\n");
  };
  const summaryText = (c) => {
    if (!c.n) return "";
    if (!perfMode) return String(c.n);
    const mr = median(c.ratios);
    return mr == null ? "" : `${mr.toFixed(1)}×`;
  };

  const grid = el("div", { class: "heatmap" + (perfMode ? " perf" : ""), role: "table", "aria-label": t("an_when_title") });
  grid.append(el("span"));
  // columns run 12:00 -> 23:00 -> 00:00 -> 11:00: midnight sits in the middle, so a night of posting
  // (evening into early morning) stays one block instead of being split over both edges
  const inBest = (h) => state.bestWindow != null && h >= state.bestWindow && h < state.bestWindow + 3;
  const hc = (h) => (h === 0 ? " midnight" : "") + (inBest(h) ? " best" + (h === state.bestWindow ? " best-first" : h === state.bestWindow + 2 ? " best-last" : "") : "");
  for (const h of HEAT_HOURS) grid.append(el("span", { class: "hh" + hc(h), text: inBest(h) && h === state.bestWindow + 1 ? "★" : h % 3 === 0 ? String(h).padStart(2, "0") : "" }));
  grid.append(el("span", { class: "hh", text: perfMode ? "×" : "Σ" }));
  for (let w = 0; w < 7; w++) {
    grid.append(el("span", { class: "hd", text: weekdayName(w) }));
    for (const h of HEAT_HOURS) {
      const c = g[w][h];
      const node = el("span", { class: "hm" + hc(h), title: tipOf(`${weekdayName(w, true)} ${hourRange(h)}`, c) });
      paint(node, c);
      grid.append(node);
    }
    const sum = el("span", { class: "ht", text: summaryText(byDay[w]), title: tipOf(weekdayName(w, true), byDay[w]) });
    if (perfMode) paintText(sum, byDay[w]);
    grid.append(sum);
  }
  // summary row: every weekday together, per hour
  grid.append(el("span", { class: "hd sum", text: t("an_heat_all_days") }));
  for (const h of HEAT_HOURS) {
    const c = byHour[h];
    const node = el("span", { class: "hm sumrow" + hc(h), title: tipOf(`${t("an_heat_all_days")} ${hourRange(h)}`, c) });
    paint(node, c, true);
    if (!perfMode && c.n) node.style.opacity = String(0.18 + 0.82 * (c.n / Math.max(1, ...byHour.map((x) => x.n))));
    grid.append(node);
  }
  grid.append(el("span"));
  box.append(grid);

  function paintText(node, c) {
    const mr = median(c.ratios);
    if (mr == null) return;
    node.classList.add(mr >= 1.2 ? "good" : mr <= 0.8 ? "bad" : "mid");
  }
}

function renderActivityInsights() {
  const a = state.activity;
  const box = $("activityInsights");
  box.replaceChildren();
  const add = (...x) => box.append(fact(...x));
  add("🗓", t("f_pace", [rate(a.per7), dur(a.medianGap)]), { title: t("an_ai_pace", [rate(a.per7), dur(a.medianGap)]) });
  if (a.trendComparable) {
    if (a.prev30 === 0 && a.last30 > 0) add("🔄", t("f_restart", [String(a.last30)]), { tone: "good", title: t("an_ai_trend_restart", [String(a.last30)]) });
    else if (a.prev30 > 0) {
      const ch = a.last30 / a.prev30 - 1;
      const key = ch >= 0.25 ? "an_ai_trend_up" : ch <= -0.25 ? "an_ai_trend_down" : "an_ai_trend_flat";
      add(ch >= 0.25 ? "📈" : ch <= -0.25 ? "📉" : "➡️", t("f_last30", [String(a.last30), String(a.prev30)]), {
        tone: ch >= 0.25 ? "good" : ch <= -0.25 ? "bad" : "", title: t(key, [String(a.last30), String(a.prev30)]),
      });
    }
  }
  if (a.sinceLastDays >= 14) add("💤", t("f_silent", [String(Math.floor(a.sinceLastDays))]), { tone: "bad", title: t("an_ai_inactive", [String(Math.floor(a.sinceLastDays))]) });
  if (a.n >= 6) {
    if (a.gapCv < 0.6) add("🕰", t("f_regular"), { title: t("an_ai_regular") });
    else if (a.gapCv > 1.5) add("🌊", t("f_bursty"), { title: t("an_ai_bursty") });
  }
  // hot right now: best views/day of the last 30 days -> opens that reel
  const hot = state.rows.filter((r) => r.vpd != null && r.ts > state.windowEnd - 30 * St.DAY).sort((x, y) => y.vpd - x.vpd)[0];
  if (hot) {
    add("🔥", t("f_hot", [cmp(Math.round(hot.vpd))]), {
      tone: "viral", onClick: () => openDetails(hot.code),
      title: t("an_ai_hot", [cmp(Math.round(hot.vpd)), dateLong(hot.ts), (captionOf(hot) || hot.code).split("\n")[0].slice(0, 60)]),
    });
  }
  if (state.data.truncated) add("⚠️", t("f_truncated", [String(state.data.count)]), { tone: "warn", title: t("an_ai_truncated", [String(state.data.count)]) });
}

// ------------------------------------------------------------------ table
function visibleRows() {
  let rows = state.rows.slice();
  const f = state.filter;
  if (f && f.kind === "views") rows = rows.filter((r) => r.views != null && r.views >= f.from && r.views < f.to);
  if (f && f.kind === "date") rows = rows.filter((r) => r.ts >= f.from && r.ts < f.to);
  const key = state.sort;
  // A clicked chart bar shows every reel of that interval; otherwise the "above X" filter of the chosen metric.
  const thr = f ? null : currentThreshold();
  if (thr && thr.test) rows = rows.filter(thr.test);
  else if (thr) rows = rows.filter((r) => isNum(metricVal(r, key)) && metricVal(r, key) > thr.value);
  rows.sort((a, b) => {
    const x = metricVal(a, key);
    const y = metricVal(b, key);
    return isNum(y) ? (isNum(x) ? y - x : 1) : isNum(x) ? -1 : 0;
  });
  return rows;
}

// ------------------------------------------------------------------ table filter: "above average" / "above X"
const isNum = (x) => typeof x === "number" && isFinite(x);
const metricVal = (r, key) => (key === "date" ? r.ts || null : r[key]);
const CUSTOM_PLACEHOLDER = {
  views: "10K", likes: "500", comments: "50", er: "5 (%)", vpd: "1K", score: "3", erAdj: "1.5",
  likeRate: "4 (%)", commentRate: "0.1 (%)", commentShare: "5 (%)",
};
// statistical groups (independent of the chosen metric, which then only sorts)
const TIER_FILTERS = {
  viral: (r) => !!r.perf && r.perf.tier === "viral",
  strong: (r) => !!r.perf && (r.perf.tier === "viral" || r.perf.tier === "strong"),
  winner: (r) => !!r.perf && r.perf.winner,
  engaged: (r) => !!r.perf && (r.perf.highEr || r.perf.talk),
  rising: (r) => !!r.perf && r.perf.rising,
};

function metricMean(key) {
  const v = state.rows.map((r) => metricVal(r, key)).filter(isNum);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
// metrics typed and shown in percent
const PCT_KEYS = new Set(["er", "likeRate", "commentRate", "commentShare"]);
/** Percent with enough digits for tiny rates: 2.1% / 0.35% / 0.062% */
function pctFine(x) {
  if (!isFinite(x)) return "–";
  const p = x * 100;
  if (p === 0) return "0%";
  return `${p >= 10 ? p.toFixed(0) : p >= 1 ? p.toFixed(1) : p >= 0.1 ? p.toFixed(2) : p.toFixed(3)}%`;
}
function metricText(v, key) {
  if (PCT_KEYS.has(key)) return pctFine(v);
  if (key === "score" || key === "erAdj") return `${v.toFixed(2)}×`;
  return v >= 1000 ? cmp(v) : String(Math.round(v * 10) / 10);
}
/** "10K", "1.5m", "2,5k", "10,000", "12 000" -> number; ER is typed in percent ("5" = 5%). */
function parseThreshold(text, key) {
  let s = String(text || "").trim().toLowerCase().replace(/[\s ]/g, "").replace(/%$/, "");
  if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, ""); // 10,000 = thousands separators
  const m = /^(\d+(?:[.,]\d+)?)([kmb]?)$/.exec(s);
  if (!m) return null;
  let n = parseFloat(m[1].replace(",", "."));
  n *= { "": 1, k: 1e3, m: 1e6, b: 1e9 }[m[2]];
  return PCT_KEYS.has(key) ? n / 100 : n;
}
function currentThreshold() {
  const key = state.sort;
  if (TIER_FILTERS[state.threshold]) return { kind: "tier", test: TIER_FILTERS[state.threshold] };
  if (key === "date" || state.threshold === "all") return null;
  if (state.threshold === "mean") {
    const m = metricMean(key);
    return m == null ? null : { value: m, kind: "mean" };
  }
  const v = parseThreshold(state.custom, key);
  return v == null ? null : { value: v, kind: "custom" };
}
function renderThresholdInfo(shown) {
  const key = state.sort;
  const box = $("thresholdInfo");
  const isDate = key === "date";
  // dates have no "above average"/custom value; the statistical groups still apply
  for (const o of $("thresholdSelect").options) if (o.value === "mean" || o.value === "custom") o.disabled = isDate;
  $("customInput").hidden = isDate || state.threshold !== "custom";
  $("customInput").placeholder = CUSTOM_PLACEHOLDER[key] || "";
  box.classList.remove("warn");
  if (state.filter) {
    box.textContent = "";
    return;
  }
  const total = String(state.rows.length);
  const name = t(`an_col_${key}`);
  const thr = currentThreshold();
  if (thr && thr.kind === "tier") {
    const label = $("thresholdSelect").selectedOptions[0].textContent;
    box.textContent = t("an_thr_info_tier", [label, String(shown), total, name]);
  } else if (isDate) box.textContent = t("an_thr_date", [String(shown), total]);
  else if (thr) {
    box.textContent = t(thr.kind === "mean" ? "an_thr_info_mean" : "an_thr_info_custom", [name, metricText(thr.value, key), String(shown), total]);
  } else if (state.threshold === "custom") {
    box.textContent = state.custom.trim() ? t("an_thr_bad") : t("an_thr_hint");
    if (state.custom.trim()) box.classList.add("warn");
  } else box.textContent = t("an_thr_all", [name, String(shown)]);
}

function jobStatusCell(row) {
  const td = el("td", { class: "st" });
  const jobId = state.jobs.get(row.code);
  const job = jobId && state.jobById.get(jobId);
  if (!job) return td;
  let txt = "";
  switch (job.status) {
    case S.QUEUED: txt = t("status_queued"); break;
    case S.RESOLVING: case S.DOWNLOADING: case S.PROCESSING:
      txt = job.cancelRequested ? t("status_cancelling")
        : PD.waitText(job) || t("status_downloading") + (job.progress != null ? ` ${Math.round(job.progress)}%` : ""); break;
    case S.SUCCESS: txt = "✓ " + t("status_success"); break;
    case S.DUPLICATE: txt = t("status_duplicate"); break;
    case S.FAILED: txt = job.errorMessage || t("status_failed"); break;
    case S.CANCELLED: txt = t("status_cancelled"); break;
    default: txt = job.status;
  }
  td.className = "st " + job.status;
  td.textContent = txt;
  td.title = job.errorDetail || txt;
  if (job.status === S.DUPLICATE) {
    td.append(" ", el("button", { class: "chipbtn", type: "button", text: t("btn_download_again"), onclick: async () => {
      const r = await send({ type: "retry", jobId: job.id, force: true });
      if (r.ok) state.jobs.set(row.code, r.data.jobId);
    } }));
  }
  if (job.status === S.FAILED || job.status === S.CANCELLED) {
    td.append(" ", el("button", { class: "chipbtn", type: "button", text: t("btn_retry"), onclick: async () => {
      const r = await send({ type: "retry", jobId: job.id });
      if (r.ok) state.jobs.set(row.code, r.data.jobId);
    } }));
  }
  if (!PD.isFinal(job.status) && !job.cancelRequested) {
    td.append(" ", el("button", {
      class: "chipbtn cancel", type: "button", text: "✕", title: t("btn_cancel"), "aria-label": t("btn_cancel"),
      onclick: () => send({ type: "cancel", jobId: job.id }),
    }));
  }
  return td;
}

/** Jobs started from this page that are still queued or running. */
function activeJobIds() {
  return [...state.jobs.values()].filter((id) => {
    const j = state.jobById.get(id);
    return j ? !PD.isFinal(j.status) && !j.cancelRequested : true; // no status yet = just queued
  });
}

/** "10 h" / "2.3 days" for a reel's age. */
function ageText(hours) {
  return hours < 48 ? t("an_dur_hours", [String(Math.max(1, Math.round(hours)))]) : t("an_dur_days", [(hours / 24).toFixed(1)]);
}

/**
 * Views, with a small dot for reels younger than 3 days: pulsing green = RISING (already
 * above the strong line while still collecting views), grey = new, not there (yet).
 */
function viewsCell(r) {
  const td = el("td", { class: "num views", title: fmt(r.views) });
  const pf = r.perf;
  if (pf && pf.isNew && pf.ageHours != null) {
    const rising = pf.rising;
    const vph = r.views / Math.max(1, pf.ageHours);
    td.append(el("span", {
      class: `fresh${rising ? " rising" : ""}`, role: "img",
      "aria-label": t(rising ? "an_sig_rising" : "an_sig_new"),
      title: rising
        ? t("an_tip_rising", [ageText(pf.ageHours), cmp(r.views), `${pf.ratio.toFixed(1)}×`, cmp(Math.round(vph))])
        : t("an_tip_fresh", [ageText(pf.ageHours), cmp(Math.round(vph))]),
    }));
  }
  td.append(r.views != null ? cmp(r.views) : "–");
  return td;
}

/** Tooltip for the "vs typical" cell: the score explained plus every signal of the reel, one per line. */
function signalsText(r) {
  const pf = r.perf;
  if (!pf) return "";
  const lines = [t("an_tip_score", [cmp(Math.round(pf.baseline)), pf.z.toFixed(1)])];
  const add = (key, tipKey, subs) => lines.push(`${t(key)}: ${t(tipKey, subs)}`);
  if (pf.tier === "viral") add("an_sig_viral", "an_sig_viral_tip", [pf.z.toFixed(1)]);
  else if (pf.tier === "strong") add("an_sig_strong", "an_sig_strong_tip", [pf.z.toFixed(1)]);
  else if (pf.tier === "weak") add("an_sig_weak", "an_sig_weak_tip");
  if (pf.rising) add("an_sig_rising", "an_tip_rising", [ageText(pf.ageHours), cmp(r.views), `${pf.ratio.toFixed(1)}×`, cmp(Math.round(r.views / Math.max(1, pf.ageHours)))]);
  else if (pf.isNew) add("an_sig_new", "an_sig_new_tip");
  if (pf.winner) add("an_sig_winner", "an_sig_winner_tip");
  if (pf.highEr) add("an_sig_high_er", "an_sig_high_er_tip", [pct(r.er), pct(pf.erExpected), pf.erZ.toFixed(1)]);
  if (pf.talk) add("an_sig_talk", "an_sig_talk_tip", [pf.crZ.toFixed(1)]);
  return lines.join("\n");
}

/** ER with a split bar: the likes part and the comments part of the engagement. */
function erCell(r) {
  const td = el("td", { class: "num ercell" });
  if (r.er == null) {
    td.textContent = "–";
    return td;
  }
  td.append(el("div", { text: pct(r.er) }));
  if (r.commentShare != null) {
    const cs = r.commentShare;
    // comments are usually a few %: give them at least 2px so they stay visible
    const bar = el("div", { class: "ersplit" }, [
      el("span", { class: "l" }),
      el("span", { class: "c" }),
    ]);
    bar.firstChild.style.flexGrow = String(1 - cs);
    bar.lastChild.style.flexGrow = String(cs);
    td.append(bar);
    td.title = t("an_tip_ercell", [pct(r.er), pctFine(r.likeRate), pct(1 - cs), pctFine(r.commentRate), pctFine(cs),
      r.comments ? String(Math.round(r.likes / r.comments)) : "–"]);
  }
  return td;
}

// ------------------------------------------------------------------ reel details panel
// details fetched from the helper, by reel code: {loading} | {error} | {data}
const details = new Map();
const captionOf = (r) => r.caption || ((details.get(r.code) || {}).data || {}).caption || "";

async function loadDetailsCache() {
  try {
    const store = (await chrome.storage.local.get("reelDetails")).reelDetails || {};
    for (const [code, v] of Object.entries(store)) if (v && v.data) details.set(code, { data: v.data, at: v.at });
  } catch (_e) { /* ignore */ }
}

function openDetails(code) {
  const wasOpen = !$("drawer").hidden;
  state.openCode = code;
  $("drawer").hidden = false;
  if (wasOpen) $("drawer").style.animation = "none"; // switching reels: no slide-in again
  for (const tr of $("reelBody").children) tr.classList.remove("open");
  renderDetails();
  renderTable(); // marks the open row
  $("drBody").scrollTop = 0;
  // keep the open row visible (moving with the arrow keys can leave the screen)
  const row = $("reelBody").querySelector("tr.open");
  if (row) row.scrollIntoView({ block: "nearest" });
  const d = details.get(code);
  if (!d || (!d.data && !d.loading)) fetchDetails(code, false);
}

function closeDetails() {
  state.openCode = null;
  $("drawer").hidden = true;
  $("drawer").style.animation = "";
  renderTable();
}

// ---- panel geometry: width resizable and remembered
const DR_MIN = 340;
const DR_MAX = 900;

function trackActionBarHeight() {
  const bar = $("actionBar");
  const set = () => {
    const h = bar.hidden || getComputedStyle(bar).position !== "fixed" ? 0 : bar.getBoundingClientRect().height;
    document.documentElement.style.setProperty("--ab-h", `${Math.round(h)}px`);
  };
  new ResizeObserver(set).observe(bar);
  new MutationObserver(set).observe(bar, { attributes: true, attributeFilter: ["hidden"] });
  window.addEventListener("resize", set);
  set();
}

function setDrawerWidth(px, save) {
  const w = Math.round(Math.max(DR_MIN, Math.min(DR_MAX, px)));
  document.documentElement.style.setProperty("--dr-w", `${w}px`);
  if (save) {
    try {
      localStorage.setItem("drawerWidth", String(w));
    } catch (_e) { /* storage blocked: the width just isn't remembered */ }
  }
}

function initDrawerResize() {
  try {
    const w = parseInt(localStorage.getItem("drawerWidth") || "", 10);
    if (w) setDrawerWidth(w, false);
  } catch (_e) { /* ignore */ }
  const handle = $("drResize");
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    document.body.classList.add("dr-resizing");
    const right = $("drawer").getBoundingClientRect().right;
    const move = (ev) => setDrawerWidth(right - ev.clientX, false);
    const up = (ev) => {
      setDrawerWidth(right - ev.clientX, true);
      handle.classList.remove("dragging");
      document.body.classList.remove("dr-resizing");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
  handle.addEventListener("dblclick", () => setDrawerWidth(460, true)); // double-click: default width
}

/** A click outside the panel closes it - except on a reel row (that switches reels) or the bottom bar. */
function initDrawerOutsideClose() {
  document.addEventListener("pointerdown", (e) => {
    if (!state.openCode) return;
    const t0 = e.target;
    if (t0.closest && t0.closest("#drawer, #reelBody tr.clickable, #actionBar, dialog")) return;
    closeDetails();
  });
}

/** Previous / next reel in the order the table shows them. */
function stepDetails(dir) {
  const codes = visibleRows().map((r) => r.code);
  const i = codes.indexOf(state.openCode);
  if (i < 0 || !codes.length) return;
  const next = codes[Math.max(0, Math.min(codes.length - 1, i + dir))];
  if (next !== state.openCode) openDetails(next);
}

async function fetchDetails(code, refresh) {
  details.set(code, { loading: true, data: (details.get(code) || {}).data });
  if (state.openCode === code) renderDetails();
  const res = await send({ type: "reelDetails", code, refresh: !!refresh });
  if (res.ok) {
    details.set(code, { data: res.data, at: res.data.cached || Date.now() });
    renderTable(); // the caption column can show the text now
  } else {
    details.set(code, { error: res.error, data: (details.get(code) || {}).data });
  }
  if (state.openCode === code) renderDetails();
}

/**
 * What the caption does, the way a dropshipper reads competitors' posts: hashtags, mentions,
 * calls to action, prices and discounts.
 */
const CTA_PATTERNS = [
  [/link in (?:my |our )?bio|\blink (?:is )?in (?:the )?bio\b|\bbio link\b/i, "link in bio"],
  [/\bcomment\b/i, "comment"],
  [/\b(?:dm|direct message|message us|send (?:us )?a message)\b/i, "DM"],
  [/\b(?:shop|store)\b/i, "shop"],
  [/\b(?:buy|order|purchase|get yours|grab (?:yours|one))\b/i, "buy / order"],
  [/\bfree shipping\b/i, "free shipping"],
  [/\b(?:sale|discount|deal|promo|coupon|code)\b/i, "sale / code"],
  [/\b(?:limited|only today|today only|last chance|selling out|sold out|restock)\b/i, "urgency"],
  [/\b(?:tag (?:a |your )?(?:friend|someone)|share (?:this|with))\b/i, "tag / share"],
  [/\b(?:save (?:this|for later))\b/i, "save"],
  [/\bfollow\b/i, "follow"],
];
function analyzeCaption(text) {
  const tags = [...new Set((text.match(/#[\p{L}\p{N}_]+/gu) || []).map((s) => s.slice(1)))];
  const mentions = [...new Set((text.match(/@[A-Za-z0-9._]{2,30}/g) || []).map((s) => s.slice(1).replace(/\.$/, "")))];
  const ctas = CTA_PATTERNS.filter(([re]) => re.test(text)).map(([, label]) => label);
  const prices = [...new Set(text.match(/(?:[$€£₺₼]\s?\d[\d.,]*|\d[\d.,]*\s?(?:\$|€|£|₺|₼|usd|eur|azn|tl|try)\b)/gi) || [])];
  const discounts = [...new Set(text.match(/-?\d{1,2}\s?%(?:\s?off)?/gi) || [])];
  const words = (text.replace(/[#@][\p{L}\p{N}_.]+/gu, " ").match(/[\p{L}\p{N}']+/gu) || []).length;
  const emojis = (text.match(/\p{Extended_Pictographic}/gu) || []).length;
  return { tags, mentions, ctas, prices, discounts, words, emojis, chars: text.length };
}

/** Caption as nodes: line breaks kept, #tags and @mentions as links to Instagram. */
function captionNodes(text) {
  const out = [];
  const re = /(#[\p{L}\p{N}_]+|@[A-Za-z0-9._]{2,30})/gu;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    const tok = m[0].replace(/\.$/, "");
    const href = tok[0] === "#"
      ? `https://www.instagram.com/explore/tags/${encodeURIComponent(tok.slice(1))}/`
      : `https://www.instagram.com/${encodeURIComponent(tok.slice(1))}/`;
    out.push(el("a", { href, target: "_blank", rel: "noopener noreferrer", class: tok[0] === "#" ? "tag" : "mention", text: tok }));
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

async function copyText(text, okKey) {
  try {
    await navigator.clipboard.writeText(text);
    setActionMsg(t(okKey), "ok");
  } catch (_e) {
    setActionMsg(t("err_UNKNOWN"), "err");
  }
}

function renderDetails() {
  const r = state.rows.find((x) => x.code === state.openCode) || state.allRows.find((x) => x.code === state.openCode);
  const body = $("drBody");
  body.replaceChildren();
  if (!r) {
    closeDetails();
    return;
  }
  const d = details.get(r.code) || {};
  const det = d.data || null;
  const pf = r.perf;
  const codes = visibleRows().map((x) => x.code);
  const pos = codes.indexOf(r.code);
  $("drPrev").disabled = pos <= 0;
  $("drNext").disabled = pos < 0 || pos >= codes.length - 1;
  $("drTitle").textContent = t("an_dr_title", [r.rank ? `#${r.rank}` : "", r.views != null ? cmp(r.views) : "–"]);
  const sub = [];
  if (r.ts) sub.push(`${weekdayName(St.weekdayMon(r.ts), true)} ${new Date(r.ts).toLocaleString(LANG, { dateStyle: "medium", timeStyle: "short" })}`);
  if (pf && pf.ageHours != null) sub.push(t("an_act_ago", [ageText(pf.ageHours)]));
  if (pos >= 0) sub.push(t("an_dr_pos", [String(pos + 1), String(codes.length)]));
  $("drSub").textContent = sub.join(" · ");

  const section = (titleKey, children, extraHead) => {
    const head = el("div", { class: "dr-sec-head" }, [el("h3", { text: t(titleKey) }), extraHead || null]);
    body.append(el("section", { class: "dr-sec" }, [head, ...[].concat(children).filter(Boolean)]));
  };

  // signals as small badges under the title
  const badges = el("div", { class: "dr-badges" });
  const badge = (cls, key) => badges.append(el("span", { class: `sig ${cls}`, text: t(key) }));
  if (pf) {
    if (pf.tier === "viral") badge("viral", "an_sig_viral");
    else if (pf.tier === "strong") badge("strong", "an_sig_strong");
    else if (pf.tier === "weak") badge("weak", "an_sig_weak");
    if (pf.rising) badge("strong", "an_sig_rising");
    else if (pf.isNew) badge("new", "an_sig_new");
    if (pf.winner) badge("winner", "an_sig_winner");
    if (pf.highEr) badge("eng", "an_sig_high_er");
    if (pf.talk) badge("talk", "an_sig_talk");
  }
  if (r.pinned) badges.append(el("span", { class: "sig", text: t("an_dr_pinned") }));
  if (det && det.paid_partnership) badges.append(el("span", { class: "sig paid", text: t("an_dr_paid") }));
  if (badges.childElementCount) body.append(badges);

  // 1) description: the main thing
  const cap = (det && det.caption) || r.caption || "";
  const capBox = [];
  if (d.loading && !cap) capBox.push(el("div", { class: "dr-loading", text: t("an_dr_loading") }));
  else if (d.error && !cap) {
    capBox.push(el("div", { class: "dr-error", text: `${d.error.message || t("err_UNKNOWN")}` }));
    capBox.push(el("button", { type: "button", class: "chipbtn", text: t("btn_retry"), onclick: () => fetchDetails(r.code, true) }));
  } else if (cap) capBox.push(el("div", { class: "dr-caption" }, captionNodes(cap)));
  else if (det) capBox.push(el("div", { class: "muted", text: t("an_dr_no_caption") }));
  const capActions = el("span", { class: "dr-sec-actions" }, [
    cap ? el("button", { type: "button", class: "chipbtn", text: t("an_dr_copy"), onclick: () => copyText(cap, "an_dr_copied_caption") }) : null,
    det ? el("button", { type: "button", class: "chipbtn", title: d.at ? t("an_dr_fetched", [new Date(d.at).toLocaleString(LANG)]) : "",
      text: d.loading ? "…" : "↻", "aria-label": t("an_dr_refresh"), onclick: () => fetchDetails(r.code, true) }) : null,
  ]);
  section("an_dr_caption", capBox, capActions);

  // 2) what the caption does
  if (cap) {
    const a = analyzeCaption(cap);
    const chips = (items, cls, hrefOf) => el("div", { class: "dr-chips" }, items.map((x) => (hrefOf
      ? el("a", { class: `dchip ${cls}`, href: hrefOf(x), target: "_blank", rel: "noopener noreferrer", text: x })
      : el("span", { class: `dchip ${cls}`, text: x }))));
    const rows = [];
    const line = (key, node) => rows.push(el("div", { class: "dr-kv" }, [el("span", { class: "k", text: t(key) }), node]));
    line("an_dr_length", el("span", { text: t("an_dr_length_v", [String(a.words), String(a.chars), String(a.emojis)]) }));
    if (a.ctas.length) line("an_dr_cta", chips(a.ctas, "cta"));
    if (a.prices.length || a.discounts.length) line("an_dr_price", chips([...a.prices, ...a.discounts], "price"));
    if (a.tags.length) line("an_dr_tags", chips(a.tags.map((x) => `#${x}`), "tag", (x) => `https://www.instagram.com/explore/tags/${encodeURIComponent(x.slice(1))}/`));
    if (a.mentions.length) line("an_dr_mentions", chips(a.mentions.map((x) => `@${x}`), "mention", (x) => `https://www.instagram.com/${encodeURIComponent(x.slice(1))}/`));
    if (!a.ctas.length) line("an_dr_cta", el("span", { class: "muted", text: t("an_dr_no_cta") }));
    section("an_dr_caption_analysis", rows);
  }

  // 3) numbers
  const grid = el("div", { class: "dr-grid" });
  const cell = (key, value, sub, cls) => grid.append(el("div", { class: "dr-cell" + (cls ? " " + cls : "") }, [
    el("div", { class: "k", text: t(key) }), el("div", { class: "v", text: value }), sub ? el("div", { class: "s", text: sub }) : null,
  ]));
  cell("an_col_views", r.views != null ? fmt(r.views) : "–", r.vpd != null ? t("an_dr_per_day", [cmp(Math.round(r.vpd))]) : "");
  if (pf) cell("an_col_score", `${pf.ratio.toFixed(1)}×`, t("an_dr_typical", [cmp(Math.round(pf.baseline)), pf.z.toFixed(1)]), pf.tier);
  cell("an_col_likes", r.likes != null ? fmt(r.likes) : "–", r.likeRate != null ? pctFine(r.likeRate) : "");
  cell("an_col_comments", r.comments != null ? fmt(r.comments) : "–", r.commentRate != null ? pctFine(r.commentRate) : "");
  const likeShareTxt = (cs) => (1 - cs > 0.99 ? `${((1 - cs) * 100).toFixed(1)}%` : pct(1 - cs)); // never "100%"
  cell("an_col_er", r.er != null ? pct(r.er) : "–", r.commentShare != null ? t("an_dr_mix", [likeShareTxt(r.commentShare), pctFine(r.commentShare)]) : "");
  if (pf && pf.erVsExpected != null) {
    const dd = pf.erVsExpected - 1;
    cell("an_col_erAdj", `${dd >= 0 ? "+" : "−"}${Math.round(Math.abs(dd) * 100)}%`, t("an_dr_expected", [pct(pf.erExpected)]), dd >= 0 ? "up" : "down");
  }
  if (r.likes && r.comments) cell("an_dr_lpc", String(Math.round(r.likes / r.comments)), t("an_dr_lpc_sub"));
  const dur = det && det.duration ? det.duration : r.duration;
  if (dur) cell("an_dr_duration", `${Math.round(dur)} s`, "");
  section("an_dr_numbers", grid);

  // 4) audio, place, people (from the details request)
  if (det) {
    const rows = [];
    const kv = (key, value) => value && rows.push(el("div", { class: "dr-kv" }, [el("span", { class: "k", text: t(key) }), el("span", { text: value })]));
    if (det.audio && (det.audio.title || det.audio.artist)) {
      kv("an_dr_audio", `${det.audio.title || ""}${det.audio.artist ? " — " + det.audio.artist : ""} (${t(det.audio.original ? "an_dr_audio_original" : "an_dr_audio_music")})`);
    }
    kv("an_dr_location", det.location);
    if (det.tagged && det.tagged.length) kv("an_dr_tagged", det.tagged.map((u) => "@" + u).join(", "));
    if (det.coauthors && det.coauthors.length) kv("an_dr_coauthors", det.coauthors.map((u) => "@" + u).join(", "));
    if (det.comments_disabled) kv("an_dr_comments_off", t("an_dr_yes"));
    if (rows.length) section("an_dr_more", rows);
  }

  // 5) actions
  const selected = state.selected.has(r.code);
  body.append(el("div", { class: "dr-actions" }, [
    el("a", { class: "btnlink primary", href: r.url, target: "_blank", rel: "noopener noreferrer", text: t("an_dr_open") }),
    el("button", { type: "button", text: t("an_dr_copy_link"), onclick: () => copyText(r.url, "an_dr_copied_link") }),
    el("button", { type: "button", text: t(selected ? "an_dr_unselect" : "an_dr_select"), onclick: () => {
      if (state.selected.has(r.code)) state.selected.delete(r.code);
      else state.selected.add(r.code);
      renderTable();
      updateActionBar();
      renderDetails();
    } }),
    (() => {
      const b = el("button", { type: "button", text: t("an_dr_download"), onclick: () => downloadOne(r) });
      b.disabled = !state.helperOk;
      return b;
    })(),
  ]));
}

/** Download only this reel, into the same collection folder as the bulk download. */
async function downloadOne(r) {
  const collection = $("collectionInput").value.trim() || `${state.data.username}_reels_${today()}`;
  const res = await send({ type: "downloadSelected", platform: "instagram", collection, items: [{
    url: r.url, code: r.code, views: r.views, title: captionOf(r).split("\n")[0].slice(0, 120) || `@${state.data.username} ${r.code}`,
  }] });
  if (!res.ok) return setActionMsg(res.error.message, "err");
  for (const j of res.data.jobs) state.jobs.set(j.code, j.jobId);
  setActionMsg(t("an_queued", ["1", `MediaDownloader/Instagram/${res.data.folder}`]), "ok");
  renderTable();
  updateCancelAll();
}

/** Engagement vs. what this reach normally gets on this profile: "+45%" / "−30%". */
function erAdjCell(r) {
  const pf = r.perf;
  if (!pf || pf.erVsExpected == null) return el("td", { class: "num muted", text: "–" });
  const d = pf.erVsExpected - 1;
  const txt = `${d >= 0 ? "+" : "−"}${Math.round(Math.abs(d) * 100)}%`;
  const cls = pf.erZ >= 1 ? "up" : pf.erZ <= -1 ? "down" : "";
  return el("td", {
    class: `num eradj ${cls}`, text: txt,
    title: t("an_tip_eradj", [pct(r.er), pct(pf.erExpected), pf.erZ.toFixed(1)]),
  });
}

/**
 * First row of the table: average (bold) and median (small) of every column over the reels
 * currently shown. Rates are averaged per reel (each reel counts once, whatever its views);
 * the tooltip also gives the pooled rate (total likes / total views), where big reels weigh more.
 */
function summaryRow(rows) {
  const vals = (f) => rows.map(f).filter(isNum);
  const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
  const sum = (f) => rows.reduce((a, r) => a + (isNum(f(r)) ? f(r) : 0), 0);
  const cellOf = (f, show, extraTip) => {
    const v = vals(f);
    if (!v.length) return el("td", { class: "num muted", text: "–" });
    const avg = mean(v);
    const md = median(v);
    return el("td", { class: "num", title: [t("an_sum_tip", [show(avg), show(md), String(v.length)]), extraTip].filter(Boolean).join("\n") }, [
      el("div", { class: "sum-avg", text: show(avg) }),
      el("div", { class: "sum-med", text: show(md) }),
    ]);
  };
  const signed = (x) => `${x >= 1 ? "+" : "−"}${Math.round(Math.abs(x - 1) * 100)}%`;
  const tViews = sum((r) => r.views);
  const pooled = (num) => (tViews ? num / tViews : null);
  const tLikes = sum((r) => (isNum(r.views) ? r.likes : null));
  const tComments = sum((r) => (isNum(r.views) ? r.comments : null));
  const ts = rows.map((r) => r.ts).filter((x) => x > 0);
  return el("tr", { class: "sumrow" }, [
    el("td"),
    el("td", { colspan: "2", class: "sum-label" }, [
      // the two lines here name the two lines of every value cell: average, then median
      el("div", { title: t("an_sum_count", [String(rows.length), cmp(tViews)]) }, [
        el("span", { text: t("an_sum_label") }),
        el("span", { class: "sum-n", text: ` · ${t("an_sum_count", [String(rows.length), cmp(tViews)])}` }),
      ]),
      el("div", { class: "sum-med", text: t("an_sum_median") }),
    ]),
    cellOf((r) => r.views, (x) => cmp(Math.round(x))),
    cellOf((r) => r.score, (x) => `${x.toFixed(1)}×`),
    cellOf((r) => r.likes, (x) => cmp(Math.round(x))),
    cellOf((r) => r.comments, (x) => cmp(Math.round(x))),
    cellOf((r) => r.er, pctFine, tViews ? t("an_sum_pooled", [pctFine(pooled(tLikes + tComments))]) : ""),
    cellOf((r) => r.likeRate, pctFine, tViews ? t("an_sum_pooled", [pctFine(pooled(tLikes))]) : ""),
    cellOf((r) => r.commentRate, pctFine, tViews ? t("an_sum_pooled", [pctFine(pooled(tComments))]) : ""),
    cellOf((r) => r.erAdj, signed),
    cellOf((r) => r.vpd, (x) => cmp(Math.round(x))),
    el("td", { class: "muted small", text: ts.length ? `${dateShort(Math.min(...ts))} – ${dateShort(Math.max(...ts))}` : "" }),
    el("td"),
    el("td"),
  ]);
}

let lastClickedCode = null; // anchor for Shift+click range selection

function renderTable() {
  const body = $("reelBody");
  body.replaceChildren();
  const rows = visibleRows();
  $("filterBar").hidden = !state.filter;
  if (state.filter) {
    const f = state.filter;
    $("filterText").textContent = f.kind === "date"
      ? t("an_filter_date", [dateRangeLabel(f.from, f.to), String(rows.length)])
      : t("an_filter_active", [rangeLabel(f.from, f.to), String(rows.length)]);
  }
  rows.forEach((r, i) => {
    const cb = el("input", { type: "checkbox", "aria-label": r.code });
    cb.checked = state.selected.has(r.code);
    cb.addEventListener("change", () => {
      if (cb.checked) state.selected.add(r.code);
      else state.selected.delete(r.code);
      tr.classList.toggle("sel", cb.checked);
      updateActionBar();
    });
    let thumb;
    if (r.thumbnail && /^https:\/\/[^/]*(cdninstagram\.com|fbcdn\.net)\//.test(r.thumbnail)) {
      thumb = el("img", { class: "thumb", alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
      thumb.src = r.thumbnail;
      thumb.addEventListener("error", () => thumb.replaceWith(el("span", { class: "thumb ph", text: "Reel" })));
    } else thumb = el("span", { class: "thumb ph", text: "Reel" });
    // the preview opens the details panel; the rest of the row selects
    const preview = el("button", {
      type: "button", class: "thumb-btn" + (state.openCode === r.code ? " open" : ""),
      title: t("an_dr_preview_hint"), "aria-label": t("an_dr_preview_hint"),
      // a second click on the open reel's preview closes the panel
      onclick: () => (state.openCode === r.code && !$("drawer").hidden ? closeDetails() : openDetails(r.code)),
    }, [thumb, el("span", { class: "thumb-ov", "aria-hidden": "true", text: t("an_dr_preview_label") })]);
    const pf = r.perf;
    const scoreCls = pf ? pf.tier : "";
    const scoreTip = signalsText(r);
    const caption = el("td", { class: "caption" }, [
      // the list API has no captions any more: show the one fetched for the details panel, if any
      el("a", { href: r.url, target: "_blank", rel: "noopener noreferrer", title: captionOf(r) || r.url, text: captionOf(r) || r.url }),
      r.pinned ? el("span", { class: "pin", text: "📌" }) : null,
    ]);
    const tr = el("tr", { class: "clickable" + (state.selected.has(r.code) ? " sel" : "") + (state.openCode === r.code ? " open" : ""), title: t("an_row_hint") }, [
      el("td", { class: "c-check" }, [cb]),
      el("td", { class: "num muted", text: r.rank ? String(r.rank) : String(i + 1) }),
      el("td", { class: "c-thumb" }, [preview]),
      viewsCell(r),
      el("td", { class: "num" }, [r.score != null ? el("span", {
        class: "score " + scoreCls + (pf && pf.winner ? " winner" : ""), title: scoreTip, text: `${r.score.toFixed(1)}×`,
      }) : null]),
      el("td", { class: "num", text: r.likes != null ? cmp(r.likes) : "–" }),
      el("td", { class: "num", text: r.comments != null ? cmp(r.comments) : "–" }),
      erCell(r),
      el("td", { class: "num", text: r.likeRate != null ? pctFine(r.likeRate) : "–" }),
      el("td", { class: "num", text: r.commentRate != null ? pctFine(r.commentRate) : "–" }),
      erAdjCell(r),
      el("td", { class: "num", title: t("an_tip_vpd"), text: r.vpd != null ? cmp(Math.round(r.vpd)) : "–" }),
      el("td", { class: "muted", title: r.ts ? new Date(r.ts).toLocaleString(LANG) : "", text: r.ts ? dateLong(r.ts) : "" }),
      caption,
      jobStatusCell(r),
    ]);
    // click anywhere else on the row ticks / unticks it (Shift+click: the whole range from the last click)
    // A drag across the row (selecting text in the caption) is not a click. Judge it by how far the
    // pointer moved on THIS row - not by a text selection left somewhere else on the page, which
    // used to block every row click until it was cleared.
    let down = null;
    tr.addEventListener("pointerdown", (ev) => (down = { x: ev.clientX, y: ev.clientY }));
    tr.addEventListener("click", (ev) => {
      if (ev.target.closest("input, button, a, select")) return;
      if (down && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 6) return;
      if (!ev.shiftKey) {
        try {
          window.getSelection().removeAllRanges(); // drop a stale selection so the row looks clean
        } catch (_e) { /* ignore */ }
      }
      const on = !state.selected.has(r.code);
      if (ev.shiftKey && lastClickedCode && lastClickedCode !== r.code) {
        const codes = rows.map((x) => x.code);
        const a = codes.indexOf(lastClickedCode);
        const b = codes.indexOf(r.code);
        if (a >= 0 && b >= 0) {
          for (const c of codes.slice(Math.min(a, b), Math.max(a, b) + 1)) {
            if (on) state.selected.add(c);
            else state.selected.delete(c);
          }
          lastClickedCode = r.code;
          renderTable();
          updateActionBar();
          return;
        }
      }
      cb.checked = on;
      cb.dispatchEvent(new Event("change"));
      lastClickedCode = r.code;
    });
    cb.addEventListener("click", () => (lastClickedCode = r.code));
    body.append(tr);
  });
  if (rows.length > 1) body.prepend(summaryRow(rows));
  renderThresholdInfo(rows.length);
  const all = rows.length > 0 && rows.every((r) => state.selected.has(r.code));
  $("checkAll").checked = all;
}

// ------------------------------------------------------------------ selection + actions
function select(codes, replace) {
  if (replace) state.selected.clear();
  for (const c of codes) state.selected.add(c);
  renderTable();
  updateActionBar();
}

function selectedRows() {
  return state.rows.filter((r) => state.selected.has(r.code));
}

function updateActionBar() {
  const sel = selectedRows();
  $("selCount").textContent = String(sel.length);
  const total = sel.reduce((a, r) => a + (r.views || 0), 0);
  $("selViews").textContent = sel.length ? t("an_sel_views", [cmp(total)]) : "";
  $("downloadSel").disabled = !sel.length || !state.helperOk;
  $("copyLinks").disabled = !sel.length;
  $("copyCaptions").disabled = !sel.length && !captionRun;
  updateCancelAll();
}

/** "Cancel all (5)" while downloads started from this page are queued or running. */
function updateCancelAll() {
  const n = activeJobIds().length;
  $("cancelAll").hidden = !n;
  $("cancelAll").textContent = t("btn_cancel_all", [String(n)]);
}

async function cancelAll() {
  const ids = activeJobIds();
  if (!ids.length) return;
  $("cancelAll").disabled = true;
  const r = await send({ type: "cancelMany", jobIds: ids });
  $("cancelAll").disabled = false;
  if (r.ok) setActionMsg(t("an_cancelled", [String(r.data.cancelled)]), "ok");
  updateCancelAll();
}

async function downloadSelected() {
  const sel = selectedRows();
  if (!sel.length) return;
  const collection = $("collectionInput").value.trim() || `${state.data.username}_reels_${today()}`;
  $("downloadSel").disabled = true;
  setActionMsg(t("an_queueing", [String(sel.length)]));
  const items = sel.sort((a, b) => (b.views || 0) - (a.views || 0)).map((r) => ({
    url: r.url, code: r.code, views: r.views, title: (r.caption || "").split("\n")[0].slice(0, 120) || `@${state.data.username} ${r.code}`,
  }));
  const res = await send({ type: "downloadSelected", platform: "instagram", items, collection });
  updateActionBar();
  if (!res.ok) {
    setActionMsg(res.error.message, "err");
    return;
  }
  for (const j of res.data.jobs) state.jobs.set(j.code, j.jobId);
  setActionMsg(t("an_queued", [String(res.data.jobs.length), `MediaDownloader/Instagram/${res.data.folder}`]), "ok");
  renderTable();
}

/**
 * Copy the descriptions of the selected reels in one go. Cached descriptions are used at once;
 * the missing ones come from ONE helper call (one gallery-dl setup, 1-2 s between Instagram
 * requests, stops at the first rate-limit answer). Clicking the button again stops it. The
 * result is copied and also shown in a dialog (copy / save as .txt).
 */
let captionRun = null; // {stop: boolean} while fetching

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "detailsProgress" && captionRun) {
    setActionMsg(t("an_cap_loading", [String(msg.done), String(msg.total)]));
  }
});

async function copyCaptions() {
  if (captionRun) {
    captionRun.stop = true;
    send({ type: "cancelDetails" });
    return;
  }
  const sel = selectedRows();
  if (!sel.length) return;
  // same order as the table shows them (selected reels outside the current filter go last, by views)
  const order = new Map(visibleRows().map((r, i) => [r.code, i]));
  sel.sort((a, b) => (order.has(a.code) ? order.get(a.code) : 1e6 - (a.views || 0) / 1e9)
    - (order.has(b.code) ? order.get(b.code) : 1e6 - (b.views || 0) / 1e9));
  const missing = sel.filter((r) => !captionOf(r) && !((details.get(r.code) || {}).data));
  const btn = $("copyCaptions");
  const run = (captionRun = { stop: false });
  btn.textContent = t("an_cap_stop");
  let failed = 0;
  let stoppedBy = "";
  if (missing.length) {
    setActionMsg(t("an_cap_loading", ["0", String(missing.length)]));
    const res = await send({ type: "reelDetailsMany", codes: missing.map((r) => r.code) });
    if (res.ok) {
      for (const [code, data] of Object.entries(res.data.items || {})) details.set(code, { data, at: Date.now() });
      failed = Object.keys(res.data.errors || {}).length;
      const why = res.data.stopped || "";
      if (why === "CANCELLED" || run.stop) stoppedBy = "user";
      else if (/RATE_LIMITED|LOGIN_REQUIRED/.test(why)) stoppedBy = "instagram";
    } else {
      failed = missing.length;
      const e = res.error || {};
      if (run.stop || e.code === "CANCELLED") stoppedBy = "user";
      else if (/RATE_LIMITED|LOGIN_REQUIRED/.test(e.code || "") || /rate limit|429/i.test(e.message || "")) stoppedBy = "instagram";
      else setActionMsg(e.message || t("err_UNKNOWN"), "err");
    }
  }
  captionRun = null;
  btn.textContent = t("an_copy_captions");
  renderTable(); // the caption column shows what was loaded

  const blocks = [];
  let without = 0;
  for (const r of sel) {
    const cap = captionOf(r);
    if (!cap) without++;
    const head = [
      r.rank ? `#${r.rank}` : "",
      r.views != null ? t("an_cap_views", [cmp(r.views)]) : "",
      r.ts ? dateLong(r.ts) : "",
    ].filter(Boolean).join(" · ");
    blocks.push(`${head}\n${r.url}\n\n${cap || t("an_cap_none")}`);
  }
  const text = blocks.join("\n\n────────────────────\n\n");
  const note = [t("an_cap_count", [String(sel.length - without), String(sel.length)])];
  if (stoppedBy === "instagram") note.push(t("an_cap_stopped_ig"));
  else if (stoppedBy === "user") note.push(t("an_cap_stopped_user"));
  else if (failed) note.push(t("an_cap_failed", [String(failed)]));

  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch (_e) { /* the dialog below still lets the user copy or save it */ }
  setActionMsg((copied ? t("an_cap_copied", [String(sel.length - without)]) + " " : "") + note.slice(1).join(" "), copied && !stoppedBy ? "ok" : "");
  showCaptionDialog(text, note.join(" "), copied);
}

function showCaptionDialog(text, note, copied) {
  $("capTitle").textContent = t("an_cap_title");
  $("capNote").textContent = (copied ? t("an_cap_copied_short") + " " : "") + note;
  $("capText").value = text;
  const dlg = $("capDialog");
  if (!dlg.open) dlg.showModal();
  $("capText").scrollTop = 0;
}

function saveCaptionsTxt() {
  const blob = new Blob([$("capText").value], { type: "text/plain;charset=utf-8" });
  const a = el("a", { href: URL.createObjectURL(blob), download: `${(state.data && state.data.username) || "reels"}_descriptions_${today()}.txt` });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

async function copyLinks() {
  const sel = selectedRows().sort((a, b) => (b.views || 0) - (a.views || 0));
  const text = sel.map((r) => `${r.url}\t${r.views ?? ""}`).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    setActionMsg(t("an_copied", [String(sel.length)]), "ok");
  } catch (_e) {
    setActionMsg(t("err_UNKNOWN"), "err");
  }
}

// keep job statuses in the table up to date
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.jobs) return;
  const jobs = changes.jobs.newValue || [];
  let touched = false;
  const ids = new Set(state.jobs.values());
  for (const j of jobs) {
    if (ids.has(j.id)) {
      state.jobById.set(j.id, j);
      touched = true;
    }
  }
  if (touched) {
    renderTable();
    updateCancelAll();
  }
});

// ------------------------------------------------------------------ init
document.addEventListener("DOMContentLoaded", async () => {
  i18nize();
  for (const opt of document.querySelectorAll("option[data-i18n]")) opt.textContent = t(opt.dataset.i18n);
  $("fetchForm").addEventListener("submit", analyze);
  $("enableCookies").addEventListener("click", enableCookies);
  $("scaleLinear").addEventListener("click", () => {
    state.scale = "linear";
    state.filter = null;
    $("scaleLinear").classList.add("on");
    $("scaleLog").classList.remove("on");
    $("clampOutliers").disabled = false;
    renderChart();
    renderActivityChart();
    renderTable();
  });
  $("scaleLog").addEventListener("click", () => {
    state.scale = "log";
    state.filter = null;
    $("scaleLog").classList.add("on");
    $("scaleLinear").classList.remove("on");
    $("clampOutliers").disabled = true;
    renderChart();
    renderActivityChart();
    renderTable();
  });
  $("clampOutliers").addEventListener("change", () => {
    state.groupOutliers = $("clampOutliers").checked;
    state.filter = null;
    renderChart();
    renderActivityChart();
    renderTable();
  });
  $("thresholdSelect").addEventListener("change", () => {
    state.threshold = $("thresholdSelect").value;
    renderTable();
    if (state.threshold === "custom") $("customInput").focus();
  });
  $("customInput").addEventListener("input", () => {
    state.custom = $("customInput").value;
    renderTable();
  });
  $("sortSelect").addEventListener("change", () => {
    state.sort = $("sortSelect").value;
    renderTable();
  });
  $("clearFilter").addEventListener("click", () => {
    state.filter = null;
    renderChart();
    renderActivityChart();
    renderTable();
  });
  // date range brush: live visuals while dragging, recompute shortly after it stops
  initBrush();
  $("rbReset").addEventListener("click", () => setRangeDays(0, state.rangeDays.n));
  let rbResize = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(rbResize);
    rbResize = requestAnimationFrame(drawRangeStrip);
  }).observe($("rbStrip"));
  for (const b of $("intervalSeg").children) {
    b.textContent = t(`an_int_${b.dataset.days}`);
    b.addEventListener("click", () => {
      state.interval = Number(b.dataset.days);
      if (state.filter && state.filter.kind === "date") state.filter = null; // old buckets no longer exist
      renderActivity();
      renderTable();
    });
  }
  for (const b of $("heatSeg").children) {
    b.textContent = t(`an_heat_${b.dataset.mode}`);
    b.classList.toggle("on", b.dataset.mode === state.heatMode);
  }
  $("csvBtn").addEventListener("click", exportCsv);
  $("csvFormat").value = csvFormat();
  $("csvFormat").title = t("an_csv_format_tip");
  $("csvFormat").addEventListener("change", () => {
    try {
      localStorage.setItem("csvFormat", $("csvFormat").value);
    } catch (_e) { /* not remembered */ }
  });
  $("csvBtn").title = t("an_csv_tip");
  $("heatSeg").addEventListener("click", (e) => {
    const b = e.target.closest("[data-mode]");
    if (!b) return;
    state.heatMode = b.dataset.mode;
    for (const x of $("heatSeg").children) x.classList.toggle("on", x === b);
    if (state.activity && state.activity.n >= 2) renderHeatmap();
  });
  for (const b of $("viewsLineSeg").children) {
    b.textContent = t(`an_line_${b.dataset.line}`);
    b.classList.toggle("on", b.dataset.line === state.viewsLine);
  }
  $("viewsLineSeg").addEventListener("click", (e) => {
    const b = e.target.closest("[data-line]");
    if (!b) return;
    state.viewsLine = b.dataset.line;
    for (const x of $("viewsLineSeg").children) x.classList.toggle("on", x === b);
    renderActivityChart();
  });
  $("checkAll").addEventListener("change", () => {
    const rows = visibleRows();
    if ($("checkAll").checked) rows.forEach((r) => state.selected.add(r.code));
    else rows.forEach((r) => state.selected.delete(r.code));
    renderTable();
    updateActionBar();
  });
  $("selViral").addEventListener("click", () => select(state.rows.filter(TIER_FILTERS.viral).map((r) => r.code), true));
  $("selWinner").addEventListener("click", () => select(state.rows.filter(TIER_FILTERS.winner).map((r) => r.code), true));
  $("selHot").addEventListener("click", () => {
    const recent = state.rows.filter((r) => r.vpd != null && r.ts > state.now - 30 * St.DAY);
    const pool = recent.length ? recent : state.rows.filter((r) => r.vpd != null);
    select(pool.sort((a, b) => b.vpd - a.vpd).slice(0, 10).map((r) => r.code), true);
  });
  $("selShown").addEventListener("click", () => select(visibleRows().map((r) => r.code), false));
  $("selNone").addEventListener("click", () => select([], true));
  $("downloadSel").addEventListener("click", downloadSelected);
  $("copyLinks").addEventListener("click", copyLinks);
  $("cancelAll").addEventListener("click", cancelAll);
  $("copyCaptions").addEventListener("click", copyCaptions);
  $("capClose").addEventListener("click", () => $("capDialog").close());
  $("capSave").addEventListener("click", saveCaptionsTxt);
  $("capCopy").addEventListener("click", () => copyText($("capText").value, "an_cap_copied_short"));
  // details panel: buttons + keyboard (Esc closes, ← → move through the table's order)
  $("drClose").addEventListener("click", closeDetails);
  trackActionBarHeight();
  initDrawerResize();
  initDrawerOutsideClose();
  $("drPrev").addEventListener("click", () => stepDetails(-1));
  $("drNext").addEventListener("click", () => stepDetails(1));
  document.addEventListener("keydown", (e) => {
    if (!state.openCode || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target.closest && e.target.closest("input, select, textarea, [role=slider]")) return;
    if (e.key === "Escape") closeDetails();
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") stepDetails(-1);
    else if (e.key === "ArrowRight" || e.key === "ArrowDown") stepDetails(1);
    else return;
    e.preventDefault();
  });
  await loadDetailsCache();

  const u = new URLSearchParams(location.search).get("u");
  if (u) {
    $("profileInput").value = u;
    const cached = await loadCache(u);
    if (cached) load(cached.data, cached.at); // instant, no request to Instagram
  }
  await loadSettings();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) loadSettings();
  });
  refreshHelper();
});
