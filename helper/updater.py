"""Self-update from GitHub.

The extension asks the helper (action "self_update") to install the latest version:
  1. download the repository ZIP of the main branch from GitHub (HTTPS)
  2. copy extension/ (mirrored) and helper/ (keeping .venv, settings, logs) into the
     install folder (~/MediaDownloader), plus the top-level install/update scripts
  3. install requirements.txt into the existing virtual environment
  4. re-register the native-messaging host (main.py install)
The extension then calls chrome.runtime.reload() and runs the new code.

Publishing an update = raise "version" in extension/manifest.json and push to main.
"""
from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from common import E_BAD_REQUEST, E_NETWORK, HELPER_DIR, VERSION, HelperError

REPO = "SelimNajaf/ansoc"
BRANCH = "main"
MANIFEST_URL = f"https://raw.githubusercontent.com/{REPO}/{BRANCH}/extension/manifest.json"
ZIP_URL = f"https://codeload.github.com/{REPO}/zip/refs/heads/{BRANCH}"
# The branch ZIP / raw files can be a few minutes old (CDN cache). The API names the newest commit,
# and a ZIP of that exact commit is never stale.
COMMIT_API_URL = f"https://api.github.com/repos/{REPO}/commits/{BRANCH}"
SHA_ZIP_URL = f"https://codeload.github.com/{REPO}/zip/{{sha}}"
MAX_ZIP_BYTES = 60 * 1024 * 1024

# never overwritten in the installed helper folder (per-user state)
KEEP_IN_HELPER = {".venv", "__pycache__", "state", "logs", "bin", "config.json", "pindl_host.bat", "pindl_host.sh"}
TOP_LEVEL_FILES = ("Install-Windows.bat", "Install-Mac.command", "Update-Windows.bat", "Update-Mac.command",
                   "Uninstall-Windows.bat", "Uninstall-Mac.command", "README.md", "CHANGELOG.md")

ProgressFn = Callable[[Optional[float], str], None]


def version_tuple(v: str) -> tuple:
    out = []
    for part in str(v).split("."):
        digits = "".join(ch for ch in part if ch.isdigit())
        out.append(int(digits) if digits else 0)
    return tuple(out)


