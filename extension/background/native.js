/* Native Messaging client for the local Python helper. */
(function (root) {
  "use strict";
  const PD = root.PD;

  class PDError extends Error {
    constructor(code, detail) {
      super(detail || code);
      this.code = code || PD.ERR.UNKNOWN;
      this.detail = detail || "";
    }
  }
  PD.PDError = PDError;

  let port = null;
  let seq = 0;
  const pending = new Map();
  let cachedStatus = null; // {ok, at, info|error}

  function mapDisconnect(msg) {
    const m = msg || "";
    if (/not found/i.test(m)) return new PDError(PD.ERR.HOST_NOT_INSTALLED, m);
    if (/forbidden/i.test(m)) return new PDError(PD.ERR.HOST_NOT_INSTALLED, m + " (extension ID not allowed)");
    if (/exited|communicating|failed to start/i.test(m)) return new PDError(PD.ERR.HOST_EXITED, m);
    return new PDError(PD.ERR.HOST_NOT_INSTALLED, m || "Native host disconnected");
  }

  function connect() {
    if (port) return port;
    const p = chrome.runtime.connectNative(PD.HOST_NAME);
    p.onMessage.addListener((msg) => {
      const entry = msg && pending.get(msg.id);
      if (!entry) return;
      if (msg.type === "progress") {
        try {
          entry.onProgress && entry.onProgress(msg);
        } catch (_e) { /* ignore */ }
        return;
      }
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.ok) entry.resolve(msg.data);
      else entry.reject(new PDError((msg.error && msg.error.code) || PD.ERR.UNKNOWN, msg.error && msg.error.message));
    });
    p.onDisconnect.addListener(() => {
      const err = mapDisconnect(chrome.runtime.lastError && chrome.runtime.lastError.message);
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(err);
      }
      pending.clear();
      if (port === p) port = null;
      cachedStatus = { ok: false, at: Date.now(), error: { code: err.code, message: err.detail } };
    });
    port = p;
    return p;
  }

  /** Send one request; resolves with the helper's data or rejects with PDError. */
  function request(action, params, opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
      let p;
      try {
        p = connect();
      } catch (e) {
        reject(mapDisconnect(String(e && e.message)));
        return;
      }
      const id = `${Date.now().toString(36)}-${++seq}`;
      if (opts.onId) opts.onId(id); // lets the caller cancel this request later
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new PDError(PD.ERR.NETWORK_ERROR, `Helper timeout (${action})`));
      }, opts.timeout || 2 * 60 * 60 * 1000);
      pending.set(id, { resolve, reject, onProgress: opts.onProgress, timer });
      try {
        p.postMessage({ id, action, params: params || {} });
      } catch (e) {
        pending.delete(id);
        clearTimeout(timer);
        reject(mapDisconnect(String(e && e.message)));
      }
    });
  }

  /** Helper status, cached for 20 s. Never throws. */
  async function status(force) {
    if (!force && cachedStatus && Date.now() - cachedStatus.at < 20000) return cachedStatus;
    try {
      const info = await request("ping", {}, { timeout: 8000 });
      cachedStatus = { ok: true, at: Date.now(), info };
    } catch (e) {
      cachedStatus = { ok: false, at: Date.now(), error: { code: e.code || PD.ERR.UNKNOWN, message: e.detail || e.message } };
    }
    return cachedStatus;
  }

  const hasActiveRequests = () => pending.size > 0;

  /** Ask the helper to stop a running request; the request then rejects with code CANCELLED. */
  function cancel(requestId) {
    if (!requestId || !pending.has(requestId)) return Promise.resolve({ cancelled: false });
    return request("cancel", { request_id: requestId }, { timeout: 10000 }).catch(() => ({ cancelled: false }));
  }

  PD.native = { request, status, hasActiveRequests, cancel };
})(typeof globalThis !== "undefined" ? globalThis : self);
