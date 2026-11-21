"""Metadata: JSON sidecar files, EXIF / video probing and the duplicate index.

Pillow and exifread are used ONLY to read metadata. Files are never re-saved,
re-encoded, resized or recompressed.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import threading
from pathlib import Path
from typing import Any, Dict, Optional

from common import find_tool, get_logger, now_iso

INDEX_NAME = ".download_index.json"

METADATA_TEMPLATE: Dict[str, Any] = {
    "platform": "",
    "content_id": "",
    "content_url": "",
    "media_type": "",
    "original_url": "",
    "downloaded_url": "",
    "file_path": "",
    "file_name": "",
    "file_size": "",
    "sha256": "",
    "created_at": "",
    "downloaded_at": "",
    "author": "",
    "username": "",
    "title": "",
    "description": "",
    "hashtags": [],
    "board": "",
    "tags": [],
    "platform_metadata": {},
    "exif_metadata": {},
    "video_metadata": {},
    "download_status": "success",
    "error_message": "",
}

_CONTENT_FIELDS = (
    "platform", "content_id", "content_url", "media_type", "original_url", "downloaded_url", "created_at",
    "author", "username", "title", "description", "hashtags", "board", "tags", "platform_metadata",
)
# Older (Pinterest-only) field names still accepted from callers.
_LEGACY = {"pin_id": "content_id", "pin_url": "content_url", "pinterest_metadata": "platform_metadata"}


def build_metadata(content: Optional[dict], **overrides: Any) -> Dict[str, Any]:
    meta = json.loads(json.dumps(METADATA_TEMPLATE))
    content = dict(content or {})
    for old, new in _LEGACY.items():
        if old in content and not content.get(new):
            content[new] = content[old]
    for key in _CONTENT_FIELDS:
        if key in content and content[key] is not None:
            meta[key] = content[key]
    meta["downloaded_at"] = now_iso()
    meta.update({k: v for k, v in overrides.items() if v is not None})
    for key in ("tags", "hashtags"):
        if not isinstance(meta.get(key), list):
            meta[key] = []
    return meta


def write_metadata(meta_dir: Path, base_name: str, meta: Dict[str, Any]) -> Path:
    """Write <base_name>.json without ever overwriting an existing file."""
    from common import unique_path

    path = unique_path(meta_dir, base_name, "json")
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)
    return path


# --------------------------------------------------------------------------- hashing / index
def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


class DuplicateIndex:
    """sha256 -> {path, content_id, at}. Kept in the helper's state folder (not on the Desktop),
    one file per platform (and per collection)."""

    def __init__(self, key: str, legacy_meta_dir: Optional[Path] = None):
        from common import STATE_DIR, safe_name

        STATE_DIR.mkdir(parents=True, exist_ok=True)
        self.path = STATE_DIR / f"{safe_name(key, 'index')}.json"
        self._lock = threading.Lock()
        # One-time migration of the old index that lived in <Platform>/metadata/ on the Desktop.
        legacy = legacy_meta_dir / INDEX_NAME if legacy_meta_dir else None
        if legacy and legacy.is_file() and not self.path.exists():
            try:
                self.path.write_text(legacy.read_text(encoding="utf-8"), encoding="utf-8")
            except OSError:
                pass

    def _load(self) -> Dict[str, dict]:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def lookup(self, digest: str) -> Optional[dict]:
        with self._lock:
            entry = self._load().get(digest)
        if not entry:
            return None
        p = Path(entry.get("path", ""))
        if p.exists():
            return entry
        # Saved before the download folder was renamed (Desktop/MediaDownloader -> Desktop/Medias)?
        from common import legacy_root_dir, root_dir

        try:
            moved = root_dir() / p.relative_to(legacy_root_dir())
        except ValueError:
            moved = None
        if moved is not None and moved.exists():
            return dict(entry, path=str(moved))
        # Ignore stale entries whose file the user deleted.
        return None

    def add(self, digest: str, path: Path, content_id: str) -> None:
        with self._lock:
            data = self._load()
            data[digest] = {"path": str(path), "content_id": content_id, "at": now_iso()}
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
            os.replace(tmp, self.path)


# --------------------------------------------------------------------------- EXIF / image info
def _jsonable(value: Any) -> Any:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, bytes):
        return value.hex() if len(value) <= 64 else f"<{len(value)} bytes>"
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value[:64]]
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in list(value.items())[:256]}
    try:
        return float(value)  # PIL IFDRational
    except Exception:
        return str(value)


def read_image_metadata(path: Path) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    log = get_logger()
    try:
        from PIL import ExifTags, Image  # read-only usage

        with Image.open(path) as img:
            out["format"] = img.format
            out["width"], out["height"] = img.size
            out["mode"] = img.mode
            out["animated"] = bool(getattr(img, "is_animated", False))
            out["frames"] = int(getattr(img, "n_frames", 1))
            exif = img.getexif()
            if exif:
                out["exif"] = {ExifTags.TAGS.get(k, str(k)): _jsonable(v) for k, v in exif.items()}
            info = {k: _jsonable(v) for k, v in img.info.items() if k not in ("exif", "icc_profile", "xmp")}
            if info:
                out["info"] = info
            if img.info.get("icc_profile"):
                out["icc_profile_bytes"] = len(img.info["icc_profile"])
            if img.info.get("xmp"):
                xmp = img.info["xmp"]
                out["xmp"] = xmp.decode("utf-8", "replace") if isinstance(xmp, bytes) else str(xmp)
    except ImportError:
        out["note"] = "Pillow not installed"
    except Exception as exc:
        log.info("Pillow could not read %s: %s", path.name, exc)
    try:
        import exifread

        with open(path, "rb") as fh:
            tags = exifread.process_file(fh, details=False)
        if tags:
            out["exifread"] = {k: str(v) for k, v in tags.items() if "Thumbnail" not in k}
    except ImportError:
        pass
    except Exception as exc:
        log.info("exifread could not read %s: %s", path.name, exc)
    return out


def read_video_metadata(path: Path) -> Dict[str, Any]:
    ffprobe = find_tool("ffprobe")
    if not ffprobe:
        return {"note": "ffprobe not found"}
    try:
        r = subprocess.run(
            [ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
            capture_output=True, text=True, timeout=60,
        )
        if r.returncode == 0:
            return json.loads(r.stdout)
        return {"note": r.stderr.strip()[:500]}
    except Exception as exc:
        return {"note": str(exc)}
