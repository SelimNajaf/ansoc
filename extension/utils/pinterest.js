/* Pinterest URL / page / JSON parsing. Pure functions, no DOM required, so it runs
 * in the service worker, the content script, the popup and under Node (tests). */
(function (root) {
  "use strict";
  const PD = (root.PD = root.PD || {});
  const P = (PD.pin = {});

  // ------------------------------------------------------------------ hosts / URLs
  const PINTEREST_HOST_RE =
    /(^|\.)pinterest\.(com|ca|co\.uk|de|fr|es|it|pt|ch|at|ie|nz|ph|cl|jp|kr|se|dk|ru|com\.au|com\.mx|co\.kr|com\.br)$/i;
  const PINIMG_RE = /(^|\.)pinimg\.com$/i;

  P.isPinterestHost = (h) => PINTEREST_HOST_RE.test(h || "");
  P.isPinimgHost = (h) => PINIMG_RE.test(h || "");

  P.safeUrl = function (u, base) {
    try {
      return new URL(u, base);
    } catch (_e) {
      return null;
    }
  };

  /** Pin id from /pin/123/, /pin/some-slug--123/ or a bare number. */
  P.pinIdFromUrl = function (url) {
    if (!url) return "";
    const s = String(url).trim();
    if (/^\d{5,25}$/.test(s)) return s;
    const m = s.match(/\/pin\/(?:[^/?#]*--)?(\d{5,25})(?:[/?#]|$)/);
    return m ? m[1] : "";
  };

  P.pinUrl = (id) => `https://www.pinterest.com/pin/${id}/`;
  P.isShortLink = (url) => {
    const u = P.safeUrl(url);
    return !!u && /^(www\.)?pin\.it$/i.test(u.hostname);
  };

  const RESERVED = new Set([
    "pin", "search", "ideas", "today", "settings", "business", "_", "explore", "categories",
    "topics", "login", "logout", "signup", "password", "about", "news_hub", "notifications",
    "inbox", "messages", "homefeed", "videos", "shopping", "edit", "following", "followers",
    "_saved", "_created", "_profile", "pins", "boards", "analytics", "board", "invite", "oauth",
  ]);

  /** "pin" | "board" | "other" for a Pinterest URL. */
  P.pageType = function (url) {
    const u = P.safeUrl(url);
    if (!u || !P.isPinterestHost(u.hostname)) return "other";
    if (P.pinIdFromUrl(u.pathname)) return "pin";
    const parts = u.pathname.split("/").filter(Boolean);
    if ((parts.length === 2 || parts.length === 3) && !RESERVED.has(parts[0]) && !RESERVED.has(parts[1]) &&
        !parts[0].startsWith("_") && !parts[1].startsWith("_")) {
      return "board";
    }
    return "other";
  };

  // ------------------------------------------------------------------ pinimg URLs
  /** https://i.pinimg.com/<size>/aa/bb/cc/<hash>.<ext> -> parts */
  P.parsePinimg = function (url) {
    const u = P.safeUrl(url);
    if (!u || !P.isPinimgHost(u.hostname)) return null;
    const m = u.pathname.match(/^\/([^/]+)\/([0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{2}\/([0-9a-f]{16,64}))\.([a-z0-9]+)$/i);
    if (!m) return null;
    return { host: u.hostname, size: m[1], path: m[2], hash: m[3].toLowerCase(), ext: m[4].toLowerCase() };
  };

  P.sizeRank = function (size) {
    if (!size) return 0;
    if (size === "originals") return 1e9;
    const m = size.match(/^(\d+)x(\d+)?/);
    return m ? parseInt(m[1], 10) : 0;
  };

  P.isAvatarOrThumb = (url) => /\/(\d+x\d+_RS|videos\/thumbnails|user|upload)\//.test(url) || /s\.pinimg\.com/.test(url);

  /** Candidate URLs best-first: originals (several extensions), then the big sizes. */
  P.imageCandidates = function (url) {
    const p = P.parsePinimg(url);
    if (!p) return [url];
    const exts = [p.ext, "jpg", "png", "gif", "webp"].filter((e, i, a) => a.indexOf(e) === i);
    const out = exts.map((e) => `https://i.pinimg.com/originals/${p.path}.${e}`);
    for (const s of ["1200x", "736x", "564x", "474x"]) out.push(`https://i.pinimg.com/${s}/${p.path}.${p.ext}`);
    out.push(url);
    return out.filter((e, i, a) => a.indexOf(e) === i);
  };

  P.videoSignature = function (url) {
    const m = String(url).match(/\/([0-9a-f]{16,64})(?:_\w+)?\.(?:m3u8|mp4|mpd)/i);
    return m ? m[1].toLowerCase() : "";
  };

  P.mp4Rank = function (url) {
    const s = String(url);
    const m = s.match(/\/(\d{3,4})p\//) || s.match(/_(\d{3,4})w\.mp4/i); // .../720p/... or ..._720w.mp4
    if (m) return parseInt(m[1], 10);
    return 0; // unknown resolution
  };

  /** Highest variant (shorter side, i.e. 720 for 720x1280) from an HLS master playlist. */
  P.hlsMaxHeight = function (text) {
    let best = 0;
    const re = /RESOLUTION=(\d+)x(\d+)/g;
    let m;
    while ((m = re.exec(text || ""))) best = Math.max(best, Math.min(+m[1], +m[2]));
    return best;
  };

  // ------------------------------------------------------------------ HTML -> JSON blobs
  /** Extract every embedded JSON payload Pinterest puts in its server-rendered HTML. */
  P.extractJsonBlobs = function (html) {
    const blobs = [];
    const push = (txt) => {
      try {
        blobs.push(JSON.parse(txt));
      } catch (_e) { /* ignore malformed */ }
    };
    const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = scriptRe.exec(html || ""))) {
      const attrs = m[1];
      const body = m[2];
      if (/id="__PWS_(DATA|INITIAL_PROPS)__"/.test(attrs) || /application\/ld\+json/.test(attrs)) {
        push(body);
      } else if (/data-relay-response|data-relay-completed-request/.test(attrs) || body.indexOf("__PWS_RELAY_REGISTER") !== -1) {
        const r = body.match(/__PWS_RELAY_REGISTER_COMPLETED_REQUEST__\(\s*"[^"]*"\s*,\s*([\s\S]*)\)\s*;?\s*$/);
        if (r) push(r[1]);
        else if (/^\s*[{[]/.test(body)) push(body);
      }
    }
    return blobs;
  };

  P.extractMeta = function (html) {
    const meta = {};
    const re = /<meta\s+[^>]*>/gi;
    let m;
    while ((m = re.exec(html || ""))) {
      const tag = m[0];
      const key = (tag.match(/(?:property|name)="([^"]+)"/) || [])[1];
      const val = (tag.match(/content="([^"]*)"/) || [])[1];
      if (key && val !== undefined && /^(og:|twitter:|pinterestapp:|description$)/.test(key)) meta[key] = decodeEntities(val);
    }
    return meta;
  };

  function decodeEntities(s) {
    return String(s)
      .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  }

  // ------------------------------------------------------------------ JSON -> pin object
  function isObj(o) {
    return o && typeof o === "object" && !Array.isArray(o);
  }

  function looksLikePin(o) {
    return (
      o.__typename === "Pin" || o.type === "pin" || "images_orig" in o || "imageSpec_orig" in o ||
      "videos" in o || "storyPinData" in o || "story_pin_data" in o || "images" in o || "pinner" in o
    );
  }

  function deepMerge(a, b) {
    if (!isObj(a) || !isObj(b)) return b === undefined || b === null ? a : b;
    const out = Object.assign({}, a);
    for (const [k, v] of Object.entries(b)) {
      out[k] = k in out ? deepMerge(out[k], v) : v;
    }
    return out;
  }

  /** Find and merge every object describing the pin with this id. */
  P.findPin = function (blobs, pinId) {
    let merged = null;
    let count = 0;
    let notFound = false;
    const seen = new Set();
    const walk = (o, depth) => {
      if (!o || typeof o !== "object" || depth > 40 || seen.has(o)) return;
      seen.add(o);
      if (Array.isArray(o)) {
        for (const v of o) walk(v, depth + 1);
        return;
      }
      if (o.__typename === "PinNotFound" || o.__isError === "PinNotFound") notFound = true;
      const id = o.entityId !== undefined ? String(o.entityId) : o.id !== undefined ? String(o.id) : "";
      if (id === pinId && looksLikePin(o)) {
        merged = merged ? deepMerge(merged, o) : o;
        count++;
      }
      for (const v of Object.values(o)) if (v && typeof v === "object") walk(v, depth + 1);
    };
    for (const b of blobs) walk(b, 0);
    return { pin: merged, count, notFound: notFound && !merged };
  };

  // ------------------------------------------------------------------ pin -> metadata
  const pick = (o, ...keys) => {
    for (const k of keys) {
      const v = k.split(".").reduce((acc, kk) => (acc && acc[kk] !== undefined ? acc[kk] : undefined), o);
      if (v !== undefined && v !== null && v !== "") return typeof v === "string" ? v.trim() : v;
    }
    return "";
  };

  function toIso(d) {
    if (!d) return "";
    const t = new Date(d);
    return isNaN(t.getTime()) ? String(d) : t.toISOString();
  }

  // Large / noisy subtrees we drop from pinterest_metadata.
  const NOISY = new Set(["interestForGoldenSet", "trackingParams", "tracking_params", "seoRelatedInterests",
    "annotationsWithLinksArray", "logging_id", "aggregatedPinData", "aggregated_pin_data"]);

  function trimmed(o, depth) {
    if (depth > 6) return undefined;
    if (Array.isArray(o)) return o.slice(0, 50).map((v) => trimmed(v, depth + 1));
    if (!isObj(o)) return o;
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      if (NOISY.has(k) || k === "__typename") continue;
      out[k] = trimmed(v, depth + 1);
    }
    return out;
  }

  /** Normalised metadata for the helper's JSON sidecar. */
  P.pinInfo = function (pin, pinId, meta) {
    pin = pin || {};
    meta = meta || {};
    const pinner = pin.pinner || pin.nativeCreator || pin.native_creator || pin.originPinner || pin.origin_pinner || {};
    const fullName = pick(pinner, "fullName", "full_name");
    const username = pick(pinner, "username");
    const tags = new Set();
    const pj = pin.pinJoin || pin.pin_join || {};
    for (const a of pj.visualAnnotation || pj.visual_annotation || []) if (typeof a === "string") tags.add(a);
    for (const h of pin.hashtags || []) if (typeof h === "string") tags.add(h.replace(/^#/, ""));
    for (const a of pj.annotationsWithLinksArray || pj.annotations_with_links_array || []) if (a && a.name) tags.add(a.name);
    const board = pin.board || {};
    return {
      pin_id: pinId,
      pin_url: P.pinUrl(pinId),
      title: pick(pin, "title", "gridTitle", "grid_title", "closeupUnifiedTitle", "seoTitle", "seo_title", "unauthOnPageTitle") ||
        meta["og:title"] || "",
      description: pick(pin, "description", "closeupUnifiedDescription", "closeup_unified_description",
        "closeupDescription", "seoDescription", "seo_description", "autoAltText", "auto_alt_text") ||
        meta["og:description"] || meta.description || "",
      author: fullName && username ? `${fullName} (@${username})` : fullName || username || "",
      board: pick(board, "name"),
      board_url: board.url ? new URL(board.url, "https://www.pinterest.com").href : "",
      created_at: toIso(pick(pin, "createdAt", "created_at")),
      link: pick(pin, "link", "trackedLink"),
      tags: Array.from(tags).slice(0, 50),
      pinterest_metadata: trimmed(pin, 0) || {},
    };
  };

  // ------------------------------------------------------------------ pin -> media list
  // Sub-trees that belong to other entities (users, boards, recommendations).
  const EXCLUDE_KEY = /^(pinner|nativeCreator|native_creator|originPinner|origin_pinner|board|owner|user|creator|sponsor|viaPinner|via_pinner|closeupAttribution|closeup_attribution|aggregatedPinData|aggregated_pin_data|pinJoin|pin_join|richSummary|rich_summary|richMetadata|rich_metadata|linkDomain|link_domain|did_it_data|comments?|reactions?|related\w*|shopping\w*|products?|attribution|embed|ad\w*Data|imageMediumUrl|imageLargeUrl)$/i;

  function collectStrings(node, out, depth) {
    if (depth > 12 || node === null || node === undefined) return out;
    if (typeof node === "string") {
      if (/^https:\/\/[^\s"']*pinimg\.com\//.test(node)) out.push(node);
      return out;
    }
    if (Array.isArray(node)) {
      for (const v of node) collectStrings(v, out, depth + 1);
      return out;
    }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (EXCLUDE_KEY.test(k)) continue;
        collectStrings(v, out, depth + 1);
      }
    }
    return out;
  }

  /** Best video in a subtree: {mp4Url, hlsUrl, signature, mp4Rank, thumbnail} or null. */
  P.videoFromNode = function (node) {
    const urls = collectStrings(node, [], 0);
    const mp4 = urls.filter((u) => /\.mp4(\?|$)/i.test(u));
    const hls = urls.filter((u) => /\.m3u8(\?|$)/i.test(u));
    if (!mp4.length && !hls.length) return null;
    mp4.sort((a, b) => P.mp4Rank(b) - P.mp4Rank(a));
    // h264 "hls" master is the most compatible; h265 variant kept as alternative.
    hls.sort((a, b) => (/\/hls\//.test(b) ? 1 : 0) - (/\/hls\//.test(a) ? 1 : 0));
    const thumb = urls.find((u) => /videos\/thumbnails/.test(u)) || "";
    return {
      type: "video",
      mp4Url: mp4[0] || "",
      mp4Candidates: Array.from(new Set(mp4)),
      hlsUrl: hls[0] || "",
      hlsCandidates: Array.from(new Set(hls)),
      mp4Rank: mp4[0] ? P.mp4Rank(mp4[0]) : 0,
      signature: P.videoSignature(hls[0] || mp4[0]),
      thumbnail: thumb,
    };
  };

  /** Best image per distinct picture (hash) in a subtree. */
  P.imagesFromNode = function (node) {
    const groups = new Map();
    for (const u of collectStrings(node, [], 0)) {
      if (P.isAvatarOrThumb(u)) continue;
      const p = P.parsePinimg(u);
      if (!p || !/^(jpe?g|png|gif|webp|avif)$/.test(p.ext)) continue;
      const g = groups.get(p.hash);
      if (!g || P.sizeRank(p.size) > P.sizeRank(g.size)) groups.set(p.hash, { url: u, size: p.size, hash: p.hash, ext: p.ext });
    }
    return Array.from(groups.values()).map((g) => ({
      type: "image",
      url: g.url,
      signature: g.hash,
      isOriginal: g.size === "originals",
      ext: g.ext,
      candidates: P.imageCandidates(g.url),
    }));
  };

  function mediaFromPage(page) {
    if (!page || typeof page !== "object") return [];
    const blocks = page.blocks || page.Blocks;
    const parts = Array.isArray(blocks) && blocks.length ? blocks : [page];
    const out = [];
    for (const b of parts) {
      const v = P.videoFromNode(b);
      if (v) out.push(v);
      else out.push(...P.imagesFromNode(b));
    }
    return out;
  }

  /** Every media item of a pin, in order. Handles video, image, carousel and story/idea pins. */
  P.extractMedia = function (pin) {
    if (!pin) return [];
    const story = pin.storyPinData || pin.story_pin_data;
    const pages = story && (story.pages || story.pagesPreview || story.pages_preview);
    if (Array.isArray(pages) && pages.length) {
      const items = pages.flatMap(mediaFromPage);
      if (items.length) return dedupe(items);
    }
    const carousel = pin.carouselData || pin.carousel_data;
    const slots = carousel && (carousel.carouselSlots || carousel.carousel_slots);
    if (Array.isArray(slots) && slots.length) {
      const items = slots.flatMap((s) => P.imagesFromNode(s));
      if (items.length) return dedupe(items);
    }
    if (pin.videos) {
      const v = P.videoFromNode(pin.videos);
      if (v) return [v];
    }
    // Plain image pin: only look at the pin's own image fields (not the whole object).
    const imgNode = {};
    for (const [k, v] of Object.entries(pin)) {
      if (/^(images?(_\w+)?|imageSpec_\w+|imageLargeUrl|imageMediumUrl|image_large_url)$/i.test(k)) imgNode["x" + k] = v;
    }
    let imgs = P.imagesFromNode(imgNode);
    if (!imgs.length) {
      const v = P.videoFromNode(pin);
      if (v) return [v];
      imgs = P.imagesFromNode(pin);
    }
    // A pin image is one picture: keep the most common hash first.
    return dedupe(imgs).slice(0, 1);
  };

  function dedupe(items) {
    const seen = new Set();
    return items.filter((m) => {
      const k = m.type + ":" + m.signature;
      if (!m.signature || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  /** Media from loose URL hints collected on the page (DOM, performance entries). */
  P.mediaFromHints = function (hints) {
    if (!hints) return [];
    const urls = [].concat(hints.videoUrls || [], hints.imageUrls || []).filter((u) => typeof u === "string");
    const v = P.videoFromNode(urls);
    if (v) return [v];
    return P.imagesFromNode(urls).slice(0, 1);
  };

  /** Short media key for duplicate detection. */
  P.mediaKey = (m) => `${m.type}:${m.signature}`;
})(typeof globalThis !== "undefined" ? globalThis : self);
