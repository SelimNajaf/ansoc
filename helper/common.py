"""Shared helpers: paths, config, logging, dependency detection and error codes.

Everything here is local. Nothing in this module talks to the network.
"""
from __future__ import annotations

import datetime as _dt
import json
import logging
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from typing import Dict, Optional
from urllib.parse import urlparse

HOST_NAME = "com.local.media_downloader"
LEGACY_HOST_NAMES = ("com.local.pinterest_downloader",)  # removed by the installer
ROOT_FOLDER = "Medias"  # Desktop download folder of 2.17 (now only read, see legacy_root_dirs)
LEGACY_ROOT_FOLDER = "MediaDownloader"  # Desktop download folder before 2.17
OUTBOX_FOLDER = "MediaDownloader-outbox"  # finished files wait here until Chrome has taken them
HELPER_DIR = Path(__file__).resolve().parent


def _read_version() -> str:
    """One version for the whole app: the extension's manifest.json (installed next to helper/)."""
    try:
        import json as _json

        return str(_json.loads((HELPER_DIR.parent / "extension" / "manifest.json").read_text(encoding="utf-8"))["version"])
    except Exception:
        return "2.4.0"


VERSION = _read_version()
CONFIG_FILE = HELPER_DIR / "config.json"

SUBDIRS = ("images", "videos")  # the only folders created on the Desktop
STATE_DIR = Path(os.environ.get("PINDL_STATE") or (HELPER_DIR / "state"))  # duplicate index (not on the Desktop)
LOG_DIR = HELPER_DIR / "logs"  # helper logs (not on the Desktop)
LOG_KEEP_DAYS = 14

IS_WINDOWS = os.name == "nt"
IS_MAC = sys.platform == "darwin"


# --------------------------------------------------------------------------- errors
class HelperError(Exception):
    """Error with a stable machine-readable code the extension can translate."""

    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code
        self.message = message or code


# Error codes shared with the extension (extension/utils/constants.js)
E_PIN_NOT_FOUND = "NOT_FOUND"
E_NOT_FOUND = E_PIN_NOT_FOUND
E_LOGIN_REQUIRED = "LOGIN_REQUIRED"
E_PRIVATE = "PRIVATE_CONTENT"
E_PRIVATE_PIN = E_PRIVATE  # backwards compatible name
E_REGION_BLOCKED = "REGION_BLOCKED"
E_UNSUPPORTED = "UNSUPPORTED_PLATFORM"
E_RATE_LIMITED = "RATE_LIMITED"
E_NETWORK = "NETWORK_ERROR"
E_FFMPEG_MISSING = "FFMPEG_MISSING"
E_YTDLP_MISSING = "YTDLP_MISSING"
E_DIR_CREATE = "DIR_CREATE_FAILED"
E_FILE_EXISTS = "FILE_EXISTS"
E_DUPLICATE = "DUPLICATE"
E_BAD_REQUEST = "BAD_REQUEST"
E_FORBIDDEN_HOST = "FORBIDDEN_HOST"
E_NO_MEDIA = "NO_MEDIA"
E_UNKNOWN = "UNKNOWN"
E_CANCELLED = "CANCELLED"  # the user pressed Cancel in the extension


# --------------------------------------------------------------------------- URL allow-list
# The allowed hosts are declared by the engines (engines/*.py); router.py checks them.
def is_allowed_url(url: str) -> bool:
    from router import is_allowed_url as _allowed  # lazy: avoids an import cycle

    return _allowed(url)


def require_allowed_url(url: str) -> str:
    if not isinstance(url, str) or not is_allowed_url(url):
        raise HelperError(E_FORBIDDEN_HOST, f"URL is not on a supported platform / CDN: {url!r}")
    return url


