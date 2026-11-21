# Instructions for AI assistants (Claude Code and others)

This repository is **Media Downloader**: a Chrome extension (`extension/`) plus a local Python helper (`helper/`) that downloads Instagram / TikTok / Pinterest media and analyzes Instagram reels.

There are two kinds of requests. Figure out which one you have:

- **A. "Install this for me" / "set this up"** → the person is usually **not technical**. Follow *Part A*.
- **B. Changing the code / publishing an update** → follow *Part B*.

---

## Part A — Installing for a non-technical user

### How to talk

- Use the person's language (if they write Azerbaijani, Turkish, Russian … answer in it). Short sentences, no jargon. Say what you are doing and why in one line.
- Do everything you can yourself. Only ask them to do what you cannot: clicking inside Chrome.
- Give one instruction at a time, with the exact text they will see on screen. Wait for "done" before the next step.
- Never ask for passwords, cookies or tokens. The extension uses their existing Chrome login; they log in to Instagram in Chrome themselves.

### Steps

1. **Get the files.** If you are not already inside this repository:
   - with git: `git clone https://github.com/SelimNajaf/ansoc.git` into a temporary folder (e.g. the system temp dir), or
   - without git: download `https://github.com/SelimNajaf/ansoc/archive/refs/heads/main.zip` and unzip it.
   The installer copies everything it needs to `~/MediaDownloader` (Windows: `%USERPROFILE%\MediaDownloader`), so the downloaded copy can be deleted afterwards.

2. **Run the installer** from the repository root, non-interactively (it ends with a "press a key" prompt, so feed it empty input):
   - **Windows** (PowerShell or cmd): `cmd /c "Install-Windows.bat < nul"`
     - Installs Python 3.12 with `winget` (per user, no admin) if no Python 3.9+ exists.
   - **macOS:** `bash Install-Mac.command < /dev/null`
     - If Python 3 is missing it opens python.org and stops. Tell the user: *"Download the macOS installer from the page that just opened, install it like any app, then tell me 'done'."* Then run the installer again.
   - **Linux:** `bash helper/install_unix.sh` after copying `extension/` and `helper/` to `~/MediaDownloader/` (needs `python3-venv`).
   The first run downloads ~150 MB (yt-dlp, gallery-dl, a static FFmpeg). It may take a few minutes.

3. **Verify the helper.** Expect `[ok]` for python, yt_dlp, gallery_dl, pillow, ffmpeg (`ffprobe` and `exifread` are optional):
   - Windows: `"%USERPROFILE%\MediaDownloader\helper\.venv\Scripts\python.exe" "%USERPROFILE%\MediaDownloader\helper\main.py" check`
   - macOS / Linux: `~/MediaDownloader/helper/.venv/bin/python ~/MediaDownloader/helper/main.py check`

4. **Guide the one manual step** (you cannot do this for them — Chrome blocks it on purpose). Tell them, in their language:
   1. "In Chrome, type `chrome://extensions` in the address bar and press Enter."
   2. "At the top right, turn on **Developer mode**."
   3. "Click **Load unpacked** and choose the folder `<exact path>`" — give the full path: `C:\Users\<name>\MediaDownloader\extension` or `/Users/<name>/MediaDownloader/extension` (on Mac: in the folder window press Cmd+Shift+G and paste `~/MediaDownloader/extension`).
   4. "Click the puzzle icon in the toolbar and pin **Media Downloader**."
   5. "Click the extension icon. Does the top right say **Helper connected**?"
   If an older copy was loaded from another folder before, tell them to **Remove** that one first (the extension ID is fixed, two copies conflict).

5. **Instagram (only if they want it):** "Log in to instagram.com in Chrome. Then open the extension → Settings → turn on *Use Chrome's login*."

6. **Explain usage in 3–4 lines** (see README "Use"): the panel on Pinterest/TikTok/Instagram pages, the popup with a link box, the Reels Analyzer on an Instagram profile, files in `Desktop/MediaDownloader`.

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Badge: *Helper not installed* | The native-messaging registration is missing. Re-run the installer; then the reload icon on the extension in `chrome://extensions`. Windows: registry key `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.local.media_downloader`. macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.local.media_downloader.json`. |
| *Developer mode is disabled by your administrator* | Managed (office) Chrome. Nothing to fix on our side: use another computer/profile. |
| `pip` fails | No internet or a proxy. Retry when online. |
| Downloads stuck at "Downloading" | Should not happen since 2.4.0 (children of the helper no longer inherit Chrome's stdin pipe). Ask them to press ✕ Cancel → Retry. Logs: `~/MediaDownloader/helper/logs/`. |
| *Instagram rate limit* | Instagram throttles accounts that make many requests. Wait 10–15 minutes; avoid re-running Analyze repeatedly. |
| macOS: "unidentified developer" | Right-click → Open, or run with `bash` as above. |
| macOS asks for Desktop access | Click Allow: downloads go to `~/Desktop/MediaDownloader`. |

### Updating an existing install

- Normal way: extension popup → **Update now** (helper action `self_update`, then the extension reloads itself).
- Manual: run `Update-Windows.bat` / `Update-Mac.command` (downloads the main-branch ZIP and re-runs the installer; keeps `.venv`, settings, logs).
- Versions ≤ 2.3.x have no `self_update`: use the manual script once.

---

## Part B — Developing and releasing

### Layout

```
extension/               Chrome MV3 extension (fixed ID via "key" in manifest.json)
  background/            service worker: job queue, native messaging client, update check
  analyzer/              Reels Analyzer page (stats.js = pure statistics, testable in Node; effects.js = shared result bars)
  ui/tokens.css          design tokens + base components shared by every page (see DESIGN.md)
  popup/  content/  utils/
  _locales/en/           all UI text (English only)