def _fetch(url: str, limit: int, progress: Optional[ProgressFn] = None) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "MediaDownloader-updater"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            total = int(resp.headers.get("Content-Length") or 0)
            chunks, size = [], 0
            while True:
                chunk = resp.read(256 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > limit:
                    raise HelperError(E_NETWORK, "Update download is unexpectedly large; stopped.")
                chunks.append(chunk)
                if progress:
                    progress(size * 100.0 / total if total else None, "update:download")
            return b"".join(chunks)
    except HelperError:
        raise
    except Exception as exc:
        raise HelperError(E_NETWORK, f"Could not reach GitHub: {exc}") from exc


def _latest_zip_url() -> str:
    """ZIP of the newest commit on the branch; the branch ZIP if the API can't be reached (rate limit, offline)."""
    try:
        req = urllib.request.Request(COMMIT_API_URL, headers={
            "User-Agent": "MediaDownloader-updater", "Accept": "application/vnd.github.sha"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            sha = resp.read(100).decode("ascii", "replace").strip()
        if len(sha) == 40 and all(c in "0123456789abcdef" for c in sha):
            return SHA_ZIP_URL.format(sha=sha)
    except Exception:
        pass
    return ZIP_URL


def latest_version() -> str:
    data = json.loads(_fetch(MANIFEST_URL, 1024 * 1024).decode("utf-8"))
    return str(data["version"])


def install_dir() -> Path:
    return HELPER_DIR.parent


def _safe_extract(zf: zipfile.ZipFile, dest: Path) -> None:
    root = dest.resolve()
    for member in zf.infolist():
        target = (dest / member.filename).resolve()
        if root not in target.parents and target != root:
            raise HelperError(E_BAD_REQUEST, f"Unsafe path in update archive: {member.filename}")
    zf.extractall(dest)


def _mirror(src: Path, dst: Path) -> None:
    """dst becomes an exact copy of src (files only in dst are removed)."""
    dst.mkdir(parents=True, exist_ok=True)
    for p in sorted(dst.rglob("*"), key=lambda x: len(x.parts), reverse=True):
        rel = p.relative_to(dst)
        if not (src / rel).exists():
            if p.is_dir():
                shutil.rmtree(p, ignore_errors=True)
            else:
                p.unlink(missing_ok=True)
    shutil.copytree(src, dst, dirs_exist_ok=True)


def _copy_helper(src: Path, dst: Path) -> None:
    def ignore(_dir: str, names: List[str]) -> List[str]:
        return [n for n in names if n in KEEP_IN_HELPER or n.endswith(".log")]

    shutil.copytree(src, dst, dirs_exist_ok=True, ignore=ignore)


def _make_executable(paths: List[Path]) -> None:
    if os.name == "nt":
        return
    for p in paths:
        if p.exists():
            p.chmod(p.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def self_update(progress: ProgressFn) -> Dict[str, Any]:
    base = install_dir()
    if (base / ".git").exists():
        raise HelperError(E_BAD_REQUEST, "This is a development copy (a git checkout): update it with git pull.")
    if not (base / "extension" / "manifest.json").exists():
        raise HelperError(E_BAD_REQUEST, f"Unexpected install folder: {base}")

    progress(None, "update:download")
    blob = _fetch(_latest_zip_url(), MAX_ZIP_BYTES, progress)
    warnings: List[str] = []
    with tempfile.TemporaryDirectory(prefix="mdl-update-") as tmp:
        tmpdir = Path(tmp)
        archive = tmpdir / "update.zip"
        archive.write_bytes(blob)
        with zipfile.ZipFile(archive) as zf:
            _safe_extract(zf, tmpdir / "x")
        # <archive>/<repo>-<branch>/extension/manifest.json -> the project root is two levels up
        roots = [p.parent.parent for p in (tmpdir / "x").glob("*/extension/manifest.json")]
        if not roots or not (roots[0] / "helper" / "native_host.py").exists():
            raise HelperError(E_BAD_REQUEST, "The downloaded update does not look like Media Downloader.")
        new = roots[0]
        new_version = str(json.loads((new / "extension" / "manifest.json").read_text(encoding="utf-8"))["version"])

        progress(None, "update:install")
        _mirror(new / "extension", base / "extension")
        _copy_helper(new / "helper", base / "helper")
        for name in TOP_LEVEL_FILES:
            if (new / name).exists():
                shutil.copy2(new / name, base / name)
    _make_executable([base / n for n in TOP_LEVEL_FILES if n.endswith(".command")] + [base / "helper" / "install_unix.sh"])

    progress(None, "update:packages")
    py = sys.executable  # the helper runs inside its .venv
    kw: Dict[str, Any] = {"capture_output": True, "text": True, "stdin": subprocess.DEVNULL}
    if os.name == "nt":
        kw["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    elif sys.version_info < (3, 10):
        warnings.append("The helper runs on Python 3.9, so yt-dlp cannot update any more. "
                        "Run Update-Mac.command once: it moves the helper to a newer Python.")
    try:
        r = subprocess.run([py, "-m", "pip", "install", "--quiet", "--upgrade", "-r",
                            str(base / "helper" / "requirements.txt")], timeout=900, **kw)
        if r.returncode != 0:
            warnings.append("Some packages could not be updated: " + (r.stderr or "").strip()[-300:])
    except Exception as exc:  # the old packages keep working
        warnings.append(f"Package update skipped: {exc}")
    try:
        r = subprocess.run([py, str(base / "helper" / "main.py"), "install"], timeout=180, **kw)
        if r.returncode != 0:
            warnings.append("Re-registering the helper reported a problem: " + (r.stdout or r.stderr or "").strip()[-300:])
    except Exception as exc:
        warnings.append(f"Re-registering the helper failed: {exc}")
    return {"from": VERSION, "to": new_version, "warnings": warnings}