# --------------------------------------------------------------------------- Desktop / root folder
def _windows_desktop() -> Optional[Path]:
    try:
        import ctypes
        from ctypes import wintypes

        class GUID(ctypes.Structure):
            _fields_ = [
                ("Data1", wintypes.DWORD),
                ("Data2", wintypes.WORD),
                ("Data3", wintypes.WORD),
                ("Data4", ctypes.c_ubyte * 8),
            ]

        # FOLDERID_Desktop {B4BFCC3A-DB2C-424C-B029-7FE99A87C641}
        fid = GUID(0xB4BFCC3A, 0xDB2C, 0x424C, (ctypes.c_ubyte * 8)(0xB0, 0x29, 0x7F, 0xE9, 0x9A, 0x87, 0xC6, 0x41))
        out = ctypes.c_wchar_p()
        if ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(fid), 0, None, ctypes.byref(out)) == 0:
            path = out.value
            ctypes.windll.ole32.CoTaskMemFree(out)
            if path:
                return Path(path)
    except Exception:  # pragma: no cover - platform specific
        pass
    return None


def _linux_desktop() -> Optional[Path]:
    try:
        r = subprocess.run(["xdg-user-dir", "DESKTOP"], capture_output=True, text=True, timeout=3)
        val = r.stdout.strip()
        if r.returncode == 0 and val and Path(val) != Path.home():
            return Path(val)
    except Exception:
        pass
    cfg = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "user-dirs.dirs"
    try:
        for line in cfg.read_text(encoding="utf-8").splitlines():
            m = re.match(r'\s*XDG_DESKTOP_DIR="(.+)"', line)
            if m:
                return Path(m.group(1).replace("$HOME", str(Path.home())))
    except OSError:
        pass
    return None


def desktop_dir() -> Path:
    if IS_WINDOWS:
        return _windows_desktop() or Path(os.environ.get("USERPROFILE", str(Path.home()))) / "Desktop"
    if not IS_MAC:
        return _linux_desktop() or Path.home() / "Desktop"
    return Path.home() / "Desktop"


def legacy_root_dirs() -> list:
    """Download folders of earlier versions (Desktop/Medias in 2.17, Desktop/MediaDownloader before).
    Files there are left alone; they are only used to recognise earlier downloads."""
    return [desktop_dir() / ROOT_FOLDER, desktop_dir() / LEGACY_ROOT_FOLDER]


def root_dir() -> Path:
    """The helper's outbox (PINDL_ROOT env var overrides it, used by tests).

    Since 2.18 finished files only wait here: Chrome then downloads them from the helper
    (see handoff.py) into the user's Downloads folder, so they show up in Chrome's download
    list. The outbox is in the system temp folder, never in a synced Desktop / Downloads."""
    override = os.environ.get("PINDL_ROOT")
    if override:
        return Path(override)
    return Path(tempfile.gettempdir()) / OUTBOX_FOLDER


def ensure_dirs(folder: str = "Pinterest") -> Dict[str, Path]:
    """Create <outbox>/<folder>/{images,videos}.

    "metadata" is returned but only created when metadata JSON is actually written
    (the "Save metadata" button or the optional setting)."""
    base = root_dir() / folder
    dirs = {"root": root_dir(), "platform": base, "metadata": base / "metadata"}
    try:
        for sub in SUBDIRS:
            p = base / sub
            p.mkdir(parents=True, exist_ok=True)
            dirs[sub] = p
    except OSError as exc:
        raise HelperError(E_DIR_CREATE, f"Cannot create {base}: {exc}") from exc
    return dirs


def ensure_all_dirs() -> Dict[str, Path]:
    from router import all_engines

    out = {"root": root_dir()}
    for eng in all_engines():
        out[eng.name] = ensure_dirs(eng.name)["platform"]
    return out


# --------------------------------------------------------------------------- config
def load_config() -> dict:
    try:
        return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_config(cfg: dict) -> None:
    CONFIG_FILE.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


# --------------------------------------------------------------------------- tool discovery
# Chrome starts the host with a minimal PATH (especially on macOS), so look in the
# usual install locations too.
_EXTRA_BIN_DIRS = [
    str(HELPER_DIR / "bin"),  # bundled FFmpeg (copied from imageio-ffmpeg by the installer)
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/snap/bin",
    str(Path.home() / ".local" / "bin"),
    r"C:\ffmpeg\bin",
    r"C:\Program Files\ffmpeg\bin",
    str(Path.home() / "AppData" / "Local" / "Microsoft" / "WinGet" / "Links"),
    r"C:\ProgramData\chocolatey\bin",
]


