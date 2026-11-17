"""Platform engines.

Every module in this package is imported automatically, and every BaseEngine
subclass with an ``id`` registers itself. Adding a platform = adding one file
here (e.g. ``instagram_engine.py``) - nothing else has to change in the helper.
"""
from __future__ import annotations

import importlib
import pkgutil

from engines.base_engine import BaseEngine  # noqa: F401

for _mod in pkgutil.iter_modules(__path__):
    if _mod.name != "base_engine" and not _mod.name.startswith("_"):
        importlib.import_module(f"{__name__}.{_mod.name}")
