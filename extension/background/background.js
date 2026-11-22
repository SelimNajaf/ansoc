/* Media Downloader - service worker.
 *
 * Supported platforms come from utils/platforms.js (Pinterest, TikTok, Instagram).
 * Network access is limited to Pinterest pages and the Pinterest CDN (pinimg.com);
 * TikTok and Instagram are handled entirely by the local helper (yt-dlp / gallery-dl).
 * No analytics, no telemetry, no third-party services, no remote code. */
"use strict";

importScripts("/utils/constants.js", "/utils/pinterest.js", "/utils/platforms.js", "/background/native.js");

const P = PD.pin;
const S = PD.STATUS;
const E = PD.ERR;
const PDError = PD.PDError;

// ============================================================================ state
let jobs = []; // newest first; persisted in chrome.storage.local
let settings = Object.assign({}, PD.DEFAULT_SETTINGS);
let loaded = null;
const queue = []; // job ids waiting
let running = 0;
let saveTimer = null;
const batches = new Map(); // batchId -> {total, done, ok, failed, dup, name, platform, jobIds}

function load() {
  if (!loaded) {
    loaded = chrome.storage.local.get(["jobs", "settings"]).then((r) => {
      jobs = Array.isArray(r.jobs) ? r.jobs : [];
      settings = Object.assign({}, PD.DEFAULT_SETTINGS, r.settings || {});
      // Jobs that were running when the worker stopped can be retried by the user.
      for (const j of jobs) {
        // A finished job of a bulk download whose ZIP was never made (Chrome closed mid-way)
        // is not in Downloads either: Retry downloads it again.
        if (!PD.isFinal(j.status) || j.pendingHandoff) {
          Object.assign(j, { status: S.FAILED, errorCode: E.INTERRUPTED, errorMessage: PD.errorText(E.INTERRUPTED),
            pendingHandoff: false });
        }
      }
      persist(true);
    });
  }
  return loaded;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) settings = Object.assign({}, PD.DEFAULT_SETTINGS, changes.settings.newValue || {});
});

function persist(now) {
  const write = () => {
    saveTimer = null;
    jobs = jobs.slice(0, PD.MAX_JOBS);
    chrome.storage.local.set({ jobs });
    updateBadge();
  };
  if (now) {
    clearTimeout(saveTimer);
    write();
  } else if (!saveTimer) {
    saveTimer = setTimeout(write, 300);
  }
}

function updateBadge() {
  const active = jobs.filter((j) => !PD.isFinal(j.status)).length;
  chrome.action.setBadgeBackgroundColor({ color: "#e60023" });
  chrome.action.setBadgeText({ text: active ? String(active) : "" });
}

const findJob = (id) => jobs.find((j) => j.id === id);

function update(job, patch, now) {
  Object.assign(job, patch, { updatedAt: Date.now() });
  persist(now);
}

// Keep the service worker alive while work is in progress (extension API calls reset the idle timer).
let keepAlive = null;
function ensureKeepAlive() {
  if (keepAlive) return;
  keepAlive = setInterval(() => {
    if (running === 0 && queue.length === 0 && !PD.native.hasActiveRequests()) {
      clearInterval(keepAlive);
      keepAlive = null;
      return;
    }
    chrome.runtime.getPlatformInfo(() => void 0);
  }, 20000);
}

// ============================================================================ helpers
function timestamp(d) {
  const p = (n) => String(n).padStart(2, "0");
  d = d || new Date();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assertAllowed(url) {
  const u = P.safeUrl(url);
  if (!u || u.protocol !== "https:" || !(P.isPinterestHost(u.hostname) || P.isPinimgHost(u.hostname) || /^(www\.)?pin\.it$/.test(u.hostname))) {
    throw new PDError(E.FORBIDDEN_HOST, String(url));
  }
  return url;
}

async function safeFetch(url, init) {
  assertAllowed(url);
  let res;
  try {
    res = await fetch(url, Object.assign({ cache: "no-store" }, init));
  } catch (e) {
    throw new PDError(E.NETWORK_ERROR, String(e && e.message));
  }
  if (res.status === 429) throw new PDError(E.RATE_LIMITED, `HTTP 429 ${url}`);
  return res;
}

const EXT_BY_TYPE = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
  "image/avif": "avif", "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm",
};

function extFromUrl(url, fallback) {
  const m = String(url).split("?")[0].match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg") : fallback;
}

/** First candidate the CDN actually serves (HEAD). */
async function probe(urls) {
  let lastStatus = 0;
  for (const url of urls) {
    let res;
    try {
      res = await safeFetch(url, { method: "HEAD", credentials: "omit" });
    } catch (e) {
      if (e.code === E.RATE_LIMITED) throw e;
      continue;
    }
    lastStatus = res.status;
    if (res.ok) {
      const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      return { url, type, size: parseInt(res.headers.get("content-length") || "0", 10), ext: EXT_BY_TYPE[type] || extFromUrl(url, "jpg") };
    }
  }
  throw new PDError(lastStatus === 403 || lastStatus === 404 ? E.PIN_NOT_FOUND : E.NETWORK_ERROR, `No candidate reachable (HTTP ${lastStatus})`);
}

// ============================================================================ resolving pins
async function resolveShortLink(url) {
  const res = await safeFetch(url, { credentials: "omit", redirect: "follow" });
  const id = P.pinIdFromUrl(res.url);
  if (!id) throw new PDError(E.PIN_NOT_FOUND, `Short link did not lead to a pin: ${res.url}`);
  return id;
}

async function fetchPinPage(pinId, withCookies) {
  const res = await safeFetch(P.pinUrl(pinId), {
    credentials: withCookies ? "include" : "omit",
    headers: { Accept: "text/html,application/xhtml+xml" },
  });
  const finalUrl = res.url || "";
  if (/\/login\/?|\/signup/.test(new URL(finalUrl || P.pinUrl(pinId)).pathname)) return { loginWall: true };
  if (res.status === 404 || res.status === 410) return { notFound: true };
  if (res.status === 401 || res.status === 403) return { loginWall: true };
  if (!res.ok) throw new PDError(E.NETWORK_ERROR, `HTTP ${res.status}`);
  const html = await res.text();
  const found = P.findPin(P.extractJsonBlobs(html), pinId);
  return { pin: found.pin, notFound: found.notFound, meta: P.extractMeta(html) };
}

/** -> {info, media[], source} */
async function resolvePin(pinId, hints) {
  let page = null;
  let netErr = null;
  try {
    page = await fetchPinPage(pinId, false); // anonymous first: public pins are fully server-rendered
    if (!page.pin) {
      const authed = await fetchPinPage(pinId, true); // private / login-only pins
      if (authed.pin || !page.loginWall) page = authed.pin ? authed : Object.assign(page, { loginWall: page.loginWall || authed.loginWall });
    }
  } catch (e) {
    if (e.code === E.RATE_LIMITED) throw e;
    netErr = e;
  }

  let media = page && page.pin ? P.extractMedia(page.pin) : [];
  let source = "page";
  if (!media.length && hints) {
    media = P.mediaFromHints(hints);
    source = "hints";
  }
  const info = P.pinInfo(page && page.pin, pinId, (page && page.meta) || {});
  if (hints) {
    info.title = info.title || hints.title || "";
    info.description = info.description || hints.description || "";
    info.author = info.author || hints.author || "";
    info.board = info.board || hints.board || "";
  }
  if (!media.length) {
    if (netErr) throw netErr;
    if (page && page.loginWall) throw new PDError(E.LOGIN_REQUIRED, "Pinterest asked for a login");
    if (page && page.notFound) throw new PDError(E.PIN_NOT_FOUND, `Pin ${pinId} not found or private`);
  }
  return { info, media, source, blobVideo: !!(hints && hints.blobVideo) };
}