helper/                  Python helper, started by Chrome via Native Messaging
  native_host.py         message loop (stdin/stdout framing, cancel registry)
  downloader.py          yt-dlp / gallery-dl / FFmpeg runner, file naming, duplicates
  engines/               instagram, tiktok, pinterest
  updater.py             self-update from GitHub
  main.py                install / uninstall / check (CLI)
Install-*.bat|command    end-user installers (copy to ~/MediaDownloader, create .venv, register host)
Update-*  Uninstall-*    end-user update / uninstall scripts
```

### Rules learned the hard way

- **Never let a child process inherit the native-messaging pipes.** On Windows a child touching stdin while the host blocks reading it freezes at startup. `native_host.py` moves stdin/stdout to private handles at import; keep `stdin=subprocess.DEVNULL` on new subprocesses anyway.
- Instagram's Reels-tab GraphQL returns **no captions and no `taken_at`**. Dates are decoded from the shortcode (`codeTime` in `stats.js`, `_code_time` in the engine); captions come from `reel_details` (one request per opened reel, cached).
- Instagram rate-limits quickly: keep Instagram downloads to one at a time (`PLATFORM_CONCURRENCY` in background.js), never prefetch details in bulk.
- Temporary download folders live in the system temp dir, not the (often OneDrive-synced) Desktop.
- **Success score ("the brain")** is the main verdict: `success()` in `extension/analyzer/stats.js` (z of log comments + z of log like rate within the store, logistic weights). It was fitted on the user's picks with `tools/brain_model.py` on `research/*.json` (Export data files, git-ignored); refit and update the constants there when new picks arrive.
- **Timing brains** (`bestTimeWindows`, `postsPerDay` in `stats.js`, both on the Success score): flexible best hour window chosen by the lower bound of its success lift; posts/day from success-per-reel vs ln(posts that day), ideal = fewest posts reaching 90 % of the best day.
- **Seasons:** `activePeriods()` in `stats.js` (Time range periods): newest → oldest; pause = ≥ 14 days AND ≥ 10× the median gap of the current season; ≥ 3 reels per season. The helper's `gap_days` stop in `list_reels` mirrors it but the UI no longer offers it ("Current season" was removed in 2.16.2).
- Statistics (viral / strong / winner) are documented at the top of `performance()` in `extension/analyzer/stats.js`: robust z-score on log views against a time-local baseline; engagement judged against a Theil–Sen fit on reach.

- **Design:** follow `DESIGN.md`. Colors, gradients, radii and font sizes come only from `extension/ui/tokens.css` (`var(--token)`); never hard-code a color. Gold = hit, green/rose = better/worse, brand gradient = actions.

### Windows + macOS (both are used every day)

Every change must keep working on **both** Windows and macOS. In particular:
- Paths: use `pathlib` / `os.path`, never hard-coded `\` or `/` separators or `C:\` / `/Users` paths.
- Platform-specific code goes behind `IS_WINDOWS` / `IS_MAC` (`helper/common.py`); new subprocesses keep `stdin=subprocess.DEVNULL` and, on Windows, `CREATE_NO_WINDOW`.
- Installer changes go into both `Install-Windows.bat` / `helper/install_windows.bat` and `Install-Mac.command` / `helper/install_unix.sh`; same for Update / Uninstall.
- Keep line endings from `.gitattributes` (`.bat` CRLF, `.sh` / `.command` LF) and the executable bit on `.command` / `.sh` files.
- Python code must run on 3.9+ (`from __future__ import annotations` for new type syntax); the installers prefer 3.10+ because yt-dlp needs it.

### Checks before committing

- `node --check` on every changed `.js` file; `python -m py_compile` on changed `.py` files; `bash -n` on `.sh` / `.command`.
- Every `t("key")` / `data-i18n="key"` used must exist in `extension/_locales/en/messages.json`.
- Never commit downloads or personal data (`Instagram/`, `TikTok/`, `Pinterest/`, `helper/.venv`, `helper/state`, `helper/logs`, `helper/config.json`) — see `.gitignore`.

### Releasing an update

1. Raise `"version"` in `extension/manifest.json` (semver, e.g. 2.4.0 → 2.4.1). The helper reads its version from the same file.
2. Add an entry at the top of `CHANGELOG.md` (plain words, user-facing).
3. Commit and push to `main`.

Installed copies check `raw.githubusercontent.com/SelimNajaf/ansoc/main/extension/manifest.json` at most every 6 hours (and when the popup opens) and offer **Update now**. Only push to `main` what is ready for users.
