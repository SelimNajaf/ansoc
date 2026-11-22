#!/usr/bin/env python3
"""Chrome Native Messaging host.

Protocol (Chrome <-> host): each message is a 32-bit native-endian length followed
by UTF-8 JSON. Requests from the extension look like
    {"id": "...", "action": "...", "params": {...}}
and the host answers with
    {"id": "...", "type": "progress", "percent": 42.0, "text": "..."}   (0..n times)
    {"id": "...", "type": "result", "ok": true, "data": {...}}
    {"id": "...", "type": "result", "ok": false, "error": {"code": "...", "message": "..."}}
"""
from __future__ import annotations

import json
import os
import struct
import sys
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# ---------------------------------------------------------------------------
# stdout is the binary channel to Chrome. Keep a private handle to it and point
# fd 1 at stderr so nothing (yt-dlp, FFmpeg children, print()) can corrupt it.
if os.name == "nt":  # pragma: no cover - Windows only
    import msvcrt

    msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
_CHANNEL = os.fdopen(os.dup(sys.stdout.fileno()), "wb", buffering=0)
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
sys.stdout = sys.stderr
# stdin is Chrome's channel in. Same idea: read it through a private, non-inheritable handle
# and point fd 0 (and the Windows standard input handle) at NUL. Otherwise every child
# (gallery-dl, FFmpeg, ...) inherits the pipe, and on Windows a child that touches its stdin
# while our main thread waits in a blocking read on that pipe hangs at startup until Chrome
# happens to send the next message: downloads "stuck at Downloading" with no CPU and no network.
_STDIN = os.fdopen(os.dup(sys.stdin.fileno()), "rb")
_nul = os.open(os.devnull, os.O_RDONLY)
os.dup2(_nul, sys.stdin.fileno())  # the CRT also updates the process' STD_INPUT_HANDLE here
os.close(_nul)
sys.stdin = open(os.devnull, "r")

from common import (  # noqa: E402
    E_BAD_REQUEST, E_UNKNOWN, VERSION, HelperError, dependency_report, ensure_all_dirs, get_logger,
    legacy_root_dirs, open_in_file_manager, root_dir,
)
import router  # noqa: E402

MAX_OUT = 1024 * 1024 - 1024  # Chrome limit for host -> extension messages is 1 MB
_write_lock = threading.Lock()


def send(msg: dict) -> None:
    data = json.dumps(msg, ensure_ascii=False).encode("utf-8")
    if len(data) > MAX_OUT:
        data = json.dumps({"id": msg.get("id"), "type": "result", "ok": False,
                           "error": {"code": E_UNKNOWN, "message": "Response too large"}}).encode("utf-8")
    with _write_lock:
        try:
            _CHANNEL.write(struct.pack("=I", len(data)) + data)
            _CHANNEL.flush()
        except OSError:  # Chrome closed the port; the result is still on disk / in the log
            pass


def read_message():
    raw_len = _STDIN.read(4)
    if len(raw_len) < 4:
        return None
    (length,) = struct.unpack("=I", raw_len)
    body = _STDIN.read(length)
    if len(body) < length:
        return None
    return json.loads(body.decode("utf-8"))


# --------------------------------------------------------------------------- actions
def _meta(params: dict) -> dict:
    meta = params.get("meta") or params.get("pin") or {}
    if not isinstance(meta, dict):
        raise HelperError(E_BAD_REQUEST, "meta must be an object")
    return meta


def _engine(params: dict, progress):
    """Engine instance chosen by explicit `platform` or by the URL."""
    url = params.get("url") or params.get("page_url") or params.get("pin_url") or ""
    platform = params.get("platform") or ("" if url else "pinterest")
    eng = router.engine_for(router.normalize(url) if url else "", platform)(progress)
    _prep(eng, params)
    return eng


def _prep(eng, params: dict) -> None:
    """Per-request options: login cookies (memory only) and optional metadata JSON."""
    eng.dl.set_cookies(params.get("cookies"))
    eng.dl.write_meta = bool(params.get("write_metadata"))
    eng.dl.prefer_compat = params.get("video_quality") == "compatible"
    views = params.get("views")
    if isinstance(views, (int, float)) and not isinstance(views, bool) and views >= 0:
        eng.dl.views = int(views)  # goes into the file name: ..._3.1M-views.mp4


# request id -> Event, for requests that are still running (set by "cancel")
_CANCEL: dict = {}
_CANCEL_LOCK = threading.Lock()


