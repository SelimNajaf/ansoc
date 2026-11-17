/* Popup UI. DOM is built with createElement/textContent only. */
"use strict";

const P = PD.pin;
const S = PD.STATUS;
const t = PD.t;
const $ = (id) => document.getElementById(id);

let activeTab = null;
let pageInfo = { type: "other" };

// ------------------------------------------------------------------------ helpers
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

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: { message: chrome.runtime.lastError.message } });
      else resolve(res || { ok: false, error: { message: t("err_UNKNOWN") } });
    });
  });
}

function showError(text) {
  $("errorText").hidden = !text;
  $("errorText").textContent = text || "";
}

function setStatus(text) {
  $("statusText").textContent = text || "";
}

function setBar(p) {
  const bar = $("statusBar");
  const fill = bar.firstElementChild;
  if (p === false) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  if (p === null || p === undefined) {
    fill.classList.add("indet");
    fill.style.width = "";
  } else {
    fill.classList.remove("indet");
    fill.style.width = Math.max(2, Math.min(100, p)) + "%";
  }
}

function i18nize() {
  for (const n of document.querySelectorAll("[data-i18n]")) n.textContent = t(n.dataset.i18n);
  for (const n of document.querySelectorAll("[data-i18n-placeholder]")) n.placeholder = t(n.dataset.i18nPlaceholder);
  document.documentElement.lang = chrome.i18n.getUILanguage();
}

function chip(text, cls) {
  return el("span", { class: "chip " + (cls || ""), text });
}

function mediaTypeLabel(mt) {
  return mt ? t("media_" + mt) : "";
}

/** Platform + media type indicator under the URL field (local regex only). */
function showDetected() {
  const box = $("detected");
  box.replaceChildren();
  const v = $("urlInput").value.trim();
  if (!v) return;
  if (/^\d{5,25}$/.test(v)) {
    box.append(chip("Pinterest", "pinterest"));
    return;
  }
  const plat = PD.platforms.detect(v);
  if (!plat) {
    box.append(chip(t("err_UNSUPPORTED_PLATFORM_short"), "bad"));
    return;
  }
  box.append(chip(plat.name, plat.id));
  const mt = plat.guessMediaType(v);
  if (mt) box.append(chip(mediaTypeLabel(mt)));
}

function statusLabel(j) {
  switch (j.status) {
    case S.QUEUED: return j.errorMessage || t("status_queued");
    case S.RESOLVING: return t("status_resolving");
    case S.DOWNLOADING: return j.cancelRequested ? t("status_cancelling") : PD.waitText(j) || t("status_downloading") + (j.progress != null ? ` ${Math.round(j.progress)}%` : "") + (j.total > 1 ? ` (${j.index || 1}/${j.total})` : "");
    case S.PROCESSING: return t("status_processing");
    case S.SUCCESS: return t("status_success");
    case S.DUPLICATE: return t("status_duplicate");
    case S.FAILED: return t("status_failed");
    case S.CANCELLED: return t("status_cancelled");
    default: return j.status;
  }
}

// ------------------------------------------------------------------------ helper status
async function refreshHelper(force) {
  const badge = $("helperBadge");
  badge.textContent = t("helper_checking");
  badge.className = "badge";
  const res = await send({ type: "helperStatus", force: !!force });
  const st = res.ok ? res.data : { ok: false, error: res.error };
  const help = $("helperHelp");
  help.replaceChildren();
  if (st.ok) {
    const deps = st.info.deps || {};
    const missing = [];
    if (!deps.yt_dlp) missing.push("yt-dlp");
    if (!deps.gallery_dl) missing.push("gallery-dl");
    if (!deps.ffmpeg) missing.push("FFmpeg");
    badge.textContent = missing.length ? t("helper_partial") : t("helper_ok");
    badge.className = "badge " + (missing.length ? "bad" : "ok");
    badge.title = `${st.info.root}\nPython ${deps.python || "?"}`;
    help.hidden = !missing.length && !st.info.root_error;
    if (st.info.root_error) {
      badge.textContent = t("helper_partial");
      badge.className = "badge bad";
      help.append(el("div", { text: PD.errorText(st.info.root_error.code) }));
      help.append(el("div", { class: "muted", text: st.info.root_error.message }));
    }
    if (missing.length) {
      help.append(el("div", { text: t("helper_missing_deps", [missing.join(", ")]) }));
      help.append(el("div", { class: "muted", text: t("helper_rerun_install") }));
    }
    // the extension is newer than the installed helper: offer to update the helper
    const old = PD.helperOutdated(st.info);
    if (old) {
      badge.textContent = t("helper_outdated_short");
      badge.className = "badge warn";
      help.hidden = false;
      help.append(el("div", { text: t("helper_outdated", [old, chrome.runtime.getManifest().version]) }));
      const btn = el("button", { class: "small primary", type: "button", text: t("btn_update_helper") });
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = t("update_running");
        await send({ type: "applyUpdate" }); // updates the helper; the extension then reloads itself
        btn.disabled = false;
        btn.textContent = t("btn_update_helper");
        renderUpdate();
      });
      help.append(btn);
    }
  } else {
    const code = (st.error && st.error.code) || "HOST_NOT_INSTALLED";
    badge.textContent = t("helper_missing");
    badge.className = "badge bad";
    badge.title = (st.error && st.error.message) || "";
    help.hidden = false;
    help.append(el("div", { text: PD.errorText(code) }));
    help.append(el("div", { class: "muted", text: t("helper_install_hint") }));
    help.append(el("code", { text: "Install-Windows.bat · Install-Mac.command" }));
  }
}

