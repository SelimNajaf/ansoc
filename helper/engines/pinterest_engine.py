"""Pinterest engine.

The Chrome extension does most of the Pinterest work itself (it parses the pin page,
picks `originals` / the best MP4 or HLS) and then calls the helper's low level
actions (ingest, download_url, download_video). This engine handles URLs given to
the helper directly (CLI, or when the extension could not parse the page).
"""
from __future__ import annotations

import re
from typing import Any, Dict

from common import E_BAD_REQUEST, E_PIN_NOT_FOUND, HelperError
from engines.base_engine import BaseEngine

PIN_ID_RE = re.compile(r"/pin/(?:[^/?#]*--)?(\d{5,25})")
PINIMG_RE = re.compile(r"^/([^/]+)/([0-9a-f]{2}/[0-9a-f]{2}/[0-9a-f]{2}/([0-9a-f]{16,64}))\.([a-z0-9]+)$", re.I)


class PinterestEngine(BaseEngine):
    id = "pinterest"
    name = "Pinterest"
    page_hosts = (
        r"(^|\.)pinterest\.(com|ca|co\.uk|de|fr|es|it|pt|ch|at|ie|nz|ph|cl|jp|kr|se|dk|ru|com\.au|com\.mx|co\.kr|com\.br)$",
        r"^(www\.)?pin\.it$",
    )
    cdn_hosts = (r"(^|\.)pinimg\.com$",)

    def content_id(self, url: str) -> str:
        m = PIN_ID_RE.search(url)
        if m:
            return m.group(1)
        m = PINIMG_RE.match(self._path(url))
        return m.group(3) if m else ""

    @staticmethod
    def _path(url: str) -> str:
        from urllib.parse import urlparse

        return urlparse(url).path

    def _resolve(self, url: str) -> str:
        if re.match(r"^https://(www\.)?pin\.it/", url):
            final = self.dl.resolve_redirect(url)
            if not PIN_ID_RE.search(final):
                raise HelperError(E_PIN_NOT_FOUND, f"Short link did not lead to a pin: {final}")
            return final
        return url

    def download(self, url: str, force: bool = False, use_browser_cookies: bool = False) -> Dict[str, Any]:
        url = self._resolve(url)
        host = self._host(url)
        cid = self.content_id(url)
        meta = {"content_id": cid, "content_url": url}
        if host.endswith("pinimg.com"):
            # A direct CDN link: try the `originals` version first, then the given file.
            m = PINIMG_RE.match(self._path(url))
            cands = []
            if m and m.group(1) != "originals" and "/videos/" not in url:
                for ext in dict.fromkeys([m.group(4).lower(), "jpg", "png", "gif", "webp"]):
                    cands.append(f"https://i.pinimg.com/originals/{m.group(2)}.{ext}")
            cands.append(url)
            mtype = "video" if re.search(r"\.(mp4|m3u8)$", url) else "image"
            last = None
            for c in cands:
                try:
                    if c.endswith(".m3u8"):
                        res = self.dl.download_video(hls_url=c, meta=meta, force=force)
                    else:
                        res = self.dl.download_url(c, mtype, "", meta, force)
                    return self._wrap(res, mtype, cid)
                except HelperError as exc:
                    last = exc
            raise last or HelperError(E_PIN_NOT_FOUND, url)
        if not cid and "/pin/" not in url:
            # boards / sections: gallery-dl understands them
            res = self.dl.download_page(url, meta=meta, force=force, use_browser_cookies=use_browser_cookies)
            return self._wrap(res, "", cid)
        if not cid:
            raise HelperError(E_BAD_REQUEST, f"Not a pin URL: {url}")
        meta["content_url"] = f"https://www.pinterest.com/pin/{cid}/"
        res = self.dl.download_page(meta["content_url"], meta=meta, force=force, use_browser_cookies=use_browser_cookies)
        return self._wrap(res, "", cid)

    def save_metadata(self, url: str, use_browser_cookies: bool = False) -> Dict[str, Any]:
        url = self._resolve(url)
        cid = self.content_id(url)
        res = self.dl.save_metadata("", {"content_id": cid, "content_url": url})
        res.update({"platform": self.id, "content_id": cid})
        return res

    def _wrap(self, res: Dict[str, Any], media_type: str, cid: str) -> Dict[str, Any]:
        files = res.get("files") or ([res["file"]] if res.get("file") else [])
        mt = media_type or (files[0]["media_type"] if files else "")
        out = dict(res, platform=self.id, content_id=cid, media_type=mt, files=files)
        if files:
            out["file"] = files[0]
        return out
