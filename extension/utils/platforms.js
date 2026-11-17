/* Platform registry for the extension (mirror of helper/engines/*).
 *
 * To add a platform later (Instagram, YouTube, X, ...):
 *   1. add one PD.platforms.register({...}) block here,
 *   2. add its hosts to manifest.json (host_permissions + content_scripts.matches),
 *   3. add helper/engines/<name>_engine.py.
 * Detection is purely local (regex on the URL); nothing is sent anywhere. */
(function (root) {
  "use strict";
  const PD = (root.PD = root.PD || {});
  const list = [];

  function hostOf(url) {
    try {
      const u = new URL(/^[a-z]+:\/\//i.test(url) ? url : "https://" + String(url).trim());
      return u.protocol === "https:" || u.protocol === "http:" ? u.hostname.toLowerCase() : "";
    } catch (_e) {
      return "";
    }
  }

  const registry = {
    list,
    register(p) {
      list.push(Object.freeze(p));
    },
    byId(id) {
      return list.find((p) => p.id === id) || null;
    },
    /** Platform object for a URL, or null ("Unsupported platform"). */
    detect(url) {
      const h = hostOf(url);
      if (!h) return null;
      return list.find((p) => p.hosts.some((re) => re.test(h))) || null;
    },
    hostOf,
  };
  PD.platforms = registry;

  // ------------------------------------------------------------------ Pinterest
  registry.register({
    id: "pinterest",
    name: "Pinterest",
    folder: "Pinterest",
    hosts: [
      /(^|\.)pinterest\.(com|ca|co\.uk|de|fr|es|it|pt|ch|at|ie|nz|ph|cl|jp|kr|se|dk|ru|com\.au|com\.mx|co\.kr|com\.br)$/,
      /^(www\.)?pin\.it$/,
      /(^|\.)pinimg\.com$/,
    ],
    // The extension has its own Pinterest pipeline (originals / MP4 vs HLS); other URLs go to the helper engine.
    pipeline: "extension",
    needsHelper: false,
    cookieDomains: ["pinterest.com"], // login cookies handed to the helper (only with "use Chrome's login")
    contentId: (url) => (PD.pin ? PD.pin.pinIdFromUrl(url) : ""),
    contentUrl: (id) => `https://www.pinterest.com/pin/${id}/`,
    pageType: (url) => (PD.pin ? PD.pin.pageType(url) : "other"), // "pin" | "board" | "other"
    guessMediaType: () => "",
  });

  // ------------------------------------------------------------------ TikTok
  const TT_POST = /\/(video|photo|v)\/(\d{10,25})/;
  registry.register({
    id: "tiktok",
    name: "TikTok",
    folder: "TikTok",
    hosts: [/(^|\.)tiktok\.com$/],
    pipeline: "helper", // yt-dlp / gallery-dl in the local helper
    needsHelper: true,
    cookieDomains: ["tiktok.com"],
    contentId: (url) => {
      const m = String(url).match(TT_POST);
      return m ? m[2] : "";
    },
    contentUrl: (id, url) => url || `https://www.tiktok.com/@/video/${id}`,
    pageType: (url) => {
      const m = String(url).match(TT_POST);
      if (!m) return "other";
      return m[1] === "photo" ? "photo" : "video";
    },
    guessMediaType: (url) => {
      const m = String(url).match(TT_POST);
      return m ? (m[1] === "photo" ? "slideshow" : "video") : "";
    },
    buttonKey: (type) => (type === "photo" ? "btn_download_images" : "btn_download_video"),
  });

  // ------------------------------------------------------------------ Instagram
  const IG_POST = /\/(?:[\w.]+\/)?(p|reels?|tv)\/([A-Za-z0-9_-]{5,})/;
  const IG_STORY = /\/stories\/(?:highlights\/(\d+)|([\w.]+)(?:\/(\d+))?)/;
  const IG_RESERVED = new Set(["p", "reel", "reels", "tv", "stories", "explore", "accounts", "direct", "about",
    "developer", "legal", "privacy", "web", "api", "graphql", "challenge", "emails", "session", "share"]);
  /** Username of a profile page (/user/ or /user/reels/), else "". */
  function igProfile(url) {
    let path = "";
    try {
      path = new URL(/^[a-z]+:\/\//i.test(url) ? url : "https://" + url).pathname;
    } catch (_e) {
      return "";
    }
    const m = path.match(/^\/([A-Za-z0-9_.]{1,30})(?:\/(?:reels|clips))?\/?$/);
    return m && !IG_RESERVED.has(m[1].toLowerCase()) ? m[1] : "";
  }
  function igParse(url) {
    let path = "";
    try {
      path = new URL(/^[a-z]+:\/\//i.test(url) ? url : "https://" + url).pathname;
    } catch (_e) {
      return null;
    }
    let m = path.match(IG_POST);
    if (m) return { type: m[1] === "p" ? "post" : m[1] === "tv" ? "tv" : "reel", id: m[2] };
    m = path.match(IG_STORY);
    if (m) return { type: "story", id: m[1] || m[3] || m[2] };
    return null;
  }
  registry.register({
    id: "instagram",
    name: "Instagram",
    folder: "Instagram",
    hosts: [/(^|\.)instagram\.com$/, /^(www\.)?instagr\.am$/],
    pipeline: "helper", // gallery-dl / yt-dlp in the local helper
    needsHelper: true,
    cookieDomains: ["instagram.com"],
    // Profiles / feeds are not downloadable; share links are resolved by the helper.
    validate: (url) => !!igParse(url) || /instagram\.com\/share\//i.test(url),
    contentId: (url) => (igParse(url) || {}).id || "",
    contentUrl: (id, url) => url || `https://www.instagram.com/p/${id}/`,
    pageType: (url) => (igParse(url) || { type: igProfile(url) ? "profile" : "other" }).type, // post | reel | tv | story | profile | other
    profileName: igProfile,
    batchDelayMs: 3000, // polite pace for bulk downloads (Instagram rate-limits aggressively)
    guessMediaType: (url) => {
      const p = igParse(url);
      return p ? (p.type === "reel" || p.type === "tv" ? "video" : p.type === "story" ? "story" : "") : "";
    },
    buttonKey: (type) => (type === "profile" ? "btn_analyze_reels" : type === "reel" || type === "tv" ? "btn_download_video" : type === "story" ? "btn_download_story" : "btn_download_post"),
  });
})(typeof globalThis !== "undefined" ? globalThis : self);