// ------------------------------------------------------------------------ recent list
function renderJobs(jobs) {
  jobs = Array.isArray(jobs) ? jobs : [];
  const list = $("recent");
  list.replaceChildren();
  const recent = jobs.slice(0, PD.RECENT_SHOWN);
  $("empty").hidden = recent.length > 0;

  for (const j of recent) {
    const platform = j.platform || "pinterest";
    const plat = PD.platforms.byId(platform);
    let thumb;
    if (j.thumb && /^https:\/\/[^/]*pinimg\.com\//.test(j.thumb)) {
      thumb = el("img", { class: "thumb", alt: "", referrerpolicy: "no-referrer" });
      thumb.src = j.thumb;
    } else {
      thumb = el("span", { class: "thumb ph", text: (plat ? plat.name : platform).slice(0, 2) });
    }
    const f = (j.files || [])[0];
    const id = j.contentId || j.pinId || "";
    const tags = el("div", { class: "detected" }, [chip(plat ? plat.name : platform, platform)]);
    const mt = j.kind === "metadata" ? "metadata" : j.mediaType;
    if (mt) tags.append(chip(mediaTypeLabel(mt)));
    const info = el("div", { class: "info" }, [
      el("div", { class: "title", title: j.title || id, text: j.title || `${plat ? plat.name : platform} ${id}`.trim() }),
      tags,
      el("div", { class: "st " + j.status, text: statusLabel(j) }),
    ]);
    if (j.status === S.SUCCESS && f) {
      const more = (j.files || []).length > 1 ? ` (+${j.files.length - 1})` : "";
      info.append(el("div", { class: "sub", title: (j.files || []).map((x) => x.path).join("\n"), text: (f.name || f.path) + more }));
    }
    if (j.status === S.SUCCESS && j.notes && j.notes.length) info.append(el("div", { class: "sub", title: j.notes.join("\n"), text: j.notes.join(" ") }));
    if (j.status === S.FAILED) info.append(el("div", { class: "sub", title: j.errorDetail || "", text: j.errorMessage || "" }));
    if (j.status === S.DUPLICATE && j.existingPath) info.append(el("div", { class: "sub", title: j.existingPath, text: j.existingPath }));
    if ([S.DOWNLOADING, S.PROCESSING, S.RESOLVING, S.QUEUED].includes(j.status)) {
      const fill = el("div", { class: "fill" + (j.progress == null ? " indet" : "") });
      if (j.progress != null) fill.style.width = Math.max(2, j.progress) + "%";
      info.append(el("div", { class: "bar" }, [fill]));
    }

    const actions = el("div", { class: "actions" });
    if (!PD.isFinal(j.status) && !j.cancelRequested) {
      actions.append(el("button", { class: "small danger", type: "button", text: t("btn_cancel"), onclick: () => send({ type: "cancel", jobId: j.id }) }));
    }
    if (j.status === S.FAILED || j.status === S.CANCELLED) {
      actions.append(el("button", { class: "small primary", type: "button", text: t("btn_retry"), onclick: () => send({ type: "retry", jobId: j.id }) }));
    }
    if (j.status === S.DUPLICATE) {
      actions.append(el("button", { class: "small", type: "button", text: t("btn_download_again"), onclick: () => send({ type: "retry", jobId: j.id, force: true }) }));
    }
    if (j.status === S.SUCCESS && f && f.path) {
      actions.append(el("button", { class: "small", type: "button", text: t("btn_show_file"), onclick: () => send({ type: "reveal", path: f.path }) }));
    }
    actions.append(el("button", { class: "small link", type: "button", text: t("btn_open_pin"), onclick: () => chrome.tabs.create({ url: j.contentUrl || j.pinUrl }) }));
    info.append(actions);
    list.append(el("li", {}, [thumb, info]));
  }

  // Summary for the overall status line.
  const active = jobs.filter((j) => [S.QUEUED, S.RESOLVING, S.DOWNLOADING, S.PROCESSING].includes(j.status));
  // "Cancel all" for every queued / running download (not only the 10 shown)
  const cancellable = active.filter((j) => !j.cancelRequested);
  $("cancelAllBtn").hidden = !cancellable.length;
  $("cancelAllBtn").textContent = t("btn_cancel_all", [String(cancellable.length)]);
  $("cancelAllBtn").onclick = () => send({ type: "cancelMany", jobIds: cancellable.map((j) => j.id) });
  if (active.length) {
    const cur = active.find((j) => j.status === S.DOWNLOADING || j.status === S.PROCESSING) || active[0];
    setStatus(active.length > 1 ? t("status_active_many", [String(active.length)]) + " · " + statusLabel(cur) : statusLabel(cur));
    setBar(cur.progress == null ? null : cur.progress);
  } else {
    const last = jobs[0];
    setBar(false);
    setStatus(last ? `${statusLabel(last)}${last.title ? " — " + last.title : ""}` : "");
  }
}

