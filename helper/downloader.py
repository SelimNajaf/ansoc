"""Platform-neutral download toolkit used by every engine.

Rules enforced here:
* Only URLs of supported platforms / their CDNs are requested (router.is_allowed_url).
* Bytes are stored exactly as received: no re-encoding, resizing or recompression.
  The only container operation is yt-dlp/FFmpeg stream *copy* (remux / merge of
  separate audio + video streams into .mp4).
* Existing files are never overwritten.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional, Tuple

from common import (
    E_BAD_REQUEST, E_CANCELLED, E_FFMPEG_MISSING, E_LOGIN_REQUIRED, E_NETWORK, E_NO_MEDIA, E_PIN_NOT_FOUND, E_PRIVATE,
    E_RATE_LIMITED, E_REGION_BLOCKED, E_UNKNOWN, E_YTDLP_MISSING, HelperError, ensure_dirs, find_tool,
    get_logger, module_available, require_allowed_url, safe_name, timestamp, unique_path,
)
from metadata import (
    DuplicateIndex, build_metadata, read_image_metadata, read_video_metadata, sha256_file, write_metadata,
)

if TYPE_CHECKING:  # pragma: no cover
    from engines.base_engine import BaseEngine

ProgressFn = Callable[[Dict[str, Any]], None]

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
)
IMAGE_EXTS = {"jpg", "jpeg", "png", "gif", "webp", "avif", "heic", "bmp"}
VIDEO_EXTS = {"mp4", "m4v", "mov", "webm", "mkv"}
AUDIO_EXTS = {"mp3", "m4a", "aac", "opus", "ogg", "wav", "flac"}
MEDIA_EXTS = IMAGE_EXTS | VIDEO_EXTS | AUDIO_EXTS
STAGING_DIR_NAME = "MediaDownloader_staging"
# Codecs QuickTime / macOS / iOS / most TVs can play: H.264 and H.265 (HEVC).
# Among those yt-dlp still picks the best resolution; only VP9/AV1-only resolutions are skipped.
_COMPAT = "[vcodec~='^(avc|h264|hvc1|hev1|hevc|h265)']"
COMPAT_FORMAT = f"bv*{_COMPAT}+ba/b{_COMPAT}/bv*+ba/b"
# Default ("max quality"): highest resolution always wins; at equal resolution H.265/H.264 are
# preferred over VP9/AV1 (same quality, opens in more editors/players such as CapCut, QuickTime).
MAX_QUALITY_SORT = ["res", "vcodec:h265"]
LEGACY_STAGING_DIR_NAMES = {"Pinterest_staging"}


def ext_of(path: Path) -> str:
    return path.suffix.lstrip(".").lower()


def sniff_ext(path: Path, fallback: str) -> str:
    """Detect the real container from magic bytes (renaming only, never converting)."""
    try:
        with open(path, "rb") as fh:
            head = fh.read(16)
    except OSError:
        return fallback
    if head.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if head.startswith(b"\x89PNG"):
        return "png"
    if head[:4] == b"GIF8":
        return "gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "wav"
    if head[:3] == b"ID3" or head[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"):
        return "mp3"
    if head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand in (b"avif", b"avis"):
            return "avif"
        if brand in (b"heic", b"heix", b"mif1"):
            return "heic"
        if brand == b"qt  ":
            return "mov"
        if brand in (b"M4A ", b"M4B "):
            return "m4a"
        return "mp4" if fallback not in AUDIO_EXTS else fallback
    if head[:4] == b"\x1a\x45\xdf\xa3":
        return "webm"
    if head[:4] == b"OggS":
        return "ogg"
    return fallback


def classify_error(text: str) -> str:
    t = (text or "").lower()
    if "429" in t or "too many requests" in t or "rate limit" in t or "rate-limit" in t:
        return E_RATE_LIMITED
    if any(s in t for s in ("not available in your country", "geo restrict", "georestrict", "region",
                            "not available in your location", "ip address is blocked", "blocked in your")):
        return E_REGION_BLOCKED
    if any(s in t for s in ("video not available", "post may have been removed", "doesn't exist", "does not exist",
                            "video has been removed", "unable to find video", "status code 10204")):
        return E_PIN_NOT_FOUND
    if "redirect to home page" in t or "redirect to login" in t or "checkpoint" in t or "challenge_required" in t:
        return E_LOGIN_REQUIRED  # session missing / expired / Instagram security check
    if "private" in t or "this account is private" in t:
        return E_PRIVATE
    if "login required" in t or "log in" in t or "login" in t or "401" in t or "cookies" in t or "sign in" in t:
        return E_LOGIN_REQUIRED
    if "404" in t or "not found" in t or "pinnotfound" in t or "unavailable" in t or "removed" in t or "403" in t:
        return E_PIN_NOT_FOUND
    if "ffmpeg" in t and ("not found" in t or "not installed" in t):
        return E_FFMPEG_MISSING
    if any(s in t for s in ("timed out", "timeout", "connection", "network", "name resolution", "unreachable", "ssl")):
        return E_NETWORK
    return E_UNKNOWN


def pick_error(errors: List[HelperError]) -> HelperError:
    if not errors:
        return HelperError(E_UNKNOWN, "Download failed")
    priority = [E_YTDLP_MISSING, E_FFMPEG_MISSING, E_RATE_LIMITED, E_REGION_BLOCKED, E_PRIVATE, E_LOGIN_REQUIRED,
                E_PIN_NOT_FOUND, E_NETWORK]
    msg = "; ".join(e.message for e in errors)[:800]
    for code in priority:
        if any(e.code == code for e in errors):
            return HelperError(code, msg)
    return HelperError(errors[0].code, msg)


def store_kind(path: Path, default: str) -> str:
    """'image' or 'video' folder for a file (audio goes into videos/)."""
    e = ext_of(path)
    if e in IMAGE_EXTS:
        return "image"
    if e in VIDEO_EXTS | AUDIO_EXTS:
        return "video"
    return default


def compact_count(n: int) -> str:
    """950 -> "950", 12345 -> "12.3K", 3121240 -> "3.1M", 2000000 -> "2M" (safe in file names)."""
    n = max(0, int(n))
    if n < 1000:
        return str(n)
    units = ((1_000, "K"), (1_000_000, "M"), (1_000_000_000, "B"))
    for i, (div, suffix) in enumerate(units):
        v = round(n / div, 1)
        if v < 1000 or i == len(units) - 1:  # 999.96K would print as "1000K": use the next unit
            return f"{v:.1f}".rstrip("0").rstrip(".") + suffix
    return str(n)


class Downloader:
    def __init__(self, engine: "BaseEngine", progress: Optional[ProgressFn] = None):
        self.engine = engine
        self.platform = engine.id
        self.folder = engine.folder
        self.dirs = ensure_dirs(self.folder)
        self.index = DuplicateIndex(self.platform, self.dirs["metadata"])
        self.log = get_logger(self.folder)
        # Metadata JSON next to downloads is optional (setting "Save metadata"); off by default.
        self.write_meta = False
        # True: only QuickTime-playable codecs (H.264/H.265), even at a lower resolution.
        # False (default): max quality, H.264/H.265 only preferred at equal resolution. Never re-encodes.
        self.prefer_compat = False
        self._progress = progress or (lambda _p: None)
        self._last_progress = 0.0
        # View count known to the extension (Reels Analyzer); added to the file name when set.
        self.views: Optional[int] = None
        # Set by the native host when the extension cancels this request (see native_host "cancel").
        self.cancel_event: threading.Event = getattr(progress, "cancel", None) or threading.Event()
        # Login cookies handed over by the extension (chrome.cookies API) for this request only.
        # Kept in memory; never written to disk or logged.
        self.cookies: List[Dict[str, Any]] = []

    # ------------------------------------------------------------------ cookies
    def set_cookies(self, cookies: Any) -> None:
        """Accept [{name, value, domain, path, secure, expirationDate}] for this engine's own domains only."""
        out: List[Dict[str, Any]] = []
        for c in (cookies if isinstance(cookies, list) else [])[:300]:
            if not isinstance(c, dict):
                continue
            name, value, domain = c.get("name"), c.get("value"), str(c.get("domain") or "")
            if not isinstance(name, str) or not isinstance(value, str) or not domain:
                continue
            if not self.engine.matches("https://" + domain.lstrip(".")):
                continue  # never accept cookies of other sites
            out.append({"name": name, "value": value, "domain": domain, "path": str(c.get("path") or "/"),
                        "secure": bool(c.get("secure")), "expires": int(c.get("expirationDate") or 0)})
        self.cookies = out

    def has_cookie(self, name: str) -> bool:
        return any(c["name"] == name and c["value"] for c in self.cookies)

    def _inject_cookies(self, ydl: Any) -> None:
        import http.cookiejar

        for c in self.cookies:
            ydl.cookiejar.set_cookie(http.cookiejar.Cookie(
                0, c["name"], c["value"], None, False, c["domain"], True, c["domain"].startswith("."),
                c["path"], True, c["secure"], c["expires"] or None, not c["expires"], None, None, {}))

    def _netscape_cookies(self) -> str:
        lines = ["# Netscape HTTP Cookie File"]
        for c in self.cookies:
            dom = c["domain"]
            lines.append("\t".join([dom, "TRUE" if dom.startswith(".") else "FALSE", c["path"],
                                    "TRUE" if c["secure"] else "FALSE", str(c["expires"]), c["name"], c["value"]]))
        return "\n".join(lines) + "\n"

    # ------------------------------------------------------------------ utils
    def check_cancel(self) -> None:
        """Raise when the user cancelled this download. Also called from yt-dlp's progress
        hook (through progress()), which stops yt-dlp in the middle of a download."""
        if self.cancel_event.is_set():
            raise HelperError(E_CANCELLED, "Cancelled")

    def progress(self, percent: Optional[float], text: str = "", force: bool = False) -> None:
        self.check_cancel()
        now = time.monotonic()
        if not force and now - self._last_progress < 0.25:
            return
        self._last_progress = now
        self._progress({"percent": None if percent is None else round(max(0.0, min(100.0, percent)), 1), "text": text})

    def base_name(self, content_id: str, given: Optional[str] = None) -> str:
        """<platform>_<id>_<timestamp>[_<views>-views]"""
        if given:
            return safe_name(given)
        name = f"{self.platform}_{safe_name(content_id or 'unknown')}_{timestamp()}"
        if self.views is not None:
            # e.g. "_3.1M-views": tells the downloaded reels apart in the folder
            name += f"_{compact_count(self.views)}-views"
        return name

    def set_collection(self, name: Optional[str]) -> Optional[Path]:
        """Save into <Platform>/<name>/ instead of images/ and videos/.

        Duplicates are checked inside the collection, so a reel that was downloaded
        elsewhere can still be added to a new collection."""
        if not name:
            return None
        cname = safe_name(name, "collection")
        if cname.lower() in ("images", "videos", "metadata", "logs"):
            cname += "_collection"
        base = self.dirs["platform"] / cname
        try:
            base.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise HelperError(E_BAD_REQUEST, f"Cannot create collection folder {base}: {exc}") from exc
        self.dirs = dict(self.dirs, images=base, videos=base, metadata=base / "metadata", collection=base)
        self.index = DuplicateIndex(f"{self.platform}__{cname}")
        return base

    def tmp_dir(self) -> Path:
        """Scratch folder for one download, in the system temp folder: inside a synced folder
        (OneDrive Desktop) the sync client grabs it, half-finished files get uploaded and the
        folder often can't be deleted afterwards. finalize() moves the result into place."""
        base = Path(tempfile.gettempdir()) / "MediaDownloader"
        base.mkdir(parents=True, exist_ok=True)
        return Path(tempfile.mkdtemp(prefix=".mdl-", dir=base))

    # ------------------------------------------------------------------ finalize
    def finalize(self, src: Path, media_type: str, base_name: str, meta: dict, original_url: str = "",
                 downloaded_url: str = "", force: bool = False, move: bool = True,
                 store_as: Optional[str] = None, extra: Optional[dict] = None) -> Dict[str, Any]:
        """Move a finished file into images/ or videos/, dedupe, write its metadata JSON.

        media_type is what goes into the JSON (image | video | slideshow);
        store_as decides the folder (image -> images/, video/audio -> videos/)."""
        if not src.is_file() or src.stat().st_size == 0:
            raise HelperError(E_NO_MEDIA, "Downloaded file is empty or missing")
        kind = store_as or ("image" if media_type == "image" else "video")
        if kind == "video":
            self._fix_hevc_tag(src)
        digest = sha256_file(src)
        existing = self.index.lookup(digest)
        if existing and not force:
            if move:
                try:
                    src.unlink()
                except OSError:
                    pass
            self.log.info("Duplicate of %s (%s %s) skipped", existing["path"], self.platform, meta.get("content_id"))
            return {"status": "duplicate", "existing_path": existing["path"], "sha256": digest,
                    "existing_download_id": existing.get("download_id")}

        ext = sniff_ext(src, ext_of(src) or ("jpg" if kind == "image" else "mp4"))
        target_dir = self.dirs["images" if kind == "image" else "videos"]
        dest = unique_path(target_dir, base_name, ext)
        if move:
            shutil.move(str(src), str(dest))
        else:
            shutil.copy2(str(src), str(dest))

        size = dest.stat().st_size
        meta_path = None
        if not self.write_meta:
            self.index.add(digest, dest, str(meta.get("content_id", "")))
            self.log.info("Saved %s (%d bytes) for %s %s", dest, size, self.platform, meta.get("content_id"))
            return {"status": "success", "file": {
                "path": str(dest), "name": dest.name, "size": size, "media_type": media_type,
                "kind": "audio" if ext in AUDIO_EXTS else kind, "metadata_path": "", "sha256": digest}}
        md = build_metadata(
            meta,
            platform=self.platform,
            media_type=media_type,
            original_url=original_url or meta.get("original_url", ""),
            downloaded_url=downloaded_url or original_url,
            file_path=str(dest),
            file_name=dest.name,
            file_size=dest.stat().st_size,
            sha256=digest,
            download_status="success",
            **(extra or {}),
        )
        if ext in IMAGE_EXTS:
            md["exif_metadata"] = read_image_metadata(dest)
        else:
            md["video_metadata"] = read_video_metadata(dest)
        self.dirs["metadata"].mkdir(parents=True, exist_ok=True)
        meta_path = write_metadata(self.dirs["metadata"], dest.stem, md)
        self.index.add(digest, dest, str(meta.get("content_id", "")))
        self.log.info("Saved %s (%d bytes) for %s %s", dest, md["file_size"], self.platform, meta.get("content_id"))
        return {
            "status": "success",
            "file": {
                "path": str(dest),
                "name": dest.name,
                "size": md["file_size"],
                "media_type": media_type,
                "kind": "audio" if ext in AUDIO_EXTS else kind,
                "metadata_path": str(meta_path),
                "sha256": digest,
            },
        }

    def _fix_hevc_tag(self, src: Path) -> None:
        """QuickTime plays HEVC only with the 'hvc1' tag. Re-tag 'hev1' files (stream copy, no re-encode)."""
        ffprobe, ffmpeg = find_tool("ffprobe"), find_tool("ffmpeg")
        if not ffprobe or not ffmpeg or ext_of(src) not in ("mp4", "mov", "m4v"):
            return
        try:
            r = subprocess.run([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries",
                                "stream=codec_name,codec_tag_string", "-of", "csv=p=0", str(src)],
                               capture_output=True, text=True, timeout=60)
            if r.stdout.strip() != "hevc,hev1":
                return
            out = src.with_name(src.stem + ".hvc1" + src.suffix)
            r = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(src), "-map", "0",
                                "-c", "copy", "-tag:v", "hvc1", "-movflags", "+faststart", str(out)],
                               capture_output=True, text=True, timeout=600)
            if r.returncode == 0 and out.exists() and out.stat().st_size > 0:
                os.replace(out, src)
                self.log.info("Re-tagged HEVC hev1 -> hvc1 for QuickTime: %s", src.name)
            else:
                out.unlink(missing_ok=True)
        except (OSError, subprocess.SubprocessError) as exc:
            self.log.info("HEVC re-tag skipped: %s", exc)

    def finalize_many(self, files: List[Path], media_type: str, base: str, meta: dict, original_url: str,
                      force: bool, names: Optional[List[str]] = None) -> Dict[str, Any]:
        results = []
        for i, f in enumerate(files):
            name = names[i] if names else (base if len(files) == 1 else f"{base}_{i + 1:02d}")
            results.append(self.finalize(f, media_type, name, meta, original_url, original_url, force,
                                         store_as=store_kind(f, "image")))
        saved = [r["file"] for r in results if r["status"] == "success"]
        dup = [r for r in results if r["status"] == "duplicate"]
        if not saved:
            return {"status": "duplicate", "existing_path": dup[0]["existing_path"] if dup else "", "files": [],
                    "existing_download_id": dup[0].get("existing_download_id") if dup else None}
        return {"status": "success", "file": saved[0], "files": saved, "duplicates": len(dup)}

    # ------------------------------------------------------------------ ingest (chrome.downloads -> helper)
    def ingest(self, staged_path: str, media_type: str, base_name: str, meta: dict,
               original_url: str = "", downloaded_url: str = "", force: bool = False) -> Dict[str, Any]:
        src = Path(staged_path or "")
        # Only accept files Chrome placed in our own staging folder.
        if src.parent.name not in {STAGING_DIR_NAME} | LEGACY_STAGING_DIR_NAMES or not src.is_file():
            raise HelperError(E_BAD_REQUEST, f"Refusing to ingest unexpected path: {staged_path}")
        if ext_of(src) not in MEDIA_EXTS:
            raise HelperError(E_BAD_REQUEST, f"Unexpected file type: {src.suffix}")
        try:
            res = self.finalize(src, media_type, self.base_name(meta.get("content_id", ""), base_name), meta,
                                original_url, downloaded_url, force)
        except PermissionError as exc:
            raise HelperError(E_BAD_REQUEST, f"No permission to read the staged file: {exc}") from exc
        try:
            src.parent.rmdir()  # remove staging folder when empty
        except OSError:
            pass
        return res

    # ------------------------------------------------------------------ direct CDN download
    def download_url(self, url: str, media_type: str, base_name: str, meta: dict, force: bool = False,
                     retries: int = 3, store_as: Optional[str] = None) -> Dict[str, Any]:
        require_allowed_url(url)
        tmp = self.tmp_dir()
        try:
            ext = Path(url.split("?")[0]).suffix.lstrip(".")[:5] or ("jpg" if media_type == "image" else "mp4")
            part = tmp / f"download.{ext}"
            self.fetch(url, part, retries)
            return self.finalize(part, media_type, self.base_name(meta.get("content_id", ""), base_name), meta,
                                 url, url, force, store_as=store_as)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def fetch(self, url: str, dest: Path, retries: int = 3, headers: Optional[dict] = None) -> None:
        delay = 2.0
        for attempt in range(1, retries + 1):
            try:
                hdrs = {"User-Agent": UA}
                hdrs.update(headers or {})
                req = urllib.request.Request(url, headers=hdrs)
                with urllib.request.urlopen(req, timeout=30) as resp:
                    require_allowed_url(resp.geturl())
                    total = int(resp.headers.get("Content-Length") or 0)
                    done = 0
                    with open(dest, "wb") as fh:
                        while True:
                            chunk = resp.read(256 * 1024)
                            if not chunk:
                                break
                            fh.write(chunk)
                            done += len(chunk)
                            self.progress(done * 100.0 / total if total else None, "download")
                    if total and done != total:
                        raise HelperError(E_NETWORK, f"Incomplete download ({done}/{total} bytes)")
                    self.progress(100, "download", force=True)
                    return
            except urllib.error.HTTPError as exc:
                if exc.code in (403, 404, 410):
                    raise HelperError(E_PIN_NOT_FOUND, f"HTTP {exc.code} for {url}") from exc
                err = HelperError(E_RATE_LIMITED if exc.code == 429 else E_NETWORK, f"HTTP {exc.code} for {url}")
            except HelperError as exc:
                err = exc
            except (urllib.error.URLError, OSError, TimeoutError) as exc:
                err = HelperError(E_NETWORK, str(exc))
            self.log.warning("Attempt %d/%d failed for %s: %s", attempt, retries, url, err.message)
            if attempt == retries or err.code not in (E_NETWORK, E_RATE_LIMITED):
                raise err
            time.sleep(delay * (3 if err.code == E_RATE_LIMITED else 1))
            delay *= 2

    def resolve_redirect(self, url: str) -> str:
        """Follow redirects of a short link (vm.tiktok.com, pin.it, ...) and return the final URL."""
        require_allowed_url(url)
        req = urllib.request.Request(url, headers={"User-Agent": UA}, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                final = resp.geturl()
        except urllib.error.HTTPError as exc:
            final = exc.geturl() or url
            if exc.code == 429:
                raise HelperError(E_RATE_LIMITED, f"HTTP 429 for {url}") from exc
        except (urllib.error.URLError, OSError) as exc:
            raise HelperError(E_NETWORK, str(exc)) from exc
        require_allowed_url(final)
        return final

    # ------------------------------------------------------------------ yt-dlp
    def _ytdlp_opts(self, out_dir: Path, use_browser_cookies: bool, fmt: Optional[str] = None) -> Dict[str, Any]:
        ffmpeg = find_tool("ffmpeg")
        outer = self

        class _Log:
            def debug(self, msg):
                pass

            def info(self, msg):
                pass

            def warning(self, msg):
                outer.log.info("yt-dlp: %s", msg)

            def error(self, msg):
                outer.log.warning("yt-dlp: %s", msg)

        def hook(d):
            self.check_cancel()  # raising inside the hook makes yt-dlp stop the download
            if d.get("status") == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate")
                if total:
                    self.progress(d.get("downloaded_bytes", 0) * 100.0 / total, "yt-dlp")
                elif d.get("fragment_count"):
                    self.progress((d.get("fragment_index") or 0) * 100.0 / d["fragment_count"], "yt-dlp")
            elif d.get("status") == "finished":
                self.progress(100, "merge", force=True)

        opts: Dict[str, Any] = {
            "outtmpl": str(out_dir / "media.%(ext)s"),
            # best video + best audio (merged), else best single file
            "format": fmt or (COMPAT_FORMAT if self.prefer_compat else "bv*+ba/b"),
            "format_sort": [] if self.prefer_compat else list(MAX_QUALITY_SORT),
            "merge_output_format": "mp4",
            "postprocessors": [
                {"key": "FFmpegVideoRemuxer", "preferedformat": "mp4"},  # remux = stream copy, no re-encode
                {"key": "FFmpegMetadata", "add_metadata": True},
            ],
            "logger": _Log(),
            "progress_hooks": [hook],
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
            "noplaylist": True,
            "retries": 5,
            "fragment_retries": 10,
            "concurrent_fragment_downloads": 4,
            "overwrites": False,
            "updatetime": False,
        }
        if ffmpeg:
            opts["ffmpeg_location"] = ffmpeg
        else:
            opts["format"] = "b[ext=mp4]/b"  # without FFmpeg only a pre-muxed file can be taken
            opts["postprocessors"] = []
        if use_browser_cookies and not self.cookies:
            # Fallback: read Chrome's cookie DB locally (may need macOS permission / Keychain).
            opts["cookiesfrombrowser"] = ("chrome",)
        return opts

    def ytdlp_info(self, url: str, use_browser_cookies: bool = False) -> Dict[str, Any]:
        """Metadata only (no download)."""
        if not module_available("yt_dlp"):
            raise HelperError(E_YTDLP_MISSING, "yt-dlp is not installed")
        import yt_dlp  # type: ignore

        require_allowed_url(url)
        opts = self._ytdlp_opts(Path(tempfile.gettempdir()), use_browser_cookies)
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                if use_browser_cookies:
                    self._inject_cookies(ydl)
                return ydl.sanitize_info(ydl.extract_info(url, download=False))
        except Exception as exc:
            raise HelperError(classify_error(str(exc)), str(exc)[:500]) from exc

    def ytdlp(self, url: str, out_dir: Path, use_browser_cookies: bool = False, fmt: Optional[str] = None,
              precheck: Optional[Callable[[dict], None]] = None) -> Tuple[Path, Dict[str, Any]]:
        """Download with yt-dlp. ``precheck(info)`` may raise to stop before downloading."""
        if not module_available("yt_dlp"):
            raise HelperError(E_YTDLP_MISSING, "yt-dlp is not installed")
        import yt_dlp  # type: ignore

        require_allowed_url(url)
        self.check_cancel()
        opts = self._ytdlp_opts(out_dir, use_browser_cookies, fmt)
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                if use_browser_cookies:
                    self._inject_cookies(ydl)
                info = ydl.extract_info(url, download=False)
                self.check_cancel()
                if precheck:
                    precheck(info)
                info = ydl.process_ie_result(info, download=True)
                info = ydl.sanitize_info(info)
        except HelperError:
            raise
        except Exception as exc:  # yt_dlp.utils.DownloadError and friends
            self.check_cancel()  # yt-dlp wraps our hook's exception: report it as a cancel
            raise HelperError(classify_error(str(exc)), str(exc)[:500]) from exc
        files = [p for p in out_dir.iterdir() if p.is_file() and ext_of(p) in VIDEO_EXTS | AUDIO_EXTS]
        if not files:
            raise HelperError(E_NO_MEDIA, "yt-dlp produced no media file")
        return max(files, key=lambda p: p.stat().st_size), info

    # ------------------------------------------------------------------ gallery-dl
    def gallery_dl(self, url: str, out_dir: Path, use_browser_cookies: bool = False,
                   options: Optional[List[str]] = None, write_metadata: bool = False) -> List[Path]:
        if not module_available("gallery_dl"):
            raise HelperError(E_NO_MEDIA, "gallery-dl is not installed")
        require_allowed_url(url)
        self.check_cancel()
        # Not --quiet: its log lines (rate-limit waits, login challenges) are read live below.
        cmd = [sys.executable, "-m", "gallery_dl", "--no-colors", "-D", str(out_dir)]
        for o in options or []:
            cmd += ["-o", o]
        if write_metadata:
            cmd.append("--write-metadata")
        # gallery-dl hands DASH videos (Instagram) to yt-dlp: give it the same codec preference
        if self.prefer_compat:
            cmd += ["-o", f"downloader.ytdl.format={COMPAT_FORMAT}"]
        else:
            cmd += ["-o", "downloader.ytdl.raw-options=" + json.dumps({"format_sort": MAX_QUALITY_SORT})]
        pass_fds: Tuple[int, ...] = ()
        cookie_tmp: Optional[Path] = None
        if use_browser_cookies and self.cookies:
            data = self._netscape_cookies().encode("utf-8")
            cmd += ["-o", "cookies-update=false"]
            if os.name != "nt" and len(data) < 16000:
                # Hand the cookies over through a pipe: nothing touches the disk.
                rfd, wfd = os.pipe()
                os.write(wfd, data)
                os.close(wfd)
                pass_fds = (rfd,)
                cmd += ["--cookies", f"/dev/fd/{rfd}"]
            else:  # Windows: short-lived private temp file, deleted right after the run
                fd, name = tempfile.mkstemp(prefix=".mdl-c-", suffix=".txt")
                with os.fdopen(fd, "wb") as fh:
                    fh.write(data)
                cookie_tmp = Path(name)
                cmd += ["--cookies", name]
        elif use_browser_cookies:
            cmd += ["--cookies-from-browser", "chrome"]
        cmd.append(url)
        self.progress(None, "gallery-dl", force=True)
        env = dict(os.environ)
        ffmpeg = find_tool("ffmpeg")
        if ffmpeg:
            env["PATH"] = os.path.dirname(ffmpeg) + os.pathsep + env.get("PATH", "")
        try:
            returncode, stderr = self._run_streaming(cmd, env, pass_fds, timeout=3600)
        finally:
            for fd in pass_fds:
                os.close(fd)
            if cookie_tmp:
                cookie_tmp.unlink(missing_ok=True)
        files = sorted(p for p in out_dir.rglob("*") if p.is_file() and ext_of(p) in MEDIA_EXTS)
        if returncode != 0 and not files:
            raise HelperError(classify_error(stderr), (stderr or "gallery-dl failed").strip()[-400:])
        return files

    # "[instagram][info] Waiting for 2 minutes until 11:52:33 (429 Too Many Requests)"
    _WAIT_RE = re.compile(r"Waiting for (.+?) until (\d{1,2}:\d{2}):\d{2} \((.+?)\)")

    def _run_streaming(self, cmd: List[str], env: Dict[str, str], pass_fds: Tuple[int, ...],
                       timeout: float) -> Tuple[int, str]:
        """Run gallery-dl and read its log while it runs, so a rate-limit wait shows up in
        the extension ("waiting until 11:52") instead of looking like a frozen download."""
        kw: Dict[str, Any] = {}
        if os.name == "nt":
            kw["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        # stdin=DEVNULL: never let a child see the native-messaging pipe (see native_host.py)
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
                                encoding="utf-8", errors="replace", env=env, pass_fds=pass_fds, **kw)
        tail: List[str] = []

        def read() -> None:
            assert proc.stderr is not None
            for line in proc.stderr:
                line = line.rstrip()
                if not line:
                    continue
                tail.append(line)
                del tail[:-40]
                m = self._WAIT_RE.search(line)
                if m:
                    # text protocol for the extension: "wait:<HH:MM>:<reason>"
                    self.progress(None, f"wait:{m.group(2)}:{m.group(3)}", force=True)
                    self.log.info("gallery-dl: %s", line)
                elif "[warning]" in line or "[error]" in line:
                    self.log.info("gallery-dl: %s", line)

        reader = threading.Thread(target=read, daemon=True)
        reader.start()
        deadline = time.monotonic() + timeout
        try:
            # poll instead of one long wait, so a Cancel (or the timeout) stops the process quickly
            while proc.poll() is None:
                if self.cancel_event.is_set():
                    self._kill_tree(proc)
                    raise HelperError(E_CANCELLED, "Cancelled")
                if time.monotonic() > deadline:
                    self._kill_tree(proc)
                    raise HelperError(E_NETWORK, "gallery-dl timed out")
                self.cancel_event.wait(0.3)
        finally:
            reader.join(timeout=5)
        return proc.returncode, "\n".join(tail)

    @staticmethod
    def _kill_tree(proc: "subprocess.Popen[str]") -> None:
        """Stop a child and its own children (on Windows the venv python.exe is a launcher that
        starts the real interpreter as a child, which a plain kill() would leave running)."""
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        else:
            proc.kill()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass

    @staticmethod
    def gallery_dl_metadata(media_file: Path) -> Dict[str, Any]:
        """Read the <file>.json written by gallery-dl --write-metadata (if any)."""
        for cand in (media_file.with_name(media_file.name + ".json"), media_file.with_suffix(".json")):
            try:
                return json.loads(cand.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
        return {}

    # ------------------------------------------------------------------ video (HLS / blob / anything)
    def download_video(self, hls_url: str = "", page_url: str = "", base_name: str = "", meta: Optional[dict] = None,
                       force: bool = False, use_browser_cookies: bool = False, mp4_url: str = "") -> Dict[str, Any]:
        """yt-dlp (HLS, then page) -> gallery-dl -> FFmpeg stream copy -> progressive MP4."""
        meta = meta or {}
        sources = [u for u in (hls_url, page_url) if u]
        if not sources:
            raise HelperError(E_BAD_REQUEST, "No video URL given")
        for u in sources:
            require_allowed_url(u)
        base = self.base_name(meta.get("content_id", ""), base_name)
        tmp = self.tmp_dir()
        errors: List[HelperError] = []
        try:
            for src in sources:
                try:
                    path, _info = self.ytdlp(src, tmp, use_browser_cookies)
                    return self.finalize(path, "video", base, meta, hls_url or src, src, force)
                except HelperError as exc:
                    errors.append(exc)
                    self.log.warning("yt-dlp failed for %s: %s", src, exc.message)
                    if exc.code == E_YTDLP_MISSING:
                        break
            if page_url and module_available("gallery_dl"):
                try:
                    vids = [f for f in self.gallery_dl(page_url, tmp, use_browser_cookies) if ext_of(f) in VIDEO_EXTS]
                    if vids:
                        best = max(vids, key=lambda p: p.stat().st_size)
                        return self.finalize(best, "video", base, meta, hls_url or page_url, page_url, force)
                    errors.append(HelperError(E_NO_MEDIA, "gallery-dl found no video"))
                except HelperError as exc:
                    errors.append(exc)
            ffmpeg = find_tool("ffmpeg")
            if hls_url and ffmpeg:
                try:
                    out = tmp / "ffmpeg.mp4"
                    self.progress(None, "ffmpeg", force=True)
                    r = subprocess.run(
                        [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-user_agent", UA,
                         "-i", hls_url, "-c", "copy", "-bsf:a", "aac_adtstoasc",
                         "-map_metadata", "0", "-movflags", "+faststart", str(out)],
                        capture_output=True, text=True, timeout=3600,
                    )
                    if r.returncode == 0 and out.exists():
                        return self.finalize(out, "video", base, meta, hls_url, hls_url, force)
                    errors.append(HelperError(classify_error(r.stderr), r.stderr.strip()[-400:]))
                except subprocess.TimeoutExpired:
                    errors.append(HelperError(E_NETWORK, "FFmpeg timed out"))
            elif hls_url and not ffmpeg:
                errors.append(HelperError(E_FFMPEG_MISSING, "FFmpeg is not installed"))
            if mp4_url:
                try:
                    return self.download_url(mp4_url, "video", base, meta, force)
                except HelperError as exc:
                    errors.append(exc)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        raise pick_error(errors)

    # ------------------------------------------------------------------ whole page fallback
    def download_page(self, page_url: str, base_name: str = "", meta: Optional[dict] = None, force: bool = False,
                      use_browser_cookies: bool = False, media_type: str = "") -> Dict[str, Any]:
        """gallery-dl, then yt-dlp, on a page URL; saves every media file found."""
        require_allowed_url(page_url)
        meta = meta or {}
        base = self.base_name(meta.get("content_id", ""), base_name)
        errors: List[HelperError] = []
        tmp = self.tmp_dir()
        try:
            files: List[Path] = []
            if module_available("gallery_dl"):
                try:
                    files = self.gallery_dl(page_url, tmp, use_browser_cookies)
                except HelperError as exc:
                    errors.append(exc)
            if not files:
                try:
                    files = [self.ytdlp(page_url, tmp, use_browser_cookies)[0]]
                except HelperError as exc:
                    errors.append(exc)
            if not files:
                raise pick_error(errors or [HelperError(E_NO_MEDIA, "No media found")])
            mtype = media_type or ("image" if all(ext_of(f) in IMAGE_EXTS for f in files) else "video")
            return self.finalize_many(files, mtype, base, meta, page_url, force)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    # ------------------------------------------------------------------ metadata only
    def save_metadata(self, base_name: str, meta: dict, status: str = "success", error_code: str = "",
                      error_message: str = "") -> Dict[str, Any]:
        base = self.base_name(meta.get("content_id", ""), base_name)
        md = build_metadata(meta, platform=self.platform, download_status=status,
                            error_message=(f"{error_code}: {error_message}" if error_code else error_message))
        self.dirs["metadata"].mkdir(parents=True, exist_ok=True)
        path = write_metadata(self.dirs["metadata"], base, md)
        return {"status": "success", "metadata_path": str(path)}
