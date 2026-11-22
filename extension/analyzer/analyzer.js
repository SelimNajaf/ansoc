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
  scale: "log",
  groupOutliers: true,
  filter: null, // {kind: "views" | "date", from, to}
  interval: null, // activity chart bucket size in days (null = automatic)
  viewsLine: "total", // activity chart line: "median" | "total" | "off"
  activity: null, // PD.stats.postingStats result
  // table: ordered filter steps [{key, min, max} | {tier}], then the sort ({key, dir}; null = automatic)
  filters: [],
  sort: null,
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
    else if (k === "text") n.append(document.createTextNode(v));
    else if (k === "data-ico") n.prepend(PD.icon(v), " ");
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
  for (const n of document.querySelectorAll("[data-i18n]")) {
    const v = t(n.dataset.i18n);
    if (v !== n.dataset.i18n || !n.textContent.trim()) n.textContent = v; // a missing message keeps the HTML text
  }
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
  const per = PERIODS[$("periodSelect").value] || PERIODS["count:120"];
  // slots for the live strip: the count asked for, else the store's post count (more are added if needed)
  const slots = per.sinceDays || $("periodSelect").value === "all" ? Math.min(500, state.previewPosts || 120) : per.limit;
  loaderStart(profile, slots);
  const res = await send({ type: "listReels", profile, limit: per.limit, sinceDays: per.sinceDays });
  $("fetchBtn").disabled = false;
  loaderStop();
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

// ------------------------------------------------------------------ loading view
// One slot per reel asked for. Every reel the helper reports fills the next slot with a bar:
// height = its views (log scale against the biggest so far), gold = a hit (3x the running median).
// So the strip is the progress bar and a first look at the profile at the same time.
const loader = { slots: [], views: [], shown: 0, target: 0, t0: 0, timer: 0, raf: 0, step: "" };

function loaderStart(profile, limit) {
  const L = loader;
  L.views = [];
  L.shown = 0;
  L.target = 0;
  L.t0 = Date.now();
  const strip = $("ldStrip");
  strip.replaceChildren();
  L.slots = Array.from({ length: Math.max(1, Math.min(500, limit || 120)) }, () => {
    const s = el("div", { class: "ld-slot" });
    strip.append(s);
    return s;
  });
  $("ldCount").textContent = "0";
  $("ldProfile").replaceChildren(document.createTextNode("@" + profile.replace(/^.*instagram\.com\//, "").replace(/[/?#].*$/, "").replace(/^@/, "")));
  $("progressText").textContent = "";
  loaderStep("connect");
  $("ldTime").textContent = "0:00";
  clearInterval(L.timer);
  L.timer = setInterval(() => {
    const sec = Math.floor((Date.now() - L.t0) / 1000);
    $("ldTime").textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  }, 1000);
  $("progressBox").hidden = false;
}

function loaderStop() {
  clearInterval(loader.timer);
  cancelAnimationFrame(loader.raf);
  $("progressBox").hidden = true;
}

function loaderStep(step) {
  if (loader.step === step) return;
  loader.step = step;
  const order = ["connect", "reels", "details"];
  const at = order.indexOf(step);
  for (const li of $("ldSteps").children) {
    const i = order.indexOf(li.dataset.step);
    li.classList.toggle("on", i === at);
    li.classList.toggle("done", i < at);
  }
  // reading is over: drop the empty slots so the strip shows only the reels that exist
  if (step === "details") for (const s of loader.slots.slice(loader.views.length)) s.classList.add("gone");
}

/** The count rolls up to the target instead of jumping (reels arrive 12 at a time). */
function loaderCount(n) {
  const L = loader;
  L.target = n;
  if (L.raf) return;
  const tick = () => {
    L.shown += Math.max(1, Math.ceil((L.target - L.shown) / 6));
    if (L.shown > L.target) L.shown = L.target;
    $("ldCount").textContent = String(L.shown);
    L.raf = L.shown < L.target ? requestAnimationFrame(tick) : 0;
  };
  L.raf = requestAnimationFrame(tick);
}

function loaderAdd(n, views) {
  const L = loader;
  while (L.views.length < n) L.views.push(L.views.length === n - 1 ? views : null);
  const known = L.views.filter((v) => v != null && v >= 0);
  const max = Math.max(1, ...known);
  const lo = Math.log10(max / 1000);
  const span = Math.log10(max) - lo || 1;
  const med = median(known);
  while (L.slots.length < L.views.length && L.slots.length < 500) {
    const extra = el("div", { class: "ld-slot" });
    $("ldStrip").append(extra);
    L.slots.push(extra);
  }
  L.views.forEach((v, i) => {
    const s = L.slots[i];
    if (!s) return;
    s.classList.add("in");
    if (v == null || v < 0) {
      s.classList.add("unk");
      s.style.height = "18%";
      return;
    }
    const h = Math.max(0.06, Math.min(1, (Math.log10(Math.max(v, 1)) - lo) / span));
    s.style.height = `${Math.round(h * 100)}%`;
    s.classList.toggle("hit", known.length >= 6 && med > 0 && v >= 3 * med);
  });
  loaderCount(n);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "reelsProgress" || $("progressBox").hidden) return;
  const text = msg.text || "";
  let m;
  if (text.startsWith("stage:connect")) loaderStep("connect");
  else if ((m = /^profile:([^:]*):(\d*)/.exec(text))) {
    const box = $("ldProfile");
    box.replaceChildren(document.createTextNode("@" + m[1]));
    if (m[2]) box.append(el("span", { class: "muted", text: t("an_ld_followers", [cmp(Number(m[2]))]) }));
    loaderStep("reels");
    $("progressText").textContent = t("an_ld_hint");
  } else if ((m = /^reels:(\d+)(?::(-?\d+))?/.exec(text))) {
    loaderStep("reels");
    if (!$("progressText").textContent) $("progressText").textContent = t("an_ld_hint");
    loaderAdd(Number(m[1]), m[2] == null ? null : Number(m[2]));
  } else if ((m = /^details:(\d+)\/(\d+)/.exec(text))) {
    loaderStep("details");
    $("progressText").textContent = t("an_fetching_details", [m[1], m[2]]);
  }
});

// ------------------------------------------------------------------ data model
// ------------------------------------------------------------------ profile preview + what to read
/*
 * Before analysing: one quick request shows the store (followers, posts, bio, link, category),
 * so the period / count can be chosen knowingly. "Last N days" reads newest -> oldest and stops
 * at that date (the seasons are then shown on the Time range).
 */
const PERIODS = {
  "since:30": { sinceDays: 30, limit: 500 },
  "since:60": { sinceDays: 60, limit: 500 },
  "since:90": { sinceDays: 90, limit: 500 },
  "since:180": { sinceDays: 180, limit: 500 },
  all: { limit: 500 },
  "count:60": { limit: 60 },
  "count:120": { limit: 120 },
  "count:240": { limit: 240 },
};
function initPeriodSelect() {
  const sel = $("periodSelect");
  for (const o of sel.querySelectorAll("option[data-n]")) o.textContent = t("an_p_newest", [o.dataset.n]);
  for (const g of sel.querySelectorAll("optgroup[data-label]")) g.label = t(g.dataset.label);
  try {
    const saved = localStorage.getItem("period");
    if (saved && PERIODS[saved]) sel.value = saved;
  } catch (_e) { /* default */ }
  sel.addEventListener("change", () => {
    try {
      localStorage.setItem("period", sel.value);
    } catch (_e) { /* not remembered */ }
  });
}
const profileName = (v) => String(v || "").trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").split(/[/?#]/)[0].toLowerCase();
let previewFor = "";
let previewTimer = 0;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => loadPreview(profileName($("profileInput").value)), 900);
}
async function loadPreview(name) {
  if (!/^[a-z0-9._]{2,30}$/.test(name) || name === previewFor) return;
  previewFor = name;
  const box = $("profilePreview");
  box.hidden = false;
  box.classList.add("loading");
  $("ppName").textContent = "@" + name;
  $("ppStats").replaceChildren(el("span", { class: "muted", text: t("an_pp_loading") }));
  $("ppBio").textContent = "";
  $("ppLinks").replaceChildren();
  $("ppCat").hidden = true;
  const res = await send({ type: "profileInfo", profile: name });
  if (previewFor !== name) return; // the user typed another name meanwhile
  box.classList.remove("loading");
  if (!res.ok) {
    $("ppStats").replaceChildren(el("span", { class: "muted", text: res.error.message || t("err_UNKNOWN") }));
    return;
  }
  renderPreview(res.data);
}
function profileStats(p) {
  const chip = (icon, v, key) => (v == null ? null : el("span", { class: "pp-stat", title: t(key + "_tip") }, [
    el("span", { class: "pp-i" }, [PD.icon(icon)]), el("strong", { text: cmp(v) }), el("span", { class: "muted", text: " " + t(key) }),
  ]));
  return [chip("users", p.followers, "an_pp_followers"), chip("film", p.posts, "an_pp_posts"), chip("user-plus", p.following, "an_pp_following")].filter(Boolean);
}
function renderPreview(p) {
  $("ppName").textContent = `@${p.username}${p.is_verified ? " ✓" : ""}${p.full_name ? " · " + p.full_name : ""}`;
  $("ppStats").replaceChildren(...profileStats(p));
  $("ppCat").hidden = !p.category;
  $("ppCat").textContent = p.category || "";
  $("ppBio").textContent = p.biography || "";
  $("ppLinks").replaceChildren(...(p.links || []).map((u) => el("a", { href: u, target: "_blank", rel: "noopener noreferrer", "data-ico": "link", text: u.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60) })));
  if (p.is_private) $("ppStats").append(el("span", { class: "pp-stat bad" }, [PD.icon("lock"), document.createTextNode(" " + t("an_pp_private"))]));
  // a count choice bigger than the store makes no sense: hint at it
  $("ppHint").textContent = p.posts != null ? t("an_pp_hint", [cmp(p.posts)]) : "";
  state.previewPosts = p.posts;
}
/** One line on the results card: which part of the store was read. */
function periodText(d) {
  const per = d.period || {};
  const ts = (d.reels || []).filter((r) => !r.pinned).map((r) => (r.taken_at ? Date.parse(r.taken_at) || 0 : 0) || St.codeTime(r.code)).filter((x) => x > 0);
  const from = ts.length ? dateShort(Math.min(...ts), true) : "";
  if (d.stopped_by === "date") return t("an_per_since", [String(per.since_days), from]);
  if (d.stopped_by === "limit") return t("an_per_limit", [String(d.count)]);
  if (d.stopped_by === "end") return t("an_per_all", [String(d.count)]);
  return "";
}

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
  // a new profile starts with the reels above the average views (a relative pick: it follows the date range)
  state.filters = [{ key: "views", min: -Infinity, max: Infinity, preset: "avg" }];
  state.sort = null;
  closeFilterPop();
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
  const whole = St.success(state.allRows);
  state.allRows.forEach((r, i) => (r.wholeHit = !!whole.items[i] && whole.items[i].tier === "hit"));
  // pinned reels sit on top whatever their age: they don't shape the seasons (same as the helper)
  state.periods = St.activePeriods(state.allRows.filter((r) => !r.pinned).map((r) => r.ts));
  state.range = null; // {from, to} in ms (local day boundaries); null = everything
  $("collectionInput").value = `${data.username}_reels_${today()}`;
  $("results").hidden = false;
  $("profilePreview").hidden = true; // the results card below shows the profile
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
  // the brain: success score of every reel, judged against the reels of this range
  state.success = St.success(state.rows);
  state.rows.forEach((r, i) => {
    r.success = state.success.items[i];
    r.successScore = r.success ? r.success.score : null;
  });
  state.activity = St.postingStats(state.rows.map((r) => r.ts), state.windowEnd);
  state.interval = null; // pick a readable interval for this range again
  const rank = state.rows.filter((r) => r.views != null).sort((a, b) => b.views - a.views);
  rank.forEach((r, i) => (r.rank = i + 1));
  updateRangeLabel();
  renderCards();
  renderChart();
  renderActivity();
  renderPlan();
  renderTop();
  renderTable();
  updateActionBar();
}