def find_tool(name: str) -> Optional[str]:
    cfg = load_config()
    configured = cfg.get(f"{name}_path")
    if configured and Path(configured).is_file():
        return configured
    found = shutil.which(name)
    if found:
        return found
    exe = name + (".exe" if IS_WINDOWS else "")
    for d in _EXTRA_BIN_DIRS:
        cand = Path(d) / exe
        if cand.is_file():
            return str(cand)
    # winget installs ffmpeg into a versioned package folder
    if IS_WINDOWS:
        pkgs = Path.home() / "AppData" / "Local" / "Microsoft" / "WinGet" / "Packages"
        if pkgs.is_dir():
            for cand in pkgs.glob(f"*FFmpeg*/**/bin/{exe}"):
                return str(cand)
    return None


def module_available(mod: str) -> bool:
    import importlib.util

    return importlib.util.find_spec(mod) is not None


def dependency_report() -> dict:
    ffmpeg = find_tool("ffmpeg")
    ffprobe = find_tool("ffprobe")
    rep = {
        "python": platform.python_version(),
        "yt_dlp": module_available("yt_dlp"),
        "gallery_dl": module_available("gallery_dl"),
        "pillow": module_available("PIL"),
        "exifread": module_available("exifread"),
        "ffmpeg": ffmpeg or "",
        "ffprobe": ffprobe or "",
    }
    if rep["yt_dlp"]:
        try:
            import yt_dlp.version  # type: ignore

            rep["yt_dlp_version"] = yt_dlp.version.__version__
        except Exception:
            pass
    return rep


# --------------------------------------------------------------------------- logging
_log_lock = threading.Lock()
_loggers: Dict[str, logging.Logger] = {}


def _prune_logs() -> None:
    cutoff = _dt.datetime.now().timestamp() - LOG_KEEP_DAYS * 86400
    for p in LOG_DIR.glob("*.log"):
        try:
            if p.stat().st_mtime < cutoff:
                p.unlink()
        except OSError:
            pass


def get_logger(folder: Optional[str] = None) -> logging.Logger:
    """Logger in the helper's own folder (<helper>/logs/<platform>-YYYY-MM-DD.log), never on the Desktop
    and never stdout (stdout is the native-messaging channel). Old logs are removed after 14 days."""
    key = folder or "_host"
    with _log_lock:
        if key in _loggers:
            return _loggers[key]
        logger = logging.getLogger(f"mdl.{key}")
        logger.setLevel(logging.INFO)
        logger.propagate = False
        fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
        name = f"{(folder or 'host').lower()}-{_dt.date.today().isoformat()}.log"
        fh = None
        try:
            LOG_DIR.mkdir(parents=True, exist_ok=True)
            _prune_logs()
            fh = logging.FileHandler(LOG_DIR / name, encoding="utf-8")
        except Exception:
            fh = None
        if fh:
            fh.setFormatter(fmt)
            logger.addHandler(fh)
        sh = logging.StreamHandler(sys.stderr)
        sh.setFormatter(fmt)
        sh.setLevel(logging.WARNING)
        logger.addHandler(sh)
        _loggers[key] = logger
        return logger


# --------------------------------------------------------------------------- misc
def timestamp() -> str:
    return _dt.datetime.now().strftime("%Y-%m-%d_%H-%M-%S")


def now_iso() -> str:
    return _dt.datetime.now().astimezone().isoformat(timespec="seconds")


_SAFE_RE = re.compile(r"[^A-Za-z0-9._-]+")


def safe_name(name: str, fallback: str = "media") -> str:
    name = re.sub(r"\.{2,}", ".", _SAFE_RE.sub("_", str(name or ""))).strip("._")
    return name[:120] or fallback


def unique_path(directory: Path, base: str, ext: str) -> Path:
    """Never overwrite: append -1, -2 ... if the file already exists."""
    ext = ext.lstrip(".").lower()
    cand = directory / f"{base}.{ext}"
    i = 1
    while cand.exists():
        cand = directory / f"{base}-{i}.{ext}"
        i += 1
    return cand


def open_in_file_manager(path: Path) -> None:
    if IS_WINDOWS:
        os.startfile(str(path))  # type: ignore[attr-defined]
    elif IS_MAC:
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])
