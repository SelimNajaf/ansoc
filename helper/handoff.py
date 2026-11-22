"""Hand finished files to Chrome, so they land in the user's Downloads folder and show up in
Chrome's download list like any other download.

The helper prepares files in its outbox (common.root_dir(), in the system temp folder). For each
file (or one ZIP of several files) it serves a one-time link on 127.0.0.1; the extension downloads
that link with chrome.downloads, then reports back ("handoff_done") and the outbox copy is deleted.

Only this computer can connect (127.0.0.1), every link has a random 32-byte token, only files the
extension asked for are served, and the server lives only as long as the helper process.
Works the same on Windows, macOS and Linux (Chrome writes the file, the helper never touches
the Downloads folder, so macOS never asks for Downloads access).
"""
from __future__ import annotations

import mimetypes
import secrets
import shutil
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import quote

from common import E_BAD_REQUEST, E_NO_MEDIA, HelperError, get_logger, root_dir, safe_name

OUTBOX_MAX_AGE = 2 * 24 * 3600  # files nobody picked up (Chrome closed mid-way) are removed after 2 days
CLEANUP_EVERY = 3600  # also clean up while the helper keeps running
BUNDLE_DIR = "_bundles"
_last_cleanup = 0.0

_lock = threading.Lock()
_server: Optional[ThreadingHTTPServer] = None
_files: Dict[str, dict] = {}  # token -> {"path": Path, "name": str, "sources": [str], "bundle": bool}


class _Handler(BaseHTTPRequestHandler):
    server_version = "MediaDownloader"
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args) -> None:  # keep the helper's stderr log clean
        pass

    def _entry(self) -> Optional[dict]:
        token = self.path.lstrip("/").split("/", 1)[0].split("?", 1)[0]
        with _lock:
            return _files.get(token)

    def _send(self, head_only: bool) -> None:
        entry = self._entry()
        path: Optional[Path] = entry["path"] if entry else None
        if not path or not path.is_file():
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        size = path.stat().st_size
        ctype = mimetypes.guess_type(entry["name"])[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(entry['name'])}")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if head_only:
            return
        try:
            with open(path, "rb") as fh:
                shutil.copyfileobj(fh, self.wfile, 1024 * 1024)
        except (ConnectionError, OSError):  # Chrome cancelled the download
            pass

    def do_GET(self) -> None:  # noqa: N802 (http.server naming)
        self._send(False)

    def do_HEAD(self) -> None:  # noqa: N802
        self._send(True)


def _ensure_server() -> int:
    global _server
    with _lock:
        if _server is None:
            _server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
            _server.daemon_threads = True
            threading.Thread(target=_server.serve_forever, name="handoff", daemon=True).start()
            get_logger().info("Hand-off server on 127.0.0.1:%d", _server.server_address[1])
        return _server.server_address[1]


def _inside_outbox(p: str) -> Path:
    root = root_dir().resolve()
    path = Path(p).resolve()
    try:
        path.relative_to(root)
    except ValueError:
        raise HelperError(E_BAD_REQUEST, f"Not a helper file: {p}")
    if not path.is_file():
        raise HelperError(E_NO_MEDIA, f"File is gone: {p}")
    return path


def _zip_stem(zip_name: str) -> str:
    name = zip_name[:-4] if zip_name.lower().endswith(".zip") else zip_name
    return safe_name(name, "media")


def _remove(p: Path) -> bool:
    """Delete a file; False if it is locked (Windows antivirus / indexer). Locked files are
    left for cleanup_outbox() instead of failing the whole hand-off."""
    try:
        p.unlink(missing_ok=True)
        return True
    except OSError as exc:
        get_logger().info("Could not remove %s yet: %s", p, exc)
        return False


def _bundle(paths: List[Path], zip_name: str) -> Path:
    """One ZIP of several files. ZIP_STORED: photos and videos are already compressed, so
    storing is as small and much faster; nothing is re-encoded. Each file leaves the outbox as
    soon as it is in the ZIP, so a big bulk download never needs twice the disk space."""
    folder = root_dir() / BUNDLE_DIR
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / f"{_zip_stem(zip_name)}_{secrets.token_hex(3)}.zip"
    used = set()
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_STORED, allowZip64=True) as zf:
        for p in paths:
            arc, n = p.name, 1
            while arc.lower() in used:
                n += 1
                arc = f"{p.stem}_{n}{p.suffix}"
            used.add(arc.lower())
            zf.write(p, arc)
            _remove(p)
    return dest


def prepare(paths: List[str], zip_name: str = "") -> dict:
    """Serve outbox files to Chrome. With zip_name, all files go into one ZIP (one download).
    Returns {"items": [{"token", "url", "name", "size", "sources"}]}."""
    if not isinstance(paths, list) or not paths:
        raise HelperError(E_BAD_REQUEST, "paths must be a non-empty list")
    files = [_inside_outbox(str(p)) for p in paths[:2000]]
    port = _ensure_server()
    global _last_cleanup
    if time.time() - _last_cleanup > CLEANUP_EVERY:
        _last_cleanup = time.time()
        try:
            cleanup_outbox()
        except Exception as exc:  # never block a hand-off
            get_logger().warning("Outbox cleanup failed: %s", exc)
    if zip_name:
        z = _bundle(files, zip_name)
        name = f"{_zip_stem(zip_name)}.zip"
        groups = [(z, name, [str(p) for p in files], True)]
    else:
        groups = [(p, p.name, [str(p)], False) for p in files]
    items = []
    with _lock:
        for path, name, sources, bundle in groups:
            token = secrets.token_urlsafe(32)
            _files[token] = {"path": path, "name": name, "sources": sources, "bundle": bundle}
            items.append({"token": token, "url": f"http://127.0.0.1:{port}/{token}/{quote(name)}",
                          "name": name, "size": path.stat().st_size, "sources": sources})
    return {"items": items}


def done(items: list) -> dict:
    """Chrome finished (ok) or gave up (not ok). Delivered files leave the outbox and their
    duplicate-index entries move to the final path. Failed ones are removed too: Retry downloads
    them again (an outbox file never counts as a duplicate)."""
    from metadata import repoint

    moves: Dict[str, dict] = {}
    removed = 0
    for it in items if isinstance(items, list) else []:
        if not isinstance(it, dict):
            continue
        with _lock:
            entry = _files.pop(str(it.get("token") or ""), None)
        if not entry:
            continue
        if not it.get("ok"):
            for src in entry["sources"]:
                _remove(Path(src))
            if entry["bundle"]:
                _remove(entry["path"])
            continue
        final = str(it.get("final_path") or "")
        did = it.get("download_id")
        for src in entry["sources"]:
            moves[src] = {"path": final, "download_id": did}
            _remove(Path(src))
            removed += 1
        if entry["bundle"]:
            _remove(entry["path"])
    changed = repoint(moves) if moves else 0
    return {"removed": removed, "index_updated": changed}


def cleanup_outbox() -> None:
    """Remove outbox files older than two days (Chrome never took them) and empty folders."""
    root = root_dir()
    if not root.is_dir():
        return
    limit = time.time() - OUTBOX_MAX_AGE
    for p in sorted(root.rglob("*"), key=lambda x: len(x.parts), reverse=True):
        try:
            if p.is_file() and p.stat().st_mtime < limit:
                p.unlink()
            elif p.is_dir() and not any(p.iterdir()) and p.parent != root:
                p.rmdir()
        except OSError:
            pass
