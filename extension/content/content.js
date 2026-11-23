/* Media Downloader - content script (Pinterest, TikTok, Instagram).
 * Reads the open page for the popup and the right-click menu (what is shown, Pinterest hints,
 * board pins). Shows a small toast only while a download started here runs, plus one fixed button
 * where it fits without covering the site (Instagram profile: Analyze reels; Pinterest pin / board:
 * Download, in Pinterest's left menu). UI is built with DOM
 * APIs inside a closed shadow root so the site's CSS cannot leak in. */
(function () {
  "use strict";
  if (window.__pinterestDownloaderLoaded) return;
  window.__pinterestDownloaderLoaded = true;

  const PD = globalThis.PD;
  const P = PD.pin;
  const t = PD.t;
  const S = PD.STATUS;

  // ========================================================================== DOM helpers
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
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: { message: t("err_EXTENSION_RELOADED") } });
          else resolve(res || { ok: false, error: { message: t("err_UNKNOWN") } });
        });
      } catch (_e) {
        resolve({ ok: false, error: { message: t("err_EXTENSION_RELOADED") } });
      }
    });
  }

  // ========================================================================== page inspection
  function bestFromSrcset(img) {
    let best = img.currentSrc || img.src || "";
    let bestW = 0;
    const ss = img.getAttribute("srcset") || "";
    for (const part of ss.split(",")) {
      const [u, d] = part.trim().split(/\s+/);
      const w = parseFloat(d) || 0;
      if (u && w >= bestW) {
        bestW = w;
        best = u;
      }
    }
    return best;
  }

  function closeupVideo() {
    const vids = Array.from(document.querySelectorAll("video")).filter((v) => {
      const r = v.getBoundingClientRect();
      return r.width >= 180 && r.height >= 180 && r.top < window.innerHeight * 1.2 + window.scrollY;
    });
    vids.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
    return vids[0] || null;
  }

  function closeupImage() {
    const sels = [
      '[data-test-id="pin-closeup-image"] img',
      '[data-test-id="closeup-image"] img',
      '[data-test-id="visual-content-container"] img',
      '[data-test-id="closeup-body-image-container"] img',
    ];
    for (const s of sels) {
      const img = document.querySelector(s);
      if (img) return img;
    }
    const imgs = Array.from(document.images).filter((i) => /pinimg\.com/.test(i.currentSrc || i.src) && i.getBoundingClientRect().width > 200);
    imgs.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
    return imgs[0] || null;
  }

  function metaContent(prop) {
    const m = document.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`);
    return m ? m.getAttribute("content") || "" : "";
  }

  /** URL hints from the live page. Used only if parsing the pin page HTML fails. */
  function collectHints() {
    const imageUrls = [];
    const videoUrls = [];
    let blobVideo = false;
    const img = closeupImage();
    if (img) imageUrls.push(bestFromSrcset(img));
    const v = closeupVideo();
    if (v) {
      for (const s of [v.currentSrc, v.src, ...Array.from(v.querySelectorAll("source")).map((x) => x.src)]) {
        if (!s) continue;
        if (s.startsWith("blob:")) blobVideo = true;
        else if (/pinimg\.com/.test(s)) videoUrls.push(s);
      }
      if (v.poster) imageUrls.push(v.poster);
    }
    if (v && (blobVideo || !videoUrls.length)) {
      // blob: URLs come from hls.js; the real playlist shows up in the resource timeline.
      try {
        const entries = performance.getEntriesByType("resource")
          .map((e) => e.name)
          .filter((n) => /pinimg\.com\/videos\/.+\.(m3u8|mp4)(\?|$)/.test(n) && !/_\d+w\.m3u8/.test(n));
        if (entries.length) videoUrls.push(entries[0]);
      } catch (_e) { /* ignore */ }
    }
    const h1 = document.querySelector("h1");
    return {
      imageUrls: imageUrls.filter(Boolean),
      videoUrls,
      blobVideo,
      thumb: imageUrls[0] || "",
      title: (h1 && h1.textContent.trim()) || metaContent("og:title"),
      description: metaContent("og:description") || metaContent("description"),
      isVideo: !!v,
    };
  }

  function boardName() {
    const h1 = document.querySelector("h1");
    if (h1 && h1.textContent.trim()) return h1.textContent.trim();
    const parts = location.pathname.split("/").filter(Boolean);
    return parts.slice(1).join(" / ");
  }

  function boardPinCount() {
    const txt = document.body ? document.body.innerText.slice(0, 4000) : "";
    const m = txt.match(/([\d.,\s]+)\s*(Pins?|pin)\b/i);
    if (!m) return 0;
    const n = parseInt(m[1].replace(/[^\d]/g, ""), 10);
    return Number.isFinite(n) && n > 0 && n < 200000 ? n : 0;
  }

  // ========================================================================== board collection
  let collecting = null; // {cancel:boolean}

  async function collectBoardPins(onProgress) {
    const state = { cancel: false };
    collecting = state;
    const expected = boardPinCount();
    const found = new Map();
    const grab = () => {
      for (const a of document.querySelectorAll('a[href*="/pin/"]')) {
        const id = P.pinIdFromUrl(a.getAttribute("href"));
        if (!id || found.has(id)) continue;
        const img = a.querySelector("img");
        found.set(id, { id, thumb: img ? bestFromSrcset(img) : "", title: (img && img.alt) || "" });
      }
    };
    window.scrollTo(0, 0);
    await sleep(800);
    let stable = 0;
    let lastCount = -1;
    let lastHeight = -1;
    while (!state.cancel && stable < 5 && found.size < 10000) {
      grab();
      onProgress(found.size, expected);
      if (expected && found.size >= expected) break;
      window.scrollBy(0, Math.round(window.innerHeight * 0.85));
      await sleep(850);
      grab();
      const h = document.scrollingElement ? document.scrollingElement.scrollHeight : 0;
      if (found.size === lastCount && h === lastHeight) stable++;
      else stable = 0;
      lastCount = found.size;
      lastHeight = h;
    }
    collecting = null;
    let pins = Array.from(found.values());
    // Pins after the board's own count are "More ideas" recommendations.
    if (expected && pins.length > expected) pins = pins.slice(0, expected);
    return { pins, cancelled: state.cancel, expected };
  }

  // ========================================================================== toast (only while something runs)
  // No permanent button on the page any more: actions live in the toolbar popup and the right-click
  // menu. This small note appears at the bottom only after the user started something (a download
  // from the right-click menu, a board download) and goes away by itself when it is done.
  const CSS = `
    :host { all: initial; --surface: #1b1b1e; --soft: #27272b; --line: #313137; --fg: #f2f2f4; --muted: #9e9eaa; --good: #3ccf7a; --bad: #ff6b8a;
      --brand: #ff5a45; --brand-grad: linear-gradient(135deg, #e60023, #ff6a3d 60%, #f59e0b); --action-grad: linear-gradient(135deg, #e60023, #c2410c 60%, #b45309);
      --on-color: #fff; --sh-2: 0 6px 24px rgba(0,0,0,.4); --fs-xs: 12px; --fs-s: 12px; --fs-m: 13px; --tap: 28px; color-scheme: dark; }
    .toast { position: fixed; left: 50%; bottom: 24px; z-index: 2147483000; width: min(360px, calc(100vw - 32px)); box-sizing: border-box;
      transform: translate(-50%, 12px); opacity: 0; pointer-events: none; transition: opacity .18s, transform .22s cubic-bezier(.2,.8,.2,1);
      font: var(--fs-m)/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--fg);
      background: var(--surface); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--sh-2); padding: 10px 12px; }
    .toast.on { opacity: 1; transform: translate(-50%, 0); pointer-events: auto; }
    .top { display: flex; align-items: center; gap: 10px; }
    .logo { flex: none; width: 24px; height: 24px; border-radius: 50%; background: var(--action-grad); color: var(--on-color); display: grid; place-items: center; }
    .logo .ico { width: 14px; height: 14px; stroke-width: 2.5; }
    .status { flex: 1; min-width: 0; word-break: break-word; }
    .status.err { color: var(--bad); }
    .status.ok { color: var(--good); }
    .x { flex: none; border: 0; background: transparent; color: var(--muted); width: var(--tap); height: var(--tap); border-radius: 8px; cursor: pointer; display: grid; place-items: center; }
    .x:hover { background: var(--soft); color: var(--fg); }
    .bar { height: 4px; background: var(--soft); border-radius: 2px; overflow: hidden; margin-top: 8px; display: none; }
    .bar.on { display: block; }
    .fill { height: 100%; width: 0; background: var(--brand-grad); transition: width .2s; }
    .fill.indet { width: 35%; animation: slide 1.1s infinite ease-in-out; }
    @keyframes slide { from { margin-left: -35%; } to { margin-left: 100%; } }
    .row { display: flex; gap: 6px; margin-top: 8px; justify-content: flex-end; }
    .row:empty { display: none; }
    button.b { border: 0; border-radius: 999px; min-height: var(--tap); padding: 6px 12px; font: 600 var(--fs-s)/1 inherit; font-family: inherit;
      cursor: pointer; background: var(--soft); color: var(--fg); }
    button.b.primary { background: var(--action-grad); color: var(--on-color); }
    button.b:hover { filter: brightness(1.12); }
    button.b:focus-visible, .x:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
    /* Instagram profile: one fixed button, top right, opens the Reels Analyzer */
    .ig { position: fixed; top: 14px; right: 16px; z-index: 2147483000; display: none; align-items: center; gap: 8px;
      height: 36px; padding: 0 14px 0 6px; border-radius: 999px; border: 1px solid var(--line); background: var(--surface);
      color: var(--fg); box-shadow: var(--sh-2); cursor: pointer; font: 600 var(--fs-m)/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      transition: filter .15s, transform .15s; }
    .ig.on { display: inline-flex; }
    .ig:hover { filter: brightness(1.15); transform: translateY(-1px); }
    .ig:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
    .ig .logo { width: 26px; height: 26px; }
    /* Pinterest pin / board: one round button in Pinterest's own left menu, in the free space under its icons */
    .pin { position: fixed; z-index: 2147483000; display: none; width: 48px; height: 48px; padding: 0; border: 0; border-radius: 50%;
      background: var(--action-grad); color: var(--on-color); box-shadow: var(--sh-2); cursor: pointer; place-items: center;
      transition: filter .15s, transform .15s; }
    .pin.on { display: grid; }
    .pin:hover { filter: brightness(1.12); transform: scale(1.05); }
    .pin:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
    .pin > .ico { width: 22px; height: 22px; stroke-width: 2.25; }
    .pin .lbl { position: absolute; left: calc(100% + 10px); top: 50%; transform: translate(-4px, -50%); opacity: 0; pointer-events: none;
      white-space: nowrap; padding: 7px 12px; border-radius: 999px; border: 1px solid var(--line); background: var(--surface); color: var(--fg);
      box-shadow: var(--sh-2); font: 600 var(--fs-m)/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; transition: opacity .15s, transform .15s; }
    .pin:hover .lbl, .pin:focus-visible .lbl { opacity: 1; transform: translate(0, -50%); }
    .pin .spin { display: none; width: 20px; height: 20px; border-radius: 50%; border: 2.5px solid rgba(255,255,255,.35); border-top-color: var(--on-color);
      box-sizing: border-box; animation: spin .8s linear infinite; }
    .pin.busy .spin { display: block; }
    .pin.busy > .ico { display: none; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .ico { width: 1em; height: 1em; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    @media (prefers-reduced-motion: reduce) { .toast, .fill, .fill.indet, .pin, .pin .lbl { transition: none; animation: none; } }`;

  /** Copy the variables of ui/tokens.css into the toast, so it matches the extension's pages. */
  async function loadTokens(shadow) {
    try {
      const css = await (await fetch(chrome.runtime.getURL("ui/tokens.css"))).text();
      const vars = (css.match(/:root\s*\{([^}]*)\}/) || [])[1];
      if (vars) shadow.appendChild(el("style", { text: `:host { ${vars} }` }));
    } catch (_e) { /* the fallback values above stay */ }
  }

  const ROOT_ID = "media-downloader-root";
  // An older copy of this script (before the extension was reloaded / updated) may still have its
  // UI in the page: remove it, it can no longer talk to the extension.
  for (const id of [ROOT_ID, "pinterest-downloader-root"]) {
    for (const n of document.querySelectorAll("#" + id)) n.remove();
  }

  const ui = {};
  let current = { platform: "", type: "other", pinId: "", contentId: "", url: "" };
  let watch = null; // {batchId?, jobId?, total?}
  let hideTimer = null;
  const icon = (name) => (PD.icon ? PD.icon(name) : document.createTextNode(""));

  function ensureUI() {
    if (ui.host && ui.host.isConnected) return;
    const host = el("div", { id: ROOT_ID });
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.appendChild(el("style", { text: CSS }));
    loadTokens(shadow);
    ui.status = el("div", { class: "status", "aria-live": "polite" });
    ui.fill = el("div", { class: "fill" });
    ui.bar = el("div", { class: "bar" }, [ui.fill]);
    ui.actions = el("div", { class: "row" });
    const close = el("button", { class: "x", type: "button", title: t("btn_close"), "aria-label": t("btn_close"), onclick: hide }, [icon("x")]);
    ui.toast = el("div", { class: "toast", role: "status" }, [
      el("div", { class: "top" }, [el("span", { class: "logo" }, [icon("download")]), ui.status, close]), ui.bar, ui.actions]);
    shadow.appendChild(ui.toast);
    ui.ig = el("button", { class: "ig", type: "button", title: t("btn_analyze_reels") }, [
      el("span", { class: "logo" }, [icon("chart")]), el("span", { text: t("btn_analyze_reels") })]);
    ui.ig.addEventListener("click", async () => {
      const plat = PD.platforms.byId("instagram");
      const res = await send({ type: "openAnalyzer", profile: plat.profileName(location.href) || "" });
      if (!res.ok) {
        setStatus(res.error.message, "err");
        hideLater(8000);
      }
    });
    shadow.appendChild(ui.ig);
    ui.pinLbl = el("span", { class: "lbl" });
    ui.pin = el("button", { class: "pin", type: "button" }, [icon("download"), el("span", { class: "spin" }), ui.pinLbl]);
    ui.pin.addEventListener("pointerenter", pinLabel);
    ui.pin.addEventListener("focus", pinLabel);
    ui.pin.addEventListener("click", onPinButton);
    shadow.appendChild(ui.pin);
    ui.host = host;
    (document.body || document.documentElement).appendChild(host);
  }

  function show() {
    ensureUI();
    clearTimeout(hideTimer);
    ui.toast.classList.add("on");
  }
  function hide() {
    clearTimeout(hideTimer);
    if (ui.toast) ui.toast.classList.remove("on");
    if (collecting) collecting.cancel = true;
  }
  /** Fold away a few seconds after the work is done (longer when there is a button to press). */
  function hideLater(ms) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => ui.toast && ui.toast.classList.remove("on"), ms);
  }

  function setStatus(text, kind) {
    show();
    ui.status.textContent = text || "";
    ui.status.className = "status" + (kind ? " " + kind : "");
  }

  function setProgress(p) {
    ensureUI();
    if (p === false) {
      ui.bar.classList.remove("on");
      return;
    }
    ui.bar.classList.add("on");
    if (p === null || p === undefined) {
      ui.fill.classList.add("indet");
      ui.fill.style.width = "";
    } else {
      ui.fill.classList.remove("indet");
      ui.fill.style.width = Math.max(2, Math.min(100, p)) + "%";
    }
  }

  function setActions(buttons) {
    ensureUI();
    ui.actions.replaceChildren(...buttons);
  }

  function button(label, onClick, primary) {
    return el("button", { class: "b" + (primary ? " primary" : ""), type: "button", text: label, onclick: onClick });
  }

  // ========================================================================== board download (Pinterest)
  async function startBoard() {
    if (collecting) return;
    setActions([button(t("btn_stop"), () => {
      if (collecting) collecting.cancel = true;
    })]);
    setProgress(null);
    setStatus(t("status_collecting", ["…"]));
    const { pins, cancelled, expected } = await collectBoardPins((n, exp) => {
      setStatus(exp ? t("status_collecting_of", [String(n), String(exp)]) : t("status_collecting", [String(n)]));
      if (exp) setProgress((n / exp) * 100);
    });
    setActions([]);
    if (!pins.length) {
      setProgress(false);
      setStatus(t("err_PIN_NOT_FOUND"), "err");
      hideLater(6000);
      return;
    }
    if (cancelled && !confirm(t("confirm_partial_board", [String(pins.length)]))) {
      setProgress(false);
      hide();
      return;
    }
    const res = await send({ type: "downloadBoard", pins, boardName: boardName() });
    if (!res.ok) {
      setProgress(false);
      setStatus(res.error.message, "err");
      hideLater(8000);
      return;
    }
    watch = { batchId: res.data.batchId, total: res.data.count };
    setStatus(t("status_board_queued", [String(res.data.count)]) + (expected && pins.length < expected ? " " + t("note_board_partial") : ""));
  }

  // ========================================================================== Pinterest: fixed button (pin / board pages)
  // Same idea as the Instagram "Analyze reels" button, but Pinterest's top right is its search bar and
  // profile, and the pin grid fills the rest. The one free place is its left menu under its own icons:
  // the button joins that column (same 48px size, same rhythm) and stays out of everything else.
  // If the menu is not there (narrow window, new layout) the button stays hidden: right-click still works.
  const PIN_SIZE = 48;

  function pinRail() {
    const nav = document.getElementById("VerticalNavContent") ||
      Array.from(document.querySelectorAll("nav")).find((n) => getComputedStyle(n).position === "fixed");
    if (!nav) return null;
    const r = nav.getBoundingClientRect();
    if (r.left > 4 || r.width < PIN_SIZE || r.width > 120 || r.height < window.innerHeight * 0.6) return null;
    const items = Array.from(nav.querySelectorAll('a[href], button, [role="button"]'))
      .map((e) => e.getBoundingClientRect())
      .filter((b) => b.width > 0 && b.height > 0)
      .sort((a, b) => a.top - b.top);
    return items.length ? { r, items } : null;
  }

  /** Free slot in the left menu: one step below its top group, never touching its bottom group. */
  function pinSpot() {
    const rail = pinRail();
    if (!rail) return null;
    const { r, items } = rail;
    // the top group ends where the next icon is far away (Settings sits alone at the bottom)
    let last = items[0];
    let step = 0;
    for (let i = 1; i < items.length; i++) {
      const gap = items[i].top - items[i - 1].top;
      if (step && gap > step * 1.8) break;
      step = step || gap;
      last = items[i];
    }
    step = step || PIN_SIZE + 24;
    const top = last.top + step;
    const left = r.left + (r.width - PIN_SIZE) / 2;
    const clash = items.some((b) => top < b.bottom + 12 && top + PIN_SIZE > b.top - 12);
    if (clash || top + PIN_SIZE > Math.min(r.bottom, window.innerHeight) - 12) return null;
    return { top: Math.round(top), left: Math.round(left) };
  }

  function updatePinButton() {
    const on = current.platform === "pinterest" && (current.type === "pin" || current.type === "board");
    if (!on && !ui.pin) return;
    if (on) ensureUI();
    const s = on ? pinSpot() : null;
    ui.pin.classList.toggle("on", !!s);
    if (!s) return;
    ui.pin.style.top = s.top + "px";
    ui.pin.style.left = s.left + "px";
    ui.pin.classList.toggle("busy", !!collecting || !!(watch && watch.fromPin));
  }

  function pinLabel() {
    const text = current.type === "board" ? t("btn_download_board")
      : collectHints().isVideo ? t("btn_download_video") : t("btn_download_image");
    ui.pinLbl.textContent = text;
    ui.pin.setAttribute("aria-label", text);
  }

  async function onPinButton() {
    if (collecting || (watch && watch.fromPin)) return show(); // already working: just show the progress
    if (current.type === "board") {
      startBoard();
      return;
    }
    if (current.type !== "pin" || !current.pinId) return;
    setActions([]);
    setProgress(null);
    setStatus(t("status_queued"));
    const res = await send({ type: "download", pinId: current.pinId, hints: collectHints() });
    if (!res.ok) {
      setProgress(false);
      setStatus(res.error.message, "err");
      hideLater(8000);
      return;
    }
    watch = { jobId: res.data.jobId, fromPin: true };
    updatePinButton();
  }

  // ========================================================================== progress from storage
  function renderJobs(jobs) {
    if (!watch || !Array.isArray(jobs)) return;
    if (watch.jobId) {
      const j = jobs.find((x) => x.id === watch.jobId);
      if (j) renderJob(j);
      return;
    }
    const list = jobs.filter((x) => x.batchId === watch.batchId);
    const total = watch.total || list.length;
    const ok = list.filter((x) => x.status === S.SUCCESS).length;
    const dup = list.filter((x) => x.status === S.DUPLICATE).length;
    const failed = list.filter((x) => x.status === S.FAILED);
    const done = ok + dup + failed.length;
    setProgress(total ? (done / total) * 100 : null);
    setStatus(t("status_board_progress", [String(done), String(total), String(ok), String(dup), String(failed.length)]),
      done >= total ? (failed.length ? "err" : "ok") : "");
    if (done >= total) {
      watch = null;
      if (failed.length) {
        setActions([button(t("btn_retry_failed"), async () => {
          for (const f of failed) await send({ type: "retry", jobId: f.id });
          setActions([]);
          hideLater(2000);
        }, true)]);
        hideLater(15000);
      } else hideLater(5000);
    }
  }

  function renderJob(j) {
    switch (j.status) {
      case S.QUEUED:
        setProgress(null);
        setStatus(j.errorMessage || t("status_queued"));
        break;
      case S.RESOLVING:
        setProgress(null);
        setStatus(t("status_resolving"));
        break;
      case S.DOWNLOADING:
      case S.PROCESSING:
        setProgress(j.progress);
        setStatus(PD.waitText(j) || (j.status === S.PROCESSING ? t("status_processing") : t("status_downloading")) +
          (j.progress != null ? ` ${Math.round(j.progress)}%` : "") + (j.total > 1 ? ` (${j.index || 1}/${j.total})` : ""));
        break;
      case S.SUCCESS: {
        setProgress(false);
        const f = (j.files || [])[0];
        setStatus(t("status_success") + (f && f.name ? `: ${f.name}` : ""), "ok");
        setActions(f && f.path ? [button(t("btn_show_file"), () => send({ type: "reveal", path: f.path }))] : []);
        watch = null;
        hideLater(6000);
        break;
      }
      case S.DUPLICATE:
        setProgress(false);
        setStatus(t("status_duplicate"));
        setActions([button(t("btn_download_again"), async () => {
          const r = await send({ type: "retry", jobId: j.id, force: true });
          if (r.ok) watch = { jobId: r.data.jobId };
          setActions([]);
        })]);
        watch = null;
        hideLater(8000);
        break;
      case S.CANCELLED:
      case S.FAILED:
        setProgress(false);
        setStatus(j.status === S.CANCELLED ? t("status_cancelled") : j.errorMessage || t("err_UNKNOWN"), j.status === S.CANCELLED ? "" : "err");
        setActions([button(t("btn_retry"), async () => {
          const r = await send({ type: "retry", jobId: j.id });
          if (r.ok) watch = { jobId: r.data.jobId };
          setActions([]);
        }, true)]);
        watch = null;
        hideLater(10000);
        break;
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.jobs) renderJobs(changes.jobs.newValue);
  });

  // ========================================================================== messages from the popup / right-click menu
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !msg) return false;
    if (msg.type === "pageInfo") {
      sendResponse({ platform: current.platform, type: current.type, pinId: current.pinId, contentId: current.contentId,
        url: current.url, boardName: current.type === "board" ? boardName() : "",
        hints: current.platform === "pinterest" && current.type === "pin" ? collectHints() : null });
    } else if (msg.type === "startBoard") {
      if (current.platform === "pinterest" && current.type === "board") {
        startBoard();
        sendResponse({ ok: true });
      } else sendResponse({ ok: false });
    } else if (msg.type === "watchJob" && msg.jobId) {
      // a download started from the right-click menu: show its progress here
      watch = { jobId: msg.jobId };
      setActions([]);
      setProgress(null);
      setStatus(t("status_queued"));
      sendResponse({ ok: true });
    } else if (msg.type === "toastError") {
      setActions([]);
      setProgress(false);
      setStatus(msg.text || t("err_UNKNOWN"), "err");
      hideLater(8000);
      sendResponse({ ok: true });
    }
    return false;
  });

  // ========================================================================== SPA navigation
  function onUrlChange() {
    const url = location.href;
    if (url === current.url) return;
    const plat = PD.platforms.detect(url);
    const platform = plat ? plat.id : "";
    const type = plat ? plat.pageType(url) : "other";
    current = { platform, type, pinId: platform === "pinterest" && type === "pin" ? P.pinIdFromUrl(url) : "",
      contentId: plat ? plat.contentId(url) : "", url };
    // a board collection belongs to its page; a running download keeps its toast
    if (collecting) collecting.cancel = true;
    // Instagram profile -> the fixed "Analyze reels" button (only there)
    const igProfile = platform === "instagram" && type === "profile";
    if (igProfile) ensureUI();
    if (ui.ig) ui.ig.classList.toggle("on", igProfile);
  }

  function tick() {
    onUrlChange();
    // Pinterest draws its menu late and moves it with the window size: find the free slot again
    updatePinButton();
  }

  tick();
  setInterval(tick, 700);
  window.addEventListener("popstate", tick);
  window.addEventListener("resize", updatePinButton);
})();