// ------------------------------------------------------------------------ actions
async function downloadInput(e) {
  e.preventDefault();
  showError("");
  const value = $("urlInput").value.trim();
  if (!value) {
    showError(t("err_BAD_URL"));
    return;
  }
  if (!/^\d{5,25}$/.test(value)) {
    const plat = PD.platforms.detect(value);
    if (!plat) {
      // Unknown site: nothing is sent anywhere.
      showError(t("err_UNSUPPORTED_PLATFORM"));
      return;
    }
    if (plat.id === "pinterest" && P.pageType(/^https?:/.test(value) ? value : "https://" + value) === "board") {
      showError(t("err_BOARD_IN_INPUT"));
      return;
    }
  }
  $("downloadBtn").disabled = true;
  const res = await send({ type: "download", url: value });
  $("downloadBtn").disabled = false;
  if (!res.ok) showError(res.error.message + (res.error.detail ? `\n${res.error.detail}` : ""));
  else {
    $("urlInput").value = "";
    showDetected();
  }
}

async function downloadCurrent() {
  showError("");
  if (!isDownloadablePage()) {
    showError(t("err_NOT_CONTENT_PAGE"));
    return;
  }
  const res = pageInfo.platform === "pinterest"
    ? await send({ type: "download", pinId: pageInfo.pinId, hints: pageInfo.hints || null })
    : await send({ type: "download", url: pageInfo.url || activeTab.url });
  if (!res.ok) showError(res.error.message);
}

async function downloadBoard() {
  showError("");
  if (pageInfo.platform !== "pinterest" || pageInfo.type !== "board" || !activeTab) {
    showError(t("err_NOT_BOARD_PAGE"));
    return;
  }
  chrome.tabs.sendMessage(activeTab.id, { type: "startBoard" }, () => void chrome.runtime.lastError);
  setStatus(t("status_collecting", ["…"]));
  setTimeout(() => window.close(), 600); // the page itself shows the board progress
}

async function openFolder() {
  showError("");
  const res = await send({ type: "openFolder" });
  if (!res.ok) showError(res.error.message);
  else if (res.data && res.data.fallback) setStatus(t("note_fallback_folder"));
}

// ------------------------------------------------------------------------ active tab
async function inspectTab() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  pageInfo = { type: "other" };
  if (!activeTab || !activeTab.url) return updateButtons();
  const plat = PD.platforms.detect(activeTab.url);
  const type = plat ? plat.pageType(activeTab.url) : "other";
  if (type === "other") return updateButtons();
  pageInfo = { platform: plat.id, type, pinId: plat.id === "pinterest" ? P.pinIdFromUrl(activeTab.url) : "", url: activeTab.url };
  const ask = () => new Promise((resolve) => {
    chrome.tabs.sendMessage(activeTab.id, { type: "pageInfo" }, (res) => resolve(chrome.runtime.lastError ? null : res));
  });
  let res = await ask();
  if (!res) {
    // Page was open before the extension was installed/reloaded: inject the content script now.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        files: ["utils/constants.js", "utils/pinterest.js", "utils/platforms.js", "content/content.js"],
      });
      res = await ask();
    } catch (_e) { /* not allowed on this page */ }
  }
  if (res) pageInfo = Object.assign(pageInfo, res);
  updateButtons();
}

function isDownloadablePage() {
  if (!pageInfo.platform || pageInfo.type === "other" || pageInfo.type === "profile") return false;
  return pageInfo.platform === "pinterest" ? pageInfo.type === "pin" : true;
}

function updateButtons() {
  const board = pageInfo.platform === "pinterest" && pageInfo.type === "board";
  $("currentBtn").disabled = !isDownloadablePage();
  $("boardBtn").disabled = !board;
  $("currentBtn").title = isDownloadablePage() ? "" : t("err_NOT_CONTENT_PAGE");
  $("boardBtn").title = board ? "" : t("err_NOT_BOARD_PAGE");
}

