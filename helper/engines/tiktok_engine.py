"""TikTok engine.

* Video posts      -> yt-dlp, best video + best audio, merged by FFmpeg with stream copy.
* Photo / slideshow -> gallery-dl: every image into TikTok/images, the music into TikTok/videos.
                       (yt-dlp does not support /photo/ posts; it is used as a fallback for the audio.)
* Short links (vm.tiktok.com, vt.tiktok.com, tiktok.com/t/...) and m.tiktok.com are resolved locally.
Nothing is sent anywhere except TikTok itself and its CDN.
"""
from __future__ import annotations

import datetime as _dt
import re
import shutil
from typing import Any, Dict, List, Optional, Tuple

from common import (
    E_BAD_REQUEST, E_CANCELLED, E_LOGIN_REQUIRED, E_NO_MEDIA, E_PRIVATE, E_RATE_LIMITED, E_REGION_BLOCKED, E_YTDLP_MISSING,
    HelperError,
)
from downloader import AUDIO_EXTS, IMAGE_EXTS, VIDEO_EXTS, ext_of, pick_error
from engines.base_engine import BaseEngine

POST_RE = re.compile(r"/(video|photo|v)/(\d{10,25})")
SHORT_HOST_RE = re.compile(r"^(vm|vt)\.tiktok\.com$", re.I)
# Errors where trying another tool would only hit the same wall (and add requests).
FINAL_ERRORS = {E_RATE_LIMITED, E_REGION_BLOCKED, E_PRIVATE, E_CANCELLED}


class _Slideshow(Exception):
    def __init__(self, info: dict):
        super().__init__("slideshow")
        self.info = info


