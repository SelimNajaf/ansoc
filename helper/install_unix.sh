#!/bin/bash
# Media Downloader - helper installer for macOS and Linux.
# Usage: install_unix.sh [EXTENSION_ID] [--uninstall]
# Creates helper/.venv with yt-dlp, gallery-dl, FFmpeg (imageio-ffmpeg) and registers the
# Native Messaging host for Chrome / Edge / Brave / Chromium.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
VENV="$HERE/.venv"
VPY="$VENV/bin/python"
EXT_ID=""
UNINSTALL=""
for a in "$@"; do
  case "$a" in
    --uninstall) UNINSTALL=1 ;;
    *) EXT_ID="$a" ;;
  esac
done

if [ -n "$UNINSTALL" ]; then
  if [ ! -x "$VPY" ]; then echo "[x] Not installed."; exit 1; fi
  "$VPY" "$HERE/main.py" uninstall
  exit $?
fi

# 1) Python 3.9+ -------------------------------------------------------------
version_ok() { "$1" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; }
PY=""
for cand in \
  /Library/Frameworks/Python.framework/Versions/3.13/bin/python3 \
  /Library/Frameworks/Python.framework/Versions/3.12/bin/python3 \
  /Library/Frameworks/Python.framework/Versions/3.11/bin/python3 \
  /opt/homebrew/bin/python3 /usr/local/bin/python3 \
  "$(command -v python3 2>/dev/null || true)"; do
  [ -n "$cand" ] && [ -x "$cand" ] || continue
  # On macOS /usr/bin/python3 is only a stub until the Command Line Tools are installed:
  # calling it would pop up an install dialog, so only use it when they are present.
  if [ "$cand" = "/usr/bin/python3" ] && [ "$(uname)" = "Darwin" ] && ! xcode-select -p >/dev/null 2>&1; then continue; fi
  if version_ok "$cand"; then PY="$cand"; break; fi
done
if [ -z "$PY" ]; then
  echo "[x] Python 3 is not installed."
  if [ "$(uname)" = "Darwin" ]; then
    echo "    Opening python.org: download the macOS installer, install it, then run this installer again."
    open "https://www.python.org/downloads/macos/" 2>/dev/null || true
  else
    echo "    Install it with your package manager (for example: sudo apt install python3 python3-venv), then run this again."
  fi
  exit 1
fi
echo "[ok] Python: $PY ($("$PY" --version 2>&1))"

# 2) Virtual environment + packages -----------------------------------------
if [ ! -x "$VPY" ]; then
  "$PY" -m venv "$VENV" || { echo "[x] Could not create the virtual environment (Linux: install python3-venv)."; exit 1; }
fi
"$VPY" -m pip install --quiet --upgrade pip
if ! "$VPY" -m pip install --quiet --upgrade -r "$HERE/requirements.txt"; then
  echo "[x] Package install failed (no internet, or blocked by a proxy?). Run this again when online."
  exit 1
fi
echo "[ok] Packages installed: yt-dlp, gallery-dl, FFmpeg (imageio-ffmpeg)"

# 3) Native Messaging registration + download folders -----------------------
if [ -n "$EXT_ID" ]; then
  "$VPY" "$HERE/main.py" install --extension-id "$EXT_ID" || { echo "[x] Registration failed."; exit 1; }
else
  "$VPY" "$HERE/main.py" install || { echo "[x] Registration failed."; exit 1; }
fi
echo
"$VPY" "$HERE/main.py" check
echo
echo "[ok] Helper installed."
