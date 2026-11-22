/* Media Downloader - content script (Pinterest, TikTok, Instagram).
 * Adds a small toolbar to Pinterest pin/board pages, TikTok video/photo pages and
 * Instagram post/reel/story pages. UI is built with DOM APIs only
 * (no innerHTML) inside a closed shadow root so Pinterest's CSS cannot leak in. */
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

  // ========================================================================== toolbar UI
  // Colors and sizes come from extension/ui/tokens.css: loadTokens() copies its variables into this
  // shadow root (a page stylesheet can't reach in). The values below are only a first-paint fallback.
  const CSS = `
    :host { all: initial; --surface: #1b1b1e; --soft: #27272b; --line: #313137; --fg: #f2f2f4; --muted: #9e9eaa; --good: #3ccf7a; --bad: #ff6b8a;
      --brand: #ff5a45; --brand-grad: linear-gradient(135deg, #e60023, #ff6a3d 60%, #f59e0b); --action-grad: linear-gradient(135deg, #e60023, #c2410c 60%, #b45309);
      --on-color: #fff; --sh-2: 0 6px 24px rgba(0,0,0,.4); --fs-xs: 12px; --fs-s: 12px; --fs-m: 13px; --fs-ml: 14px; --tap: 28px;
      --ease: cubic-bezier(.2, .8, .2, 1); color-scheme: dark; }
    /* A small tab docked to the right edge of the window (out of the way of the site's own buttons).
       Hover or click opens the card; drag the tab up / down to move it. */
    .dock { position: fixed; right: 0; top: 40%; z-index: 2147483000; display: flex; align-items: center; flex-direction: row-reverse;
      font: var(--fs-m)/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--fg); }
    .tab { position: relative; width: 40px; height: 44px; border: 0; padding: 0 0 0 4px; cursor: grab; touch-action: none;
      border-radius: 22px 0 0 22px; background: var(--surface); border: 1px solid var(--line); border-right: 0; box-shadow: var(--sh-2); display: grid; place-items: center;
      opacity: .72; transform: translateX(6px); transition: opacity .15s, transform .2s var(--ease); }
    .dock:hover .tab, .dock.open .tab, .dock.busy .tab, .dock.flash .tab, .tab:focus-visible { opacity: 1; transform: none; }
    .tab:focus-visible, button.b:focus-visible, .x:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
    .tab.drag { cursor: grabbing; }
    .logo { width: 26px; height: 26px; border-radius: 50%; background: var(--action-grad); color: var(--on-color); display: grid; place-items: center; }
    .logo .ico { width: 15px; height: 15px; stroke-width: 2.5; }
    .ring { position: absolute; left: 3px; top: 50%; width: 34px; height: 34px; margin-top: -17px; transform: rotate(-90deg); display: none; }
    .dock.busy .ring { display: block; }
    .ring circle { fill: none; stroke-width: 3; }
    .ring .trk { stroke: var(--soft); }
    .ring .val { stroke: var(--brand); stroke-linecap: round; stroke-dasharray: 100; stroke-dashoffset: 100; transition: stroke-dashoffset .3s; }
    .ring.indet .val { stroke-dashoffset: 70; animation: spin 1s linear infinite; transform-origin: center; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .dot { position: absolute; right: 6px; top: 6px; width: 9px; height: 9px; border-radius: 50%; border: 2px solid var(--surface); display: none; }
    .dock.ok .dot { display: block; background: var(--good); }
    .dock.err .dot { display: block; background: var(--bad); }
    .card { width: 260px; margin-right: 8px; padding: 12px; box-sizing: border-box; border-radius: 16px; background: var(--surface);
      border: 1px solid var(--line); box-shadow: var(--sh-2); opacity: 0; transform: translateX(12px) scale(.98); pointer-events: none;
      transition: opacity .15s, transform .2s var(--ease); }
    .dock.open .card, .dock.flash .card { opacity: 1; transform: none; pointer-events: auto; }
    .head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; font-weight: 700; }
    .head .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .x { border: 0; background: transparent; color: var(--muted); width: var(--tap); height: var(--tap); border-radius: 8px; cursor: pointer; display: grid; place-items: center; }
    .x:hover { background: var(--soft); color: var(--fg); }
    .btns { display: flex; flex-direction: column; gap: 6px; }
    button.b { display: flex; align-items: center; justify-content: center; gap: 6px; border: 0; border-radius: 999px; min-height: 34px; padding: 8px 12px;
      font: 600 var(--fs-m)/1 inherit; font-family: inherit; cursor: pointer; background: var(--soft); color: var(--fg); }
    button.b.primary { background: var(--action-grad); color: var(--on-color); }
    button.b:hover { filter: brightness(1.12); }
    button.b:disabled { opacity: .55; cursor: default; }
    .status { margin-top: 8px; font-size: var(--fs-s); color: var(--muted); word-break: break-word; }
    .status:empty { display: none; }
    .status.err { color: var(--bad); }
    .status.ok { color: var(--good); }
    .bar { height: 4px; background: var(--soft); border-radius: 2px; overflow: hidden; margin-top: 8px; display: none; }
    .bar.on { display: block; }
    .fill { height: 100%; width: 0; background: var(--brand-grad); transition: width .2s; }
    .fill.indet { width: 35%; animation: slide 1.1s infinite ease-in-out; }
    @keyframes slide { from { margin-left: -35%; } to { margin-left: 100%; } }
    .row { display: flex; gap: 6px; margin-top: 8px; }
    .row:empty { display: none; }
    .row button.b { flex: 1; }
    .ico { width: 1em; height: 1em; flex: none; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    @media (prefers-reduced-motion: reduce) { .tab, .card, .fill, .fill.indet, .ring .val { transition: none; animation: none; } }`;

  /** Copy the variables of ui/tokens.css into the panel, so it always matches the extension's pages. */
  async function loadTokens(shadow) {
    try {
      const css = await (await fetch(chrome.runtime.getURL("ui/tokens.css"))).text();
      const vars = (css.match(/:root\s*\{([^}]*)\}/) || [])[1];
      if (vars) shadow.appendChild(el("style", { text: `:host { ${vars} }` }));
    } catch (_e) { /* the fallback values above stay */ }
  }

  const ui = {};
  let current = { platform: "", type: "other", pinId: "", contentId: "", url: "" };
  let watch = null; // {pinId?, batchId?, jobId?, since}

  const icon = (name) => (PD.icon ? PD.icon(name) : document.createTextNode(""));
  let closeTimer = null;

  function buildUI() {
    const host = el("div", { id: "pinterest-downloader-root" });
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.appendChild(el("style", { text: CSS }));
    loadTokens(shadow);
    ui.dock = el("div", { class: "dock", role: "region", "aria-label": "Media Downloader" });
    // the tab: logo + progress ring + result dot
    const ns = "http://www.w3.org/2000/svg";
    ui.ring = document.createElementNS(ns, "svg");
    ui.ring.setAttribute("class", "ring");
    ui.ring.setAttribute("viewBox", "0 0 36 36");
    ui.ring.innerHTML = '<circle class="trk" cx="18" cy="18" r="15.9" pathLength="100"/><circle class="val" cx="18" cy="18" r="15.9" pathLength="100"/>';
    ui.ringVal = ui.ring.lastChild;
    ui.tab = el("button", { class: "tab", type: "button", title: "Media Downloader", "aria-label": "Media Downloader", "aria-expanded": "false" },
      [el("span", { class: "logo" }, [icon("download")]), el("span", { class: "dot" })]);
    ui.tab.prepend(ui.ring);
    // the card
    ui.title = el("span", { class: "t", text: "Media Downloader" });
    const close = el("button", { class: "x", type: "button", title: t("ui_minimize"), "aria-label": t("ui_minimize"), onclick: () => setOpen(false) }, [icon("x")]);
    ui.btns = el("div", { class: "btns" });
    ui.status = el("div", { class: "status", "aria-live": "polite" });
    ui.fill = el("div", { class: "fill" });
    ui.bar = el("div", { class: "bar" }, [ui.fill]);
    ui.actions = el("div", { class: "row" });
    ui.card = el("div", { class: "card" }, [el("div", { class: "head" }, [ui.title, close]), ui.btns, ui.bar, ui.status, ui.actions]);
    ui.dock.append(ui.tab, ui.card);
    shadow.appendChild(ui.dock);
    ui.host = host;
    (document.body || document.documentElement).appendChild(host);

    // open on hover (desktop) or click; leave = close after a moment (not while pinned open by a click)
    ui.dock.addEventListener("mouseenter", () => { clearTimeout(closeTimer); ui.dock.classList.add("hover"); });
    ui.dock.addEventListener("mouseleave", () => {
      ui.dock.classList.remove("hover");
      clearTimeout(closeTimer);
      if (!ui.pinned) closeTimer = setTimeout(() => setOpen(false), 500);
    });
    ui.tab.addEventListener("mouseenter", () => setOpen(true));
    // drag the tab up / down (a click without movement toggles the card)
    let drag = null;
    ui.tab.addEventListener("pointerdown", (e) => {
      drag = { y: e.clientY, top: ui.dock.getBoundingClientRect().top, moved: false };
      ui.tab.setPointerCapture(e.pointerId);
    });
    ui.tab.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dy = e.clientY - drag.y;
      if (Math.abs(dy) > 4) drag.moved = true;
      if (!drag.moved) return;
      ui.tab.classList.add("drag");
      placeDock(drag.top + dy);
    });
    ui.tab.addEventListener("pointerup", () => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      ui.tab.classList.remove("drag");
      if (moved) {
        try { chrome.storage.local.set({ dockTop: ui.dock.getBoundingClientRect().top / window.innerHeight }); } catch (_e) { /* ignore */ }
      } else {
        ui.pinned = !(ui.pinned && ui.dock.classList.contains("open"));
        setOpen(ui.pinned);
      }
    });
    document.addEventListener("pointerdown", (e) => {
      if (ui.pinned && !e.composedPath().includes(ui.host)) { ui.pinned = false; setOpen(false); }
    }, true);
    window.addEventListener("resize", () => placeDock(ui.dock.getBoundingClientRect().top));
    try {
      chrome.storage.local.get("dockTop", (r) => {
        if (r && typeof r.dockTop === "number") placeDock(r.dockTop * window.innerHeight);
      });
    } catch (_e) { /* ignore */ }
  }

  function placeDock(top) {
    const max = window.innerHeight - 60;
    ui.dock.style.top = Math.max(12, Math.min(max, top)) + "px";
  }

  function setOpen(open) {
    if (!open) ui.pinned = false;
    ui.dock.classList.toggle("open", !!open);
    ui.tab.setAttribute("aria-expanded", open ? "true" : "false");
  }

  /** Show the card for a few seconds (a download finished or failed), then fold back. */
  function flash() {
    ui.dock.classList.add("flash");
    clearTimeout(ui.flashTimer);
    ui.flashTimer = setTimeout(() => ui.dock.classList.remove("flash"), 4000);
  }

  function setStatus(text, kind) {
    ui.status.textContent = text || "";
    ui.status.className = "status" + (kind ? " " + kind : "");
    ui.dock.classList.toggle("ok", kind === "ok");
    ui.dock.classList.toggle("err", kind === "err");
    if (kind) flash();
  }

  function setProgress(p) {
    const busy = p !== false && p !== 100;
    ui.dock.classList.toggle("busy", busy);
    if (p === false) {
      ui.bar.classList.remove("on");
      return;
    }
    ui.bar.classList.add("on");
    if (p === null || p === undefined) {
      ui.fill.classList.add("indet");
      ui.fill.style.width = "";
      ui.ring.classList.add("indet");
    } else {
      ui.fill.classList.remove("indet");
      ui.fill.style.width = Math.max(2, Math.min(100, p)) + "%";
      ui.ring.classList.remove("indet");
      ui.ringVal.style.strokeDashoffset = String(100 - Math.max(2, Math.min(100, p)));
    }
  }

  function setActions(buttons) {
    ui.actions.replaceChildren(...buttons);
  }

  function button(label, onClick, primary, ico) {
    return el("button", { class: "b" + (primary ? " primary" : ""), type: "button", onclick: onClick },
      [ico ? icon(ico) : null, el("span", { text: label })]);
  }

  function renderButtons() {
    ui.btns.replaceChildren();
    setActions([]);
    const platObj = PD.platforms.byId(current.platform);
    ui.title.textContent = platObj ? `Media Downloader · ${platObj.name}` : "Media Downloader";
    if (current.platform && current.platform !== "pinterest" && current.type !== "other") {
      // TikTok / Instagram / ...: the local helper (yt-dlp / gallery-dl) does the work; label per post type.
      const plat = PD.platforms.byId(current.platform);
      if (current.type === "profile") {
        // Instagram profile: open the Reels Analyzer (views, statistics, pick & bulk download).
        ui.mainBtn = button(t("btn_analyze_reels"), () => send({ type: "openAnalyzer", profile: plat.profileName(current.url) }), true, "chart");
        ui.btns.append(ui.mainBtn);
      } else {
        ui.mainBtn = button(t(plat && plat.buttonKey ? plat.buttonKey(current.type) : "btn_download"), () => startPin(false), true, "download");
        ui.btns.append(ui.mainBtn, button(t("btn_save_metadata"), startMetadata));
      }
    } else if (current.type === "pin") {
      const hints = collectHints();
      ui.mainBtn = button(hints.isVideo ? t("btn_download_video") : t("btn_download_image"), () => startPin(false), true, "download");
      ui.btns.append(ui.mainBtn, button(t("btn_save_metadata"), startMetadata));
    } else if (current.type === "board") {
      ui.mainBtn = button(t("btn_download_all"), startBoard, true, "download");
      ui.btns.append(ui.mainBtn);
    }
  }

  // ========================================================================== actions
  async function startPin(force) {
    setStatus(t("status_queued"));
    setProgress(null);
    const res = current.platform === "pinterest"
      ? await send({ type: "download", pinId: current.pinId, hints: collectHints(), force: !!force })
      : await send({ type: "download", url: current.url, force: !!force });
    if (!res.ok) {
      setProgress(false);
      setStatus(res.error.message, "err");
      return;
    }
    watch = { jobId: res.data.jobId };
  }

  async function startMetadata() {
    setStatus(t("status_queued"));
    setProgress(null);
    const res = current.platform === "pinterest"
      ? await send({ type: "saveMetadata", pinId: current.pinId, hints: collectHints() })
      : await send({ type: "saveMetadata", url: current.url });
    if (!res.ok) {
      setProgress(false);
      setStatus(res.error.message, "err");
      return;
    }
    watch = { jobId: res.data.jobId };
  }

  async function startBoard() {
    if (collecting) return;
    ui.mainBtn.disabled = true;
    setProgress(null);
    const stop = button(t("btn_stop"), () => {
      if (collecting) collecting.cancel = true;
    });
    setActions([stop]);
    const { pins, cancelled, expected } = await collectBoardPins((n, exp) => {
      setStatus(exp ? t("status_collecting_of", [String(n), String(exp)]) : t("status_collecting", [String(n)]));
      if (exp) setProgress((n / exp) * 100);
    });
    setActions([]);
    ui.mainBtn.disabled = false;
    if (!pins.length) {
      setProgress(false);
      setStatus(t("err_PIN_NOT_FOUND"), "err");
      return;
    }
    if (cancelled && !confirm(t("confirm_partial_board", [String(pins.length)]))) {
      setProgress(false);
      setStatus("");
      return;
    }
    const res = await send({ type: "downloadBoard", pins, boardName: boardName() });
    if (!res.ok) {
      setProgress(false);
      setStatus(res.error.message, "err");
      return;
    }
    watch = { batchId: res.data.batchId, total: res.data.count };
    setStatus(t("status_board_queued", [String(res.data.count)]) + (expected && pins.length < expected ? " " + t("note_board_partial") : ""));
  }

  // ========================================================================== progress from storage
  function renderJobs(jobs) {
    if (!watch || !Array.isArray(jobs)) return;
    if (watch.jobId) {
      const j = jobs.find((x) => x.id === watch.jobId);
      if (!j) return;
      renderJob(j);
    } else if (watch.batchId) {
      const list = jobs.filter((x) => x.batchId === watch.batchId);
      const total = watch.total || list.length;
      const ok = list.filter((x) => x.status === S.SUCCESS).length;
      const dup = list.filter((x) => x.status === S.DUPLICATE).length;
      const failed = list.filter((x) => x.status === S.FAILED);
      const done = ok + dup + failed.length;
      setProgress(total ? (done / total) * 100 : null);
      setStatus(t("status_board_progress", [String(done), String(total), String(ok), String(dup), String(failed.length)]),
        done >= total ? (failed.length ? "err" : "ok") : "");
      if (done >= total && failed.length) {
        setActions([button(t("btn_retry_failed"), async () => {
          for (const f of failed) await send({ type: "retry", jobId: f.id });
          setActions([]);
        })]);
      }
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
        setStatus(
          PD.waitText(j) ||
            (j.status === S.PROCESSING ? t("status_processing") : t("status_downloading")) +
              (j.progress != null ? ` ${Math.round(j.progress)}%` : "") +
              (j.total > 1 ? ` (${j.index || 1}/${j.total})` : "")
        );
        break;
      case S.SUCCESS: {
        setProgress(100);
        const f = (j.files || [])[0];
        const notes = (j.notes || []).join(" ");
        setStatus(t("status_success") + (f && f.name ? `: ${f.name}` : "") + (notes ? ` — ${notes}` : ""), "ok");
        setActions(f && f.path ? [button(t("btn_show_file"), () => send({ type: "reveal", path: f.path }))] : []);
        watch = null;
        break;
      }
      case S.DUPLICATE:
        setProgress(false);
        setStatus(t("status_duplicate"), "");
        setActions([button(t("btn_download_again"), () => startPin(true))]);
        watch = null;
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
        break;
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.jobs) renderJobs(changes.jobs.newValue);
  });

  // ========================================================================== messages from the popup
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !msg) return false;
    if (msg.type === "pageInfo") {
      sendResponse({ platform: current.platform, type: current.type, pinId: current.pinId, contentId: current.contentId,
        url: current.url, boardName: current.type === "board" ? boardName() : "",
        hints: current.platform === "pinterest" && current.type === "pin" ? collectHints() : null });
    } else if (msg.type === "startBoard") {
      if (current.platform === "pinterest" && current.type === "board") {
        ui.pinned = true;
        setOpen(true);
        startBoard();
        sendResponse({ ok: true });
      } else sendResponse({ ok: false });
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
    if (collecting) collecting.cancel = true;
    watch = null;
    if (!ui.host) buildUI();
    ui.host.style.display = type === "other" ? "none" : "";
    ui.dock.classList.remove("ok", "err", "flash");
    setStatus("");
    setProgress(false);
    renderButtons();
    // the closeup video may appear a bit later: refresh the button label
    if (platform === "pinterest" && type === "pin") setTimeout(() => current.url === url && !watch && renderButtons(), 2500);
  }

  onUrlChange();
  setInterval(onUrlChange, 700);
  window.addEventListener("popstate", onUrlChange);
})();
