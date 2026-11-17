"""URL -> platform engine."""
from __future__ import annotations

from typing import List, Optional, Type

import engines  # noqa: F401  (imports and registers every engine module)
from common import E_BAD_REQUEST, E_UNSUPPORTED, HelperError
from engines.base_engine import BaseEngine


class UnsupportedPlatformError(HelperError):
    def __init__(self, url: str):
        super().__init__(E_UNSUPPORTED, f"Unsupported platform: {url}")


def all_engines() -> List[Type[BaseEngine]]:
    return list(BaseEngine._registry)


def get_engine(platform_id: str) -> Type[BaseEngine]:
    for eng in BaseEngine._registry:
        if eng.id == platform_id:
            return eng
    raise HelperError(E_BAD_REQUEST, f"Unknown platform: {platform_id}")


def detect(url: str) -> Type[BaseEngine]:
    """Engine class for a pasted URL. Purely local: no network request."""
    if not isinstance(url, str) or not url.strip():
        raise HelperError(E_BAD_REQUEST, "Empty URL")
    u = url.strip()
    if "://" not in u:
        u = "https://" + u
    for eng in BaseEngine._registry:
        if eng.matches(u):
            return eng
    raise UnsupportedPlatformError(url)


def normalize(url: str) -> str:
    u = url.strip()
    return u if "://" in u else "https://" + u


def is_allowed_url(url: str) -> bool:
    return any(eng.allows(url) for eng in BaseEngine._registry)


def engine_for(url: str, platform_id: Optional[str] = None) -> Type[BaseEngine]:
    return get_engine(platform_id) if platform_id else detect(url)