// ============================================================================ chrome.downloads
function chromeDownload(url, filename, onProgress) {
  return new Promise((resolve, reject) => {
    let id = null;
    let poll = null;
    const done = (fn, arg) => {
      clearInterval(poll);
      chrome.downloads.onChanged.removeListener(listener);
      fn(arg);
    };
    const listener = (delta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === "complete") {
        chrome.downloads.search({ id }, (items) => done(resolve, items && items[0]));
      } else if (delta.state.current === "interrupted") {
        chrome.downloads.search({ id }, (items) => {
          const reason = (items && items[0] && items[0].error) || (delta.error && delta.error.current) || "INTERRUPTED";
          const code = /FILE_(ACCESS_DENIED|NO_SPACE|NAME_TOO_LONG|TOO_LARGE)/.test(reason) ? E.DIR_CREATE_FAILED
            : /SERVER_(FORBIDDEN|BAD_CONTENT|UNAUTHORIZED)/.test(reason) ? E.PIN_NOT_FOUND : E.DOWNLOAD_INTERRUPTED;
          done(reject, new PDError(code, reason));
        });
      }
    };
    chrome.downloads.onChanged.addListener(listener);
    chrome.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError || downloadId === undefined) {
        done(reject, new PDError(E.DOWNLOAD_INTERRUPTED, chrome.runtime.lastError && chrome.runtime.lastError.message));
        return;
      }
      id = downloadId;
      poll = setInterval(() => {
        chrome.downloads.search({ id }, (items) => {
          const it = items && items[0];
          if (it && it.totalBytes > 0) onProgress && onProgress((it.bytesReceived / it.totalBytes) * 100);
        });
      }, 500);
    });
  });
}

function dataUrlJson(obj) {
  const json = JSON.stringify(obj, null, 2);
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return "data:application/json;base64," + btoa(bin);
}

