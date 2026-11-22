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
    :host { all: initial; --surface: #1b1b1e; --soft: #27272b; --fg: #f2f2f4; --muted: #9e9eaa; --good: #3ccf7a; --bad: #ff6b8a;
      --brand-grad: linear-gradient(135deg, #e60023, #ff6a3d 60%, #f59e0b); --action-grad: linear-gradient(135deg, #e60023, #c2410c 60%, #b45309);
      --on-color: #fff; --sh-2: 0 6px 24px rgba(0,0,0,.4); --fs-xs: 12px; --fs-s: 12px; --fs-m: 13px; --fs-ml: 14px; --tap: 28px;
      color-scheme: dark; }
    .wrap { position: fixed; right: 18px; bottom: 18px; z-index: 2147483000; font: var(--fs-m)/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: var(--fg); background: var(--surface); border-radius: 16px; box-shadow: var(--sh-2); padding: 10px; width: 250px; box-sizing: border-box; }
    .wrap.min { width: auto; padding: 6px; }
    .head { display: flex; align-items: center; gap: 6px; font-weight: 600; margin-bottom: 8px; }
    .wrap.min .head { margin: 0; }
    .wrap.min .body { display: none; }
    .logo { width: 18px; height: 18px; border-radius: 50%; background: var(--action-grad); color: var(--on-color); display: inline-flex; align-items: center; justify-content: center; font-size: var(--fs-xs); font-weight: 800; }
    .grow { flex: 1; }
    .icon { border: 0; background: transparent; cursor: pointer; font-size: var(--fs-ml); min-width: var(--tap); min-height: var(--tap); padding: 2px 6px; border-radius: 8px; color: var(--muted); }
    .icon:hover { background: var(--soft); }
    .btns { display: flex; flex-direction: column; gap: 6px; }
    button.b { border: 0; border-radius: 20px; min-height: var(--tap); padding: 8px 12px; font: 600 var(--fs-m)/1 inherit; font-family: inherit; cursor: pointer; background: var(--soft); color: var(--fg); }
    button.b.primary { background: var(--action-grad); color: var(--on-color); }
    button.b:hover { filter: brightness(1.12); }
    button.b:focus-visible, .icon:focus-visible { outline: 2px solid var(--brand, #ff5a45); outline-offset: 2px; }
    button.b:disabled { opacity: .55; cursor: default; }
    .status { margin-top: 8px; font-size: var(--fs-s); color: var(--muted); word-break: break-word; }
    .status.err { color: var(--bad); }
    .status.ok { color: var(--good); }
    .bar { height: 6px; background: var(--soft); border-radius: 3px; overflow: hidden; margin-top: 6px; display: none; }
    .bar.on { display: block; }
    .fill { height: 100%; width: 0; background: var(--brand-grad); transition: width .2s; }
    .fill.indet { width: 35%; animation: slide 1.1s infinite ease-in-out; }
    @keyframes slide { from { margin-left: -35%; } to { margin-left: 100%; } }
    .row { display: flex; gap: 6px; margin-top: 6px; }
    @media (prefers-reduced-motion: reduce) { .fill, .fill.indet { transition: none; animation: none; } }`;

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

  function buildUI() {
    const host = el("div", { id: "pinterest-downloader-root" });
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.appendChild(el("style", { text: CSS }));
    loadTokens(shadow);
    ui.wrap = el("div", { class: "wrap", role: "region", "aria-label": "Media Downloader" });
    ui.min = el("button", { class: "icon", title: t("ui_minimize"), text: "–", onclick: toggleMin });
    ui.head = el("div", { class: "head" }, [el("span", { class: "logo", text: "↓" }), el("span", { class: "grow", text: "Media Downloader" }), ui.min]);
    ui.btns = el("div", { class: "btns" });
    ui.status = el("div", { class: "status", "aria-live": "polite" });
    ui.fill = el("div", { class: "fill" });
    ui.bar = el("div", { class: "bar" }, [ui.fill]);
    ui.actions = el("div", { class: "row" });
    ui.body = el("div", { class: "body" }, [ui.btns, ui.bar, ui.status, ui.actions]);
    ui.wrap.append(ui.head, ui.body);
    shadow.appendChild(ui.wrap);
    try {
      if (sessionStorage.getItem("pd-min") === "1") ui.wrap.classList.add("min");
    } catch (_e) { /* ignore */ }
    ui.host = host;
    (document.body || document.documentElement).appendChild(host);
  }

  function toggleMin() {
    ui.wrap.classList.toggle("min");
    ui.min.textContent = ui.wrap.classList.contains("min") ? "+" : "–";
    try {
      sessionStorage.setItem("pd-min", ui.wrap.classList.contains("min") ? "1" : "0");
    } catch (_e) { /* ignore */ }
  }

  function setStatus(text, kind) {
    ui.status.textContent = text || "";
    ui.status.className = "status" + (kind ? " " + kind : "");
  }

  function setProgress(p) {
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
    ui.actions.replaceChildren(...buttons);
  }

  function button(label, onClick, primary) {
    return el("button", { class: "b" + (primary ? " primary" : ""), type: "button", text: label, onclick: onClick });
  }

  function renderButtons() {
    ui.btns.replaceChildren();
    setActions([]);
    if (current.platform && current.platform !== "pinterest" && current.type !== "other") {
      // TikTok / Instagram / ...: the local helper (yt-dlp / gallery-dl) does the work; label per post type.
      const plat = PD.platforms.byId(current.platform);
      if (current.type === "profile") {
        // Instagram profile: open the Reels Analyzer (views, statistics, pick & bulk download).
        ui.mainBtn = button(t("btn_analyze_reels"), () => send({ type: "openAnalyzer", profile: plat.profileName(current.url) }), true);
        ui.btns.append(ui.mainBtn);
      } else {
        ui.mainBtn = button(t(plat && plat.buttonKey ? plat.buttonKey(current.type) : "btn_download"), () => startPin(false), true);
        ui.btns.append(ui.mainBtn, button(t("btn_save_metadata"), startMetadata));
      }
    } else if (current.type === "pin") {
      const hints = collectHints();
      ui.mainBtn = button(hints.isVideo ? t("btn_download_video") : t("btn_download_image"), () => startPin(false), true);
      ui.btns.append(ui.mainBtn, button(t("btn_save_metadata"), startMetadata));
    } else if (current.type === "board") {
      ui.mainBtn = button(t("btn_download_all"), startBoard, true);
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
        if (ui.wrap.classList.contains("min")) toggleMin();
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