// ------------------------------------------------------------------ "What to do": the verdicts first
/**
 * A short action plan built from the same brains as the charts below (success score, timing,
 * posting rhythm). Each item: what to do, the evidence, and a click that shows the proof.
 */
function renderPlan() {
  const box = $("planGrid");
  box.replaceChildren();
  const items = [];
  const add = (o) => items.push(o);
  const goWW = (dim) => () => {
    state.wwDim = dim;
    if (!$("activityCard").hidden) {
      renderWhatWorks();
      $("wwChart").scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };
  const w = state.wwTime && state.wwTime.best;
  if (w) {
    add({ icon: "clock", tone: w.lift >= 1.05 ? "good" : "", head: t("pl_time", [windowLabel(w)]),
      sub: t("pl_time_sub", [PD.effectsUI.fmt(w.lift), String(w.n)]), conf: w.confidence, click: goWW("window") });
  }
  const dd = state.wwDay;
  if (dd) {
    add({ icon: "repeat", tone: "good", head: t("pl_per_day", [String(dd.ideal.n)]),
      sub: t("pl_per_day_sub", [dd.ideal.perDay.toFixed(1), String(dd.days)]), conf: dd.confidence, click: goWW("perDay") });
  }
  const gap = state.wwEffects && PD.stats.bestEffect(state.wwEffects.gap || []);
  if (gap) {
    add({ icon: "timer", tone: gap.ratio >= 1.05 ? "good" : "", head: t("pl_gap", [gap.group]),
      sub: t("pl_gap_sub", [PD.effectsUI.fmt(gap.ratio), String(gap.n)]), click: goWW("gap") });
  }
  const hits = state.rows.filter((r) => r.success && r.success.tier === "hit");
  if (state.rows.length >= 5) {
    const share = hits.length / state.rows.length;
    add({ icon: "target", tone: hits.length ? "hit" : "bad", head: t(hits.length ? "pl_hits" : "pl_no_hits", [String(hits.length)]),
      sub: t("pl_hits_sub", [pct(share), String(state.rows.length)]), click: hits.length ? () => showInTable("hit") : null });
  }
  const a = state.activity;
  if (a && a.trendComparable && a.prev30 != null) {
    const ch = a.prev30 ? a.last30 / a.prev30 - 1 : 1;
    if (Math.abs(ch) >= 0.25) {
      add({ icon: ch > 0 ? "trending-up" : "trending-down", tone: ch > 0 ? "good" : "bad",
        head: t(ch > 0 ? "pl_trend_up" : "pl_trend_down", [String(Math.round(Math.abs(ch) * 100))]),
        sub: t("pl_trend_sub", [String(a.last30), String(a.prev30)]), click: () => $("activityCard").scrollIntoView({ behavior: "smooth", block: "start" }) });
    }
  }
  if (a && a.sinceLastDays >= 14) {
    add({ icon: "moon", tone: "bad", head: t("pl_quiet", [String(Math.floor(a.sinceLastDays))]), sub: t("pl_quiet_sub") });
  }
  $("planCard").hidden = !items.length;
  for (const it of items) {
    const conf = it.conf ? el("span", { class: `fx-conf ${it.conf}`, title: t(`fx_conf_${it.conf}`),
      text: it.conf === "clear" ? "●●●" : it.conf === "likely" ? "●●○" : "●○○" }) : null;
    const node = el(it.click ? "button" : "div", { class: "plan-item " + (it.tone || ""), type: it.click ? "button" : null }, [
      el("span", { class: "plan-ic" }, [PD.icon(it.icon)]),
      el("span", { class: "plan-txt" }, [el("strong", { text: it.head }), el("span", { class: "plan-sub" }, [document.createTextNode(it.sub + " "), conf])]),
      it.click ? el("span", { class: "plan-go" }, [PD.icon("arrow-right")]) : null,
    ]);
    if (it.click) node.addEventListener("click", it.click);
    box.append(node);
  }
}

// ------------------------------------------------------------------ top reels gallery
/** The best reels of the range (success score, then views): thumbnail, score, views. Click = details. */
function renderTop() {
  const rows = state.rows.filter((r) => r.successScore != null || r.views != null)
    .sort((x, y) => (y.successScore ?? -1) - (x.successScore ?? -1) || (y.views ?? 0) - (x.views ?? 0)).slice(0, 8);
  $("topCard").hidden = rows.length < 3;
  const grid = $("topGrid");
  grid.replaceChildren();
  $("topSub").textContent = t("top_sub", [String(state.rows.length)]);
  for (const r of rows) {
    let img;
    if (r.thumbnail && /^https:\/\/[^/]*(cdninstagram\.com|fbcdn\.net)\//.test(r.thumbnail)) {
      img = el("img", { class: "top-img", alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
      img.src = r.thumbnail;
      img.addEventListener("error", () => img.replaceWith(el("span", { class: "top-img ph" }, [PD.icon("film")])));
    } else img = el("span", { class: "top-img ph" }, [PD.icon("film")]);
    const s = r.success || {};
    const tier = s.tier || "";
    grid.append(el("button", { type: "button", class: "top-item " + tier, title: (captionOf(r) || r.code).split("\n")[0].slice(0, 120), onclick: () => openDetails(r.code) }, [
      el("span", { class: "top-media" }, [img,
        s.score != null ? el("i", { class: "succ " + tier, style: `--p:${s.score}` }, [tier === "hit" ? el("span", { class: "succ-i" }, [PD.icon("target")]) : null, el("span", { text: String(s.score) })]) : null]),
      el("span", { class: "top-meta" }, [
        el("strong", { text: r.views != null ? cmp(r.views) : "–" }), el("span", { class: "muted", text: " " + t("top_views") }),
      ]),
      el("span", { class: "top-date muted", text: r.ts ? dateShort(r.ts) : "" }),
    ]));
  }
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

  // hits (success score >= 80): a thin gold tick each on the baseline (grey outside the selection)
  for (const r of state.allRows) {
    if (!r.wholeHit || !r.ts) continue;
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
  $("profileExtra").replaceChildren(...[...profileStats(p),
    p.category ? el("span", { class: "chip pp-cat", text: p.category }) : null,
    ...(p.links || []).slice(0, 2).map((u) => el("a", { class: "pp-link", href: u, target: "_blank", rel: "noopener noreferrer", "data-ico": "link", text: u.replace(/^https?:\/\/(www\.)?/, "").slice(0, 40) }))].filter(Boolean));
  $("profileBio").textContent = p.biography || "";
  $("profileBio").hidden = !p.biography;
  const notes = [periodText(d)].filter(Boolean);
  if (d.truncated && d.stopped_by !== "limit") notes.push(t("an_note_truncated", [String(d.count)]));
  if (d.missing_views) notes.push(t("an_note_missing", [String(d.missing_views)]));
  $("profileNote").textContent = notes.join(" ");
}

/** Top KPIs in two groups: views (with a spread bar) and engagement (with a likes : comments bar). */
function renderCards() {
  const s = state.stats;
  const box = $("cards");
  box.replaceChildren();
  if (!s.n) {
    box.append(el("div", { class: "kpi" }, [el("div", { class: "k", text: t("an_no_views") })]));
    return;
  }
  const kpi = (k, v, sub, opts) => {
    opts = opts || {};
    return el("div", { class: "kpi" + (opts.cls ? " " + opts.cls : ""), title: opts.title || "" }, [
      el("div", { class: "k", text: k }), el("div", { class: "v", text: v }),
      sub ? el("div", { class: "s", text: sub }) : null, opts.extra || null,
    ]);
  };
  const group = (icon, title, nodes, cls) => el("div", { class: "kgroup " + cls }, [
    el("div", { class: "kg-head" }, [el("span", { class: "kg-i" }, [PD.icon(icon)]), el("span", { text: title })]),
    el("div", { class: "kg-grid" }, nodes),
  ]);
  const views = [
    kpi(t("an_stat_total"), cmp(s.sum), t("an_stat_reels", [String(s.n)]), { cls: "hero" }),
    kpi(t("an_median"), cmp(s.median), fmt(Math.round(s.median)), { title: t("an_tip_median") }),
    kpi(t("an_mean"), cmp(s.mean), fmt(Math.round(s.mean)), { title: t("an_tip_mean") }),
    kpi("P90", cmp(s.p90), t("an_stat_p90_sub"), { title: t("an_tip_p90") }),
    spreadKpi(s),
  ];
  const eng = [];
  const ers = state.rows.map((r) => r.er).filter((x) => x != null).sort((a, b) => a - b);
  if (ers.length) eng.push(kpi(t("an_stat_er"), pct(St.quantile(ers, 0.5)), t("an_stat_er_sub"), { cls: "hero", title: t("an_tip_er") }));
  // profile-wide sums, so big reels weigh in proportionally
  const mix = state.rows.filter((r) => r.views && r.likes != null && r.comments != null);
  const sumL = mix.reduce((a, r) => a + r.likes, 0);
  const sumC = mix.reduce((a, r) => a + r.comments, 0);
  if (sumL + sumC > 0) {
    const sumV = mix.reduce((a, r) => a + r.views, 0);
    const likeShare = sumL / (sumL + sumC);
    eng.push(kpi(t("an_col_likeRate"), pctFine(sumL / sumV), t("an_stat_rates_sub"), { title: t("an_tip_rates") }));
    eng.push(kpi(t("an_col_commentRate"), pctFine(sumC / sumV), t("an_stat_rates_sub"), { title: t("an_tip_rates") }));
    eng.push(kpi(t("an_stat_mix"), sumC ? `${Math.round(sumL / sumC)} : 1` : "–", t("an_kpi_mix_sub"), {
      title: t("an_tip_mix"),
      extra: el("div", { class: "mixbar" }, [
        el("i", { class: "l", style: `width:${(likeShare * 100).toFixed(1)}%` }),
        el("i", { class: "c", style: `width:${Math.max(2, (1 - likeShare) * 100).toFixed(1)}%` }),
      ]),
    }));
  }
  box.append(group("eye", t("an_kg_views"), views, "kg-views"));
  if (eng.length) box.append(group("message", t("an_kg_eng"), eng, "kg-eng"));
}

/** "Typical" tile with a spread bar on a log scale: min - max line, P25-P75 box, median tick, P90 dot. */
function spreadKpi(s) {
  const lo = Math.log10(Math.max(1, s.min));
  const hi = Math.log10(Math.max(1, s.max));
  const x = (v) => (((Math.log10(Math.max(1, v)) - lo) / (hi - lo || 1)) * 100).toFixed(1);
  const bar = el("div", { class: "spread" }, [
    el("i", { class: "sp-line" }),
    el("i", { class: "sp-box", style: `left:${x(s.p25)}%;width:${(x(s.p75) - x(s.p25)).toFixed(1)}%` }),
    el("i", { class: "sp-med", style: `left:${x(s.median)}%`, title: `${t("an_median")} ${cmp(s.median)}` }),
    el("i", { class: "sp-p90", style: `left:${x(s.p90)}%`, title: `P90 ${cmp(s.p90)}` }),
  ]);
  return el("div", { class: "kpi wide", title: t("an_tip_typical") }, [
    el("div", { class: "k", text: t("an_stat_typical") }),
    el("div", { class: "v", text: `${cmp(s.p25)} – ${cmp(s.p75)}` }),
    bar,
    el("div", { class: "sp-ends" }, [el("span", { text: cmp(s.min) }), el("span", { text: cmp(s.max) })]),
  ]);
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
  // typical range (middle 50% of the reels) as a soft band behind the bars
  const tx0 = xOf(s.p25, bins, m.l, bw);
  const tx1 = xOf(s.p75, bins, m.l, bw);
  const band = svg("rect", { class: "typ-band", x: tx0, y: m.t, width: Math.max(2, tx1 - tx0), height: ph, rx: 6 });
  band.append(svg("title", {}, t("an_tip_typical")));
  root.append(band);

  // bars
  const labelEvery = Math.ceil(bins.length / 14);
  bins.forEach((b, i) => {
    const h = (b.count / yMax) * ph;
    const x = m.l + i * bw + 2;
    const y = m.t + ph - h;
    const active = !state.filter || state.filter.kind !== "views" || (state.filter.from === b.from && state.filter.to === b.to);
    const rect = svg("rect", {
      class: "bin" + (active ? "" : " dim"),
      x, y, width: Math.max(1, bw - 4), height: Math.max(b.count ? 2 : 0, h),
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
    // the hits (success >= 80) among the reels of this bin, in gold at the bottom of the bar
    const nHit = state.rows.filter((r) => r.views != null && r.views >= b.from && (r.views < b.to || i === bins.length - 1) && TIER_FILTERS.hit(r)).length;
    if (nHit) {
      const hh = Math.max(2, (nHit / yMax) * ph);
      const hr = svg("rect", { class: "abin-hit", x, y: m.t + ph - hh, width: Math.max(1, bw - 4), height: hh, rx: 3 });
      hr.append(svg("title", {}, `${t("an_act_tip_hit", [String(nHit)])}`));
      root.append(hr);
    }
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

  // mean & median lines
  const lines = [["median", s.median, `${t("an_median")} ${cmp(s.median)}`], ["mean", s.mean, `${t("an_mean")} ${cmp(s.mean)}`]];

  for (const [cls, value, label] of lines) {
    const x = xOf(value, bins, m.l, bw);
    root.append(svg("line", { class: `vline ${cls}`, x1: x, x2: x, y1: m.t - 6, y2: m.t + ph }));
    const anchor = x > W - 170 ? "end" : "start";
    const ly = cls === "mean" ? m.t - 10 : cls === "viral" ? m.t + 18 : m.t + 4;
    const text = svg("text", { class: `vlabel ${cls}`, x: x + (anchor === "end" ? -4 : 4), y: ly, "text-anchor": anchor }, label);
    root.append(text);
  }
  wrap.append(root);
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
  renderWhatWorks();
}

/** Posting KPIs: pace, last 30 days vs the 30 before, gaps, last post, hot reel (click = open it). */
function renderActivityCards() {
  const a = state.activity;
  const box = $("activityCards");
  box.replaceChildren();
  const kpi = (icon, k, v, sub, opts) => {
    opts = opts || {};
    const node = el(opts.onClick ? "button" : "div", {
      class: "kpi" + (opts.cls ? " " + opts.cls : ""), title: opts.title || "", type: opts.onClick ? "button" : "",
    }, [
      el("div", { class: "k" }, [el("span", { class: "k-i" }, [PD.icon(icon)]), el("span", { text: k })]),
      el("div", { class: "v", text: v }), sub ? el("div", { class: "s" + (opts.subCls ? " " + opts.subCls : ""), text: sub }) : null,
    ]);
    if (opts.onClick) node.addEventListener("click", opts.onClick);
    box.append(node);
  };
  kpi("calendar", t("an_act_per1"), rate(a.perDay), t("an_kpi_pace_sub", [rate(a.per7), rate(a.per30)]), { cls: "hero" });
  if (a.trendComparable && a.prev30 != null) {
    const ch = a.prev30 ? a.last30 / a.prev30 - 1 : 1;
    const tone = ch >= 0.25 ? "up" : ch <= -0.25 ? "down" : "";
    kpi(tone === "up" ? "trending-up" : tone === "down" ? "trending-down" : "arrow-right", t("an_kpi_last30"), String(a.last30),
      t("an_kpi_before", [String(a.prev30)]), { subCls: tone, title: t(ch >= 0.25 ? "an_ai_trend_up" : ch <= -0.25 ? "an_ai_trend_down" : "an_ai_trend_flat", [String(a.last30), String(a.prev30)]) });
  }
  kpi("timer", t("an_kpi_gap"), dur(a.medianGap), t("an_kpi_gap_sub", [dur(a.meanGap)]), { title: t("an_tip_gap") });
  if (a.maxGap) kpi("pause", t("an_act_gap_max"), dur(a.maxGap.hours), `${dateShort(a.maxGap.from)} – ${dateShort(a.maxGap.to)}`);
  const silent = a.sinceLastDays >= 14;
  kpi(silent ? "moon" : "clock", t("an_act_last"), t("an_act_ago", [dur(a.sinceLastDays * 24)]), dateLong(a.last), {
    cls: silent ? "bad" : "", title: silent ? t("an_ai_inactive", [String(Math.floor(a.sinceLastDays))]) : "",
  });
  kpi("check-circle", t("an_act_active"), pct(a.activeShare), t("an_act_active_sub", [String(a.activeDays), String(a.spanDays)]), { title: t("an_tip_active") });
  kpi("zap", t("an_act_max_day"), String(a.maxPerDay), t("an_act_posts"));
  // hot right now: the best views/day of the last 30 days -> opens that reel
  const hot = state.rows.filter((r) => r.vpd != null && r.ts > state.windowEnd - 30 * St.DAY).sort((x, y) => y.vpd - x.vpd)[0];
  if (hot) {
    kpi("flame", t("an_kpi_hot"), cmp(Math.round(hot.vpd)), t("an_kpi_hot_sub"), {
      cls: "hot", onClick: () => openDetails(hot.code),
      title: t("an_ai_hot", [cmp(Math.round(hot.vpd)), dateLong(hot.ts), (captionOf(hot) || hot.code).split("\n")[0].slice(0, 60)]),
    });
  }
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
  // views on a log scale (one viral interval would flatten all the others); 0 sits on the floor
  const pos = bins.map(lineVal).filter((v) => v > 0);
  const lo10 = pos.length ? Math.floor(Math.log10(Math.min(...pos))) : 0;
  const hi10 = Math.max(lo10 + 1, pos.length ? Math.ceil(Math.log10(Math.max(...pos))) : 1);
  const vy = (v) => m.t + ph - (v > 0 ? Math.max(0, (Math.log10(v) - lo10) / (hi10 - lo10)) : 0) * ph;
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
    // 1K · 10K · 100K …, plus 2 and 5 in between when the range is short
    const mids = hi10 - lo10 <= 2 ? [1, 2, 5] : [1];
    for (let e = lo10; e <= hi10; e++) {
      for (const k of mids) {
        const v = k * Math.pow(10, e);
        if (v > Math.pow(10, hi10)) continue;
        root.append(svg("text", { class: "axis views", x: W - m.r + 6, y: vy(v) + 4 }, cmp(v)));
      }
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
    // the hits of this interval, stacked at the bottom of the bar in gold
    const nViral = b.items.filter((k) => TIER_FILTERS.hit(state.rows[k])).length;
    if (nViral) {
      const vh = Math.max(2, (nViral / yMax) * ph);
      const vr = svg("rect", { class: "abin-hit", x, y: m.t + ph - vh, width: Math.max(1, bw - (bw > 6 ? 4 : 1)), height: vh, rx: bw > 6 ? 3 : 0 });
      vr.append(svg("title", {}, `${dateRangeLabel(b.from, b.to)}
${t("an_act_tip_hit", [String(nViral)])}`));
      root.append(vr);
    }
    if (b.count && bw >= 14) root.append(svg("text", { class: "count", x: x + (bw - 4) / 2, y: y - 4, "text-anchor": "middle" }, String(b.count)));
    if (i % labelEvery === 0) {
      const lx = m.l + i * bw;
      const label = monthly ? monthLabel(b.from) : dateShort(b.from, multiYear && (i === 0 || new Date(b.from).getMonth() === 0));
      root.append(svg("text", { class: "axis", x: lx + 2, y: m.t + ph + 14, transform: `rotate(35 ${lx + 2} ${m.t + ph + 14})` }, label));
    }
  });

  if (line) {
    const pts = bins
      .map((b, i) => (lineVal(b) == null ? null : [m.l + i * bw + bw / 2, vy(lineVal(b)), b]))
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
 * Posting hours: one column per hour of the day (weekdays are pooled - only the hour matters).
 * Bar height = how many reels were posted in that hour; bar color + label = how well they did,
 * as the median "vs typical" ratio (the profile's level at the time is already factored out, so a
 * growing account doesn't make late hours look better). Green = better than usual, red = worse.
 */
const HEAT_HOURS = [...Array(24).keys()].map((i) => (i + 12) % 24); // 12, 13 … 23, 0, 1 … 11

// ------------------------------------------------------------------ "What works" (timing + pace)
// Groupings shared with stats.js (St.BUCKETS), judged by the brain (St.successEffect): every reel's
// "vs typical" ratio, grouped by 3-hour window, posts that day / week, gap before it.
const WW_WINDOWS = [12, 15, 18, 21, 0, 3, 6, 9]; // same order as the heatmap (midnight in the middle)
const p2h = (h) => String(h).padStart(2, "0");
const WW_DIMS = {
  window: { icon: "⏰", title: "ww_time", order: WW_WINDOWS, label: (w) => `${p2h(w)}–${p2h((w + 3) % 24)}` },
  perDay: { icon: "repeat", title: "ww_per_day", order: St.BUCKETS.perDay.order, label: (g) => t("ww_per_day_v", [g]) },
  perWeek: { icon: "calendar-days", title: "ww_per_week", order: St.BUCKETS.perWeek.order, label: (g) => t("ww_per_week_v", [g]) },
  gap: { icon: "timer", title: "ww_gap", order: St.BUCKETS.gap.order, label: (g) => g },
};

/** For every reel in range (with a score, not still growing): its group in each dimension. */
function wwItems() {
  const allTs = state.allRows.map((r) => r.ts).filter((x) => x > 0).sort((a, b) => a - b);
  const perDay = new Map();
  for (const x of allTs) perDay.set(St.dayStart(x), (perDay.get(St.dayStart(x)) || 0) + 1);
  const out = [];
  for (const r of state.rows) {
    // judged by the brain; reels younger than 3 days are left out (their comments are still coming)
    if (!r.ts || !r.success || (r.perf && r.perf.isNew)) continue;
    const d = new Date(r.ts);
    let week = 0;
    let prev = null;
    for (const x of allTs) {
      if (x > r.ts - 7 * St.DAY && x <= r.ts) week++;
      if (x < r.ts) prev = x;
    }
    out.push({
      p: r.success.p,
      hour: d.getHours(),
      day: dateKey(r.ts),
      nDay: perDay.get(St.dayStart(r.ts)) || 1,
      window: St.BUCKETS.window.of(d.getHours()),
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
  for (const key of ["perWeek", "gap"]) state.wwEffects[key] = St.successEffect(items.map((it) => ({ group: it[key], p: it.p })));
  // the two timing brains: the store's own best stretch of hours, and the best number of reels a day
  state.wwTime = St.bestTimeWindows(items.map((it) => ({ hour: it.hour, p: it.p })));
  state.wwDay = St.postsPerDay(items.map((it) => ({ day: it.day, n: it.nDay, p: it.p })));
  $("wwNote").textContent = t("ww_note", [String(items.length)]);
  if (!state.wwDim || !["window", "perDay", "perWeek", "gap"].includes(state.wwDim)) state.wwDim = "window";
  const pick = (key) => () => {
    state.wwDim = key;
    renderWhatWorks();
  };
  const conf = (c) => el("span", { class: `fx-conf ${c}`, title: t(`fx_conf_${c}`), text: c === "clear" ? "●●●" : c === "likely" ? "●●○" : "●○○" });
  const tile = (key, icon, titleKey, value, pill, pillTone, sub, c) => {
    const node = el("button", { type: "button", class: "fx-tile" + (value ? "" : " empty") + (state.wwDim === key ? " on" : ""), onclick: pick(key) }, [
      el("div", { class: "fx-tile-top" }, [el("span", { class: "fx-icon" }, [PD.icon(icon)]), el("span", { class: "fx-tile-title", text: t(titleKey) })]),
      el("div", { class: "fx-tile-val", text: value || t("fx_not_enough") }),
      value ? el("div", { class: "fx-tile-sub" }, [pill ? el("span", { class: "fx-pill " + pillTone, text: pill }) : null, el("span", { class: "fx-tile-n", text: sub }), conf(c)])
        : el("div", { class: "fx-tile-sub muted", text: t("fx_need_more") }),
    ]);
    tiles.append(node);
  };
  const w = state.wwTime.best;
  tile("window", "clock", "ww_time", w ? windowLabel(w) : "", w ? PD.effectsUI.fmt(w.lift) : "", w ? (w.lift >= 1.05 ? "good" : "mid") : "",
    w ? t("ww_window_sub", [String(w.len), String(w.n)]) : "", w ? w.confidence : "few");
  const dd = state.wwDay;
  tile("perDay", "repeat", "ww_per_day", dd ? t(dd.ideal.n >= dd.maxN && dd.top.n === dd.maxN ? "ww_per_day_edge" : "ww_per_day_v2", [String(dd.ideal.n)]) : "",
    dd ? t("ww_hits_day", [dd.ideal.perDay.toFixed(1)]) : "", "good", dd ? t("ww_days", [String(dd.days)]) : "", dd ? dd.confidence : "few");
  for (const key of ["perWeek", "gap"]) {
    const dim = WW_DIMS[key];
    const node = PD.effectsUI.tile(dim.icon, dim.title, state.wwEffects[key], dim.label, pick(key));
    node.classList.toggle("on", state.wwDim === key);
    tiles.append(node);
  }
  const box = $("wwChart");
  if (state.wwDim === "window") box.append(hoursChart(state.wwTime));
  else if (state.wwDim === "perDay") box.append(perDayChart(state.wwDay));
  else {
    const dim = WW_DIMS[state.wwDim];
    box.append(PD.effectsUI.bars(state.wwEffects[state.wwDim], { order: dim.order, label: dim.label }));
  }
}

const windowLabel = (w) => `${p2h(w.start)}:00–${p2h((w.start + w.len) % 24)}:00`;

/**
 * Posting hours, 12:00 -> 11:00 (midnight in the middle). Bars: reels posted in that hour, colored
 * by their success vs usual. Line: smooth success curve (right axis, log scale, 1x dashed).
 * The best window (any width) is a green band; a second good window a lighter one.
 */
function hoursChart(tw) {
  const W = 900;
  const H = 260;
  const m = { l: 34, r: 44, t: 40, b: 28 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const cw = pw / 24;
  const col = (h) => HEAT_HOURS.indexOf(h);
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "hc", role: "img", "aria-label": t("ww_time") });
  const maxN = Math.max(1, ...tw.hourly.map((x) => x.n));
  const yStep = Math.max(1, Math.round(St.niceStep(maxN, 4)));
  const yMax = Math.ceil(maxN / yStep) * yStep;
  // success axis: log2 from 1/4x to 4x
  const LIM = 2;
  const ly = (lift) => m.t + ph / 2 - (Math.max(-LIM, Math.min(LIM, Math.log2(Math.max(lift, 1e-3)))) / LIM) * (ph / 2);
  for (let y = 0; y <= yMax; y += yStep) {
    const yy = m.t + ph - (y / yMax) * ph;
    root.append(svg("line", { class: "grid", x1: m.l, x2: W - m.r, y1: yy, y2: yy }));
    root.append(svg("text", { class: "axis", x: m.l - 6, y: yy + 4, "text-anchor": "end" }, String(y)));
  }
  root.append(svg("text", { class: "axis", x: 4, y: 12 }, t("an_act_axis_y")));
  for (const [v, lab] of [[0.5, "0.5×"], [1, "1×"], [2, "2×"]]) {
    root.append(svg("text", { class: "axis succ-axis", x: W - m.r + 6, y: ly(v) + 4 }, lab));
  }
  root.append(svg("text", { class: "axis succ-axis", x: W - 4, y: 12, "text-anchor": "end" }, t("ww_axis_success")));
  // windows as bands (a window crossing 12:00 is drawn in two parts)
  const band = (w, cls, label) => {
    const cols = [];
    for (let k = 0; k < w.len; k++) cols.push(col((w.start + k) % 24));
    cols.sort((a, b) => a - b);
    const runs = [];
    for (const c of cols) {
      if (runs.length && runs[runs.length - 1][1] === c - 1) runs[runs.length - 1][1] = c;
      else runs.push([c, c]);
    }
    for (const [a, b] of runs) {
      root.append(svg("rect", { class: `hc-band ${cls}`, x: m.l + a * cw + 1, y: m.t - 22, width: (b - a + 1) * cw - 2, height: ph + 22, rx: 8 }));
    }
    const first = runs.reduce((x, r) => (r[1] - r[0] > x[1] - x[0] ? r : x));
    const cx = m.l + ((first[0] + first[1] + 1) / 2) * cw;
    const tx = Math.max(m.l + 90, Math.min(W - m.r - 90, cx));
    root.append(svg("text", { class: `hc-label ${cls}`, x: tx, y: m.t - 8, "text-anchor": "middle" }, label));
  };
  if (tw.second) band(tw.second, "also", `${t("ww_also")} ${windowLabel(tw.second)} · ${PD.effectsUI.fmt(tw.second.lift)}`);
  if (tw.best) band(tw.best, "best", `★ ${windowLabel(tw.best)} · ${PD.effectsUI.fmt(tw.best.lift)}`);
  // 1x reference
  root.append(svg("line", { class: "hc-one", x1: m.l, x2: W - m.r, y1: ly(1), y2: ly(1) }));
  // bars
  HEAT_HOURS.forEach((h, i) => {
    const c = tw.hourly[h];
    const x = m.l + i * cw;
    if (c.n) {
      const bh = Math.max(3, (c.n / yMax) * ph);
      const tone = c.lift == null ? "" : c.lift >= 1.2 ? " good" : c.lift <= 0.8 ? " bad" : "";
      const strength = c.lift == null ? 0 : Math.min(1, Math.abs(Math.log2(Math.max(c.lift, 0.01))) / 2);
      const r = svg("rect", { class: "hc-bar" + tone + (c.n === 1 ? " thin" : ""), x: x + 3, y: m.t + ph - bh, width: cw - 6, height: bh, rx: 3 });
      if (tone) r.style.opacity = String(0.45 + 0.55 * strength);
      root.append(r);
      root.append(svg("text", { class: "hc-n", x: x + cw / 2, y: m.t + ph - bh - 4, "text-anchor": "middle" }, String(c.n)));
    }
    const lab = svg("text", { class: "axis hc-hour" + (h === 0 ? " midnight" : ""), x: x + cw / 2, y: H - 10, "text-anchor": "middle" }, p2h(h));
    root.append(lab);
    // hover target with the hour's numbers
    const hit = svg("rect", { class: "hc-hit", x, y: m.t - 22, width: cw, height: ph + 22 });
    const lines = [hourRange(h), t("an_reels_count", [String(c.n)])];
    if (c.lift != null) lines.push(t("an_hours_tip_succ", [`${c.lift.toFixed(1)}×`, String(state.rows.filter((r) => r.ts && new Date(r.ts).getHours() === h && TIER_FILTERS.hit(r)).length)]));
    hit.append(svg("title", {}, lines.join("\n")));
    root.append(hit);
  });
  // midnight divider
  const mx = m.l + col(0) * cw;
  root.append(svg("line", { class: "hc-mid", x1: mx, x2: mx, y1: m.t, y2: m.t + ph }));
  // smooth success curve
  // the curve breaks where there is no data instead of drawing across the gap
  let seg = [];
  const flush = () => {
    if (seg.length > 1) root.append(svg("polyline", { class: "hc-curve", points: seg.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ") }));
    seg = [];
  };
  HEAT_HOURS.forEach((h, i) => {
    if (tw.curve[h] == null) flush();
    else seg.push([m.l + i * cw + cw / 2, ly(tw.curve[h])]);
  });
  flush();
  const wrap = el("div", { class: "chart-wrap hc-wrap" }, [root]);
  const legend = el("div", { class: "legend small" }, [
    el("span", {}, [el("i", { class: "sw hc-sw-bar" }), el("span", { text: t("ww_lg_bars") })]),
    el("span", {}, [el("i", { class: "sw line hc-sw-curve" }), el("span", { text: t("ww_lg_curve") })]),
    el("span", {}, [el("i", { class: "sw hc-sw-band" }), el("span", { text: t("ww_lg_band") })]),
  ]);
  return el("div", {}, [wrap, legend]);
}

/** Reels per day: real days (bars, hits per day on average) next to the fitted curve; ideal = green. */
function perDayChart(dd) {
  if (!dd) return el("p", { class: "muted small", text: t("fx_need_more") });
  const W = 900;
  const H = 240;
  const m = { l: 40, r: 16, t: 40, b: 40 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const cw = pw / dd.maxN;
  const yMaxRaw = Math.max(0.1, ...dd.actual.map((g) => g.perDay), ...dd.curve.map((c) => c.perDay));
  const yStep = St.niceStep(yMaxRaw, 4);
  const yMax = Math.ceil(yMaxRaw / yStep) * yStep;
  const y = (v) => m.t + ph - (v / yMax) * ph;
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "hc", role: "img", "aria-label": t("ww_per_day") });
  for (let v = 0; v <= yMax + 1e-9; v += yStep) {
    root.append(svg("line", { class: "grid", x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
    root.append(svg("text", { class: "axis", x: m.l - 6, y: y(v) + 4, "text-anchor": "end" }, v < 1 ? v.toFixed(1) : String(Math.round(v * 10) / 10)));
  }
  root.append(svg("text", { class: "axis", x: 4, y: 12 }, t("ww_axis_hits_day")));
  const ix = dd.ideal.n - 1;
  root.append(svg("rect", { class: "hc-band best", x: m.l + ix * cw + 1, y: m.t - 22, width: cw - 2, height: ph + 22, rx: 8 }));
  root.append(svg("text", { class: "hc-label best", x: Math.max(m.l + 80, Math.min(W - m.r - 80, m.l + (ix + 0.5) * cw)), y: m.t - 8, "text-anchor": "middle" },
    `★ ${t("ww_per_day_v2", [String(dd.ideal.n)])} · ${t("ww_hits_day", [dd.ideal.perDay.toFixed(1)])}`));
  const byN = new Map(dd.actual.map((g) => [g.n, g]));
  for (let n = 1; n <= dd.maxN; n++) {
    const x = m.l + (n - 1) * cw;
    const g = byN.get(n);
    if (g) {
      const r = svg("rect", { class: "hc-bar day" + (g.days < 2 ? " thin" : ""), x: x + cw * 0.2, y: y(g.perDay), width: cw * 0.6, height: Math.max(2, m.t + ph - y(g.perDay)), rx: 3 });
      r.append(svg("title", {}, t("ww_day_tip", [String(n), String(g.days), g.perDay.toFixed(2)])));
      root.append(r);
      root.append(svg("text", { class: "hc-n", x: x + cw / 2, y: m.t + ph + 28, "text-anchor": "middle" }, t("ww_days_short", [String(g.days)])));
    }
    root.append(svg("text", { class: "axis hc-hour" + (n === dd.ideal.n ? " midnight" : ""), x: x + cw / 2, y: m.t + ph + 14, "text-anchor": "middle" }, String(n)));
  }
  const pts = dd.curve.map((c) => [m.l + (c.n - 0.5) * cw, y(c.perDay)]);
  root.append(svg("polyline", { class: "hc-curve", points: pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ") }));
  for (const [px, py] of pts) root.append(svg("circle", { class: "hc-dot", cx: px, cy: py, r: 3 }));
  const legend = el("div", { class: "legend small" }, [
    el("span", {}, [el("i", { class: "sw hc-sw-bar" }), el("span", { text: t("ww_lg_days") })]),
    el("span", {}, [el("i", { class: "sw line hc-sw-curve" }), el("span", { text: t("ww_lg_fit") })]),
    el("span", { class: "muted", text: t("ww_lg_caution") }),
  ]);
  return el("div", {}, [el("div", { class: "chart-wrap hc-wrap" }, [root]), legend]);
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
  "success_score", "success_tier",
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
      success_score: r.success ? r.success.score : "", success_tier: r.success ? r.success.tier || "" : "",
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


// ------------------------------------------------------------------ table: an ordered chain of filters
// Click a column header -> a slider for that column. Filters run in the order they were added:
// step 2 only sees the reels that step 1 kept, so its slider and histogram span what is left.
const isNum = (x) => typeof x === "number" && isFinite(x);
const metricVal = (r, key) => (key === "date" ? r.ts || null : key === "success" ? r.successScore : r[key]);
// statistical groups (from the clickable facts): a step without a slider
const TIER_FILTERS = {
  hit: (r) => !!r.success && r.success.tier === "hit",
  good: (r) => !!r.success && !!r.success.tier,
  viral: (r) => !!r.perf && r.perf.tier === "viral",
  strong: (r) => !!r.perf && (r.perf.tier === "viral" || r.perf.tier === "strong"),
  winner: (r) => !!r.perf && r.perf.winner,
  engaged: (r) => !!r.perf && (r.perf.highEr || r.perf.talk),
  rising: (r) => !!r.perf && r.perf.rising,
};
const TIER_ICON = { hit: "target", good: "check", viral: "rocket", strong: "award", winner: "trophy", engaged: "message", rising: "sprout" };
// metrics shown in percent
const PCT_KEYS = new Set(["er", "likeRate", "commentRate", "commentShare"]);
// counts spread over orders of magnitude: the slider moves on a log scale
const LOG_KEYS = new Set(["views", "likes", "comments", "vpd"]);
// "Standard" slider range (the other choice is the min - max of the reels left)
const STD_RANGE = {
  views: [1e3, 1e7], likes: [10, 1e6], comments: [1, 1e5], vpd: [1, 1e6],
  er: [0, 0.1], likeRate: [0, 0.1], commentRate: [0, 0.01], score: [0, 10], erAdj: [0, 3], success: [0, 100],
};
/** Percent with enough digits for tiny rates: 2.1% / 0.35% / 0.062% */
function pctFine(x) {
  if (!isFinite(x)) return "–";
  const p = x * 100;
  if (p === 0) return "0%";
  return `${p >= 10 ? p.toFixed(0) : p >= 1 ? p.toFixed(1) : p >= 0.1 ? p.toFixed(2) : p.toFixed(3)}%`;
}
function metricText(v, key) {
  if (key === "success") return String(Math.round(v));
  if (PCT_KEYS.has(key)) return pctFine(v);
  if (key === "score" || key === "erAdj") return `${v.toFixed(v < 10 ? 1 : 0)}×`;
  return v >= 1000 ? cmp(v) : String(Math.round(v * 10) / 10);
}
/** "≥ 3%", "≤ 10K", "3% – 12%" */
function rangeText(f) {
  if (f.tier) return t(`an_tier_${f.tier}`);
  const lo = isFinite(f.min);
  const hi = isFinite(f.max);
  if (lo && hi) return `${metricText(f.min, f.key)} – ${metricText(f.max, f.key)}`;
  if (lo) return `≥ ${metricText(f.min, f.key)}`;
  if (hi) return `≤ ${metricText(f.max, f.key)}`;
  return t("an_all");
}
function stepTest(f) {
  if (f.tier) return TIER_FILTERS[f.tier];
  return (r) => {
    const v = metricVal(r, f.key);
    return isNum(v) && v >= f.min && v <= f.max;
  };
}
/** The reels before any step (date range + a clicked chart bar). */
function baseRows() {
  let rows = state.rows;
  const f = state.filter;
  if (f && f.kind === "views") rows = rows.filter((r) => r.views != null && r.views >= f.from && r.views < f.to);
  if (f && f.kind === "date") rows = rows.filter((r) => r.ts >= f.from && r.ts < f.to);
  return rows;
}
/** pools[i] = the reels step i sees; the last one = what the table shows. */
function chainPools() {
  const pools = [baseRows()];
  for (const f of state.filters) {
    const pool = pools[pools.length - 1];
    // relative picks (Above avg, Top 25%, Top 10%) follow the reels this step sees
    if (f.key && f.preset && !f.preset.startsWith("v:")) f.min = presetValue(f.key, f.preset, pool);
    pools.push(pool.filter(stepTest(f)));
  }
  return pools;
}
/** The value behind a relative pick: the average or a quantile of the column in this pool. */
function presetValue(key, q, pool) {
  const v = pool.map((r) => metricVal(r, key)).filter(isNum).sort((a, b) => a - b);
  if (!v.length) return -Infinity;
  if (q === "avg") return v.reduce((a, b) => a + b, 0) / v.length;
  return v[Math.min(v.length - 1, Math.floor(Number(q) * v.length))];
}
/** "Nice" round step near x: 1, 2, 2.5 or 5 times a power of ten. */
function niceNum(x) {
  if (!(x > 0)) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(x)));
  const m = x / e;
  return (m < 1.5 ? 1 : m < 2.25 ? 2 : m < 3.5 ? 2.5 : m < 7.5 ? 5 : 10) * e;
}
/**
 * Quick picks for a column, chosen from the data:
 *  counts (views, likes …): Above avg / Top 25% / Top 10% (relative, follow the pool);
 *  rates (%): up to 6 round thresholds spread over the usual range, e.g. 0.5 1.0 1.5 … % for
 *  engagement or 0.02 0.04 0.06 … % for comments;  × columns: fixed 1× 1.5× 2× 3× 5×.
 */
function quickPicks(key, vals) {
  if (LOG_KEYS.has(key)) {
    return [{ label: t("an_fp_avg_up"), preset: "avg" }, { label: t("an_fp_top", ["25"]), preset: "0.75" }, { label: t("an_fp_top", ["10"]), preset: "0.9" }];
  }
  const fixed = (list) => list.map((x) => ({ label: `≥ ${metricText(x, key)}`, preset: `v:${x}`, min: x }));
  if (key === "score") return fixed([1, 1.5, 2, 3, 5]);
  if (key === "success") {
    return [
      { label: `✓ ${t("an_tier_good")} ≥ 50`, preset: "v:50", min: 50 },
      { label: `${t("an_tier_hit")} ≥ 80`, preset: "v:80", min: 80 },
      { label: "≥ 90", preset: "v:90", min: 90 },
    ];
  }
  if (key === "erAdj") return fixed([1, 1.25, 1.5, 2]);
  const v = vals.filter(isNum).map((x) => (PCT_KEYS.has(key) ? x * 100 : x)).sort((a, b) => a - b);
  if (v.length < 2) return [];
  const lo = St.quantile(v, 0.05);
  const hi = St.quantile(v, 0.9);
  let step = niceNum((hi - lo) / 5 || hi / 5);
  let out = [];
  for (let x = Math.max(step, Math.ceil(lo / step) * step); x <= hi + 1e-9 && out.length < 6; x += step) out.push(+x.toFixed(6));
  if (out.length < 3) {
    step /= 2;
    out = [];
    for (let x = Math.max(step, Math.ceil(lo / step) * step); x <= hi + 1e-9 && out.length < 6; x += step) out.push(+x.toFixed(6));
  }
  const dec = (String(+step.toFixed(6)).split(".")[1] || "").length; // as many decimals as the step has
  return out.map((x) => {
    const val = PCT_KEYS.has(key) ? x / 100 : x;
    return { label: `≥ ${x.toFixed(Math.min(4, Math.max(dec, 1)))}${PCT_KEYS.has(key) ? "%" : ""}`, preset: `v:${val}`, min: val };
  });
}
/** Sort: chosen in a column's panel; otherwise by the first filter's column, else views. */
function currentSort() {
  if (state.sort) return state.sort;
  const first = state.filters.find((f) => f.key);
  return { key: first ? first.key : "views", dir: -1 };
}
function visibleRows() {
  const pools = chainPools();
  const rows = pools[pools.length - 1].slice();
  const { key, dir } = currentSort();
  rows.sort((a, b) => {
    const x = metricVal(a, key);
    const y = metricVal(b, key);
    return isNum(y) ? (isNum(x) ? (x - y) * dir : 1) : isNum(x) ? -1 : 0;
  });
  return rows;
}

/** The filter chain above the table: ① ER ≥ 3% · 41 › ② Comment rate ≥ 0.2% · 17 */
function renderChain(pools) {
  const box = $("filterChain");
  box.replaceChildren();
  box.append(el("span", { class: "fc-start", title: t("an_fc_total") }, [
    el("span", { class: "fc-icon" }, [PD.icon("layers")]), el("strong", { text: String(pools[0].length) }),
  ]));
  state.filters.forEach((f, i) => {
    const kept = pools[i + 1].length;
    const chip = el("span", {
      class: "fc-chip" + (f.tier ? " tier" : "") + (fpop.step === f ? " on" : ""), draggable: "true",
      title: t("an_fc_chip_tip", [String(pools[i].length), String(kept)]),
    }, [
      el("span", { class: "fc-n", text: String(i + 1) }),
      el("button", {
        type: "button", class: "fc-body", onclick: (e) => (f.tier ? null : openFilterPop(f.key, colHead(f.key) || e.currentTarget)),
      }, [
        f.tier ? el("span", { class: "fc-tier-i" }, [PD.icon(TIER_ICON[f.tier] || "check")]) : el("span", { class: "fc-key", text: t(`an_col_${f.key}`) }),
        el("span", { class: "fc-range", text: rangeText(f) }),
      ]),
      el("span", { class: "fc-kept" + (kept ? "" : " zero"), text: String(kept) }),
      el("button", { type: "button", class: "fc-x", "aria-label": t("an_fc_remove"), text: "×", onclick: () => removeStep(f) }),
    ]);
    chip.addEventListener("dragstart", (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(i));
      chip.classList.add("dragging");
    });
    chip.addEventListener("dragend", () => chip.classList.remove("dragging"));
    chip.addEventListener("dragover", (e) => {
      e.preventDefault();
      chip.classList.add("drop");
    });
    chip.addEventListener("dragleave", () => chip.classList.remove("drop"));
    chip.addEventListener("drop", (e) => {
      e.preventDefault();
      const from = Number(e.dataTransfer.getData("text/plain"));
      if (!isFinite(from) || from === i) return renderTable();
      const [moved] = state.filters.splice(from, 1);
      state.filters.splice(i, 0, moved);
      renderTable();
    });
    box.append(el("span", { class: "fc-arrow", "aria-hidden": "true", text: "›" }), chip);
  });
  if (!state.filters.length) box.append(el("span", { class: "fc-hint muted", text: t("an_fc_hint") }));
  else box.append(el("button", { type: "button", class: "link fc-clear", text: t("an_fc_clear"), onclick: clearSteps }));
}
function removeStep(f) {
  state.filters = state.filters.filter((x) => x !== f);
  if (fpop.step === f) closeFilterPop();
  renderTable();
}
function clearSteps() {
  state.filters = [];
  closeFilterPop();
  renderTable();
}
/** Show a statistical group (used by the clickable facts): it becomes the first step. */
function showInTable(tier) {
  state.filters = [{ tier }].concat(state.filters.filter((f) => f.tier !== tier));
  state.filter = null;
  renderTable();
  $("reelTable").closest(".card").scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Column headers: filter number badge, sort arrow. */
const colHead = (key) => document.querySelector(`#reelTable th[data-key="${key}"] .fh-btn`);
function renderHeads() {
  const s = currentSort();
  for (const th of document.querySelectorAll("#reelTable th[data-key]")) {
    const key = th.dataset.key;
    const idx = state.filters.findIndex((f) => f.key === key);
    th.classList.toggle("filtered", idx >= 0);
    th.classList.toggle("sorted", s.key === key);
    th.classList.toggle("open", fpop.key === key);
    const i = th.querySelector(".fh-i");
    i.textContent = idx >= 0 ? String(idx + 1) : "";
    th.querySelector(".fh-sort").textContent = s.key === key ? (s.dir < 0 ? "↓" : "↑") : "";
    th.setAttribute("aria-sort", s.key === key ? (s.dir < 0 ? "descending" : "ascending") : "none");
  }
}

// ---- the filter panel (pops up next to a column header)
const fpop = { key: null, step: null, anchor: null, mode: "data" };
/** slider units: log10 for counts, percent for rates, the value itself for × */
function toU(v, key) {
  if (LOG_KEYS.has(key)) return Math.log10(Math.max(0, v) + 1);
  if (PCT_KEYS.has(key)) return v * 100;
  return v;
}
function fromU(u, key) {
  if (LOG_KEYS.has(key)) return niceRound(Math.pow(10, u) - 1);
  if (PCT_KEYS.has(key)) return u / 100;
  return u;
}
/** 2 significant digits for counts: 12345 -> 12000 */
function niceRound(x) {
  if (x < 10) return Math.round(x);
  const p = Math.pow(10, Math.floor(Math.log10(x)) - 1);
  return Math.round(x / p) * p;
}
function popScale(key, pool) {
  const vals = pool.map((r) => metricVal(r, key)).filter(isNum);
  let lo;
  let hi;
  if (fpop.mode === "std" && STD_RANGE[key]) [lo, hi] = STD_RANGE[key].map((v) => toU(v, key));
  else {
    lo = vals.length ? toU(Math.min(...vals), key) : 0;
    hi = vals.length ? toU(Math.max(...vals), key) : 1;
  }
  const spanU = hi - lo || 1;
  // ~200 stops on log scales; a round step (0.1 / 0.01 / 0.005 …) giving ~150 stops otherwise,
  // so tiny rates (comment rate 0.0x %) still move in fine steps
  const step = LOG_KEYS.has(key) ? spanU / 200 : niceNum(spanU / 150);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  if (hi <= lo) hi = lo + step;
  return { vals, lo, hi, step };
}

function openFilterPop(key, anchor) {
  if (fpop.key === key && fpop.anchor === anchor && $("fpop").classList.contains("open")) return closeFilterPop();
  fpop.key = key;
  fpop.anchor = anchor;
  fpop.step = state.filters.find((f) => f.key === key) || null;
  fpop.mode = "data";
  renderFilterPop();
  placeFilterPop();
  const pop = $("fpop");
  clearTimeout(fpop.hideT);
  pop.hidden = false;
  pop.classList.remove("open", "closing");
  void pop.offsetWidth; // restart the drop animation (also when moving to another column)
  pop.classList.add("open");
  renderHeads();
  renderTable();
}
function closeFilterPop() {
  const pop = $("fpop");
  if (pop.hidden || pop.classList.contains("closing")) return;
  pop.classList.remove("open");
  pop.classList.add("closing");
  fpop.key = null;
  fpop.step = null;
  const before = state.filters.length;
  state.filters = state.filters.filter((f) => f.tier || isFinite(f.min) || isFinite(f.max));
  if (state.filters.length !== before) renderTable();
  clearTimeout(fpop.hideT);
  fpop.hideT = setTimeout(() => {
    if (!pop.classList.contains("open")) pop.hidden = true;
    pop.classList.remove("closing");
  }, 170);
  renderHeads();
  for (const c of document.querySelectorAll(".fc-chip.on")) c.classList.remove("on");
}
function placeFilterPop() {
  const pop = $("fpop");
  const a = fpop.anchor.getBoundingClientRect();
  const w = Math.min(320, window.innerWidth - 16);
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, a.left + a.width / 2 - w / 2));
  pop.style.width = `${w}px`;
  pop.style.left = `${left + window.scrollX}px`;
  pop.style.top = `${a.bottom + window.scrollY + 8}px`;
  pop.style.setProperty("--ox", `${Math.round(a.left + a.width / 2 - left)}px`);
}

/** Pool for the open panel: the reels before its step (a new step goes last). */
function popPool() {
  const pools = chainPools();
  const i = fpop.step ? state.filters.indexOf(fpop.step) : state.filters.length;
  return { pool: pools[i], index: i };
}

function renderFilterPop() {
  const key = fpop.key;
  const pop = $("fpop");
  pop.replaceChildren();
  const { pool, index } = popPool();
  const s = currentSort();
  const sortBtn = (dir, label) => el("button", {
    type: "button", class: "seg-btn" + (state.sort && state.sort.key === key && state.sort.dir === dir ? " on" : ""), text: label,
    title: s.key === key && s.dir === dir && !state.sort ? t("an_fp_sort_auto") : "",
    onclick: () => {
      // a second click on the chosen order goes back to the automatic one
      const on = state.sort && state.sort.key === key && state.sort.dir === dir;
      state.sort = on ? null : { key, dir };
      renderFilterPop();
      renderTable();
    },
  });
  const head = el("div", { class: "fp-head" }, [
    el("div", { class: "fp-title" }, [
      el("span", { class: "fp-n", text: String(index + 1) }),
      el("strong", { text: t(`an_col_${key}`) }),
    ]),
    el("div", { class: "seg" }, key === "date"
      ? [sortBtn(-1, t("an_fp_new")), sortBtn(1, t("an_fp_old"))]
      : [sortBtn(-1, "↓ " + t("an_fp_high")), sortBtn(1, "↑ " + t("an_fp_low"))]),
  ]);
  pop.append(head);
  if (key === "date") {
    pop.querySelector(".fp-n").remove();
    return;
  }
  const sc = popScale(key, pool);
  const f = fpop.step || { key, min: -Infinity, max: Infinity };
  const uMin = isFinite(f.min) ? Math.max(sc.lo, Math.min(sc.hi, toU(f.min, key))) : sc.lo;
  const uMax = isFinite(f.max) ? Math.max(sc.lo, Math.min(sc.hi, toU(f.max, key))) : sc.hi;

  // readout: the chosen range, big; how many reels it keeps
  const readout = el("div", { class: "fp-read" }, [
    el("span", { class: "fp-val", id: "fpVal" }), el("span", { class: "fp-kept", id: "fpKept" }),
  ]);
  // smooth density of the reels this step sees (no empty columns), the part inside the range lit
  const us = sc.vals.map((v) => toU(v, key)).sort((x, y) => x - y);
  const span = sc.hi - sc.lo;
  let bwU = span * 0.04;
  if (us.length > 1) {
    const avg = us.reduce((x, y) => x + y, 0) / us.length;
    const sd = Math.sqrt(us.reduce((x, y) => x + (y - avg) ** 2, 0) / (us.length - 1));
    const iqr = St.quantile(us, 0.75) - St.quantile(us, 0.25);
    const spread = Math.min(sd, iqr / 1.34) || sd;
    bwU = Math.max(span * 0.025, 0.9 * spread * Math.pow(us.length, -0.2));
  }
  const NPT = 100;
  const dens = Array.from({ length: NPT + 1 }, (_, i) => {
    const x = sc.lo + (span * i) / NPT;
    let d = 0;
    for (const u of us) d += Math.exp(-0.5 * ((x - u) / bwU) ** 2);
    return d;
  });
  const maxD = Math.max(1e-9, ...dens);
  const pts = dens.map((d, i) => `${i},${(50 - (d / maxD) * 46).toFixed(2)}`).join(" L");
  const area = `M0,50 L${pts} L${NPT},50 Z`;
  const sv = (tag, attrs) => {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  const clipRect = sv("rect", { x: 0, y: 0, width: NPT, height: 50 });
  const clip = sv("clipPath", { id: "fpClip" });
  clip.append(clipRect);
  const defs = sv("defs", {});
  defs.append(clip);
  const dsvg = sv("svg", { class: "fp-dens", viewBox: `0 0 ${NPT} 50`, preserveAspectRatio: "none", "aria-hidden": "true" });
  dsvg.append(defs, sv("path", { class: "fp-area-base", d: area }), sv("path", { class: "fp-area", d: area, "clip-path": "url(#fpClip)" }),
    sv("path", { class: "fp-line", d: `M${pts}`, "vector-effect": "non-scaling-stroke" }));
  const hist = el("div", { class: "fp-hist" }, [dsvg]);
  const mean = sc.vals.length ? sc.vals.reduce((a, b) => a + b, 0) / sc.vals.length : null;
  if (mean != null) {
    const x = ((toU(mean, key) - sc.lo) / span) * 100;
    if (x >= 0 && x <= 100) hist.append(el("b", { class: "fp-avg", style: `left:${x}%`, title: `${t("an_fp_avg")} ${metricText(mean, key)}` }));
  }
  // two thumbs on one track (own pointer handling: smooth on mouse, touch and keyboard)
  let lo = uMin;
  let hi = uMax;
  const fill = el("div", { class: "fp-fill" });
  const thumb = (label) => el("button", { type: "button", class: "fp-thumb", role: "slider", "aria-label": label });
  const ta = thumb(t("an_fp_min"));
  const tb = thumb(t("an_fp_max"));
  const track = el("div", { class: "fp-track" }, [fill, ta, tb]);
  const slider = el("div", { class: "fp-slider" }, [track]);
  const ends = el("div", { class: "fp-ends" }, [
    el("span", { text: metricText(fromU(sc.lo, key), key) }), el("span", { text: metricText(fromU(sc.hi, key), key) }),
  ]);
  pop.append(readout, hist, slider, ends);

  const snap = (u) => Math.max(sc.lo, Math.min(sc.hi, sc.lo + Math.round((u - sc.lo) / sc.step) * sc.step));
  const pos = (u) => ((u - sc.lo) / (sc.hi - sc.lo)) * 100;
  const sync = (commit) => {
    ta.style.left = `${pos(lo)}%`;
    tb.style.left = `${pos(hi)}%`;
    fill.style.left = `${pos(lo)}%`;
    fill.style.width = `${pos(hi) - pos(lo)}%`;
    clipRect.setAttribute("x", pos(lo));
    clipRect.setAttribute("width", Math.max(0, pos(hi) - pos(lo)));
    const half = sc.step / 2;
    const cand = { key, min: lo <= sc.lo + half ? -Infinity : fromU(lo, key), max: hi >= sc.hi - half ? Infinity : fromU(hi, key), preset: null };
    // a quick pick keeps its exact value (the average, a quantile) and stays marked as chosen
    if (commit && commit.preset) Object.assign(cand, { min: commit.min, preset: commit.preset });
    ta.setAttribute("aria-valuetext", isFinite(cand.min) ? metricText(cand.min, key) : "–");
    tb.setAttribute("aria-valuetext", isFinite(cand.max) ? metricText(cand.max, key) : "–");
    // just opened / range switched: show the step as it is, not as rounded to this slider's grid
    const shown = !commit && fpop.step ? fpop.step : cand;
    $("fpVal").textContent = rangeText(shown);
    $("fpKept").textContent = t("an_fp_kept", [String(pool.filter(stepTest(shown)).length), String(pool.length)]);
    if (!commit) return;
    const all = !isFinite(cand.min) && !isFinite(cand.max);
    // a step pulled back to "everything" keeps its place until the panel closes
    if (fpop.step) Object.assign(fpop.step, cand);
    else if (!all) {
      fpop.step = cand;
      state.filters.push(cand);
    }
    scheduleTable();
    markPresets();
  };
  const setVal = (which, u) => {
    u = snap(u);
    if (which === ta) lo = Math.min(u, hi);
    else hi = Math.max(u, lo);
    sync(true);
  };
  const uAt = (x) => {
    const r = track.getBoundingClientRect();
    return sc.lo + ((x - r.left) / (r.width || 1)) * (sc.hi - sc.lo);
  };
  let drag = null;
  slider.addEventListener("pointerdown", (e) => {
    const u = uAt(e.clientX);
    // the nearer thumb moves; both on one spot -> the side you pull towards
    drag = Math.abs(u - lo) < Math.abs(u - hi) || (lo === hi && u < lo) ? ta : tb;
    drag.focus({ preventScroll: true });
    drag.classList.add("drag");
    slider.setPointerCapture(e.pointerId);
    setVal(drag, u);
    e.preventDefault();
  });
  slider.addEventListener("pointermove", (e) => drag && setVal(drag, uAt(e.clientX)));
  const end = () => {
    if (drag) drag.classList.remove("drag");
    drag = null;
  };
  slider.addEventListener("pointerup", end);
  slider.addEventListener("pointercancel", end);
  for (const th of [ta, tb]) {
    th.addEventListener("keydown", (e) => {
      const cur = th === ta ? lo : hi;
      const big = e.shiftKey ? 10 : 1;
      const k = { ArrowLeft: -big, ArrowDown: -big, ArrowRight: big, ArrowUp: big }[e.key];
      if (k) setVal(th, cur + k * sc.step);
      else if (e.key === "Home") setVal(th, sc.lo);
      else if (e.key === "End") setVal(th, sc.hi);
      else return;
      e.preventDefault();
    });
  }
  sync(false);

  // quick picks (stay highlighted while they are the filter; a second click clears it) + the slider's range
  const qp = (item) => el("button", {
    type: "button", class: "chipbtn", text: item.label, "data-q": item.preset,
    onclick: () => {
      if (!sc.vals.length) return;
      hi = sc.hi;
      if (fpop.step && fpop.step.preset === item.preset) {
        lo = sc.lo;
        return sync(true);
      }
      const val = item.min != null ? item.min : presetValue(key, item.preset, pool);
      lo = Math.max(sc.lo, Math.min(snap(toU(val, key)), sc.hi));
      sync({ preset: item.preset, min: val });
    },
  });
  const quick = el("div", { class: "fp-quick" }, quickPicks(key, sc.vals).map(qp));
  function markPresets() {
    for (const b of quick.children) b.classList.toggle("on", !!fpop.step && fpop.step.preset === b.dataset.q);
  }
  const modeBtn = (mode, label) => el("button", {
    type: "button", class: "seg-btn" + (fpop.mode === mode ? " on" : ""), text: label, title: t(`an_fp_${mode}_tip`),
    onclick: () => {
      fpop.mode = mode;
      renderFilterPop();
    },
  });
  pop.append(el("div", { class: "fp-foot" }, [
    quick,
    STD_RANGE[key] ? el("div", { class: "seg" }, [modeBtn("data", t("an_fp_data")), modeBtn("std", t("an_fp_std"))]) : null,
  ]));
  pop.append(el("div", { class: "fp-actions" }, [
    fpop.step ? el("button", { type: "button", class: "link", text: t("an_fc_remove"), onclick: () => removeStep(fpop.step) }) : el("span"),
    el("button", { type: "button", class: "primary", text: t("an_fp_done"), onclick: closeFilterPop }),
  ]));
  markPresets();
}
let tableRaf = 0;
function scheduleTable() {
  cancelAnimationFrame(tableRaf);
  tableRaf = requestAnimationFrame(() => {
    renderTable();
    renderHeads();
  });
}
function initFilterPop() {
  for (const th of document.querySelectorAll("#reelTable th[data-key]")) {
    const btn = th.querySelector(".fh-btn");
    btn.title = th.dataset.key === "date" ? t("an_fh_sort_tip") : t("an_fh_tip");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openFilterPop(th.dataset.key, btn);
    });
  }
  const pop = $("fpop");
  document.addEventListener("pointerdown", (e) => {
    if (pop.hidden || pop.contains(e.target) || e.target.closest(".fh-btn, .fc-body")) return;
    closeFilterPop();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !pop.hidden) {
      e.stopPropagation();
      closeFilterPop();
    }
  }, true);
  window.addEventListener("resize", () => !pop.hidden && fpop.anchor && placeFilterPop());
}

function jobStatusCell(row) {
  const td = el("td", { class: "st c-st" });
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
  td.className = "st c-st " + job.status;
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

/** The brain's verdict: a 0-100 chip (gold = hit, green = good) explained in its tooltip. */
function successText(r) {
  const s = r.success;
  if (!s) return "";
  const top = (x) => (x == null ? "–" : `${Math.max(1, Math.round((1 - x) * 100))}%`);
  return [
    t("an_succ_tip", [String(s.score)]),
    t("an_succ_tip_c", [r.comments != null ? cmp(r.comments) : "–", top(s.commentsRank)]),
    t("an_succ_tip_l", [r.likeRate != null ? pctFine(r.likeRate) : "–", top(s.likeRateRank)]),
  ].join("\n");
}
function successCell(r, extraTip) {
  const s = r.success;
  if (!s) return el("td", { class: "num muted", text: "–" });
  return el("td", { class: "num" }, [el("span", {
    class: "succ" + (s.tier ? " " + s.tier : ""),
    title: [successText(r), extraTip].filter(Boolean).join("\n\n"),
    style: `--p:${s.score}`,
  }, [s.tier === "hit" ? el("span", { class: "succ-i" }, [PD.icon("target")]) : null, el("span", { text: String(s.score) })])]);
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
  const badge = (cls, key, icon) => badges.append(el("span", { class: `sig ${cls}` }, [icon ? PD.icon(icon) : null, document.createTextNode((icon ? " " : "") + t(key))]));
  if (r.success && r.success.tier) badge(r.success.tier === "hit" ? "winner" : "strong", r.success.tier === "hit" ? "an_sig_hit" : "an_sig_good", r.success.tier === "hit" ? "target" : "check");
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
  if (r.success) cell("an_col_success", String(r.success.score), successText(r).split("\n").slice(1).join(" · "), r.success.tier || "");
  cell("an_col_views", r.views != null ? fmt(r.views) : "–", r.vpd != null ? t("an_dr_per_day", [cmp(Math.round(r.vpd))]) : "");
  if (pf) cell("an_col_score", `${pf.ratio.toFixed(1)}×`, t("an_dr_typical", [cmp(Math.round(pf.baseline)), pf.z.toFixed(1)]), pf.tier);
  cell("an_col_likes", r.likes != null ? fmt(r.likes) : "–", r.likeRate != null ? pctFine(r.likeRate) : "");
  cell("an_col_comments", r.comments != null ? fmt(r.comments) : "–", r.commentRate != null ? pctFine(r.commentRate) : "");
  const shares = r.shares != null ? r.shares : det && det.shares != null ? det.shares : null;
  if (shares != null) cell("an_col_shares", fmt(shares), r.views ? pctFine(shares / r.views) : "");
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
  setActionMsg(t("an_queued", ["1", t("an_saved_to_downloads")]), "ok");
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
    el("td", { colspan: "2", class: "sum-label" }, [el("div", { class: "sum-flex" }, [
      // the two lines here name the two lines of every value cell: average, then median
      el("div", {}, [el("div", { text: t("an_sum_label") }), el("div", { class: "sum-med", text: t("an_sum_median") })]),
      el("div", { class: "sum-meta" }, [
        el("div", { class: "sum-n", text: t("an_sum_count", [String(rows.length), cmp(tViews)]) }),
        el("div", { class: "sum-med", text: ts.length ? `${dateShort(Math.min(...ts))} – ${dateShort(Math.max(...ts))}` : "" }),
      ]),
    ])]),
    cellOf((r) => r.views, (x) => cmp(Math.round(x))),
    cellOf((r) => r.successScore, (x) => String(Math.round(x))),
    cellOf((r) => r.vpd, (x) => cmp(Math.round(x))),
    ((c) => (c.classList.add("grp"), c))(cellOf((r) => r.likes, (x) => cmp(Math.round(x)))),
    cellOf((r) => r.comments, (x) => cmp(Math.round(x))),
    cellOf((r) => r.er, pctFine, tViews ? t("an_sum_pooled", [pctFine(pooled(tLikes + tComments))]) : ""),
    cellOf((r) => r.likeRate, pctFine, tViews ? t("an_sum_pooled", [pctFine(pooled(tLikes))]) : ""),
    cellOf((r) => r.commentRate, pctFine, tViews ? t("an_sum_pooled", [pctFine(pooled(tComments))]) : ""),
    cellOf((r) => r.erAdj, signed),
    el("td", { class: "c-st" }),
  ]);
}

let lastClickedCode = null; // anchor for Shift+click range selection

function renderTable() {
  const body = $("reelBody");
  body.replaceChildren();
  const pools = chainPools();
  const rows = visibleRows();
  renderChain(pools);
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
      thumb.addEventListener("error", () => thumb.replaceWith(el("span", { class: "thumb ph", "aria-hidden": "true", text: "▶" })));
    } else thumb = el("span", { class: "thumb ph", "aria-hidden": "true", text: "▶" });
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
    // one "Reel" cell: preview, date + time, and the caption (or a short link when it isn't loaded yet)
    const cap = (captionOf(r) || "").replace(/\s+/g, " ").trim();
    const d = r.ts ? new Date(r.ts) : null;
    const reel = el("td", { class: "c-reel" }, [el("div", { class: "reel" }, [
      preview,
      el("div", { class: "reel-txt" }, [
        el("div", { class: "reel-date", title: d ? d.toLocaleString(LANG) : "" }, [
          el("span", { text: d ? dateLong(r.ts) : "–" }),
          d ? el("span", { class: "reel-time", text: `${p2(d.getHours())}:${p2(d.getMinutes())}` }) : null,
          r.pinned ? el("span", { class: "pin", title: t("an_pinned"), "aria-label": t("an_pinned") }, [PD.icon("pin")]) : null,
        ]),
        el("a", {
          class: "reel-cap" + (cap ? "" : " empty"), href: r.url, target: "_blank", rel: "noopener noreferrer",
          title: cap || r.url, text: cap || t("an_open_ig"),
        }),
      ]),
    ])]);
    const tr = el("tr", { class: "clickable" + (state.selected.has(r.code) ? " sel" : "") + (state.openCode === r.code ? " open" : ""), title: t("an_row_hint") }, [
      el("td", { class: "c-check" }, [cb]),
      el("td", { class: "num muted c-rank", text: r.rank ? String(r.rank) : String(i + 1) }),
      reel,
      viewsCell(r),
      successCell(r, scoreTip),
      el("td", { class: "num", title: t("an_tip_vpd"), text: r.vpd != null ? cmp(Math.round(r.vpd)) : "–" }),
      el("td", { class: "num grp", text: r.likes != null ? cmp(r.likes) : "–" }),
      el("td", { class: "num", text: r.comments != null ? cmp(r.comments) : "–" }),
      erCell(r),
      el("td", { class: "num", text: r.likeRate != null ? pctFine(r.likeRate) : "–" }),
      el("td", { class: "num", text: r.commentRate != null ? pctFine(r.commentRate) : "–" }),
      erAdjCell(r),
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
  $("reelTable").classList.toggle("no-jobs", !state.jobs.size);
  renderHeads();
  const all = rows.length > 0 && rows.every((r) => state.selected.has(r.code));
  $("checkAll").checked = all;
}

// ------------------------------------------------------------------ selection + actions

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
  $("exportSel").disabled = !sel.length || exportRun;
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
  setActionMsg(t("an_queued", [String(res.data.jobs.length), res.data.jobs.length > 1 ? t("an_saved_as_zip", [res.data.folder]) : t("an_saved_to_downloads")]), "ok");
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

// ------------------------------------------------------------------ full-page screenshot
/*
 * The whole page, top to bottom, like DevTools' "Capture full size screenshot", but sharper:
 * at least 2x pixels (zoom in on a phone and it still looks like the real screen). Uses the
 * Chrome DevTools protocol on this tab (chrome.debugger: Chrome shows a short "started
 * debugging" bar while it runs). Long pages are captured in slices and stitched on a canvas.
 * Saved to Downloads and copied to the clipboard.
 */
let shotRun = false;
function setShotMsg(text, kind) {
  const m = $("shotMsg");
  m.textContent = text || "";
  m.className = "shot-msg small" + (kind ? " " + kind : "");
  clearTimeout(setShotMsg.t);
  if (text && kind !== "busy") setShotMsg.t = setTimeout(() => (m.textContent = ""), 8000);
}
async function captureFullPage() {
  if (shotRun) return;
  shotRun = true;
  $("shotBtn").disabled = true;
  setShotMsg(t("an_shot_busy"), "busy");
  closeFilterPop();
  if (!$("drawer").hidden) closeDetails();
  const tab = await chrome.tabs.getCurrent();
  const target = { tabId: tab.id };
  const cmd = (method, params) => chrome.debugger.sendCommand(target, method, params || {});
  let attached = false;
  let overridden = false;
  try {
    try {
      await chrome.debugger.attach(target, "1.3");
      attached = true;
    } catch (_e) {
      // Chrome refused the debugger (policy, DevTools already open …): scroll and stitch instead
      return await captureByScrolling(tab);
    }
    // Chrome now slides in its "started debugging" bar, which changes the window height: let it settle
    await new Promise((r) => setTimeout(r, 700));
    document.body.classList.add("shooting"); // keep "Capturing…" and the busy button out of the picture
    // Same method as DevTools' "Capture full size screenshot": make the viewport as tall as the page
    // (and 2x sharp) for a moment, so nothing depends on the window size or the scroll position.
    const dpr = window.devicePixelRatio || 1;
    const vw = document.documentElement.clientWidth;
    let H = 0;
    let out = Math.max(2, dpr);
    for (let pass = 0; pass < 3; pass++) {
      const metrics = await cmd("Page.getLayoutMetrics");
      const h = Math.ceil((metrics.cssContentSize || metrics.contentSize).height);
      if (h === H) break;
      H = h;
      out = Math.max(2, dpr);
      // stay under Chrome's canvas limits on very long pages
      while (out > 1 && (H * out > 32000 || vw * H * out * out > 250e6)) out -= 0.25;
      await cmd("Emulation.setDeviceMetricsOverride", { width: vw, height: H, deviceScaleFactor: out, mobile: false });
      await new Promise((r) => setTimeout(r, 500)); // charts redraw for the new size
    }
    // Chrome never reports a page shorter than the viewport: measure where the content really ends,
    // so the picture has no empty strip at the bottom
    const bottom = Math.ceil(Math.max(...[...document.body.children]
      .filter((n) => !n.hidden && getComputedStyle(n).position !== "fixed" && getComputedStyle(n).display !== "none")
      .map((n) => n.getBoundingClientRect().bottom + window.scrollY)) + 16);
    if (bottom > 100 && bottom < H - 4) {
      H = bottom;
      await cmd("Emulation.setDeviceMetricsOverride", { width: vw, height: H, deviceScaleFactor: out, mobile: false });
      await new Promise((r) => setTimeout(r, 300));
    }
    overridden = true;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vw * out);
    canvas.height = Math.round(H * out);
    const ctx = canvas.getContext("2d");
    const SLICE = 3000; // CSS px per capture: keeps every piece well under the GPU texture limit
    for (let y = 0; y < H; y += SLICE) {
      const h = Math.min(SLICE, H - y);
      const res = await cmd("Page.captureScreenshot", { format: "png", fromSurface: true, clip: { x: 0, y, width: vw, height: h, scale: 1 } });
      const img = new Image();
      img.src = "data:image/png;base64," + res.data;
      await img.decode();
      ctx.drawImage(img, 0, Math.round(y * out)); // natural size: never stretched
    }
    await cmd("Emulation.clearDeviceMetricsOverride");
    overridden = false;
    document.body.classList.remove("shooting");
    await chrome.debugger.detach(target);
    attached = false;
    await saveShot(canvas);
  } catch (e) {
    setShotMsg(t("an_shot_err", [String((e && e.message) || e)]), "err");
  } finally {
    if (attached) {
      try {
        if (overridden) await cmd("Emulation.clearDeviceMetricsOverride");
        await chrome.debugger.detach(target);
      } catch (_e) { /* already gone */ }
    }
    document.body.classList.remove("shooting");
    shotRun = false;
    $("shotBtn").disabled = false;
  }
}

/** Fallback without the debugger: screen-size pieces while scrolling (sharpness = the screen's). */
async function captureByScrolling(tab) {
  const W = document.documentElement.scrollWidth;
  const H = document.documentElement.scrollHeight;
  const vh = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext("2d");
  const back = window.scrollY;
  document.documentElement.style.scrollBehavior = "auto";
  for (let y = 0; y < H; y += vh) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 550)); // captureVisibleTab allows ~2 calls a second
    const top = window.scrollY;
    const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const img = new Image();
    img.src = url;
    await img.decode();
    ctx.drawImage(img, 0, Math.round(top * dpr));
  }
  window.scrollTo(0, back);
  document.documentElement.style.scrollBehavior = "";
  if (W > window.innerWidth) { /* wider than the window: the right part is not included */ }
  await saveShot(canvas);
}

async function saveShot(canvas) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  const d = new Date();
  const name = `${(state.data && state.data.username) || "reels"}_${today()}_${p2(d.getHours())}-${p2(d.getMinutes())}.png`;
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({ url, filename: name, conflictAction: "uniquify" });
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  let copied = false;
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    copied = true;
  } catch (_e) { /* saving is enough */ }
  document.body.classList.add("shot-flash");
  setTimeout(() => document.body.classList.remove("shot-flash"), 400);
  setShotMsg(t(copied ? "an_shot_done_copied" : "an_shot_done", [`${canvas.width}×${canvas.height}`]), "ok");
}

// ------------------------------------------------------------------ data export (temporary research tool)
/*
 * "Export data": one JSON file per store with
 *   store     - profile + the statistics every verdict is relative to (typical views, thresholds),
 *   selected  - the selected reels with every number we have + their details (description, audio,
 *               location, tags …; missing details are loaded first, one request per reel),
 *   all_reels - every analyzed reel, numbers only (no extra requests), to compare the selected ones
 *               against the rest of the store.
 * Several stores' files can be merged and studied together.
 */
let exportRun = false;

function timingIndex() {
  const allTs = state.allRows.map((r) => r.ts).filter((x) => x > 0).sort((a, b) => a - b);
  const perDay = new Map();
  for (const x of allTs) perDay.set(St.dayStart(x), (perDay.get(St.dayStart(x)) || 0) + 1);
  return (r) => {
    if (!r.ts) return {};
    let week = 0;
    let prev = null;
    for (const x of allTs) {
      if (x > r.ts - 7 * St.DAY && x <= r.ts) week++;
      if (x < r.ts) prev = x;
    }
    return { posts_same_day: perDay.get(St.dayStart(r.ts)) || 1, posts_last_7_days: week, hours_since_prev: prev ? +((r.ts - prev) / St.HOUR).toFixed(1) : null };
  };
}

function reelRecord(r, timing, full) {
  const pf = r.perf || {};
  const d = r.ts ? new Date(r.ts) : null;
  const round = (x, k) => (isNum(x) ? +x.toFixed(k) : null);
  const det = (details.get(r.code) || {}).data || null;
  const rec = {
    code: r.code, url: r.url, rank: r.rank || null, pinned: !!r.pinned,
    posted_local: d ? `${dateKey(r.ts)} ${p2(d.getHours())}:${p2(d.getMinutes())}` : null,
    hour: d ? d.getHours() : null,
    age_days: r.ts ? round((state.now - r.ts) / St.DAY, 1) : null,
    views: r.views ?? null, likes: r.likes ?? null, comments: r.comments ?? null, shares: r.shares ?? (det && det.shares) ?? null,
    er: round(r.er, 5), like_rate: round(r.likeRate, 5), comment_rate: round(r.commentRate, 6), comment_share: round(r.commentShare, 4),
    views_per_day: round(r.vpd, 1),
    success_score: r.success ? r.success.score : null, success_tier: r.success ? r.success.tier : null,
    vs_typical: round(pf.ratio, 3), z: round(pf.z, 2), baseline_views: round(pf.baseline, 0),
    tier: pf.tier || null, winner: !!pf.winner, rising: !!pf.rising, is_new: !!pf.isNew,
    high_er: !!pf.highEr, talked_about: !!pf.talk, er_vs_expected: round(pf.erVsExpected, 3),
    duration_s: round((det && det.duration) || r.duration, 1),
    selected: state.selected.has(r.code),
  };
  Object.assign(rec, timing(r));
  const cap = captionOf(r);
  if (full) {
    rec.caption = cap || null;
    rec.details_loaded = !!det;
    if (det) {
      rec.audio = det.audio || null;
      rec.location = det.location || null;
      rec.alt_text = det.alt_text || null;
      rec.tagged = det.tagged || [];
      rec.coauthors = det.coauthors || [];
      rec.paid_partnership = !!det.paid_partnership;
      rec.comments_disabled = !!det.comments_disabled;
      rec.like_count_hidden = !!det.like_count_hidden;
    }
  } else if (cap) rec.caption = cap; // already known: costs nothing
  return rec;
}

async function exportSelected() {
  if (exportRun) return;
  const sel = selectedRows();
  if (!sel.length) return;
  exportRun = true;
  $("exportSel").disabled = true;
  let failed = 0;
  let stopped = "";
  const missing = sel.filter((r) => !((details.get(r.code) || {}).data));
  if (missing.length) {
    setActionMsg(t("an_exp_loading", [String(missing.length)]));
    const res = await send({ type: "reelDetailsMany", codes: missing.map((r) => r.code) });
    if (res.ok) {
      for (const [code, data] of Object.entries(res.data.items || {})) details.set(code, { data, at: Date.now() });
      failed = Object.keys(res.data.errors || {}).length;
      stopped = res.data.stopped || "";
    } else {
      failed = missing.length;
      stopped = (res.error || {}).code || "ERROR";
    }
  }
  const timing = timingIndex();
  const s = state.stats || {};
  const p = state.perf || {};
  const prof = state.data.profile || {};
  const ers = state.rows.map((r) => r.er).filter(isNum).sort((a, b) => a - b);
  const ts = state.rows.map((r) => r.ts).filter((x) => x > 0);
  const out = {
    format: "media-downloader-export/1",
    exported_at: new Date().toISOString(),
    timezone_offset_min: -new Date().getTimezoneOffset(),
    store: {
      username: state.data.username, full_name: prof.full_name || null, followers: prof.followers ?? null,
      following: prof.following ?? null, posts: prof.posts ?? null, category: prof.category || null,
      biography: prof.biography || null, links: prof.links || [], period: state.data.period || null, stopped_by: state.data.stopped_by || null,
      analyzed_at: new Date(state.now).toISOString(),
      range: ts.length ? { from: dateKey(Math.min(...ts)), to: dateKey(Math.max(...ts)) } : null,
      reels: state.rows.length,
      views: Object.fromEntries(["sum", "mean", "median", "p25", "p75", "p90", "min", "max"].map((k) => [k === "sum" ? "total" : k, isNum(s[k]) ? Math.round(s[k]) : null])),
      er_median: ers.length ? +St.quantile(ers, 0.5).toFixed(5) : null,
      typical_views: isNum(p.typicalViews) ? Math.round(p.typicalViews) : null,
      viral_mult: isNum(p.viralMult) ? +p.viralMult.toFixed(2) : null, strong_mult: isNum(p.strongMult) ? +p.strongMult.toFixed(2) : null,
      viral_threshold_views: p.typicalViews && p.viralMult ? Math.round(p.typicalViews * p.viralMult) : null,
      counts: { viral: p.nViral ?? null, strong: p.nStrong ?? null, winner: p.nWinner ?? null },
      filters: state.filters.map((f) => (f.tier ? { group: f.tier } : { column: f.key, min: isFinite(f.min) ? f.min : null, max: isFinite(f.max) ? f.max : null })),
    },
    selected: sel.map((r) => reelRecord(r, timing, true)),
    all_reels: state.rows.map((r) => reelRecord(r, timing, false)),
  };
  const blob = new Blob([JSON.stringify(out, null, 1)], { type: "application/json" });
  const a = el("a", { href: URL.createObjectURL(blob), download: `${state.data.username}_selected_${sel.length}_${today()}.json` });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
  const withDet = out.selected.filter((x) => x.details_loaded).length;
  let msg = t("an_exp_done", [String(sel.length), String(withDet)]);
  if (/RATE_LIMITED|LOGIN_REQUIRED/.test(stopped)) msg += " " + t("an_cap_stopped_ig");
  else if (failed) msg += " " + t("an_cap_failed", [String(failed)]);
  setActionMsg(msg, withDet === sel.length ? "ok" : "");
  exportRun = false;
  updateActionBar();
  renderTable();
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
  initPeriodSelect();
  $("profileInput").addEventListener("input", schedulePreview);
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
  $("topAll").addEventListener("click", () => $("reelsCard").scrollIntoView({ behavior: "smooth", block: "start" }));
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
  $("csvBtn").addEventListener("click", exportCsv);
  $("csvFormat").value = csvFormat();
  $("csvFormat").title = t("an_csv_format_tip");
  $("csvFormat").addEventListener("change", () => {
    try {
      localStorage.setItem("csvFormat", $("csvFormat").value);
    } catch (_e) { /* not remembered */ }
  });
  $("csvBtn").title = t("an_csv_tip");
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
  initFilterPop();
  $("downloadSel").addEventListener("click", downloadSelected);
  $("copyLinks").addEventListener("click", copyLinks);
  $("cancelAll").addEventListener("click", cancelAll);
  $("copyCaptions").addEventListener("click", copyCaptions);
  $("exportSel").addEventListener("click", exportSelected);
  $("shotBtn").addEventListener("click", captureFullPage);
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
    loadPreview(profileName(u));
    const cached = await loadCache(u);
    if (cached) load(cached.data, cached.at); // instant, no request to Instagram
  }
  await loadSettings();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) loadSettings();
  });
  refreshHelper();
});
