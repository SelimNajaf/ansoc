"""Base class every platform engine derives from."""
from __future__ import annotations

import re
from typing import Any, Callable, Dict, List, Optional, Pattern, Tuple, Type
from urllib.parse import urlparse

ProgressFn = Callable[[Dict[str, Any]], None]


class BaseEngine:
    """One supported platform.

    Subclasses set the class attributes and implement ``download`` (and usually
    ``save_metadata``). Registration is automatic.
    """

    #: short lowercase id used in file names and messages ("pinterest")
    id: str = ""
    #: display name, also the folder under Desktop/Medias ("Pinterest")
    name: str = ""
    #: host regexes of URLs a user may paste (pages and short links)
    page_hosts: Tuple[str, ...] = ()
    #: host regexes media may be downloaded from (CDNs)
    cdn_hosts: Tuple[str, ...] = ()

    _registry: List[Type["BaseEngine"]] = []
    _page_re: Optional[Pattern] = None
    _cdn_re: Optional[Pattern] = None

    def __init_subclass__(cls, **kwargs):
        super().__init_subclass__(**kwargs)
        if cls.id:
            cls._page_re = re.compile("|".join(f"(?:{h})" for h in cls.page_hosts), re.I) if cls.page_hosts else None
            cls._cdn_re = re.compile("|".join(f"(?:{h})" for h in cls.cdn_hosts), re.I) if cls.cdn_hosts else None
            BaseEngine._registry.append(cls)

    # ------------------------------------------------------------------ class helpers
    @property
    def folder(self) -> str:
        return self.name

    @classmethod
    def _host(cls, url: str) -> str:
        try:
            p = urlparse(url)
        except ValueError:
            return ""
        return (p.hostname or "") if p.scheme == "https" else ""

    @classmethod
    def matches(cls, url: str) -> bool:
        """True if the user pasted a URL of this platform (page, short link or CDN media)."""
        h = cls._host(url)
        return bool(h) and bool((cls._page_re and cls._page_re.search(h)) or (cls._cdn_re and cls._cdn_re.search(h)))

    @classmethod
    def allows(cls, url: str) -> bool:
        """True if the helper may send a request to this URL for this platform."""
        return cls.matches(url)

    # ------------------------------------------------------------------ instance
    def __init__(self, progress: Optional[ProgressFn] = None):
        from downloader import Downloader

        self.progress = progress or (lambda _p: None)
        self.dl = Downloader(self, self.progress)
        self.log = self.dl.log

    def content_id(self, url: str) -> str:
        return ""

    def download(self, url: str, force: bool = False, use_browser_cookies: bool = False) -> Dict[str, Any]:
        """Download everything behind ``url``. Returns
        {"status": "success"|"duplicate", "platform", "content_id", "media_type", "files": [...], "file": {...}}"""
        raise NotImplementedError

    def save_metadata(self, url: str, use_browser_cookies: bool = False) -> Dict[str, Any]:
        raise NotImplementedError

    def describe(self) -> Dict[str, Any]:
        return {"id": self.id, "name": self.name, "folder": self.folder}