function metadataFor(job, info, extra) {
  const pm = Object.assign({ board_url: info.board_url, link: info.link }, info.pinterest_metadata || {});
  const username = (String(info.author || "").match(/@([\w.\-]+)\)?$/) || [])[1] || "";
  return Object.assign(
    {
      platform: "pinterest", content_id: info.pin_id, content_url: info.pin_url, media_type: "", original_url: "",
      downloaded_url: "", file_path: "", file_name: "", file_size: "", created_at: info.created_at,
      downloaded_at: new Date().toISOString(), author: info.author, username, title: info.title,
      description: info.description, hashtags: (String(info.description || "").match(/#[^\s#]+/g) || []).map((h) => h.slice(1)),
      board: info.board, tags: info.tags || [], platform_metadata: pm,
      exif_metadata: {}, video_metadata: {}, download_status: "success", error_message: "",
    },
    extra || {}
  );
}

/** Minimal metadata for helper-driven platforms when the download failed. */
function genericMeta(job, extra) {
  return Object.assign({ platform: job.platform, content_id: job.contentId, content_url: job.contentUrl,
    title: job.title || "", download_status: "failed" }, extra || {});
}

// ============================================================================ login cookies
/**
 * When "use Chrome's login" is on, read the platform's own cookies with the
 * chrome.cookies API (current Chrome profile) and hand them to the local helper
 * for this one request. They travel only over the native-messaging pipe, are
 * never stored by the extension or the helper, and the helper only sends them
 * to that platform. No Keychain / macOS permission prompts are needed.
 */
async function loginParams(platform) {
  if (!settings.useBrowserCookies) return { use_browser_cookies: false };
  const plat = PD.platforms.byId(platform);
  const domains = (plat && plat.cookieDomains) || [];
  const cookies = [];
  for (const domain of domains) {
    try {
      for (const c of await chrome.cookies.getAll({ domain })) {
        cookies.push({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure,
          expirationDate: c.expirationDate ? Math.floor(c.expirationDate) : 0 });
      }
    } catch (_e) { /* no host permission for this domain */ }
  }
  return { use_browser_cookies: true, cookies };
}

// ============================================================================ duplicates
async function dupLookup(key) {
  const r = await chrome.storage.local.get("dupIndex");
  return (r.dupIndex || {})[key] || null;
}
/**
 * Duplicate hit only if the earlier file still exists. If the user deleted it,
 * forget the entry so the media is downloaded again.
 */
async function dupHit(key) {
  const hit = await dupLookup(key);
  if (!hit || !hit.path) return hit;
  if (hit.downloadId != null) {
    // Saved through Chrome: Chrome knows whether the file is still there (search() re-checks it).
    const item = await downloadItemById(hit.downloadId);
    if (!item || (item.exists && item.state === "complete")) return hit; // history cleared: trust it
    await dupForget(key);
    return null;
  }
  const st = await PD.native.status();
  if (!st.ok) return hit; // cannot check without the helper (Downloads fallback mode)
  try {
    const res = await PD.native.request("paths_exist", { paths: [hit.path] }, { timeout: 8000 });
    if (res.exists && res.exists[0]) return hit;
  } catch (_e) {
    return hit;
  }
  await dupForget(key);
  return null;
}

async function dupForget(key) {
  const r = await chrome.storage.local.get("dupIndex");
  const idx = r.dupIndex || {};
  delete idx[key];
  await chrome.storage.local.set({ dupIndex: idx });
}

/** After a hand-off: entries that pointed at outbox files now point at the file in Downloads. */
async function dupRepoint(moves) {
  if (!moves.size) return;
  const r = await chrome.storage.local.get("dupIndex");
  const idx = r.dupIndex || {};
  let changed = false;
  for (const entry of Object.values(idx)) {
    const m = entry && moves.get(entry.path);
    if (m) {
      Object.assign(entry, m);
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ dupIndex: idx });
}

function searchDownload(id) {
  return new Promise((resolve) => chrome.downloads.search({ id }, (items) => {
    void chrome.runtime.lastError;
    resolve((items && items[0]) || null);
  }));
}

/** Chrome's download item with an up-to-date "exists" flag: a search() starts the file check,
 *  its answer may still be stale, so ask once more after a short wait when it says "exists". */
async function downloadItemById(id) {
  const first = await searchDownload(id);
  if (!first || !first.exists) return first;
  await sleep(400);
  return (await searchDownload(id)) || first;
}

/**
 * The helper reported a duplicate of a file that was saved through Chrome: is it really still in
 * Downloads? (On macOS the helper cannot look there itself.) false = the user deleted it.
 */
async function duplicateStillThere(res) {
  if (!res || res.existing_download_id == null) return true;
  const item = await downloadItemById(res.existing_download_id);
  return !item || (item.exists && item.state === "complete");
}

// ============================================================================ hand-off to Chrome
const baseOf = (p) => String(p || "").split(/[\\/]/).pop();

/**
 * Files the helper finished wait in its outbox. Chrome downloads them from a one-time
 * 127.0.0.1 link, so they land in the Downloads folder and show up in Chrome's download list.
 * With zipName all paths become ONE download (a ZIP). Returns [{sources, path, name, size, downloadId}].
 */
async function deliver(paths, zipName) {
  const res = await PD.native.request("handoff", { paths, zip_name: zipName || "" }, { timeout: 30 * 60 * 1000 });
  const out = [];
  const report = [];
  try {
    for (const it of res.items || []) {
      const d = await chromeDownload(it.url, it.name);
      out.push({ sources: it.sources, path: d.filename, name: baseOf(d.filename) || it.name,
        size: d.fileSize || d.totalBytes || it.size, downloadId: d.id });
      report.push({ token: it.token, ok: true, final_path: d.filename, download_id: d.id });
    }
  } finally {
    for (const it of res.items || []) if (!report.some((r) => r.token === it.token)) report.push({ token: it.token, ok: false });
    await PD.native.request("handoff_done", { items: report }, { timeout: 60000 }).catch(() => null);
  }
  const moves = new Map();
  for (const o of out) for (const src of o.sources) moves.set(src, { path: o.path, downloadId: o.downloadId });
  await dupRepoint(moves);
  return out;
}

const isMedia = (f) => f && f.media_type !== "metadata";

/**
 * Hand a finished job's files to Chrome. One media file -> as it is; several (carousel,
 * slideshow) -> one ZIP. Jobs of a bulk download wait and go out together as one ZIP at the end
 * (deliverBatch). Returns the job's file list pointing at Downloads.
 */
async function handOff(job, files) {
  const local = (files || []).filter((f) => f && f.path);
  if (!local.length) return files;
  const b = job.batchId && batches.get(job.batchId);
  if (b) {
    b.jobIds.add(job.id);
    job.pendingHandoff = true; // cleared once the batch ZIP is in Downloads (see load())
    return files;
  }
  update(job, { status: S.PROCESSING, progress: null });
  const paths = [];
  for (const f of local) {
    paths.push(f.path);
    if (f.metadata_path) paths.push(f.metadata_path);
  }
  const media = local.filter(isMedia);
  if (media.length > 1) {
    const [z] = await deliver(paths, `${job.platform}_${job.contentId || "media"}_${timestamp()}.zip`);
    return [{ path: z.path, name: z.name, size: z.size, media_type: "zip", count: media.length, downloadId: z.downloadId }];
  }
  const out = await deliver(paths, "");
  const bySrc = new Map(out.map((o) => [o.sources[0], o]));
  return local.map((f) => {
    const o = bySrc.get(f.path);
    const m = f.metadata_path && bySrc.get(f.metadata_path);
    return Object.assign({}, f, o ? { path: o.path, name: o.name, downloadId: o.downloadId } : {},
      m ? { metadata_path: m.path } : {});
  });
}

/** End of a bulk download: every saved file of the batch in one ZIP (one line in Chrome's list). */
async function deliverBatch(b) {
  const all = [...b.jobIds].map(findJob).filter(Boolean);
  try {
    return await deliverBatchFiles(b, all.filter((j) => j.status === S.SUCCESS && (j.files || []).length));
  } catch (e) {
    // The ZIP did not reach Downloads: these jobs did not either. Retry downloads them again.
    for (const j of all) {
      if (j.status === S.SUCCESS && j.pendingHandoff) {
        update(j, { status: S.FAILED, errorCode: E.DOWNLOAD_INTERRUPTED, errorMessage: PD.t("err_handoff_failed") });
      }
    }
    throw e;
  } finally {
    for (const j of all) j.pendingHandoff = false;
    persist(true);
  }
}

async function deliverBatchFiles(b, batchJobs) {
  const paths = [];
  for (const j of batchJobs) {
    for (const f of j.files) {
      if (f.path) paths.push(f.path);
      if (f.metadata_path) paths.push(f.metadata_path);
    }
  }
  if (!paths.length) return null;
  const media = batchJobs.reduce((n, j) => n + j.files.filter(isMedia).length, 0);
  const single = batchJobs.length === 1 && media === 1;
  const name = `${b.name || (b.platform === "pinterest" ? "pinterest_board" : `${b.platform}_collection`)}_${media}_files_${timestamp()}.zip`;
  const out = await deliver(paths, single ? "" : name);
  if (single) {
    const j = batchJobs[0];
    const bySrc = new Map(out.map((o) => [o.sources[0], o]));
    update(j, { files: j.files.map((f) => {
      const o = bySrc.get(f.path);
      return o ? Object.assign({}, f, { path: o.path, name: o.name, downloadId: o.downloadId }) : f;
    }) }, true);
    return out[0];
  }
  const z = out[0];
  for (const j of batchJobs) {
    update(j, { files: [{ path: z.path, name: z.name, size: z.size, media_type: "zip", count: j.files.filter(isMedia).length,
      downloadId: z.downloadId }] });
  }
  persist(true);
  return z;
}

async function dupAdd(key, entry) {
  const r = await chrome.storage.local.get("dupIndex");
  const idx = r.dupIndex || {};
  idx[key] = Object.assign({ at: Date.now() }, entry);
  const keys = Object.keys(idx);
  if (keys.length > 20000) for (const k of keys.slice(0, keys.length - 20000)) delete idx[k];
  await chrome.storage.local.set({ dupIndex: idx });
}

// ============================================================================ downloading one media item
async function downloadItem(job, info, item, baseName, helperOk, setProgress) {
  const pinMeta = metadataFor(job, info);
  const force = !!job.force;

  // ---- choose the source --------------------------------------------------
  let plan; // {kind:'direct', url, ext, mediaType} | {kind:'hls', hlsUrl, mp4Url}
  if (item.type === "image") {
    const best = await probe(item.candidates || [item.url]);
    plan = { kind: "direct", url: best.url, ext: best.ext, mediaType: "image" };
    if (!/\/originals\//.test(best.url)) job.notes.push(PD.t("note_not_original"));
    if (best.ext === "webp") job.notes.push(PD.t("note_webp"));
  } else {
    let mp4 = null;
    if (item.mp4Candidates && item.mp4Candidates.length) {
      try {
        mp4 = await probe(item.mp4Candidates);
      } catch (e) {
        if (e.code === E.RATE_LIMITED) throw e;
      }
    }
    let useHls = false;
    if (item.hlsUrl) {
      if (!mp4) useHls = true;
      else if (helperOk) {
        // Prefer HLS only if it offers a higher resolution than the progressive MP4
        // (equal quality -> MP4, because it is the untouched original file).
        try {
          const txt = await (await safeFetch(item.hlsUrl, { credentials: "omit" })).text();
          const hlsH = P.hlsMaxHeight(txt);
          useHls = hlsH > 0 && hlsH > P.mp4Rank(mp4.url);
        } catch (_e) { /* keep mp4 */ }
      }
    }
    if (useHls) {
      if (!helperOk) throw new PDError(E.HLS_NEEDS_HELPER, item.hlsUrl);
      job.notes.push(PD.t(job.blobVideo ? "note_blob" : "note_hls"));
      plan = { kind: "hls", hlsUrl: item.hlsUrl, mp4Url: mp4 ? mp4.url : "" };
    } else if (mp4) {
      plan = { kind: "direct", url: mp4.url, ext: mp4.ext || "mp4", mediaType: "video" };
    } else {
      throw new PDError(E.NO_MEDIA, "No playable video URL");
    }
  }

  // ---- duplicate check (by media identity) ----------------------------------
  const key = "pinterest:" + P.mediaKey(item);
  if (settings.skipDuplicates && !force) {
    const hit = await dupHit(key);
    if (hit) return { status: "duplicate", existing_path: hit.path || "" };
  }

  // ---- HLS via helper (yt-dlp -> gallery-dl -> FFmpeg) -----------------------
  if (plan.kind === "hls") {
    update(job, { status: S.DOWNLOADING });
    const res = await PD.native.request(
      "download_video",
      { hls_url: plan.hlsUrl, mp4_url: plan.mp4Url, pin_url: info.pin_url, base_name: baseName, pin: pinMeta,
        force, write_metadata: !!settings.saveMetadata, video_quality: settings.compatVideos ? "compatible" : "max", ...(await loginParams("pinterest")) },
      { onProgress: (m) => setProgress(m.percent, m.text), onId: (id) => (job.nativeId = id) }
    );
    if (res.status === "success") await dupAdd(key, { path: res.file.path, contentId: info.pin_id });
    return res;
  }

  // ---- direct file (image / progressive mp4) ---------------------------------
  update(job, { status: S.DOWNLOADING });
  if (helperOk) {
    // The helper fetches the CDN URL itself; the finished file is then handed to Chrome
    // (handOff) so it lands in Downloads and shows up in Chrome's download list.
    const res = await PD.native.request(
      "download_url",
      { url: plan.url, media_type: plan.mediaType, base_name: baseName, pin: pinMeta, force,
        write_metadata: !!settings.saveMetadata, video_quality: settings.compatVideos ? "compatible" : "max" },
      { onProgress: (m) => setProgress(m.percent), onId: (id) => (job.nativeId = id) }
    );
    if (res.status === "success") await dupAdd(key, { path: res.file.path, contentId: info.pin_id });
    return res;
  }

  // ---- no helper: save straight into Downloads with chrome.downloads only ----
  const dl = await chromeDownload(plan.url, `${baseName}.${plan.ext}`, (p) => setProgress(p));
  const fileName = (dl.filename || "").split(/[\\/]/).pop();
  const meta = metadataFor(job, info, {
    media_type: plan.mediaType, original_url: item.url || item.mp4Url || plan.url, downloaded_url: plan.url,
    file_path: dl.filename || "", file_name: fileName, file_size: dl.fileSize || dl.totalBytes || "",
  });
  if (settings.saveMetadata) {
    await chromeDownload(dataUrlJson(meta), `${baseName}.json`).catch(() => null);
  }
  await dupAdd(key, { path: dl.filename, contentId: info.pin_id, downloadId: dl.id });
  return { status: "success", file: { path: dl.filename, name: fileName, size: meta.file_size, media_type: plan.mediaType } };
}

// ============================================================================ job runner
async function runJob(job) {
  if (job.cancelRequested) return markCancelled(job); // cancelled during the polite batch delay
  job.notes = [];
  const helper = await PD.native.status();
  const helperOk = helper.ok;
  job.helperPlatform = helper.ok && helper.info ? helper.info.platform : "";
  update(job, { status: S.RESOLVING, progress: null, errorCode: "", errorMessage: "", notes: [] }, true);

  let info = null;
  try {
    if (job.pipeline === "helper") {
      await runHelperJob(job, helperOk);
      return;
    }
    if (job.kind === "metadata") {
      const r = await resolvePin(job.pinId, job.hints);
      info = r.info;
      const meta = metadataFor(job, info, { media_type: r.media[0] ? r.media[0].type : "" });
      const base = `pinterest_${job.pinId}_${timestamp()}`;
      let path;
      if (helperOk) {
        path = (await PD.native.request("save_metadata", { base_name: base, pin: meta })).metadata_path;
        path = (await handOff(job, [{ path, media_type: "metadata" }]))[0].path;
      } else {
        const d = await chromeDownload(dataUrlJson(meta), `${base}.json`);
        path = d.filename;
      }
      update(job, { status: S.SUCCESS, progress: 100, title: info.title || job.title, files: [{ path, media_type: "metadata" }] }, true);
      return;
    }

    let r;
    try {
      r = await resolvePin(job.pinId, job.hints);
    } catch (e) {
      // Page parsing failed completely: let gallery-dl / yt-dlp try the pin URL.
      if (helperOk && [E.NO_MEDIA, E.NETWORK_ERROR].includes(e.code)) r = { info: P.pinInfo(null, job.pinId, {}), media: [], source: "none" };
      else throw e;
    }
    info = r.info;
    job.blobVideo = r.blobVideo;
    const thumb = r.media[0] ? (r.media[0].type === "image" ? r.media[0].url : r.media[0].thumbnail) : job.thumb;
    update(job, { title: info.title || job.title || "", thumb: thumb || job.thumb || "",
      mediaType: r.media[0] ? r.media[0].type : "", total: r.media.length });

    const ts = timestamp();
    const files = [];
    let dupCount = 0;
    let existing = "";

    if (!r.media.length) {
      if (!helperOk) throw new PDError(E.NO_MEDIA, "No media URL found on the pin page");
      update(job, { status: S.DOWNLOADING });
      const res = await PD.native.request(
        "download_pin",
        { pin_url: info.pin_url, base_name: `pinterest_${job.pinId}_${ts}`, pin: metadataFor(job, info), force: !!job.force,
          write_metadata: !!settings.saveMetadata, video_quality: settings.compatVideos ? "compatible" : "max", ...(await loginParams("pinterest")) },
        { onProgress: (m) => update(job, { progress: m.percent }), onId: (id) => (job.nativeId = id) }
      );
      if (res.status === "duplicate") {
        dupCount = 1;
        existing = res.existing_path;
      } else files.push(...(res.files || [res.file]));
    } else {
      const n = r.media.length;
      for (let i = 0; i < n; i++) {
        const base = n > 1 ? `pinterest_${job.pinId}_${ts}_${i + 1}` : `pinterest_${job.pinId}_${ts}`;
        const setProgress = (p) => {
          const each = p === null || p === undefined ? null : (i * 100 + p) / n;
          update(job, { progress: each, index: i + 1 });
        };
        let res = await downloadItem(job, info, r.media[i], base, helperOk, setProgress);
        if (res.status === "duplicate" && !(await duplicateStillThere(res))) {
          job.force = true; // the earlier copy was deleted from Downloads: download it again
          res = await downloadItem(job, info, r.media[i], base, helperOk, setProgress);
        }
        if (res.status === "duplicate") {
          dupCount++;
          existing = existing || res.existing_path;
        } else files.push(res.file);
      }
    }

    if (!files.length && dupCount) {
      update(job, { status: S.DUPLICATE, progress: 100, existingPath: existing, notes: job.notes }, true);
    } else {
      const saved = helperOk ? await handOff(job, files) : files;
      update(job, { status: S.SUCCESS, progress: 100, files: saved, notes: job.notes, dupCount }, true);
    }
  } catch (e) {
    const code = (e && e.code) || E.UNKNOWN;
    const detail = (e && (e.detail || e.message)) || "";
    if (job.cancelRequested || code === E.CANCELLED) {
      markCancelled(job); // no auto-retry, no "failed" metadata
      return;
    }
    if (PD.RETRYABLE.has(code) && (job.autoRetries || 0) < settings.autoRetries) {
      job.autoRetries = (job.autoRetries || 0) + 1;
      update(job, { status: S.QUEUED, progress: null, errorMessage: PD.t("status_retrying") });
      await sleep(code === E.RATE_LIMITED ? 15000 * job.autoRetries : 3000 * job.autoRetries);
      if (job.cancelRequested) return markCancelled(job); // cancelled while waiting to retry
      return runJob(job);
    }
    update(job, { status: S.FAILED, errorCode: code, errorMessage: PD.errorText(code), errorDetail: String(detail).slice(0, 400) }, true);
    if (helperOk && settings.saveMetadata && job.kind !== "metadata" && code !== E.HOST_EXITED) {
      // Record the failure as a metadata JSON too (download_status: "failed").
      const meta = job.platform === "pinterest" && job.pipeline !== "helper"
        ? metadataFor(job, info || P.pinInfo(null, job.pinId, {}), { download_status: "failed" })
        : genericMeta(job, { media_type: job.mediaType || "" });
      PD.native.request("save_metadata", {
        platform: job.platform, base_name: `${job.platform}_${job.contentId || "unknown"}_${timestamp()}`, status: "failed",
        error_code: code, error_message: String(detail).slice(0, 400), meta,
      }).then((r) => (r && r.metadata_path && !job.batchId ? deliver([r.metadata_path], "") : null)).catch(() => null);
    }
  }
}

/**
 * Cancel a job. Queued: it just leaves the queue. Running: the helper request is stopped
 * (gallery-dl is killed, yt-dlp stops at its next progress step) and runJob() then marks it
 * cancelled. A file that was already completely saved stays saved.
 */
function cancelJob(job) {
  if (!job || PD.isFinal(job.status)) return false;
  const qi = queue.indexOf(job.id);
  if (qi >= 0) {
    queue.splice(qi, 1);
    markCancelled(job);
    finishJob(job);
    return true;
  }
  job.cancelRequested = true;
  update(job, { cancelRequested: true, waitUntil: "", waitReason: "" }, true);
  if (job.nativeId) PD.native.cancel(job.nativeId);
  return true;
}

function markCancelled(job) {
  update(job, { status: S.CANCELLED, progress: null, waitUntil: "", waitReason: "", errorCode: E.CANCELLED,
    errorMessage: PD.t("status_cancelled"), errorDetail: "" }, true);
}

let detailsRequestId = null; // running "reels_details" helper request (cancellable)
let detailsCancelled = false; // Stop pressed during the one-by-one fallback

// ============================================================================ updates
// The published version lives in the GitHub repo's manifest.json (raw.githubusercontent.com
// answers with CORS "*", so no extra permission is needed). Checked at most every 6 hours.
const UPDATE_MANIFEST_URL = "https://raw.githubusercontent.com/SelimNajaf/ansoc/main/extension/manifest.json";
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;

function newerVersion(a, b) {
  const pa = String(a).split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

async function checkForUpdate(force, maxAgeMs) {
  const current = chrome.runtime.getManifest().version;
  const saved = (await chrome.storage.local.get("updateInfo")).updateInfo;
  if (!force && saved && saved.current === current && Date.now() - saved.at < (maxAgeMs || UPDATE_CHECK_MS)) return saved;
  let latest = null;
  try {
    const r = await fetch(UPDATE_MANIFEST_URL, { cache: "no-store", credentials: "omit" });
    if (r.ok) latest = String((await r.json()).version || "") || null;
  } catch (_e) { /* offline: try again next time */ }
  const info = { at: Date.now(), current, latest, available: !!latest && newerVersion(latest, current) };
  await chrome.storage.local.set({ updateInfo: info });
  return info;
}

function enqueue(job) {
  jobs.unshift(job);
  queue.push(job.id);
  persist(true);
  pump();
  return job;
}

// Instagram rate-limits an account quickly (HTTP 429 and minutes of waiting): one download at a time there.
const PLATFORM_CONCURRENCY = { instagram: 1 };
const runningByPlatform = new Map();

function pump() {
  ensureKeepAlive();
  while (running < PD.CONCURRENCY && queue.length) {
    // the first queued job whose platform still has a free slot
    const idx = queue.findIndex((id) => {
      const j = findJob(id);
      if (!j) return true; // stale id: take it out below
      const cap = PLATFORM_CONCURRENCY[j.platform];
      return !cap || (runningByPlatform.get(j.platform) || 0) < cap;
    });
    if (idx < 0) break;
    const job = findJob(queue.splice(idx, 1)[0]);
    if (!job) continue;
    running++;
    runningByPlatform.set(job.platform, (runningByPlatform.get(job.platform) || 0) + 1);
    const plat = PD.platforms.byId(job.platform);
    const delay = job.batchId ? (plat && plat.batchDelayMs) || PD.BOARD_DELAY_MS : 0;
    sleep(delay)
      .then(() => runJob(job))
      .finally(() => {
        running--;
        runningByPlatform.set(job.platform, Math.max(0, (runningByPlatform.get(job.platform) || 1) - 1));
        finishJob(job);
        pump();
      });
  }
}

function finishJob(job) {
  if (job.batchId && batches.has(job.batchId)) {
    const b = batches.get(job.batchId);
    b.done++;
    if (job.status === S.SUCCESS) b.ok++;
    else if (job.status === S.DUPLICATE) b.dup++;
    else if (job.status !== S.CANCELLED) b.failed++; // the user stopped it: not a failure
    if (b.done >= b.total) {
      batches.delete(job.batchId);
      finishBatch(b);
    }
    return;
  }
  if (job.status === S.SUCCESS) {
    const f = job.files && job.files[0];
    notify(PD.t("notif_done_title"), (job.title ? job.title + "\n" : "") + (f ? f.path : ""));
  } else if (job.status === S.FAILED) {
    notify(PD.t("notif_failed_title"), job.errorMessage || "");
  } else if (job.status === S.DUPLICATE) {
    notify(PD.t("notif_dup_title"), job.existingPath || "");
  }
}

/** All jobs of a bulk download are done: hand their files to Chrome as one ZIP, then report. */
async function finishBatch(b) {
  running++; // keeps the service worker (and the helper connection) alive during the hand-off
  ensureKeepAlive();
  let zip = null;
  let err = null;
  try {
    zip = await deliverBatch(b);
  } catch (e) {
    err = e;
  } finally {
    running--;
  }
  if (err) {
    notify(PD.t("notif_failed_title"), PD.t("err_handoff_failed"));
    return;
  }
  // nothing to report when the user cancelled the whole batch
  if (b.ok + b.dup + b.failed > 0) {
    notify(b.name ? PD.t("notif_collection_title", [b.name]) : PD.t("notif_board_title"),
      PD.t("notif_board_body", [String(b.ok), String(b.dup), String(b.failed)]) + (zip ? "\n" + zip.name : ""));
  }
}

function notify(title, message) {
  if (!settings.notifications) return;
  chrome.notifications.create("", {
    type: "basic",
    iconUrl: chrome.runtime.getURL("assets/icon128.png"),
    title: title.slice(0, 120),
    message: String(message || "").slice(0, 300),
    priority: 0,
  });
}

/** TikTok (and any future helper-driven platform): the helper engine does everything. */
async function runHelperJob(job, helperOk) {
  const plat = PD.platforms.byId(job.platform);
  if (!helperOk) throw new PDError(E.HOST_NOT_INSTALLED, `${plat ? plat.name : job.platform} needs the local helper`);
  if (job.kind === "metadata") {
    const res = await PD.native.request("save_metadata_url", { url: job.contentUrl, platform: job.platform, ...(await loginParams(job.platform)) });
    const files = await handOff(job, [{ path: res.metadata_path, name: baseOf(res.metadata_path), media_type: "metadata" }]);
    update(job, { status: S.SUCCESS, progress: 100, mediaType: res.media_type || job.mediaType, files }, true);
    return;
  }
  // Collections have their own duplicate scope (a reel may be added to several collections).
  const key = job.contentId ? `${job.platform}:${job.contentId}${job.collection ? "@" + job.collection : ""}` : "";
  if (key && settings.skipDuplicates && !job.force) {
    const hit = await dupHit(key);
    if (hit) {
      update(job, { status: S.DUPLICATE, progress: 100, existingPath: hit.path || "" }, true);
      return;
    }
  }
  update(job, { status: S.DOWNLOADING, progress: null, waitUntil: "", waitReason: "" });
  const res = await PD.native.request(
    "download",
    { url: job.contentUrl, platform: job.platform, force: !!job.force, ...(await loginParams(job.platform)),
      collection: job.collection || "", write_metadata: !!settings.saveMetadata, video_quality: settings.compatVideos ? "compatible" : "max",
      views: typeof job.views === "number" ? job.views : null },
    {
      onId: (id) => (job.nativeId = id),
      onProgress: (m) => {
        // "wait:11:52:429 Too Many Requests" = the site is rate-limiting, gallery-dl waits and retries
        const w = /^wait:(\d{1,2}:\d{2}):(.*)$/.exec(m.text || "");
        if (w) update(job, { waitUntil: w[1], waitReason: w[2] }, true);
        else update(job, { progress: m.percent == null ? null : m.percent });
      },
    }
  );
  update(job, { waitUntil: "", waitReason: "" });
  const files = res.files || (res.file ? [res.file] : []);
  const notes = [];
  if (res.media_type === "slideshow") {
    const imgs = files.filter((f) => f.kind === "image").length;
    const audio = files.some((f) => f.kind === "audio");
    notes.push(PD.t("note_slideshow", [String(imgs), audio ? PD.t("note_with_audio") : ""]).trim());
  }
  if (res.media_type === "carousel" || res.media_type === "story") notes.push(PD.t("note_carousel", [String(files.length)]));
  if (res.warning === "IMAGES_MISSING") notes.push(PD.t("note_images_missing"));
  if (res.duplicates) notes.push(PD.t("note_some_duplicates", [String(res.duplicates)]));
  if (res.status === "duplicate") {
    if (!job.force && !(await duplicateStillThere(res))) {
      job.force = true; // the earlier copy was deleted from Downloads: download it again
      return runHelperJob(job, helperOk);
    }
    update(job, { status: S.DUPLICATE, progress: 100, mediaType: res.media_type || job.mediaType, existingPath: res.existing_path || "" }, true);
    return;
  }
  if (key && files[0]) await dupAdd(key, { path: files[0].path, contentId: job.contentId });
  const saved = await handOff(job, files);
  update(job, { status: S.SUCCESS, progress: 100, files: saved, notes, mediaType: res.media_type || job.mediaType,
    contentId: res.content_id || job.contentId }, true);
}

function newJob(platform, contentId, extra) {
  const plat = PD.platforms.byId(platform);
  const contentUrl = (extra && extra.contentUrl) || (plat ? plat.contentUrl(contentId) : "");
  return Object.assign(
    {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      kind: "pin",
      platform,
      platformName: plat ? plat.name : platform,
      pipeline: plat ? plat.pipeline : "helper",
      contentId,
      contentUrl,
      pinId: platform === "pinterest" ? contentId : "",
      pinUrl: contentUrl,
      mediaType: "",
      title: "",
      thumb: "",
      status: S.QUEUED,
      progress: null,
      files: [],
      notes: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      force: false,
    },
    extra || {}
  );
}

/** URL / id typed by the user -> {platform, contentId, url, viaHelper}. Detection is local. */
async function parseInput(input) {
  const s = String(input || "").trim();
  if (!s) throw new PDError(E.BAD_URL, "empty");
  if (/^\d{5,25}$/.test(s)) return { platform: "pinterest", contentId: s, url: P.pinUrl(s), viaHelper: false };
  const url = (/^https?:\/\//i.test(s) ? s : "https://" + s).replace(/^http:/i, "https:");
  const plat = PD.platforms.detect(url);
  if (!plat) throw new PDError(E.UNSUPPORTED_PLATFORM, s);
  if (plat.id === "pinterest") {
    let id = P.pinIdFromUrl(url);
    if (!id && P.isShortLink(url)) id = await resolveShortLink(url);
    if (id) return { platform: "pinterest", contentId: id, url: P.pinUrl(id), viaHelper: false };
    if (P.pageType(url) === "board") throw new PDError(E.BOARD_IN_INPUT, url);
    // e.g. a direct i.pinimg.com link: the helper's Pinterest engine handles it
    return { platform: "pinterest", contentId: "", url, viaHelper: true };
  }
  if (plat.validate && !plat.validate(url)) throw new PDError(E.BAD_URL, url);
  return { platform: plat.id, contentId: plat.contentId(url), url, viaHelper: true, mediaType: plat.guessMediaType(url) };
}

function jobFromInput(parsed, extra) {
  if (parsed.viaHelper) {
    return newJob(parsed.platform, parsed.contentId, Object.assign({ pipeline: "helper", contentUrl: parsed.url,
      mediaType: parsed.mediaType || "" }, extra || {}));
  }
  return newJob("pinterest", parsed.contentId, extra);
}

// ============================================================================ messaging
const handlers = {
  async download(msg) {
    const parsed = await parseInput(msg.url || msg.pinId);
    const job = enqueue(jobFromInput(parsed, { hints: msg.hints || null, force: !!msg.force,
      thumb: (msg.hints && msg.hints.thumb) || "" }));
    return { jobId: job.id, platform: job.platform, contentId: job.contentId };
  },
  async saveMetadata(msg) {
    const parsed = await parseInput(msg.url || msg.pinId);
    const job = enqueue(jobFromInput(parsed, { kind: "metadata", hints: msg.hints || null }));
    return { jobId: job.id, platform: job.platform };
  },
  /** Local platform detection for the popup's indicator. */
  async detect(msg) {
    const plat = PD.platforms.detect(msg.url || "");
    return plat ? { platform: plat.id, name: plat.name, mediaType: plat.guessMediaType(msg.url) } : { platform: "" };
  },
  async downloadBoard(msg) {
    const pins = (msg.pins || []).filter((p) => p && /^\d{5,25}$/.test(p.id));
    if (!pins.length) throw new PDError(E.PIN_NOT_FOUND, "No pins found on this board");
    const batchId = `b-${Date.now().toString(36)}`;
    batches.set(batchId, { total: pins.length, done: 0, ok: 0, failed: 0, dup: 0, name: msg.boardName || "",
      platform: "pinterest", jobIds: new Set() });
    // oldest first so the newest end up at the top of the list
    for (const p of pins.slice().reverse()) {
      enqueue(newJob("pinterest", p.id, { batchId, board: msg.boardName || "", thumb: p.thumb || "", title: p.title || "",
        hints: p.thumb ? { imageUrls: [p.thumb] } : null }));
    }
    return { batchId, count: pins.length };
  },
  /** Open the Instagram Reels Analyzer page (optionally for a profile). */
  async openAnalyzer(msg) {
    const q = msg.profile ? `?u=${encodeURIComponent(msg.profile)}` : "";
    await chrome.tabs.create({ url: chrome.runtime.getURL("analyzer/analyzer.html") + q });
    return {};
  },
  /** Reels of a profile with view counts (list only; nothing is downloaded). */
  async listReels(msg) {
    const st = await PD.native.status(true);
    if (!st.ok) throw new PDError((st.error && st.error.code) || E.HOST_NOT_INSTALLED, st.error && st.error.message);
    if (!settings.useBrowserCookies) throw new PDError(E.LOGIN_REQUIRED, "Enable \"use Chrome's login\" first");
    const limit = Math.max(1, Math.min(500, parseInt(msg.limit, 10) || 120));
    const progress = (m) => chrome.runtime.sendMessage({ type: "reelsProgress", percent: m.percent, text: m.text }).catch(() => null);
    ensureKeepAlive();
    running++; // keeps the service worker alive while the list is fetched
    try {
      const login = await loginParams("instagram");
      if (!login.cookies.some((c) => c.name === "sessionid" && c.value)) {
        throw new PDError(E.LOGIN_REQUIRED, "Not logged in to instagram.com in this Chrome profile");
      }
      const period = {};
      if (Number(msg.sinceDays) > 0) period.since_days = Number(msg.sinceDays);
      if (Number(msg.gapDays) > 0) period.gap_days = Number(msg.gapDays);
      return await PD.native.request("list_reels", { profile: String(msg.profile || ""), limit, ...period, ...login },
        { onProgress: progress, timeout: 30 * 60 * 1000 });
    } finally {
      running--;
    }
  },
  /** Quick look at a profile before analysing (one Instagram request, kept for 6 hours). */
  async profileInfo(msg) {
    const name = String(msg.profile || "").trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").split(/[/?#]/)[0].toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/.test(name)) throw new PDError(E.BAD_REQUEST, "bad profile");
    const KEY = "profileInfo";
    const store = (await chrome.storage.local.get(KEY))[KEY] || {};
    if (!msg.refresh && store[name] && Date.now() - store[name].at < 6 * 3600 * 1000) return Object.assign({ cached: store[name].at }, store[name].data);
    await load();
    if (!settings.useBrowserCookies) throw new PDError(E.LOGIN_REQUIRED, "Enable \"use Chrome's login\" first");
    const st = await PD.native.status(true);
    if (!st.ok) throw new PDError((st.error && st.error.code) || E.HOST_NOT_INSTALLED, st.error && st.error.message);
    const data = await PD.native.request("profile_info", { profile: name, ...(await loginParams("instagram")) }, { timeout: 60000 });
    store[name] = { at: Date.now(), data };
    const keys = Object.keys(store).sort((a, b) => store[b].at - store[a].at);
    for (const k of keys.slice(50)) delete store[k];
    await chrome.storage.local.set({ [KEY]: store });
    return data;
  },
  /** Bulk download of picked items into one collection folder. */
  async downloadSelected(msg) {
    const platform = msg.platform || "instagram";
    const plat = PD.platforms.byId(platform);
    if (!plat) throw new PDError(E.UNSUPPORTED_PLATFORM, platform);
    const valid = (msg.items || []).filter((it) => it && typeof it.url === "string" &&
      PD.platforms.detect(it.url) === plat && (!plat.validate || plat.validate(it.url)));
    if (!valid.length) throw new PDError(E.BAD_URL, "No valid links selected");
    const collection = String(msg.collection || "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/\.{2,}/g, ".").replace(/^[._]+|[._]+$/g, "").slice(0, 120) || `${platform}_collection`;
    const batchId = `c-${Date.now().toString(36)}`;
    batches.set(batchId, { total: valid.length, done: 0, ok: 0, failed: 0, dup: 0, name: collection, platform, jobIds: new Set() });
    const out = [];
    for (const it of valid.slice().reverse()) {
      const job = enqueue(newJob(platform, it.code || plat.contentId(it.url), { pipeline: "helper", contentUrl: it.url,
        mediaType: plat.guessMediaType(it.url), title: it.title || "", batchId, collection, views: it.views }));
      out.push({ code: it.code || job.contentId, jobId: job.id });
    }
    return { batchId, folder: collection, jobs: out };
  },
  async retry(msg) {
    const old = findJob(msg.jobId);
    if (!old) throw new PDError(E.BAD_REQUEST, "unknown job");
    jobs = jobs.filter((j) => j.id !== old.id);
    const platform = old.platform || "pinterest";
    const job = enqueue(newJob(platform, old.contentId || old.pinId, { kind: old.kind, hints: old.hints, thumb: old.thumb,
      title: old.title, force: !!msg.force, pipeline: old.pipeline || "extension", contentUrl: old.contentUrl || old.pinUrl,
      mediaType: old.mediaType || "", collection: old.collection || "", views: old.views }));
    return { jobId: job.id };
  },
  /**
   * Caption, audio, location ... of one Instagram reel. Fetched only when the user opens it in
   * the analyzer (one request), then kept in storage so reopening costs nothing.
   */
  async reelDetails(msg) {
    const code = String(msg.code || "");
    if (!/^[A-Za-z0-9_-]{5,64}$/.test(code)) throw new PDError(E.BAD_REQUEST, "bad reel code");
    const KEY = "reelDetails";
    const store = (await chrome.storage.local.get(KEY))[KEY] || {};
    if (!msg.refresh && store[code]) return Object.assign({ cached: store[code].at }, store[code].data);
    await load(); // settings (login permission) must be loaded before loginParams()
    const data = await PD.native.request("reel_details", { code, ...(await loginParams("instagram")) }, { timeout: 90000 });
    store[code] = { at: Date.now(), data };
    const keys = Object.keys(store).sort((a, b) => store[b].at - store[a].at);
    for (const k of keys.slice(400)) delete store[k]; // keep the newest 400
    await chrome.storage.local.set({ [KEY]: store });
    return data;
  },
  /**
   * Details of many reels at once ("Copy descriptions"): cached ones at once, the rest in ONE
   * helper call (one gallery-dl setup, 1-2 s between Instagram requests). Progress goes to the
   * analyzer as {type: "detailsProgress", done, total}; cancelDetails stops it.
   */
  async reelDetailsMany(msg) {
    const codes = [...new Set([].concat(msg.codes || []).map(String))].filter((c) => /^[A-Za-z0-9_-]{5,64}$/.test(c)).slice(0, 200);
    const KEY = "reelDetails";
    const store = (await chrome.storage.local.get(KEY))[KEY] || {};
    const items = {};
    for (const c of codes) if (store[c]) items[c] = store[c].data;
    const missing = codes.filter((c) => !items[c]);
    if (!missing.length) return { items, errors: {}, stopped: null };
    await load();
    const login = await loginParams("instagram");
    const progress = (done, total) => chrome.runtime.sendMessage({ type: "detailsProgress", done, total }).catch(() => null);
    let res;
    try {
      res = await PD.native.request("reels_details", { codes: missing, ...login }, {
        timeout: 30 * 60 * 1000,
        onId: (id) => (detailsRequestId = id),
        onProgress: (m) => {
          const p = /^details:(\d+)\/(\d+)$/.exec(m.text || "");
          if (p) progress(Number(p[1]), Number(p[2]));
        },
      }).finally(() => (detailsRequestId = null));
    } catch (e) {
      // a helper older than 2.4.5 has no batch action: fetch one by one with the single-reel action
      if (!(e.code === E.BAD_REQUEST && /Unknown action/i.test(e.detail || e.message || ""))) throw e;
      res = { items: {}, errors: {}, stopped: null };
      detailsCancelled = false;
      for (let i = 0; i < missing.length; i++) {
        if (detailsCancelled) {
          res.stopped = "CANCELLED";
          break;
        }
        progress(i + 1, missing.length);
        try {
          res.items[missing[i]] = await PD.native.request("reel_details", { code: missing[i], ...login }, {
            timeout: 120000, onId: (id) => (detailsRequestId = id),
          });
        } catch (err) {
          res.errors[missing[i]] = { code: err.code || E.UNKNOWN, message: err.detail || err.message || "" };
          if ([E.RATE_LIMITED, E.LOGIN_REQUIRED, E.CANCELLED].includes(err.code)) {
            res.stopped = err.code;
            break;
          }
        } finally {
          detailsRequestId = null;
        }
      }
    }
    const now = Date.now();
    for (const [c, data] of Object.entries(res.items || {})) {
      store[c] = { at: now, data };
      items[c] = data;
    }
    const keys = Object.keys(store).sort((a, b) => store[b].at - store[a].at);
    for (const k of keys.slice(400)) delete store[k];
    await chrome.storage.local.set({ [KEY]: store });
    return { items, errors: res.errors || {}, stopped: res.stopped || null };
  },
  async cancelDetails() {
    detailsCancelled = true; // stops the one-by-one fallback between reels
    if (detailsRequestId) await PD.native.cancel(detailsRequestId);
    return {};
  },
  async updateInfo(msg) {
    return checkForUpdate(!!msg.force, msg.maxAgeMs);
  },
  /** One-click update: the helper downloads + installs the latest version, then we reload. */
  async applyUpdate() {
    const from = chrome.runtime.getManifest().version;
    await chrome.storage.local.set({ updateState: { status: "running", at: Date.now() } });
    try {
      const res = await PD.native.request("self_update", {}, {
        timeout: 20 * 60 * 1000,
        onProgress: (m) => chrome.storage.local.set({ updateState: { status: "running", step: m.text || "", percent: m.percent, at: Date.now() } }),
      });
      await chrome.storage.local.set({
        updateState: { status: "done", from, to: res.to, warnings: res.warnings || [], at: Date.now() },
        updateInfo: null,
      });
      setTimeout(() => chrome.runtime.reload(), 400); // run the new files
      return res;
    } catch (e) {
      // an old helper doesn't know "self_update" yet: the user runs the Update script once
      const old = e.code === E.BAD_REQUEST && /Unknown action/i.test(e.detail || e.message || "");
      await chrome.storage.local.set({ updateState: { status: "failed", manual: old, message: e.detail || e.message || "", at: Date.now() } });
      throw e;
    }
  },
  async cancel(msg) {
    return { cancelled: cancelJob(findJob(msg.jobId)) ? 1 : 0 };
  },
  async cancelMany(msg) {
    // newest first, so queued jobs leave the queue before the running ones are stopped
    let n = 0;
    for (const id of [].concat(msg.jobIds || [])) if (cancelJob(findJob(id))) n++;
    return { cancelled: n };
  },
  async helperStatus(msg) {
    return PD.native.status(!!msg.force);
  },
  async openFolder() {
    chrome.downloads.showDefaultFolder(); // everything is saved into Chrome's Downloads folder
    return {};
  },
  async reveal(msg) {
    // Saved through Chrome: let Chrome show it (works for files in Downloads on every OS).
    const items = msg.path ? await new Promise((resolve) => chrome.downloads.search({ filename: msg.path }, (r) => {
      void chrome.runtime.lastError;
      resolve(r || []);
    })) : [];
    const item = items.find((it) => it.exists && it.state === "complete");
    if (item) {
      chrome.downloads.show(item.id);
      return { shown: item.id };
    }
    // older downloads on the Desktop (Desktop/Medias, Desktop/MediaDownloader): the helper opens them
    const st = await PD.native.status();
    if (st.ok && msg.path) {
      try {
        return await PD.native.request("reveal", { path: msg.path }, { timeout: 10000 });
      } catch (_e) { /* not a helper file */ }
    }
    chrome.downloads.showDefaultFolder();
    return { fallback: true };
  },
  async clearHistory() {
    jobs = jobs.filter((j) => !PD.isFinal(j.status));
    persist(true);
    return {};
  },
  async getJobs() {
    return { jobs };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only accept messages from this extension (popup / our content script).
  if (sender.id !== chrome.runtime.id || !msg || !handlers[msg.type]) return false;
  load()
    .then(() => handlers[msg.type](msg, sender))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: { code: e.code || E.UNKNOWN, message: PD.errorText(e.code), detail: e.detail || String(e.message || e) } }));
  return true;
});

chrome.notifications.onClicked.addListener((id) => {
  handlers.openFolder({}).catch(() => null);
  chrome.notifications.clear(id);
});

chrome.runtime.onInstalled.addListener(() => {
  load();
  chrome.storage.local.get("settings").then((r) => {
    if (!r.settings) chrome.storage.local.set({ settings: PD.DEFAULT_SETTINGS });
  });
});
chrome.runtime.onStartup.addListener(() => {
  load();
  checkForUpdate(false).catch(() => null); // quietly, at most every 6 hours
});
load();
