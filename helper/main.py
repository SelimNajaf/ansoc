#!/usr/bin/env python3
"""Media Downloader helper - command line entry point.

    python main.py install [--extension-id ID]   register the native-messaging host
    python main.py uninstall                       remove the registration
    python main.py setup                           create Desktop/Medias/<Platform>/{images,videos,metadata,logs}
    python main.py check                           show dependency status
    python main.py detect <url>                    show which platform engine handles a URL
    python main.py download <url> [--force]        download a Pinterest / TikTok URL without the browser

The Chrome extension talks to native_host.py; this file is for installation and
manual use.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import stat
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import (  # noqa: E402
    HELPER_DIR, HOST_NAME, IS_MAC, IS_WINDOWS, LEGACY_HOST_NAMES, VERSION, HelperError, dependency_report,
    ensure_all_dirs, find_tool, load_config, save_config,
)

# ID derived from the public "key" in extension/manifest.json, so it is the same on every machine.
DEFAULT_EXTENSION_ID = "pdajcifnbdkaoeiajndahpadigkigjab"

_MAC_BROWSERS = [
    "Google/Chrome", "Google/Chrome Beta", "Google/Chrome Dev", "Google/Chrome Canary",
    "Chromium", "BraveSoftware/Brave-Browser", "Microsoft Edge", "Vivaldi",
]
_LINUX_BROWSERS = [
    "google-chrome", "google-chrome-beta", "google-chrome-unstable", "chromium",
    "BraveSoftware/Brave-Browser", "microsoft-edge", "vivaldi",
]
_WIN_REG_KEYS = [
    r"Software\Google\Chrome\NativeMessagingHosts",
    r"Software\Chromium\NativeMessagingHosts",
    r"Software\Microsoft\Edge\NativeMessagingHosts",
    r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
]


def _manifest_dirs() -> list:
    if IS_MAC:
        base = Path.home() / "Library" / "Application Support"
        dirs = [base / b for b in _MAC_BROWSERS]
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
        dirs = [base / b for b in _LINUX_BROWSERS]
    # always register for Google Chrome, others only if installed
    return [d / "NativeMessagingHosts" for i, d in enumerate(dirs) if i == 0 or d.exists()]


def _write_wrapper() -> Path:
    # Do NOT resolve symlinks: .venv/bin/python is a symlink and resolving it would
    # bypass the virtualenv (and its yt-dlp / gallery-dl packages).
    py = Path(os.path.abspath(sys.executable))
    host = HELPER_DIR / "native_host.py"
    if IS_WINDOWS:
        wrapper = HELPER_DIR / "pindl_host.bat"
        wrapper.write_text(f'@echo off\r\n"{py}" -u "{host}" %* 2>>"{HELPER_DIR / "host-stderr.log"}"\r\n', encoding="utf-8")
    else:
        wrapper = HELPER_DIR / "pindl_host.sh"
        err = HELPER_DIR / "host-stderr.log"
        wrapper.write_text(f'#!/bin/sh\nexec "{py}" -u "{host}" "$@" 2>>"{err}"\n', encoding="utf-8")
        wrapper.chmod(wrapper.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return wrapper


def _bundled_ffmpeg() -> str:
    """No system FFmpeg? Use the static build shipped by the imageio-ffmpeg wheel (copied as bin/ffmpeg)."""
    try:
        import imageio_ffmpeg  # type: ignore

        src = Path(imageio_ffmpeg.get_ffmpeg_exe())
    except Exception:
        return ""
    dst = HELPER_DIR / "bin" / ("ffmpeg.exe" if IS_WINDOWS else "ffmpeg")
    dst.parent.mkdir(exist_ok=True)
    if not dst.exists() or dst.stat().st_size != src.stat().st_size:
        shutil.copy2(src, dst)
        dst.chmod(0o755)
    return str(dst)


def _manifest(wrapper: Path, ext_ids: list) -> dict:
    return {
        "name": HOST_NAME,
        "description": "Media Downloader local helper (Pinterest, TikTok; yt-dlp / gallery-dl / FFmpeg)",
        "path": str(wrapper),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{i}/" for i in ext_ids],
    }


def cmd_install(args) -> int:
    ext_ids = [DEFAULT_EXTENSION_ID]
    if args.extension_id and args.extension_id not in ext_ids:
        ext_ids.append(args.extension_id.strip())
    for i in ext_ids:
        if len(i) != 32 or not all("a" <= c <= "p" for c in i):
            print(f"[x] Invalid extension ID: {i}")
            return 2

    dirs = ensure_all_dirs()
    print(f"[ok] Download folder: {dirs['root']}")
    for k, v in dirs.items():
        if k != "root":
            print(f"     {k}: {v}")
    _remove_legacy()

    cfg = load_config()
    cfg.update({
        "extension_ids": ext_ids,
        "ffmpeg_path": find_tool("ffmpeg") or _bundled_ffmpeg(),
        "ffprobe_path": find_tool("ffprobe") or "",
        "python": sys.executable,
        "version": VERSION,
    })
    save_config(cfg)

    wrapper = _write_wrapper()
    manifest = _manifest(wrapper, ext_ids)
    print(f"[ok] Host launcher: {wrapper}")

    if IS_WINDOWS:
        import winreg  # type: ignore

        mpath = HELPER_DIR / f"{HOST_NAME}.json"
        mpath.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        for key in _WIN_REG_KEYS:
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, f"{key}\\{HOST_NAME}") as k:
                winreg.SetValueEx(k, "", 0, winreg.REG_SZ, str(mpath))
            print(f"[ok] Registry: HKCU\\{key}\\{HOST_NAME}")
        print(f"[ok] Manifest: {mpath}")
    else:
        for d in _manifest_dirs():
            d.mkdir(parents=True, exist_ok=True)
            mpath = d / f"{HOST_NAME}.json"
            mpath.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
            print(f"[ok] Manifest: {mpath}")
    print("[ok] Native Messaging host registered. Reload the extension in chrome://extensions.")
    return 0


def _remove_legacy() -> None:
    """Drop registrations of the old Pinterest-only host name."""
    for name in LEGACY_HOST_NAMES:
        if IS_WINDOWS:
            import winreg  # type: ignore

            for key in _WIN_REG_KEYS:
                try:
                    winreg.DeleteKey(winreg.HKEY_CURRENT_USER, f"{key}\\{name}")
                    print(f"[ok] Removed old registration HKCU\\{key}\\{name}")
                except OSError:
                    pass
        else:
            for d in _manifest_dirs():
                p = d / f"{name}.json"
                if p.exists():
                    p.unlink()
                    print(f"[ok] Removed old manifest {p}")


def cmd_uninstall(_args) -> int:
    if IS_WINDOWS:
        import winreg  # type: ignore

        for key in _WIN_REG_KEYS:
            try:
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, f"{key}\\{HOST_NAME}")
                print(f"[ok] Removed HKCU\\{key}\\{HOST_NAME}")
            except OSError:
                pass
        (HELPER_DIR / f"{HOST_NAME}.json").unlink(missing_ok=True)
    else:
        for d in _manifest_dirs():
            p = d / f"{HOST_NAME}.json"
            if p.exists():
                p.unlink()
                print(f"[ok] Removed {p}")
    print("[ok] Uninstalled. Your downloaded files were NOT touched.")
    return 0


def cmd_setup(_args) -> int:
    dirs = ensure_all_dirs()
    for k, v in dirs.items():
        print(f"{k:9s} {v}")
    return 0


def cmd_check(_args) -> int:
    rep = dependency_report()
    ok = True
    for name, val in rep.items():
        good = bool(val)
        ok = ok and (good or name in ("exifread", "yt_dlp_version"))
        print(f"[{'ok' if good else 'x '}] {name}: {val if val not in (True, False) else ('yes' if val else 'MISSING')}")
    return 0 if ok else 1


def cmd_detect(args) -> int:
    import router

    try:
        eng = router.detect(args.url)
    except HelperError as exc:
        print(f"[x] {exc.code}: {exc.message}")
        return 1
    print(f"{eng.id} ({eng.name})")
    return 0


def cmd_download(args) -> int:
    import router

    def progress(p):
        pct = p.get("percent")
        print(f"\r  {p.get('text', '')} {'' if pct is None else f'{pct:5.1f}%'}   ", end="", flush=True)

    url = router.normalize(args.url)
    try:
        eng = router.detect(url)(progress)
        print(f"[..] {eng.name}: {url}")
        res = eng.save_metadata(url, args.cookies) if args.metadata_only else eng.download(url, args.force, args.cookies)
    except HelperError as exc:
        print(f"\n[x] {exc.code}: {exc.message}")
        return 1
    print()
    if res.get("metadata_path"):
        print(f"[ok] {res['metadata_path']}")
    if res.get("status") == "duplicate":
        print(f"[=] Already downloaded: {res.get('existing_path')}")
    for f in res.get("files", []):
        print(f"[ok] {f['path']} ({f['size']} bytes)")
    if res.get("warning"):
        print(f"[!] {res['warning']}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Media Downloader helper (Pinterest, TikTok)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("install", help="register the native messaging host")
    p.add_argument("--extension-id", default="", help="extra extension ID (if you changed the manifest key)")
    p.set_defaults(fn=cmd_install)
    sub.add_parser("uninstall").set_defaults(fn=cmd_uninstall)
    sub.add_parser("setup").set_defaults(fn=cmd_setup)
    sub.add_parser("check").set_defaults(fn=cmd_check)
    p = sub.add_parser("detect", help="show the platform of a URL")
    p.add_argument("url")
    p.set_defaults(fn=cmd_detect)
    p = sub.add_parser("download", help="download a Pinterest / TikTok URL from the command line")
    p.add_argument("url")
    p.add_argument("--force", action="store_true", help="download even if the same file exists")
    p.add_argument("--cookies", action="store_true", help="read Chrome's login cookies locally (private posts)")
    p.add_argument("--metadata-only", action="store_true", help="only write the metadata JSON")
    p.set_defaults(fn=cmd_download)
    args = ap.parse_args()
    try:
        return args.fn(args)
    except HelperError as exc:
        print(f"[x] {exc.code}: {exc.message}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
