"""Instagram engine.

* Posts (/p/), carousels, reels (/reel/, /reels/), IGTV (/tv/), stories (/stories/...).
* gallery-dl downloads every image and video of a post (carousel included) at the
  largest size Instagram serves; yt-dlp is used for videos (best video + best audio,
  merged with FFmpeg stream copy).
* Instagram shows almost nothing to logged-out visitors. Without the
  "use Chrome's login" setting only some public videos work; everything else
  needs that setting (cookies are read locally from Chrome by yt-dlp / gallery-dl,
  never stored, and sent only to Instagram itself).
"""
from __future__ import annotations

import datetime as _dt
import logging
import re
import shutil
import threading
import time
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

from common import (
    E_BAD_REQUEST, E_CANCELLED, E_LOGIN_REQUIRED, E_NETWORK, E_NO_MEDIA, E_PIN_NOT_FOUND, E_PRIVATE, E_RATE_LIMITED,
    E_REGION_BLOCKED, E_YTDLP_MISSING, HelperError, module_available, now_iso,
)
from downloader import IMAGE_EXTS, VIDEO_EXTS, ext_of, pick_error
from engines.base_engine import BaseEngine

PROFILE_RE = re.compile(r"^/([A-Za-z0-9_.]{1,30})(?:/(?:reels|clips))?/?$")
RESERVED = {"p", "reel", "reels", "tv", "stories", "explore", "accounts", "direct", "about", "developer",
            "legal", "privacy", "web", "api", "graphql", "challenge", "emails", "session", "share"}
_GDL_LOCK = threading.Lock()  # gallery-dl's config is global
MAX_REELS = 500

POST_RE = re.compile(r"/(?:[\w.]+/)?(p|reels?|tv)/([A-Za-z0-9_-]{5,})")
STORY_RE = re.compile(r"/stories/(?:highlights/(\d+)|([\w.]+)(?:/(\d+))?)")
# Errors where trying another tool would only hit the same wall (and add requests).
FINAL_ERRORS = {E_RATE_LIMITED, E_REGION_BLOCKED, E_PRIVATE, E_CANCELLED}


class _NotSingleVideo(Exception):
    pass


