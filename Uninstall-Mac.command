#!/bin/bash
# Media Downloader - uninstall. Your downloaded files (Desktop/MediaDownloader) are NOT deleted.
DEST="$HOME/MediaDownloader"
echo
echo "=== Uninstalling Media Downloader ==="
if [ -x "$DEST/helper/.venv/bin/python" ]; then
  "$DEST/helper/.venv/bin/python" "$DEST/helper/main.py" uninstall
fi
echo
echo " 1. In Chrome open chrome://extensions and click 'Remove' on Media Downloader."
read -r -p " 2. Delete the program folder $DEST now? [y/N] " ans
case "$ans" in
  [yY]*) cd "$HOME" && rm -rf "$DEST" && echo "[ok] Program folder deleted." ;;
  *) echo "Kept $DEST." ;;
esac
echo
echo "Your downloads in Desktop/MediaDownloader were kept."
read -r -p "Press Enter to close."
