/* Compare stores: load the CSV files exported by the Reels Analyzer ("Download CSV") from several
 * stores and show what works across all of them (best time window, weekday, posting pace, gap).
 * Statistics: PD.stats.groupEffect on "vs typical" - every store weighs the same.
 * Everything stays on this computer (chrome.storage.local). */
"use strict";

const St = PD.stats;
const UI = PD.effectsUI;
const t = PD.t;
const $ = (id) => document.getElementById(id);
const KEY = "compareStores";

function el(tag, attrs, children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(children || [])) if (c) n.append(c);
  return n;
}

// store name -> {rows: [...], file, at}
let stores = new Map();

// ------------------------------------------------------------------ CSV parsing
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const NEEDED = ["store", "reel_code", "hour", "weekday", "vs_typical"];

/** RFC 4180-ish parser; the separator (";" or ",") is detected from the header line. */
function parseCsv(text) {
  text = text.replace(/^﻿/, "");
  const firstLine = text.slice(0, text.indexOf("\n") >>> 0 || text.length);
  const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ";" : ",";
  const rows = [];
  let row = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); if (row.some((x) => x !== "")) rows.push(row); }
  return { sep, rows };
}

function toRows(text, fileName) {
  const { sep, rows } = parseCsv(text);
  if (rows.length < 2) throw new Error(t("cmp_err_empty", [fileName]));
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const missing = NEEDED.filter((c) => !head.includes(c));
  if (missing.length) throw new Error(t("cmp_err_columns", [fileName, missing.join(", ")]));
  const col = (name) => head.indexOf(name);
  // Excel format uses a decimal comma: "1,85" -> 1.85
  const num = (s) => {
    if (s == null || s === "") return null;
    const v = parseFloat(sep === ";" ? String(s).replace(",", ".") : s);
    return isFinite(v) ? v : null;
  };
  const out = [];
  for (const r of rows.slice(1)) {
    const get = (name) => (col(name) >= 0 ? r[col(name)] : "");
    const wdRaw = String(get("weekday")).trim().toLowerCase();
    const wd = WEEKDAYS.indexOf(wdRaw) >= 0 ? WEEKDAYS.indexOf(wdRaw) : WEEKDAYS.findIndex((w) => w.startsWith(wdRaw.slice(0, 3)));
    const item = {
      store: String(get("store")).trim(),
      code: String(get("reel_code")).trim(),
      hour: num(get("hour")),
      weekday: wd,
      ratio: num(get("vs_typical")),
      isNew: String(get("is_new")).trim().toLowerCase() === "yes",
      perDay: num(get("posts_same_day")),
      perWeek: num(get("posts_last_7_days")),
      gapH: num(get("hours_since_prev_post")),
      date: String(get("posted_date")).trim(),
    };
    if (item.store && item.code && item.ratio > 0 && item.hour != null) out.push(item);
  }
  return out;
}

async function addFiles(files) {
  const errors = [];
  for (const f of files) {
    try {
      const rows = toRows(await f.text(), f.name);
      if (!rows.length) throw new Error(t("cmp_err_empty", [f.name]));
      // a file can hold several stores (if someone merged them); a store loaded again is replaced
      const byStore = new Map();
      for (const r of rows) {
        if (!byStore.has(r.store)) byStore.set(r.store, new Map());
        byStore.get(r.store).set(r.code, r); // same reel twice: keep one
      }
      for (const [name, m] of byStore) stores.set(name, { rows: [...m.values()], file: f.name, at: Date.now() });
    } catch (e) {
      errors.push(e.message || String(e));
    }
  }
  $("errors").hidden = !errors.length;
  $("errors").textContent = errors.join("\n");
  await save();
  render();
}

async function save() {
  try {
    await chrome.storage.local.set({ [KEY]: [...stores.entries()].map(([name, s]) => ({ name, ...s })) });
  } catch (_e) { /* too big for storage: it still works for this session */ }
}

async function restore() {
  try {
    const list = (await chrome.storage.local.get(KEY))[KEY] || [];
    stores = new Map(list.map((s) => [s.name, { rows: s.rows, file: s.file, at: s.at }]));
  } catch (_e) { stores = new Map(); }
}

// ------------------------------------------------------------------ analysis
const p2 = (h) => String(h).padStart(2, "0");
const DIMS = {
  window: { icon: "⏰", title: "ww_time", order: [12, 15, 18, 21, 0, 3, 6, 9], label: (w) => `${p2(w)}–${p2((w + 3) % 24)}`, of: (r) => St.BUCKETS.window.of(r.hour) },
  weekday: { icon: "📅", title: "ww_day", order: [0, 1, 2, 3, 4, 5, 6], label: (w) => dayName(w), of: (r) => (r.weekday >= 0 ? r.weekday : null) },
  perDay: { icon: "🔁", title: "ww_per_day", order: St.BUCKETS.perDay.order, label: (g) => t("ww_per_day_v", [g]), of: (r) => (r.perDay ? St.BUCKETS.perDay.of(r.perDay) : null) },
  perWeek: { icon: "📆", title: "ww_per_week", order: St.BUCKETS.perWeek.order, label: (g) => t("ww_per_week_v", [g]), of: (r) => (r.perWeek ? St.BUCKETS.perWeek.of(r.perWeek) : null) },
  gap: { icon: "⏱", title: "ww_gap", order: St.BUCKETS.gap.order, label: (g) => g, of: (r) => St.BUCKETS.gap.of(r.gapH) },
};