def _own_path(p) -> Path:
    """p resolved, if it is inside the outbox or an earlier Desktop download folder (else ValueError)."""
    rp = Path(str(p)).resolve()
    for root in [root_dir()] + legacy_root_dirs():
        try:
            rp.relative_to(root.resolve())
            return rp
        except ValueError:
            continue
    raise ValueError(str(p))


def _in_outbox(rp: Path) -> bool:
    try:
        rp.relative_to(root_dir().resolve())
        return True
    except ValueError:
        return False


def handle(action: str, params: dict, progress) -> dict:
    if action == "cancel":  # stop a running request: its Downloader checks the event
        with _CANCEL_LOCK:
            ev = _CANCEL.get(str(params.get("request_id") or ""))
        if ev:
            ev.set()
        return {"cancelled": bool(ev)}
    if action == "ping":
        info = {"version": VERSION, "root": str(root_dir()), "deps": dependency_report(), "platform": sys.platform,
                "helper_dir": str(Path(__file__).resolve().parent),
                "engines": [{"id": e.id, "name": e.name} for e in router.all_engines()]}
        try:
            ensure_all_dirs()  # on macOS this triggers the "access Desktop folder" prompt once
        except HelperError as exc:
            info["root_error"] = {"code": exc.code, "message": exc.message}
        return info

    if action == "paths_exist":  # duplicate check: is a previously downloaded file still there?
        out = []
        for p in (params.get("paths") or [])[:200]:
            try:
                rp = _own_path(p)  # only answer for the outbox and the old Desktop folders
                # A file still in the outbox never reached Downloads (Chrome failed or was closed):
                # it does not count as downloaded, so Retry downloads it again.
                out.append(rp.is_file() and not _in_outbox(rp))
            except (ValueError, OSError):
                out.append(False)
        return {"exists": out}

    if action == "handoff":  # serve finished files to Chrome (one-time 127.0.0.1 links), optionally as one ZIP
        import handoff

        return handoff.prepare(params.get("paths") or [], str(params.get("zip_name") or ""))
    if action == "handoff_done":  # Chrome saved them in Downloads: clear the outbox, update the duplicate index
        import handoff

        return handoff.done(params.get("items") or [])

    if action == "detect":  # purely local URL -> platform
        eng = router.detect(params.get("url", ""))
        return {"platform": eng.id, "name": eng.name}

    if action == "open_folder":
        dirs = ensure_all_dirs()
        target = root_dir()
        plat = params.get("platform")
        if plat:
            target = dirs.get(router.get_engine(plat).name, target)
            sub = params.get("sub")
            if sub in ("images", "videos", "metadata", "logs"):
                target = Path(target) / sub
        open_in_file_manager(Path(target))
        return {"opened": str(target)}

    if action == "reveal":  # open the folder containing a file we saved
        try:
            p = _own_path(params.get("path", ""))
        except ValueError:
            raise HelperError(E_BAD_REQUEST, "Path is not a helper file")
        open_in_file_manager(p.parent if p.is_file() else p)
        return {"opened": str(p)}

    force = bool(params.get("force"))
    cookies = bool(params.get("use_browser_cookies"))

    # ---- generic, platform-routed actions
    if action == "download":
        url = router.normalize(params.get("url", ""))
        eng = router.engine_for(url, params.get("platform"))(progress)
        _prep(eng, params)
        coll = eng.dl.set_collection(params.get("collection"))
        res = eng.download(url, force, cookies)
        if coll:
            res["collection_path"] = str(coll)
        return res
    if action == "list_reels":  # profile analysis: list only, nothing is downloaded
        eng = router.get_engine("instagram")(progress)
        _prep(eng, params)
        return eng.list_reels(params.get("profile", ""), int(params.get("limit") or 100), cookies,
                              bool(params.get("enrich_missing", True)),
                              float(params["since_days"]) if params.get("since_days") else None,
                              float(params["gap_days"]) if params.get("gap_days") else None)
    if action == "profile_info":  # quick look before analysing: followers, posts, bio, link
        eng = router.get_engine("instagram")(progress)
        _prep(eng, params)
        return eng.profile_info(params.get("profile", ""), cookies)
    if action == "check_update":  # latest version published on GitHub
        import updater

        latest = updater.latest_version()
        return {"current": VERSION, "latest": latest,
                "available": updater.version_tuple(latest) > updater.version_tuple(VERSION)}
    if action == "self_update":  # download + install the latest version (the extension then reloads itself)
        import updater

        return updater.self_update(lambda p, txt="": progress({"percent": p, "text": txt}))
    if action == "reels_details":  # several reels in one go ("Copy descriptions")
        eng = router.get_engine("instagram")(progress)
        _prep(eng, params)
        codes = params.get("codes") or []
        if not isinstance(codes, list):
            raise HelperError(E_BAD_REQUEST, "codes must be a list")
        return eng.reels_details(codes, cookies)
    if action == "reel_details":  # one reel's caption, audio, tags ... (opened in the analyzer)
        eng = router.get_engine("instagram")(progress)
        _prep(eng, params)
        return eng.reel_details(params.get("code", ""), cookies)
    if action == "save_metadata_url":
        url = router.normalize(params.get("url", ""))
        eng = router.engine_for(url, params.get("platform"))(progress)
        _prep(eng, params)
        return eng.save_metadata(url, cookies)

    # ---- low level actions (used by the extension's Pinterest pipeline; work for any platform)
    eng = _engine(params, progress)
    dl = eng.dl
    if action == "ingest":
        return dl.ingest(params.get("staged_path", ""), params.get("media_type", "image"), params.get("base_name", ""),
                         _meta(params), params.get("original_url", ""), params.get("downloaded_url", ""), force)
    if action == "download_url":
        return dl.download_url(params.get("url", ""), params.get("media_type", "image"),
                               params.get("base_name", ""), _meta(params), force)
    if action == "download_video":
        return dl.download_video(params.get("hls_url", ""), params.get("page_url") or params.get("pin_url", ""),
                                 params.get("base_name", ""), _meta(params), force, cookies, params.get("mp4_url", ""))
    if action in ("download_page", "download_pin"):
        return dl.download_page(params.get("page_url") or params.get("pin_url", ""), params.get("base_name", ""),
                                _meta(params), force, cookies)
    if action == "save_metadata":
        return dl.save_metadata(params.get("base_name", ""), _meta(params), params.get("status", "success"),
                                params.get("error_code", ""), params.get("error_message", ""))
    raise HelperError(E_BAD_REQUEST, f"Unknown action: {action}")


