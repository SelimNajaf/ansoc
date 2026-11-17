#!/bin/bash
# Media Downloader - macOS installer. Double-click this file (or: right-click > Open the first time).
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/MediaDownloader"

echo
echo "=== Installing Media Downloader ==="
echo

mkdir -p "$DEST"
if [ "$HERE" != "$DEST" ]; then
  # extension: replace completely; helper: keep the installed .venv, settings and logs
  rsync -a --delete "$HERE/extension/" "$DEST/extension/" || { echo "[x] Could not copy the extension."; read -r -p "Press Enter to close."; exit 1; }
  rsync -a --exclude ".venv" --exclude "__pycache__" --exclude "state" --exclude "logs" --exclude "bin" \
        --exclude "config.json" --exclude "pindl_host.sh" --exclude "*.log" \
        "$HERE/helper/" "$DEST/helper/" || { echo "[x] Could not copy the helper."; read -r -p "Press Enter to close."; exit 1; }
  for f in Update-Mac.command Uninstall-Mac.command README.md; do
    [ -f "$HERE/$f" ] && cp "$HERE/$f" "$DEST/$f"
  done
fi
chmod +x "$DEST/helper/install_unix.sh" "$DEST"/*.command 2>/dev/null
# files downloaded from the internet are quarantined by macOS: clear that for our own copy
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null

if ! bash "$DEST/helper/install_unix.sh"; then
  echo
  echo "[x] The helper could not be installed. Read the message above."
  read -r -p "Press Enter to close."
  exit 1
fi

open "$DEST" 2>/dev/null
open -a "Google Chrome" "chrome://extensions/" 2>/dev/null
echo
echo "======================================================================"
echo " DONE! Last step (first time only):"
echo
echo "  1. In Chrome open   chrome://extensions"
echo "  2. Turn on 'Developer mode' (top right)"
echo "  3. Click 'Load unpacked' and choose this folder:"
echo "        $DEST/extension"
echo "  4. Updating? Just click the reload icon on the extension instead."
echo
echo " Your downloads go to:  Desktop/MediaDownloader"
echo " (macOS may ask once to allow access to the Desktop folder: click Allow.)"
echo "======================================================================"
read -r -p "Press Enter to close."