class InstagramEngine(BaseEngine):
    id = "instagram"
    name = "Instagram"
    page_hosts = (r"(^|\.)instagram\.com$", r"^(www\.)?instagr\.am$")
    cdn_hosts = (r"(^|\.)cdninstagram\.com$", r"(^|\.)fbcdn\.net$")

    # ------------------------------------------------------------------ URLs
    def parse(self, url: str) -> Tuple[str, str, str]:
        """-> (content_id, kind 'post'|'reel'|'tv'|'story', canonical_url)"""
        p = urlparse(url)
        path = p.path
        if p.hostname and "instagr.am" in p.hostname:
            url = f"https://www.instagram.com{path}"
        if "/share/" in path:  # share links redirect to the real post
            url = self.dl.resolve_redirect(url)
            path = urlparse(url).path
        m = POST_RE.search(path)
        if m:
            kind = {"p": "post", "reel": "reel", "reels": "reel", "tv": "tv"}[m.group(1)]
            code = m.group(2)
            seg = "reel" if kind == "reel" else ("tv" if kind == "tv" else "p")
            return code, kind, f"https://www.instagram.com/{seg}/{code}/"
        m = STORY_RE.search(path)
        if m:
            cid = m.group(1) or m.group(3) or m.group(2)
            return cid, "story", f"https://www.instagram.com{path.rstrip('/')}/"
        raise HelperError(E_BAD_REQUEST, f"Not an Instagram post / reel / story URL: {url}")

    def content_id(self, url: str) -> str:
        try:
            return self.parse(url)[0]
        except HelperError:
            return ""

    # ------------------------------------------------------------------ metadata mapping
    @staticmethod
    def _iso(value: Any) -> str:
        if value in (None, ""):
            return ""
        if isinstance(value, (int, float)):
            try:
                return _dt.datetime.fromtimestamp(int(value), _dt.timezone.utc).isoformat()
            except (OverflowError, ValueError):
                return ""
        s = str(value)
        try:  # gallery-dl writes "YYYY-MM-DD HH:MM:SS" in UTC
            return _dt.datetime.strptime(s[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=_dt.timezone.utc).isoformat()
        except ValueError:
            return s

    _CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    _IG_EPOCH_MS = 1314220021721  # 2011-08-24, start of Instagram's sharded IDs

    @classmethod
    def _code_time(cls, code: str) -> str:
        """Post time from a shortcode: the shortcode is the media ID in base64 and the
        ID's top 41 bits are milliseconds since Instagram's epoch."""
        n = 0
        for ch in (code or "")[:11]:
            d = cls._CODE_ALPHABET.find(ch)
            if d < 0:
                return ""
            n = n * 64 + d
        if not n:
            return ""
        ms = (n >> 23) + cls._IG_EPOCH_MS
        try:
            when = _dt.datetime.fromtimestamp(ms / 1000, _dt.timezone.utc)
        except (OverflowError, ValueError, OSError):
            return ""
        if not (2010 <= when.year <= _dt.datetime.now(_dt.timezone.utc).year + 1):
            return ""
        return when.isoformat()

    @staticmethod
    def _hashtags(text: str, extra: Optional[List[str]] = None) -> List[str]:
        tags = re.findall(r"#([^\s#]+)", text or "")
        for t in extra or []:
            t = str(t).lstrip("#")
            if t and t not in tags:
                tags.append(t)
        return tags[:100]

    def _meta_from_gallery(self, m: dict, base: dict) -> dict:
        desc = m.get("description") or m.get("caption") or ""
        loc = m.get("location_slug") or m.get("location") or ""
        keep = ("post_id", "post_shortcode", "post_url", "media_id", "likes", "count", "type", "width", "height",
                "location_id", "location_url", "tagged_users", "coauthors", "pinned", "expires", "sidecar_shortcode")
        return dict(
            base,
            title=(desc.split("\n")[0] if desc else "")[:300],
            description=desc,
            author=m.get("fullname") or m.get("full_name") or m.get("username") or "",
            username=m.get("username") or "",
            created_at=self._iso(m.get("post_date") or m.get("date")),
            hashtags=self._hashtags(desc, m.get("tags") if isinstance(m.get("tags"), list) else None),
            platform_metadata={"source": "gallery-dl", "location": loc,
                               **{k: m.get(k) for k in keep if m.get(k) not in (None, "", [])}},
        )

    def _meta_from_ytdlp(self, info: dict, base: dict) -> dict:
        desc = info.get("description") or ""
        keep = ("id", "channel", "uploader_id", "channel_id", "duration", "like_count", "comment_count",
                "view_count", "webpage_url", "width", "height", "format_id", "vcodec", "acodec", "thumbnail")
        return dict(
            base,
            title=(info.get("title") or desc.split("\n")[0] if desc else info.get("title") or "")[:300],
            description=desc,
            author=info.get("uploader") or info.get("channel") or "",
            username=info.get("channel") or info.get("uploader_id") or "",
            created_at=self._iso(info.get("timestamp")),
            hashtags=self._hashtags(desc, info.get("tags")),
            platform_metadata={"source": "yt-dlp", **{k: info.get(k) for k in keep if info.get(k) is not None}},
        )

    # ------------------------------------------------------------------ download
    def download(self, url: str, force: bool = False, use_browser_cookies: bool = False) -> Dict[str, Any]:
        cid, kind, canonical = self.parse(url)
        base_meta = {"content_id": cid, "content_url": canonical}
        base = self.dl.base_name(cid)
        errors: List[HelperError] = []

        # 1) gallery-dl: images + videos + carousels + stories (needs Chrome login in practice)
        if use_browser_cookies:
            try:
                return self._gallery(canonical, cid, kind, base, base_meta, force, True)
            except HelperError as exc:
                errors.append(exc)
                self.log.warning("gallery-dl failed for %s: [%s] %s", canonical, exc.code, exc.message)
                if exc.code in FINAL_ERRORS:
                    raise

        # 2) yt-dlp: single videos / reels (some public ones work without login)
        if kind != "story":
            try:
                return self._ytdlp_video(canonical, cid, base, base_meta, force, use_browser_cookies)
            except _NotSingleVideo:
                errors.append(HelperError(E_NO_MEDIA, "Post is not a single video"))
            except HelperError as exc:
                errors.append(exc)
                self.log.warning("yt-dlp failed for %s: [%s] %s", canonical, exc.code, exc.message)
                if exc.code in FINAL_ERRORS:
                    raise

        if not use_browser_cookies:
            # Images, carousels and stories are only served to logged-in users.
            raise HelperError(E_LOGIN_REQUIRED, "Instagram needs your login for this post. Enable "
                              "\"use Chrome's login\" in the extension settings. Details: "
                              + "; ".join(e.message for e in errors)[:400])
        raise pick_error(errors)

    def _ytdlp_video(self, canonical: str, cid: str, base: str, base_meta: dict, force: bool,
                     cookies: bool) -> Dict[str, Any]:
        def precheck(info: dict) -> None:
            if info.get("_type") in ("playlist", "multi_video") or not any(
                    (f.get("vcodec") or "none") != "none" for f in info.get("formats") or []):
                raise _NotSingleVideo()

        tmp = self.dl.tmp_dir()
        try:
            path, info = self.dl.ytdlp(canonical, tmp, cookies, precheck=precheck)
            meta = self._meta_from_ytdlp(info, base_meta)
            res = self.dl.finalize(path, "video", base, meta, canonical, canonical, force)
            return self._wrap(res, "video", cid)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def _gallery(self, canonical: str, cid: str, kind: str, base: str, base_meta: dict, force: bool,
                 cookies: bool) -> Dict[str, Any]:
        tmp = self.dl.tmp_dir()
        try:
            files = self.dl.gallery_dl(canonical, tmp, cookies, ["videos=true", "previews=false"], True)
            media = [f for f in files if ext_of(f) in IMAGE_EXTS | VIDEO_EXTS]
            if not media:
                raise HelperError(E_NO_MEDIA, "gallery-dl found no media")
            media.sort(key=lambda f: int(self.dl.gallery_dl_metadata(f).get("num") or 0))
            first = self.dl.gallery_dl_metadata(media[0])
            meta = self._meta_from_gallery(first, base_meta) if first else dict(base_meta)
            if len(media) > 1:
                media_type = "carousel" if kind != "story" else "story"
            else:
                media_type = "video" if ext_of(media[0]) in VIDEO_EXTS else "image"
            saved, dups, existing = [], 0, ""
            for i, f in enumerate(media, 1):
                fm = self.dl.gallery_dl_metadata(f)
                item_meta = self._meta_from_gallery(fm, base_meta) if fm else meta
                if len(media) > 1:
                    item_meta["platform_metadata"] = dict(item_meta.get("platform_metadata", {}), item_index=i,
                                                          item_count=len(media))
                name = base if len(media) == 1 else f"{base}_{i:02d}"
                r = self.dl.finalize(f, media_type, name, item_meta, canonical, canonical, force,
                                     store_as="video" if ext_of(f) in VIDEO_EXTS else "image")
                if r["status"] == "success":
                    saved.append(r["file"])
                else:
                    dups += 1
                    existing = existing or r.get("existing_path", "")
            if not saved:
                return {"status": "duplicate", "platform": self.id, "content_id": cid, "media_type": media_type,
                        "existing_path": existing, "files": []}
            return {"status": "success", "platform": self.id, "content_id": cid, "media_type": media_type,
                    "files": saved, "file": saved[0], "duplicates": dups}
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    # ------------------------------------------------------------------ metadata only
    def save_metadata(self, url: str, use_browser_cookies: bool = False) -> Dict[str, Any]:
        cid, kind, canonical = self.parse(url)
        base_meta = {"content_id": cid, "content_url": canonical}
        meta = dict(base_meta)
        try:
            info = self.dl.ytdlp_info(canonical, use_browser_cookies)
            meta = self._meta_from_ytdlp(info, base_meta)
            meta["media_type"] = "carousel" if info.get("_type") == "playlist" else "video"
        except HelperError as exc:
            if exc.code in FINAL_ERRORS or exc.code == E_YTDLP_MISSING:
                raise
            if not use_browser_cookies:
                raise HelperError(E_LOGIN_REQUIRED, exc.message) from exc
            meta["media_type"] = ""
        res = self.dl.save_metadata("", meta)
        res.update({"platform": self.id, "content_id": cid, "media_type": meta.get("media_type", "")})
        return res

    # ------------------------------------------------------------------ profile reels analysis
    @staticmethod
    def profile_username(value: str) -> str:
        v = (value or "").strip()
        if v.startswith("@"):
            v = v[1:]
        if re.fullmatch(r"[A-Za-z0-9_.]{1,30}", v):
            return v
        p = urlparse(v if "://" in v else "https://" + v)
        if not p.hostname or not re.search(r"(^|\.)instagram\.com$|^(www\.)?instagr\.am$", p.hostname):
            raise HelperError(E_BAD_REQUEST, f"Not an Instagram profile: {value}")
        m = PROFILE_RE.match(p.path)
        if not m or m.group(1).lower() in RESERVED:
            raise HelperError(E_BAD_REQUEST, f"Not an Instagram profile: {value}")
        return m.group(1)

    @staticmethod
    def _first_num(d: dict, *keys: str) -> Optional[int]:
        for k in keys:
            v = d.get(k)
            if isinstance(v, (int, float)) and v >= 0:
                return int(v)
            if isinstance(v, str) and v.isdigit():
                return int(v)
        return None

    def _reel_row(self, media: dict) -> Dict[str, Any]:
        code = media.get("code") or media.get("shortcode") or ""
        cap = media.get("caption")
        caption = cap.get("text", "") if isinstance(cap, dict) else (cap or "")
        thumb = ""
        cands = ((media.get("image_versions2") or {}).get("candidates") or [])
        if cands:
            # smallest candidate that is still >= 320 px wide (keeps the page light)
            ok = sorted((c for c in cands if (c.get("width") or 0) >= 320), key=lambda c: c.get("width") or 0)
            thumb = (ok[0] if ok else cands[0]).get("url", "")
        thumb = thumb or media.get("display_uri") or media.get("thumbnail_src") or ""
        return {
            "code": code,
            "url": f"https://www.instagram.com/reel/{code}/" if code else "",
            "views": self._first_num(media, "play_count", "ig_play_count", "view_count", "video_view_count",
                                     "video_play_count", "fb_play_count"),
            "likes": self._first_num(media, "like_count"),
            "comments": self._first_num(media, "comment_count"),
            # the GraphQL reels-tab query no longer returns taken_at: decode it from the shortcode
            "taken_at": self._iso(media.get("taken_at")) or self._code_time(code),
            "duration": media.get("video_duration"),
            "caption": caption[:5000],
            "thumbnail": thumb,
            "pinned": bool(media.get("clips_tab_pinned_user_ids")),
        }

    @staticmethod
    def _gdl_setup(cookies: Any):
        from gallery_dl import config, output

        if not hasattr(logging.Logger, "traceback"):  # gallery-dl expects its own Logger class
            output.initialize_logging(logging.ERROR)
            if not hasattr(logging.Logger, "traceback"):
                logging.Logger.traceback = lambda self, exc: self.debug("traceback", exc_info=exc)  # type: ignore
        config.clear()
        config.set(("extractor",), "user-cache", "memory")
        if isinstance(cookies, dict) and cookies:
            config.set(("extractor",), "cookies", cookies)  # from the extension (memory only)
            config.set(("extractor",), "cookies-update", False)
        elif cookies:
            config.set(("extractor",), "cookies", ["chrome"])  # fallback: read Chrome's cookie DB locally

    @staticmethod
    def _gdl_error(exc: Exception) -> HelperError:
        name = type(exc).__name__
        text = str(exc)
        if name in ("AuthorizationError", "AuthenticationError", "AuthRequired"):
            return HelperError(E_LOGIN_REQUIRED, text or name)
        if name == "NotFoundError":
            return HelperError(E_PIN_NOT_FOUND, text or "Profile not found")
        if "429" in text or "rate" in text.lower():
            return HelperError(E_RATE_LIMITED, text)
        from downloader import classify_error

        return HelperError(classify_error(text), f"{name}: {text}"[:500])

    def reel_details(self, code: str, use_browser_cookies: bool = False) -> Dict[str, Any]:
        """Details of ONE reel (the analyzer's details panel). See reels_details()."""
        res = self.reels_details([code], use_browser_cookies)
        if code in res["items"]:
            return res["items"][code]
        err = res["errors"].get(code) or {"code": E_NO_MEDIA, "message": "Instagram returned no data for this reel"}
        raise HelperError(err["code"], err["message"])

    def reels_details(self, codes: List[str], use_browser_cookies: bool = False) -> Dict[str, Any]:
        """Everything the Reels-tab list leaves out (full caption, audio, location, tags,
        paid-partnership flag) for several reels in ONE helper call: one gallery-dl setup,
        one request (/media/<id>/info/) per reel.

        gallery-dl waits 6-12 s before every Instagram request by default; for these small
        single-item lookups 1-2 s is enough (2-4 s for big batches). The first rate-limit or
        login error stops the batch: the next requests would fail the same way."""
        codes = [str(c or "").strip() for c in codes][:200]
        bad = [c for c in codes if not re.fullmatch(r"[A-Za-z0-9_-]{5,64}", c)]
        if bad:
            raise HelperError(E_BAD_REQUEST, f"Invalid reel code: {bad[0]}")
        if not codes:
            return {"items": {}, "errors": {}, "stopped": None}
        if not use_browser_cookies:
            raise HelperError(E_LOGIN_REQUIRED, "Reel details need Instagram login: enable \"use Chrome's login\".")
        if not module_available("gallery_dl"):
            raise HelperError(E_NO_MEDIA, "gallery-dl is not installed")
        items: Dict[str, Any] = {}
        errors: Dict[str, Dict[str, str]] = {}
        stopped: Optional[str] = None
        with _GDL_LOCK:
            from gallery_dl import config, extractor

            if self.dl.cookies and not self.dl.has_cookie("sessionid"):
                raise HelperError(E_LOGIN_REQUIRED, "You are not logged in to instagram.com in this Chrome "
                                  "profile. Log in there, then retry.")
            self._gdl_setup({c["name"]: c["value"] for c in self.dl.cookies} if self.dl.cookies else True)
            config.set(("extractor", "instagram"), "sleep-request", [1.0, 2.0] if len(codes) <= 40 else [2.0, 4.0])
            # on HTTP 429 fail at once (and stop the batch) instead of gallery-dl's 1-4 minute backoff
            config.set(("extractor", "instagram"), "retries", 0)
            try:
                ex = extractor.find(f"https://www.instagram.com/reel/{codes[0]}/")
                if ex is None:
                    raise HelperError(E_BAD_REQUEST, f"gallery-dl cannot handle {codes[0]}")
                self.dl.progress(None, "stage:connect", force=True)
                ex.initialize()
                ex.login()
                for i, code in enumerate(codes, 1):
                    self.dl.progress(i * 100.0 / len(codes), f"details:{i}/{len(codes)}", force=True)  # also checks Cancel
                    try:
                        media = next(iter(ex.api.media(code)), None) or {}
                    except Exception as exc:  # one reel failing (deleted, private) must not lose the others
                        err = exc if isinstance(exc, HelperError) else self._gdl_error(exc)
                        errors[code] = {"code": err.code, "message": err.message}
                        if err.code in (E_RATE_LIMITED, E_LOGIN_REQUIRED):
                            stopped = err.code
                            break
                        continue
                    if media:
                        items[code] = self._details_from_media(code, media)
                    else:
                        errors[code] = {"code": E_NO_MEDIA, "message": "Instagram returned no data for this reel"}
            except HelperError as exc:
                if exc.code == E_CANCELLED:
                    stopped = E_CANCELLED  # keep what was loaded so far
                elif not items:
                    raise
                else:
                    stopped = exc.code
            except Exception as exc:
                if not items:
                    raise self._gdl_error(exc) from exc
                stopped = self._gdl_error(exc).code
            finally:
                config.clear()
        return {"items": items, "errors": errors, "stopped": stopped}

    def _details_from_media(self, code: str, media: Dict[str, Any]) -> Dict[str, Any]:
        cap = media.get("caption")
        caption = cap.get("text", "") if isinstance(cap, dict) else (cap or "")
        clips = media.get("clips_metadata") or {}
        music = (clips.get("music_info") or {}).get("music_asset_info") or {}
        original = clips.get("original_sound_info") or {}
        audio: Dict[str, Any] = {}
        if music:
            audio = {"title": music.get("title") or "", "artist": music.get("display_artist") or "", "original": False}
        elif original:
            owner = (original.get("ig_artist") or {}).get("username") or ""
            audio = {"title": original.get("original_audio_title") or "Original audio", "artist": owner, "original": True}
        loc = media.get("location") or {}
        tags = [((t.get("user") or {}).get("username") or "") for t in ((media.get("usertags") or {}).get("in") or [])]
        coauthors = [(u.get("username") or "") for u in (media.get("coauthor_producers") or [])]
        return {
            "code": code,
            "caption": caption[:5000],
            "taken_at": self._iso(media.get("taken_at")) or self._code_time(code),
            "views": self._first_num(media, "play_count", "ig_play_count", "view_count", "video_view_count"),
            "likes": self._first_num(media, "like_count"),
            "comments": self._first_num(media, "comment_count"),
            "duration": media.get("video_duration"),
            "audio": audio,
            "location": loc.get("name") or "",
            "tagged": [t for t in tags if t][:30],
            "coauthors": [c for c in coauthors if c][:10],
            "paid_partnership": bool(media.get("is_paid_partnership")),
            "product_type": media.get("product_type") or "",
            "comments_disabled": bool(media.get("comments_disabled")),
            "like_count_hidden": bool(media.get("like_and_view_counts_disabled")),
        }

    def list_reels(self, profile: str, limit: int = 100, use_browser_cookies: bool = False,
                   enrich_missing: bool = True) -> Dict[str, Any]:
        """Reels of a profile with view / like / comment counts. Nothing is downloaded.

        Uses Instagram's own Reels-tab API through gallery-dl (12 reels per request)."""
        username = self.profile_username(profile)
        if not use_browser_cookies:
            raise HelperError(E_LOGIN_REQUIRED, "Listing reels needs Instagram login: enable \"use Chrome's login\".")
        if not module_available("gallery_dl"):
            raise HelperError(E_NO_MEDIA, "gallery-dl is not installed")
        limit = max(1, min(int(limit or 100), MAX_REELS))
        with _GDL_LOCK:
            from gallery_dl import extractor

            if self.dl.cookies and not self.dl.has_cookie("sessionid"):
                raise HelperError(E_LOGIN_REQUIRED, "You are not logged in to instagram.com in this Chrome "
                                  "profile. Log in there, then retry.")
            self._gdl_setup({c["name"]: c["value"] for c in self.dl.cookies} if self.dl.cookies else True)
            try:
                ex = extractor.find(f"https://www.instagram.com/{username}/reels/")
                if ex is None:
                    raise HelperError(E_BAD_REQUEST, f"gallery-dl cannot handle {username}")
                ex.initialize()
                ex.login()
                if not getattr(ex, "_logged_in", True):
                    raise HelperError(E_LOGIN_REQUIRED, "No Instagram login found in Chrome. Log in to "
                                      "instagram.com in Chrome, then retry.")
                user = ex.api.user(username) or {}
                profile_info = {
                    "username": user.get("username") or username,
                    "full_name": user.get("full_name") or "",
                    "followers": self._first_num(user, "follower_count") or
                    self._first_num(user.get("edge_followed_by") or {}, "count"),
                    "is_private": bool(user.get("is_private")),
                    "is_verified": bool(user.get("is_verified")),
                }
                # "profile:<name>:<followers>" lets the page show who it is reading while it waits
                self.dl.progress(None, f"profile:{profile_info['username']}:{profile_info['followers'] or ''}",
                                 force=True)
                rows: List[Dict[str, Any]] = []
                seen = set()
                truncated = False
                for node in ex.api.user_reels(username):
                    media = node.get("media", node) if isinstance(node, dict) else {}
                    row = self._reel_row(media)
                    if not row["code"] or row["code"] in seen:
                        continue
                    seen.add(row["code"])
                    rows.append(row)
                    # every reel is reported (not throttled): the page draws one bar per reel, height = views
                    views = row["views"]
                    self.dl.progress(len(rows) * 100.0 / limit,
                                     f"reels:{len(rows)}:{-1 if views is None else int(views)}", force=True)
                    if len(rows) >= limit:
                        truncated = True
                        break
                # Some responses omit the counter; ask for those reels individually (slowly).
                missing = [r for r in rows if r["views"] is None]
                if enrich_missing and missing and len(missing) <= 60:
                    for i, r in enumerate(missing, 1):
                        try:
                            info = next(iter(ex.api.media(r["code"])), {}) or {}
                            r["views"] = self._first_num(info, "play_count", "ig_play_count", "view_count",
                                                         "video_view_count")
                            r["likes"] = r["likes"] if r["likes"] is not None else self._first_num(info, "like_count")
                            r["comments"] = r["comments"] if r["comments"] is not None else \
                                self._first_num(info, "comment_count")
                        except Exception as exc:  # keep the row, just without views
                            self.log.info("media info failed for %s: %s", r["code"], exc)
                        self.dl.progress(i * 100.0 / len(missing), f"details:{i}/{len(missing)}", force=True)
                        time.sleep(0.8)
            except HelperError:
                raise
            except Exception as exc:
                raise self._gdl_error(exc) from exc
            finally:
                from gallery_dl import config

                config.clear()
        self.log.info("Listed %d reels of @%s", len(rows), username)
        return {
            "platform": self.id,
            "username": profile_info["username"],
            "profile": profile_info,
            "reels": rows,
            "count": len(rows),
            "truncated": truncated,
            "missing_views": sum(1 for r in rows if r["views"] is None),
            "fetched_at": now_iso(),
        }

    def _wrap(self, res: Dict[str, Any], media_type: str, cid: str) -> Dict[str, Any]:
        files = res.get("files") or ([res["file"]] if res.get("file") else [])
        return dict(res, platform=self.id, content_id=cid, media_type=media_type, files=files)