def worker(msg: dict) -> None:
    log = get_logger()
    mid = msg.get("id")
    action = msg.get("action", "")

    def progress(p: dict) -> None:
        send({"id": mid, "type": "progress", **p})

    # the Downloader picks this up (getattr(progress, "cancel")) and checks it while working
    progress.cancel = threading.Event()  # type: ignore[attr-defined]
    with _CANCEL_LOCK:
        _CANCEL[str(mid)] = progress.cancel  # type: ignore[attr-defined]
    try:
        data = handle(action, msg.get("params") or {}, progress)
        send({"id": mid, "type": "result", "ok": True, "data": data})
    except HelperError as exc:
        log.warning("%s failed: [%s] %s", action, exc.code, exc.message)
        send({"id": mid, "type": "result", "ok": False, "error": {"code": exc.code, "message": exc.message}})
    except Exception as exc:  # never crash the host on a single bad job
        log.error("%s crashed: %s\n%s", action, exc, traceback.format_exc())
        send({"id": mid, "type": "result", "ok": False, "error": {"code": E_UNKNOWN, "message": str(exc)[:500]}})
    finally:
        with _CANCEL_LOCK:
            _CANCEL.pop(str(mid), None)


def main() -> int:
    log = get_logger()
    log.info("Native host %s started (pid %d)", VERSION, os.getpid())
    try:
        import handoff

        handoff.cleanup_outbox()  # files Chrome never picked up (older than two days)
    except Exception as exc:  # never block the start
        log.warning("Outbox cleanup failed: %s", exc)
    pool = ThreadPoolExecutor(max_workers=3)
    try:
        while True:
            msg = read_message()
            if msg is None:
                break
            if not isinstance(msg, dict):
                continue
            if msg.get("action") in ("ping", "detect", "open_folder", "reveal", "paths_exist", "cancel"):
                worker(msg)  # instant actions answer inline (a cancel must not wait behind downloads)
            else:
                pool.submit(worker, msg)
    finally:
        # Chrome closed the port (extension reloaded / browser closed): nobody can receive the
        # results any more, so stop running downloads instead of letting them run for up to an hour.
        with _CANCEL_LOCK:
            for ev in _CANCEL.values():
                ev.set()
        pool.shutdown(wait=True)
        log.info("Native host exiting")
    return 0


if __name__ == "__main__":
    sys.exit(main())