class TikTokEngine(BaseEngine):
    id = "tiktok"
    name = "TikTok"
    page_hosts = (r"(^|\.)tiktok\.com$",)
    cdn_hosts = (
        r"(^|\.)tiktokcdn(-[a-z0-9]+)?\.com$",
        r"(^|\.)tiktokv\.(com|us|eu)$",
        r"(^|\.)ibyteimg\.com$",
        r"(^|\.)byteimg\.com$",
        r"(^|\.)ttwstatic\.com$",
        r"(^|\.)muscdn\.com$",
    )

    # ------------------------------------------------------------------ URLs
    def content_id(self, url: str) -> str:
        m = POST_RE.search(url)
        return m.group(2) if m else ""

    def resolve(self, url: str) -> Tuple[str, str, str, str]:
        """-> (content_id, kind 'video'|'photo', canonical_url, url_for_yt_dlp)"""
        url = url.split("#")[0]
        m = POST_RE.search(url)
        if not m:
            host = self._host(url)
            if SHORT_HOST_RE.match(host) or "/t/" in url or host.startswith("m."):
                url = self.dl.resolve_redirect(url)
                m = POST_RE.search(url)
        if not m:
            raise HelperError(E_BAD_REQUEST, f"Not a TikTok video/photo URL: {url}")
        kind = "photo" if m.group(1) == "photo" else "video"
        cid = m.group(2)
        user = re.search(r"/@([\w.\-]+)/", url)
        handle = user.group(1) if user else ""
        canonical = f"https://www.tiktok.com/@{handle}/{kind}/{cid}"
        return cid, kind, canonical, f"https://www.tiktok.com/@{handle}/video/{cid}"

    # ------------------------------------------------------------------ metadata mapping
    @staticmethod
    def _iso(ts: Any) -> str:
        try:
            return _dt.datetime.fromtimestamp(int(ts), _dt.timezone.utc).isoformat()
        except (TypeError, ValueError, OverflowError):
            return ""

    @staticmethod
    def _hashtags(text: str, extra: Optional[List[str]] = None) -> List[str]:
        tags = re.findall(r"#([^\s#]+)", text or "")
        for t in extra or []:
            if t and t not in tags:
                tags.append(t)
        return tags[:100]

    def _meta_from_ytdlp(self, info: dict, base: dict) -> dict:
        desc = info.get("description") or info.get("title") or ""
        keep = ("id", "uploader_id", "channel", "channel_id", "channel_url", "uploader_url", "track", "artist",
                "artists", "album", "duration", "view_count", "like_count", "repost_count", "comment_count",
                "save_count", "webpage_url", "width", "height", "format_id", "format", "vcodec", "acodec",
                "thumbnail", "upload_date")
        return dict(
            base,
            title=info.get("title") or "",
            description=desc,
            author=info.get("channel") or info.get("creator") or info.get("uploader") or "",
            username=info.get("uploader") or "",
            created_at=self._iso(info.get("timestamp")),
            hashtags=self._hashtags(desc, info.get("tags")),
            platform_metadata={"source": "yt-dlp", **{k: info.get(k) for k in keep if info.get(k) is not None}},
        )

    def _meta_from_gallery(self, m: dict, base: dict) -> dict:
        author = m.get("author") or {}
        music = m.get("music") or {}
        stats = m.get("stats") or {}
        desc = m.get("desc") or ""
        tags = [t.get("hashtagName") for t in (m.get("textExtra") or []) if isinstance(t, dict) and t.get("hashtagName")]
        image_post = m.get("imagePost") or {}
        return dict(
            base,
            title=(image_post.get("title") or desc)[:300],
            description=desc,
            author=author.get("nickname") or "",
            username=author.get("uniqueId") or "",
            created_at=self._iso(m.get("createTime")),
            hashtags=self._hashtags(desc, tags),
            platform_metadata={
                "source": "gallery-dl",
                "id": m.get("id"),
                "author_id": author.get("id"),
                "music": {k: music.get(k) for k in ("id", "title", "authorName", "album", "duration", "original") if k in music},
                "stats": stats,
                "image_count": len(image_post.get("images") or []),
                "location_created": m.get("locationCreated"),
                "is_ad": m.get("isAd"),
            },
        )

    # ------------------------------------------------------------------ download
    def download(self, url: str, force: bool = False, use_browser_cookies: bool = False) -> Dict[str, Any]:
        cid, kind, canonical, video_url = self.resolve(url)
        base_meta = {"content_id": cid, "content_url": canonical}
        base = self.dl.base_name(cid)
        if kind == "photo":
            return self._slideshow(canonical, video_url, cid, base, base_meta, force, use_browser_cookies)

        def precheck(info: dict) -> None:
            fmts = info.get("formats") or []
            if fmts and not any((f.get("vcodec") or "none") != "none" for f in fmts):
                raise _Slideshow(info)  # a photo post opened through a /video/ link

        tmp = self.dl.tmp_dir()
        errors: List[HelperError] = []
        try:
            try:
                path, info = self.dl.ytdlp(video_url, tmp, use_browser_cookies, precheck=precheck)
                meta = self._meta_from_ytdlp(info, base_meta)
                res = self.dl.finalize(path, "video", base, meta, canonical, info.get("url") or video_url, force)
                return self._wrap(res, "video", cid)
            except _Slideshow as s:
                shutil.rmtree(tmp, ignore_errors=True)
                photo_url = canonical.replace("/video/", "/photo/")
                return self._slideshow(photo_url, video_url, cid, base, base_meta, force, use_browser_cookies,
                                       yt_info=s.info)
            except HelperError as exc:
                errors.append(exc)
                self.log.warning("yt-dlp failed for %s: [%s] %s", video_url, exc.code, exc.message)
                if exc.code in FINAL_ERRORS:
                    raise
            # gallery-dl fallback (also handles videos)
            try:
                files = self.dl.gallery_dl(canonical, tmp, use_browser_cookies, ["videos=true", "audio=false"], True)
                vids = [f for f in files if ext_of(f) in VIDEO_EXTS]
                if vids:
                    gm = self.dl.gallery_dl_metadata(vids[0])
                    meta = self._meta_from_gallery(gm, base_meta) if gm else base_meta
                    res = self.dl.finalize(vids[0], "video", base, meta, canonical, canonical, force)
                    return self._wrap(res, "video", cid)
                if files:
                    return self._slideshow(canonical.replace("/video/", "/photo/"), video_url, cid, base,
                                           base_meta, force, use_browser_cookies)
                errors.append(HelperError(E_NO_MEDIA, "gallery-dl found no media"))
            except HelperError as exc:
                errors.append(exc)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        raise pick_error(errors)

    def _slideshow(self, photo_url: str, video_url: str, cid: str, base: str, base_meta: dict, force: bool,
                   cookies: bool, yt_info: Optional[dict] = None) -> Dict[str, Any]:
        """Images -> TikTok/images, music -> TikTok/videos, one JSON per file (media_type 'slideshow')."""
        tmp = self.dl.tmp_dir()
        errors: List[HelperError] = []
        try:
            files: List = []
            try:
                files = self.dl.gallery_dl(photo_url, tmp, cookies, ["photos=true", "audio=true", "videos=false",
                                                                     "covers=false"], True)
            except HelperError as exc:
                errors.append(exc)
                if exc.code in FINAL_ERRORS:
                    raise
            images = [f for f in files if ext_of(f) in IMAGE_EXTS]
            audio = [f for f in files if ext_of(f) in AUDIO_EXTS | VIDEO_EXTS]
            gm = self.dl.gallery_dl_metadata(images[0] if images else audio[0]) if files else {}
            if gm:
                meta = self._meta_from_gallery(gm, base_meta)
                images.sort(key=lambda f: int(self.dl.gallery_dl_metadata(f).get("num") or 0))
            elif yt_info:
                meta = self._meta_from_ytdlp(yt_info, base_meta)
            else:
                meta = dict(base_meta)

            if not audio:
                # Music through yt-dlp (it exposes the audio track of photo posts).
                audio_dir = tmp / "_audio"
                audio_dir.mkdir(exist_ok=True)
                try:
                    path, info = self.dl.ytdlp(video_url, audio_dir, cookies, fmt="ba/b")
                    audio = [path]
                    if not gm:
                        meta = self._meta_from_ytdlp(info, base_meta)
                except HelperError as exc:
                    errors.append(exc)

            if not images and not audio:
                raise pick_error(errors or [HelperError(E_NO_MEDIA, "No images or audio in this post")])

            saved, dups, existing = [], 0, ""

            def keep(r: Dict[str, Any]) -> None:
                nonlocal dups, existing
                if r["status"] == "success":
                    saved.append(r["file"])
                else:
                    dups += 1
                    existing = existing or r.get("existing_path", "")

            for i, f in enumerate(images, 1):
                pm = dict(meta.get("platform_metadata", {}), slideshow_image_count=len(images), slide_index=i)
                keep(self.dl.finalize(f, "slideshow", f"{base}_{i:02d}", dict(meta, platform_metadata=pm),
                                      photo_url, photo_url, force, store_as="image"))
            for f in audio[:1]:
                keep(self.dl.finalize(f, "slideshow", f"{base}_audio", meta, photo_url, photo_url, force,
                                      store_as="video"))
            if not images:
                self.log.warning("Slideshow %s: images could not be downloaded (%s)", cid,
                                 "; ".join(e.message for e in errors))
            if not saved:
                return {"status": "duplicate", "platform": self.id, "content_id": cid, "media_type": "slideshow",
                        "existing_path": existing, "files": []}
            out = {"status": "success", "platform": self.id, "content_id": cid, "media_type": "slideshow",
                   "files": saved, "file": saved[0], "duplicates": dups}
            if not images:
                out["warning"] = "IMAGES_MISSING"
            return out
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    # ------------------------------------------------------------------ metadata only
    def save_metadata(self, url: str, use_browser_cookies: bool = False) -> Dict[str, Any]:
        cid, kind, canonical, video_url = self.resolve(url)
        base_meta = {"content_id": cid, "content_url": canonical}
        try:
            info = self.dl.ytdlp_info(video_url, use_browser_cookies)
            meta = self._meta_from_ytdlp(info, base_meta)
            has_video = any((f.get("vcodec") or "none") != "none" for f in info.get("formats") or [])
            meta["media_type"] = "video" if has_video and kind == "video" else "slideshow"
        except HelperError as exc:
            if exc.code in (E_YTDLP_MISSING,) or exc.code in FINAL_ERRORS or exc.code == E_LOGIN_REQUIRED:
                raise
            meta = dict(base_meta, media_type="slideshow" if kind == "photo" else "video")
        res = self.dl.save_metadata("", meta)
        res.update({"platform": self.id, "content_id": cid, "media_type": meta.get("media_type", "")})
        return res

    def _wrap(self, res: Dict[str, Any], media_type: str, cid: str) -> Dict[str, Any]:
        files = res.get("files") or ([res["file"]] if res.get("file") else [])
        out = dict(res, platform=self.id, content_id=cid, media_type=media_type, files=files)
        return out
