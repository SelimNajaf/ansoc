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

# 1) Python (3.10+ preferred, 3.9 still works) ------------------------------
# yt-dlp no longer supports Python 3.9: with it, yt-dlp stays on an old version and
# downloads break over time. macOS ships 3.9 (/usr/bin/python3), so look for a newer one.
py_at_least() { "$1" -c "import sys; sys.exit(0 if sys.version_info >= (3, $2) else 1)" >/dev/null 2>&1; }
find_python() {  # $1 = minimum minor version
  for cand in \
    /Library/Frameworks/Python.framework/Versions/3.14/bin/python3 \
    /Library/Frameworks/Python.framework/Versions/3.13/bin/python3 \
    /Library/Frameworks/Python.framework/Versions/3.12/bin/python3 \
    /Library/Frameworks/Python.framework/Versions/3.11/bin/python3 \
    /Library/Frameworks/Python.framework/Versions/3.10/bin/python3 \
    /opt/homebrew/bin/python3.13 /opt/homebrew/bin/python3.12 /opt/homebrew/bin/python3.11 /opt/homebrew/bin/python3 \
    /usr/local/bin/python3.13 /usr/local/bin/python3.12 /usr/local/bin/python3.11 /usr/local/bin/python3 \
    "$(command -v python3.13 2>/dev/null || true)" "$(command -v python3.12 2>/dev/null || true)" \
    "$(command -v python3.11 2>/dev/null || true)" "$(command -v python3.10 2>/dev/null || true)" \
    "$(command -v python3 2>/dev/null || true)"; do
    [ -n "$cand" ] && [ -x "$cand" ] || continue
    # On macOS /usr/bin/python3 is only a stub until the Command Line Tools are installed:
    # calling it would pop up an install dialog, so only use it when they are present.
    if [ "$cand" = "/usr/bin/python3" ] && [ "$(uname)" = "Darwin" ] && ! xcode-select -p >/dev/null 2>&1; then continue; fi
    if py_at_least "$cand" "$1"; then echo "$cand"; return 0; fi
  done
  return 1
}
BREW="$(command -v brew 2>/dev/null || true)"
[ -z "$BREW" ] && [ -x /opt/homebrew/bin/brew ] && BREW=/opt/homebrew/bin/brew
[ -z "$BREW" ] && [ -x /usr/local/bin/brew ] && BREW=/usr/local/bin/brew

PY="$(find_python 10 || true)"
if [ -z "$PY" ] && [ "$(uname)" = "Darwin" ] && [ -n "$BREW" ]; then
  echo "[..] Installing Python 3.12 with Homebrew (one time, a few minutes)..."
  if "$BREW" install python@3.12 </dev/null; then PY="$(find_python 10 || true)"; fi
fi
if [ -z "$PY" ]; then
  PY="$(find_python 9 || true)"
  if [ -n "$PY" ]; then
    echo "[!] Only Python 3.9 was found. It works, but yt-dlp cannot update on 3.9 any more."
    if [ "$(uname)" = "Darwin" ]; then
      echo "    Recommended: install Python 3.12 from python.org (or: brew install python@3.12), then run this again."
    fi
  fi
fi
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
# An old .venv made with Python 3.9 is rebuilt when a newer Python is now available.
if [ -x "$VPY" ] && ! py_at_least "$VPY" 10 && py_at_least "$PY" 10; then
  echo "[..] Rebuilding the helper environment with $("$PY" --version 2>&1)"
  rm -rf "$VENV"
fi
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