// ------------------------------------------------------------------------ settings
async function loadSettings() {
  const r = await chrome.storage.local.get("settings");
  const s = Object.assign({}, PD.DEFAULT_SETTINGS, r.settings || {});
  $("setSkipDup").checked = !!s.skipDuplicates;
  $("setNotify").checked = !!s.notifications;
  $("setCookies").checked = !!s.useBrowserCookies;
  $("setMeta").checked = !!s.saveMetadata;
  $("setCompat").checked = !!s.compatVideos;
  const save = async () => {
    const cur = Object.assign({}, PD.DEFAULT_SETTINGS, (await chrome.storage.local.get("settings")).settings || {});
    cur.skipDuplicates = $("setSkipDup").checked;
    cur.notifications = $("setNotify").checked;
    cur.useBrowserCookies = $("setCookies").checked;
    cur.saveMetadata = $("setMeta").checked;
    cur.compatVideos = $("setCompat").checked;
    await chrome.storage.local.set({ settings: cur });
  };
  for (const id of ["setSkipDup", "setNotify", "setCookies", "setMeta", "setCompat"]) $(id).addEventListener("change", save);
}

// ------------------------------------------------------------------------ init
document.addEventListener("DOMContentLoaded", async () => {
  i18nize();
  $("urlForm").addEventListener("submit", downloadInput);
  $("urlInput").addEventListener("input", showDetected);
  $("currentBtn").addEventListener("click", downloadCurrent);
  $("boardBtn").addEventListener("click", downloadBoard);
  $("folderBtn").addEventListener("click", openFolder);
  $("analyzerBtn").addEventListener("click", () => {
    const ig = PD.platforms.byId("instagram");
    const profile = activeTab && activeTab.url && ig.profileName(activeTab.url);
    send({ type: "openAnalyzer", profile: profile || "" });
    window.close();
  });
  $("clearBtn").addEventListener("click", () => send({ type: "clearHistory" }));
  $("helperBadge").addEventListener("click", () => refreshHelper(true));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.jobs) renderJobs(changes.jobs.newValue);
  });
  const res = await send({ type: "getJobs" });
  renderJobs(res.ok ? res.data.jobs : []);
  loadSettings();
  inspectTab();
  refreshHelper(false);
  $("updateBtn").addEventListener("click", startUpdate);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.updateState || changes.updateInfo)) renderUpdate();
  });
  renderUpdate();
  send({ type: "updateInfo", force: false, maxAgeMs: 30 * 60 * 1000 }).then(renderUpdate); // popup: at most every 30 min
});

// ------------------------------------------------------------------------ updates
async function renderUpdate() {
  const r = await chrome.storage.local.get(["updateInfo", "updateState"]);
  const info = r.updateInfo;
  const st = r.updateState;
  const box = $("updateBox");
  const text = $("updateText");
  const btn = $("updateBtn");
  box.className = "update";
  text.title = "";
  const current = chrome.runtime.getManifest().version;
  const age = st ? Date.now() - st.at : Infinity;
  // 1) an update is running right now (stale after 30 min: it was interrupted)
  if (st && st.status === "running" && age < 30 * 60 * 1000) {
    box.hidden = false;
    btn.hidden = true;
    const step = { "update:download": "update_step_download", "update:install": "update_step_install", "update:packages": "update_step_packages" }[st.step];
    text.textContent = t("update_running") + (step ? " " + t(step) : "") + (st.percent != null ? ` ${Math.round(st.percent)}%` : "");
    return;
  }
  // 2) a newer version always wins over older "done" / "failed" notes
  if (info && info.available && info.current === current) {
    box.hidden = false;
    btn.hidden = false;
    text.textContent = t("update_available", [info.latest, info.current]);
    if (st && st.status === "failed" && age < 24 * 3600 * 1000) {
      box.classList.add("bad");
      text.textContent += " · " + (st.manual ? t("update_manual") : t("update_failed", [st.message || ""]));
    }
    return;
  }
  // 3) just updated: a short confirmation (10 minutes)
  if (st && st.status === "done" && st.to === current && age < 10 * 60 * 1000) {
    box.hidden = false;
    btn.hidden = true;
    box.classList.add("ok");
    text.textContent = t("update_done", [st.to]) + (st.warnings && st.warnings.length ? " " + t("update_done_warn") : "");
    text.title = (st.warnings || []).join("\n");
    return;
  }
  box.hidden = true;
}

async function startUpdate() {
  $("updateBtn").disabled = true;
  await send({ type: "applyUpdate" }); // on success the extension reloads itself (this popup closes)
  $("updateBtn").disabled = false;
  renderUpdate();
}
