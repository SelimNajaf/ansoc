/* Shared constants. Classic script: loaded by the service worker (importScripts),
 * the content script and the popup. */
(function (root) {
  "use strict";
  const PD = (root.PD = root.PD || {});

  PD.HOST_NAME = "com.local.media_downloader";
  PD.STAGING_DIR = "MediaDownloader_staging"; // inside Chrome's Downloads folder, helper moves files out
  PD.FALLBACK_DIR = "MediaDownloader/Pinterest"; // used only when the helper is not installed
  PD.MAX_JOBS = 50;
  PD.RECENT_SHOWN = 10;
  PD.CONCURRENCY = 2;
  PD.BOARD_DELAY_MS = 900; // polite delay between pin-page requests during "Download all"

  PD.STATUS = Object.freeze({
    QUEUED: "queued",
    RESOLVING: "resolving",
    DOWNLOADING: "downloading",
    PROCESSING: "processing",
    SUCCESS: "success",
    FAILED: "failed",
    DUPLICATE: "duplicate",
    CANCELLED: "cancelled",
  });
  /** Finished one way or another: nothing runs or waits for this job any more. */
  PD.isFinal = (status) => ["success", "failed", "duplicate", "cancelled"].includes(status);

  // Error codes (helper/common.py uses the same strings).
  PD.ERR = Object.freeze({
    PIN_NOT_FOUND: "NOT_FOUND",
    NOT_FOUND: "NOT_FOUND",
    LOGIN_REQUIRED: "LOGIN_REQUIRED",
    PRIVATE_PIN: "PRIVATE_CONTENT",
    PRIVATE_CONTENT: "PRIVATE_CONTENT",
    REGION_BLOCKED: "REGION_BLOCKED",
    UNSUPPORTED_PLATFORM: "UNSUPPORTED_PLATFORM",
    BOARD_IN_INPUT: "BOARD_IN_INPUT",
    RATE_LIMITED: "RATE_LIMITED",
    CANCELLED: "CANCELLED",
    NETWORK_ERROR: "NETWORK_ERROR",
    FFMPEG_MISSING: "FFMPEG_MISSING",
    YTDLP_MISSING: "YTDLP_MISSING",
    PYTHON_MISSING: "PYTHON_MISSING",
    HOST_NOT_INSTALLED: "HOST_NOT_INSTALLED",
    HOST_EXITED: "HOST_EXITED",
    DIR_CREATE_FAILED: "DIR_CREATE_FAILED",
    FILE_EXISTS: "FILE_EXISTS",
    DUPLICATE: "DUPLICATE",
    NO_MEDIA: "NO_MEDIA",
    HLS_NEEDS_HELPER: "HLS_NEEDS_HELPER",
    BAD_URL: "BAD_URL",
    BAD_REQUEST: "BAD_REQUEST",
    FORBIDDEN_HOST: "FORBIDDEN_HOST",
    DOWNLOAD_INTERRUPTED: "DOWNLOAD_INTERRUPTED",
    INTERRUPTED: "INTERRUPTED",
    UNKNOWN: "UNKNOWN",
  });

  // Errors worth retrying automatically (with back-off).
  PD.RETRYABLE = new Set(["NETWORK_ERROR", "RATE_LIMITED", "DOWNLOAD_INTERRUPTED"]);

  PD.DEFAULT_SETTINGS = Object.freeze({
    skipDuplicates: true,
    notifications: true,
    useBrowserCookies: false, // let yt-dlp / gallery-dl read Chrome cookies locally for private / login-only posts
    autoRetries: 2,
    saveMetadata: false, // metadata JSON next to downloads (off: keep folders clean)
    compatVideos: false, // true: only H.264/H.265 (QuickTime etc.), even at lower resolution; false: max quality
  });

  /** chrome.i18n wrapper with fallback to the key itself. */
  PD.t = function (key, subs) {
    try {
      const m = chrome.i18n.getMessage(key, subs);
      return m || key;
    } catch (_e) {
      return key;
    }
  };

  /** "Rate limited · retrying at 11:52" while the helper waits for the site, else "". */
  PD.waitText = function (job) {
    if (!job || !job.waitUntil) return "";
    return PD.t(/429/.test(job.waitReason || "") ? "status_ratelimited" : "status_waiting", [job.waitUntil]);
  };

  /** Human readable, localized error text. */
  PD.errorText = function (code, detail) {
    const msg = PD.t("err_" + (code || "UNKNOWN"));
    return msg.startsWith("err_") ? PD.t("err_UNKNOWN") : msg;
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
