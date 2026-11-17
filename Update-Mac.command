#!/bin/bash
# Media Downloader - update to the latest version from GitHub. Double-click this file.
# (Normally the extension updates itself: popup > "Update now". This is the manual way.)
TMPD="$(mktemp -d)"
echo
echo "=== Updating Media Downloader ==="
echo "Downloading the latest version from GitHub..."
if ! curl -fsSL "https://codeload.github.com/SelimNajaf/ansoc/zip/refs/heads/main" -o "$TMPD/update.zip"; then
  echo "[x] The download failed. Check your internet connection and try again."
  read -r -p "Press Enter to close."
  exit 1
fi
unzip -q "$TMPD/update.zip" -d "$TMPD/x" || { echo "[x] Could not unpack the update."; read -r -p "Press Enter to close."; exit 1; }
SRC="$(dirname "$(ls "$TMPD"/x/*/Install-Mac.command 2>/dev/null | head -n 1)")"
if [ ! -f "$SRC/Install-Mac.command" ]; then
  echo "[x] The downloaded files look wrong. Try again later."
  read -r -p "Press Enter to close."
  exit 1
fi
bash "$SRC/Install-Mac.command"
rm -rf "$TMPD"