function dayName(i) {
  const names = t("an_weekdays_long").split(",");
  return names.length === 7 ? names[i] : WEEKDAYS[i];
}

function analyze() {
  const includeNew = $("includeNew").checked;
  const rows = [];
  for (const s of stores.values()) for (const r of s.rows) if (includeNew || !r.isNew) rows.push(r);
  const effects = {};
  for (const [key, dim] of Object.entries(DIMS)) {
    // several stores: a group needs 8+ reels from at least 2 stores to count
    effects[key] = St.groupEffect(rows.map((r) => ({ group: dim.of(r), ratio: r.ratio, store: r.store })),
      { minN: stores.size > 1 ? 8 : 5, minStores: Math.min(2, stores.size) });
  }
  return { rows, effects };
}

// ------------------------------------------------------------------ render
function render() {
  const has = stores.size > 0;
  $("storesCard").hidden = !has;
  $("results").hidden = !has;
  $("empty").hidden = has;
  const box = $("stores");
  box.replaceChildren();
  let total = 0;
  for (const [name, s] of [...stores.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    total += s.rows.length;
    box.append(el("span", { class: "store", title: s.file }, [
      el("span", { text: "@" + name }),
      el("span", { class: "n", text: String(s.rows.length) }),
      el("button", { type: "button", text: "✕", "aria-label": t("cmp_remove", [name]), onclick: async () => {
        stores.delete(name);
        await save();
        render();
      } }),
    ]));
  }
  $("storeCount").textContent = t("cmp_count", [String(stores.size), String(total)]);
  if (!has) return;

  const { rows, effects } = analyze();
  $("resultNote").textContent = t("cmp_note", [String(rows.length), String(stores.size)]);
  const tiles = $("tiles");
  tiles.replaceChildren();
  const charts = $("charts");
  charts.replaceChildren();
  for (const [key, dim] of Object.entries(DIMS)) {
    const card = el("div", { class: "card", id: `chart-${key}` }, [
      el("h3", {}, [el("span", { text: dim.icon }), el("span", { text: t(dim.title) })]),
      UI.bars(effects[key], { order: dim.order, label: dim.label }),
    ]);
    charts.append(card);
    tiles.append(UI.tile(dim.icon, dim.title, effects[key], dim.label, () => card.scrollIntoView({ behavior: "smooth", block: "center" })));
  }
  state.last = { rows, effects };
}

const state = { last: null };

/** Short plain-text summary to paste into any (free) AI chat for interpretation. */
function summaryText() {
  const { rows, effects } = state.last || analyze();
  const f = (e) => `${UI.fmt(e.ratio)} (${e.n} reels, ${St.effectConfidence(e)})`;
  const lines = [
    `Instagram reels from ${stores.size} stores (${[...stores.keys()].map((s) => "@" + s).join(", ")}), ${rows.length} reels${$("includeNew").checked ? "" : " (reels younger than 3 days excluded)"}.`,
    `Numbers are "vs typical": each reel's views divided by that store's normal level at the time (1.0× = usual, 2.0× = twice as many views). Every store has equal weight. Confidence: clear = likely range fully above/below 1×, likely = not fully, few = too few reels.`,
    "",
  ];
  for (const [key, dim] of Object.entries(DIMS)) {
    const list = dim.order.map((g) => effects[key].find((e) => e.group === g)).filter(Boolean);
    if (!list.length) continue;
    lines.push(`${t(dim.title)}:`);
    for (const e of list) lines.push(`  ${dim.label(e.group)}: ${f(e)}`);
    const best = St.bestEffect(effects[key]);
    if (best) lines.push(`  -> best: ${dim.label(best.group)}`);
    lines.push("");
  }
  lines.push("Question: what posting schedule (time of day, weekday, posts per day/week, gap between posts) would you recommend for a dropshipping store, and how sure can we be?");
  return lines.join("\n");
}

async function copySummary() {
  try {
    await navigator.clipboard.writeText(summaryText());
    $("copySummary").textContent = t("cmp_copied");
    setTimeout(() => ($("copySummary").textContent = t("cmp_copy")), 1800);
  } catch (_e) { /* clipboard blocked */ }
}

// ------------------------------------------------------------------ init
document.addEventListener("DOMContentLoaded", async () => {
  for (const n of document.querySelectorAll("[data-i18n]")) n.textContent = t(n.dataset.i18n);
  for (const n of document.querySelectorAll("[data-i18n-title]")) n.title = t(n.dataset.i18nTitle);
  const drop = $("drop");
  drop.addEventListener("click", (e) => {
    if (!e.target.closest("label")) $("fileInput").click();
  });
  drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") $("fileInput").click();
  });
  $("fileInput").addEventListener("change", () => {
    addFiles([...$("fileInput").files]);
    $("fileInput").value = "";
  });
  for (const ev of ["dragenter", "dragover"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
  for (const ev of ["dragleave", "drop"]) drop.addEventListener(ev, () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    addFiles([...e.dataTransfer.files].filter((f) => /\.csv$/i.test(f.name) || f.type === "text/csv"));
  });
  // dropping a file anywhere on the page should not open it in the tab
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());
  $("includeNew").addEventListener("change", render);
  $("copySummary").addEventListener("click", copySummary);
  $("clearAll").addEventListener("click", async () => {
    stores = new Map();
    await save();
    render();
  });
  await restore();
  render();
});
