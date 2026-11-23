# CLAUDE.md — everything an AI assistant needs to work on Media Downloader

Read this file first, in every new environment. It replaces a long explanation from the owner.
`AGENTS.md` only points here.

---

## 0. First 60 seconds (do this before anything else)

1. **Sync with GitHub.** `git fetch` and compare with `origin/main`. Releases are pushed from several
   machines and sessions; a local checkout can be many versions behind (once it was 2.16.2 while
   GitHub had 2.21.1, and work was done on the stale copy). If behind and the tree is clean: `git pull`.
   If you have local work: put it on a branch first, never throw it away.
2. Note the current version in `extension/manifest.json` and the top of `CHANGELOG.md`.
3. Decide what kind of request this is:
   - **A. "Install / set this up for me"** → Part A (the person is usually not technical).
   - **B. Change the code / release / fix a problem on the owner's machine** → Parts B–E.

---

## 1. The owner and how to talk to them

- The owner is a **non-coder dropshipper** who studies competitor Instagram stores (reels) with this app.
  They use it every day on **Windows and macOS**, in **Chrome with two profiles** ("Default" and "Profile 1").
- **Chat in Azerbaijani**, plain words, no jargon. (They complained when answered in English.)
  Other people installing the app: answer in *their* language.
- **The app's UI stays English**, short (1–3 word labels), visual: charts, chips, colors, tooltips instead of sentences.
  Drop what is not important.
- They like bold visual changes ("if I don't like it we roll back"); they notice layout details:
  no empty grid slots (tiles stretch), subtitles on one line, nothing that shifts table width, log scales for views.
- **No paid AI APIs.** Free scripts and statistics only.
- **Hours matter, weekdays don't.** Times are shown in their local time (Baku, UTC+4).
- Decisions they already made (don't bring these back): no Viral/Strong/Winner/Top-10% KPI tiles,
  no "How is this calculated?", no rows of fact chips under charts, no "What to do" / "Top reels" blocks (removed 2.20.0),
  no "Current season" read option (removed 2.16.2), no Compare stores page (removed 2.13.0),
  no permanent panel on top of Instagram / TikTok / Pinterest (removed 2.20.0),
  no Repeats / same-cover groups (cover fingerprints, removed 2.26.1: not useful enough),
  no audio (original vs music) or reel-length analysis (dropped: standard in organic dropshipping),
  no day-square Calendar (replaced by Posting schedule in 2.27.0: it only repeated Posting activity).
- A chart's own switches sit right above that chart. Views histogram defaults to log; activity line defaults to total views.

---

## 2. What the product is

**Media Downloader** = a Chrome MV3 extension (`extension/`) + a local Python helper (`helper/`) started by Chrome
via Native Messaging. Everything runs locally; nothing is uploaded.

| Feature | Where |
|---|---|
| Download Instagram post / reel / story, TikTok video / photo, Pinterest pin / board, best quality | right-click menu (**Download this post**, also on links), toolbar popup (link box), fixed on-page buttons |
| Instagram profile → fixed **Analyze reels** button (top right) → **Reels Analyzer** page | `content/content.js`, `analyzer/` |
| Pinterest pin / board → fixed round **Download** button inside Pinterest's own left menu, under its icons (same 48px size and spacing; hidden if that menu is missing) | `content/content.js` (`pinSpot()`) |
| Small toast at the bottom only while something started on the page runs | `content/content.js` |
| Files land in Chrome's **Downloads** folder and download list; several files of one job / a bulk download = one ZIP | `background.js` `deliver()` / `handOff()`, `helper/handoff.py` |
| Self-update: popup shows **Update now** when GitHub has a newer version | `background.js`, `helper/updater.py` |

### Reels Analyzer (the main thing the owner uses)

Order on the page (CSS `order` on `#results` children in analyzer.css): fetch form + profile preview card → loader (reels appear one by one) → profile card →
**Time range** (brush over activity, detected seasons) → KPI cards → **Views distribution** →
**Posting activity** → **What works** (best hour window, ideal posts per day) → **Posting schedule** (date × time of day,
dot = reel, size = views, color = Success, best window as a green band; hour rows tinted by success lift; right side =
Best time: reels/hour bars colored by lift + blue success curve — the old separate hours chart is gone, the Best time tile jumps here) → **Reaction map**
(scatter: Views × Success / Comments × Likes, four clickable corners filter the table, hover preview) → **Reels table**
(column filters with sliders, ordered filter chain, Success chips, details drawer, select + download /
copy links / copy captions / CSV / Export data, 📷 full-page screenshot).

What to read: *Last 30 / 60 / 90 / 180 days* (default 60), *Everything (≤ 500)*, *Newest 60 / 120 / 240*.

---

## 3. Layout

```
extension/                 Chrome MV3 extension (fixed ID pdajcifnbdkaoeiajndahpadigkigjab via "key" in manifest.json)
  manifest.json            version lives here (the helper reads it too)
  background/background.js service worker: job queue, native messaging, right-click menus, update check, hand-off
  analyzer/                Reels Analyzer: analyzer.html/.css/.js (UI), stats.js (pure statistics, runs in Node), effects.js
  content/content.js       page script: page info for popup/menus, toast, Instagram + Pinterest fixed buttons, board collection
  popup/                   toolbar popup (page-aware actions, link box, recent downloads, Update now)
  ui/tokens.css  ui/icons.js   design tokens and line icons shared by every page (see DESIGN.md)
  utils/                   constants.js (PD.*, statuses, t()), platforms.js (registry), pinterest.js (pin parsing)
  _locales/en/messages.json   all UI text (English only)
helper/                    Python 3.9+ helper
  native_host.py           message loop (stdin/stdout framing, cancel registry)
  downloader.py            yt-dlp / gallery-dl / FFmpeg runner, naming, duplicates
  engines/                 instagram_engine.py, tiktok_engine.py, pinterest_engine.py, base_engine.py
  handoff.py               one-time 127.0.0.1 link that hands finished files to chrome.downloads
  updater.py               self_update from GitHub (copies files, pip upgrade, runs main.py install)
  main.py                  install / uninstall / check CLI; writes the host wrapper (pindl_host.bat / .sh)
  common.py                IS_WINDOWS / IS_MAC, errors, paths
tools/brain_model.py  tools/brain_analysis.py   fit the Success score on research/*.json
research/                  owner's Export data JSON files (git-ignored)
translations/az/  QURASHDIRMA-OXU.txt          Azerbaijani texts for people installing it
Install-* Update-* Uninstall-*   end-user scripts (Windows .bat, macOS .command)
README.md  CHANGELOG.md  DESIGN.md
```

---

## 4. Rules learned the hard way

### Helper / processes
- **Never let a child process inherit the native-messaging pipes.** `native_host.py` moves stdin/stdout to private
  handles at import; new subprocesses keep `stdin=subprocess.DEVNULL` and on Windows `CREATE_NO_WINDOW`.
- **Several hosts run at once** (one per Chrome profile / browser). The Windows wrapper must not take an exclusive
  file that a second host also needs: `cmd`'s `2>>file` locks the file while the host runs, and the second host
  then dies instantly ("helper started but exited immediately"). Since 2.22.1 `pindl_host.bat` probes
  `host-stderr.log`, falls back to `host-stderr-2.log`, then `NUL`. Keep anything new per-process or shareable.
- Stdout of the host is Chrome's message pipe: never print to it.
- Temporary / outbox folders live in the system temp dir, never the (OneDrive-synced) Desktop.
- **Where files go (since 2.18):** helper finishes files in its outbox, `handoff.py` serves them once on
  `127.0.0.1`, the extension downloads with `chrome.downloads`. The helper never writes to ~/Downloads
  (macOS would ask for folder access). Duplicates store Chrome's `download_id`; its `exists` flag says if the file is still there.

### Instagram
- Rate limits come fast: Instagram downloads one at a time (`PLATFORM_CONCURRENCY` in background.js);
  never prefetch details in bulk; bulk actions use `batchDelayMs`.
- The Reels-tab GraphQL returns **no captions and no `taken_at`**. Dates are decoded from the shortcode
  (`codeTime` in stats.js, `_code_time` in the engine); captions come from `reel_details` (one request per opened reel, cached).
- Login: the helper uses Chrome's Instagram cookies only when the user turns on *Use Chrome's login*. Never ask for passwords/cookies.

### Pinterest pages (for anything drawn on them)
- Pinterest's own hover buttons on a pin card: *Save* + board picker (top), *Send* + *⋯* (bottom right), site link (bottom left).
- Top of the page is Pinterest's search bar + profile across the full width; the left menu `#VerticalNavContent`
  (fixed, 72px) holds 48px icons every 72px, *Settings* alone at the bottom. That free space is where our button lives.
- Don't insert UI into Pinterest's React tree unless needed; if you do, expect it to be dropped on re-render.

### Statistics ("the brains", all in `extension/analyzer/stats.js`)
- **Success score** is the main verdict: `success()` = logistic( z(log comments) · 3.10 + z(log like rate) · 1.34 − 5.31 )
  within the store, 0–100; hit ≥ 80 (gold), good ≥ 50 (green). Fitted with `tools/brain_model.py` on the owner's picks
  (4 stores, 28 picks / 388 reels, LOSO top-N 23/28 vs views 12/28). Refit when new research files arrive.
  Picks are positive-unlabeled: unpicked high scorers are not errors.
- **Timing brains** (on Success): `bestTimeWindows` = flexible 1–12 h window (can cross midnight) chosen by the lower
  bound of its success lift; `postsPerDay` = success per reel vs ln(posts that day), ideal = fewest posts reaching 90 % of the best day.
- **Seasons:** `activePeriods()` newest → oldest; pause = ≥ 14 days AND ≥ 10× the season's median gap; ≥ 3 reels per season.
- **Viral / strong / winner** (documented at the top of `performance()`): robust z-score of log views against a
  time-local baseline; engagement judged against a Theil–Sen fit on reach.
- **Chart picks:** any chart click sets `state.filter` (`views` / `date` / `codes` with a `src` like `hour:5`, `win:3:8`,
  `perday:2`); `renderTable()` then puts the table steps aside in `state.savedSteps` and restores them when the
  filter is cleared. Hover cards on charts go through `bindRowsTip()` (numbers + best reels' thumbnails).
- Known store patterns from research: "Comment X" call to action + original audio, 12–16 s reels;
  best windows mostly at night Baku time (US morning).

### Design (details in DESIGN.md)
- Dark theme only. Colors, gradients, radii, font sizes only from `ui/tokens.css` (`var(--token)`); never hard-code a color
  (a content script's closed shadow root copies the tokens at runtime and keeps fallbacks).
- Icons from `ui/icons.js` (`PD.icon("name")`), never emoji. Gold = hit, green / rose = better / worse,
  `--action-grad` = buttons with text. Text ≥ 12px, click targets ≥ 28px.

---

## 5. Windows + macOS (both used every day)

- Paths with `pathlib` / `os.path`; no hard-coded separators or `C:\` / `/Users` paths.
- Platform code behind `IS_WINDOWS` / `IS_MAC` (`helper/common.py`).
- Installer changes go into both `Install-Windows.bat` / `helper/install_windows.bat` and `Install-Mac.command` /
  `helper/install_unix.sh`; same for Update / Uninstall.
- Line endings per `.gitattributes` (`.bat` CRLF, `.sh` / `.command` LF); keep the executable bit on `.command` / `.sh`.
- Python must run on 3.9+ (`from __future__ import annotations`); installers prefer 3.10+ (yt-dlp needs it).

---

## 6. Checks before committing

- `node --check` on every changed `.js`; `python -m py_compile` on changed `.py`; `bash -n` on `.sh` / `.command`.
- Every `t("key")` / `data-i18n="key"` must exist in `extension/_locales/en/messages.json`.
- Never commit downloads or personal data (`Instagram/`, `TikTok/`, `Pinterest/`, `research/`, `helper/.venv`,
  `helper/state`, `helper/logs`, `helper/config.json`, `helper/host-stderr*.log`).
- Statistics changes: run `stats.js` in Node on the research files and compare before / after.

## 7. Releasing (every user-visible change ships as a release)

1. Raise `"version"` in `extension/manifest.json` (patch for fixes, minor for features).
2. Add a plain-words, user-facing entry at the top of `CHANGELOG.md`; say "Needs the helper update: use **Update now**" when helper files changed.
3. Commit (`2.x.y: short summary`) and push to `main`. Only push what is ready for users.

Installed copies check `raw.githubusercontent.com/SelimNajaf/ansoc/main/extension/manifest.json` (every 6 h and
whenever the popup opens; raw GitHub can lag ~5 min) and offer **Update now**.
**The owner presses Update now themselves** — don't run `updater.self_update` for them (they want to see it arrive).
Exception: repairing a broken install on their machine (helper won't start) — fix the installed files directly and say so.

## 8. The owner's machine (Windows)

- Project checkout: `C:\Users\Ogtay\OneDrive\Desktop\MediaDownloader` (OneDrive-synced; `cmd` cannot run `.bat`
  files from it — run scripts from the installed copy or with an absolute path).
- Installed copy Chrome loads: `%USERPROFILE%\MediaDownloader\extension`, helper in `%USERPROFILE%\MediaDownloader\helper`
  (`.venv`, `logs\host-YYYY-MM-DD.log`, `host-stderr.log`). Native host registry key:
  `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.local.media_downloader`.
- Both Chrome profiles load the same folder. After files change, a profile keeps running the old code until ↻ in
  `chrome://extensions`. To see which version each profile runs: search `pdajcifnbdkaoeiajndahpadigkigjab` in
  `%LOCALAPPDATA%\Google\Chrome\User Data\<profile>\Secure Preferences`.
- Diagnose "Helper not installed": `main.py check` with the venv python; read `logs\host-*.log` (a start line means
  Python ran); simulate Chrome by starting `pindl_host.bat` with the origin argument and sending a framed
  `{"id":"1","action":"ping","params":{}}`; list hosts with `Get-CimInstance Win32_Process | ? CommandLine -match MediaDownloader`.

## 9. Testing without bothering the owner

- **Live site in the owner's Chrome** (Claude in Chrome): open the page, inject a small copy of the new UI code
  with stubs (`chrome`, `send`, `t`) through the JavaScript tool, check placement / overlaps with `getBoundingClientRect`,
  hover and screenshot. Claude in Chrome cannot open `chrome-extension://` URLs.
- **Real extension:** Google Chrome ignores `--load-extension`, Edge doesn't:
  `msedge.exe --remote-debugging-port=9337 --user-data-dir=<scratch> --load-extension=<copy of extension>`, open
  `chrome-extension://pdajcifnbdkaoeiajndahpadigkigjab/analyzer/analyzer.html` via CDP `/json/new`, call
  `load(DATA, Date.now())` with mock reels.
- **UI harness:** copy `extension/` to a scratch folder, add a `mock.js` that fakes `chrome.*` (i18n from messages.json,
  demo reels in `reelsCache`), insert it before `constants.js` in the page, serve with `py -3 -I -m http.server`.

---

## Part A — Installing for a non-technical person

### How to talk
- Their language, short sentences, no jargon; one instruction at a time with the exact on-screen text; wait for "done".
- Do everything you can yourself; they only click inside Chrome. Never ask for passwords, cookies or tokens.

### Steps
1. **Get the files** (if not inside this repo): `git clone https://github.com/SelimNajaf/ansoc.git` into a temp folder,
   or download `https://github.com/SelimNajaf/ansoc/archive/refs/heads/main.zip` and unzip. The installer copies what it
   needs to `~/MediaDownloader`, so the download can be deleted afterwards.
2. **Run the installer** non-interactively from the repo root:
   - Windows: `cmd /c "Install-Windows.bat < nul"` (installs Python 3.12 with winget per user if needed).
   - macOS: `bash Install-Mac.command < /dev/null` (if Python is missing python.org opens: "install it like any app, then tell me 'done'", then run again).
   - Linux: copy `extension/` and `helper/` to `~/MediaDownloader/`, then `bash helper/install_unix.sh` (needs `python3-venv`).
   First run downloads ~150 MB (yt-dlp, gallery-dl, FFmpeg).
3. **Verify:** `<venv python> ~/MediaDownloader/helper/main.py check` → `[ok]` for python, yt_dlp, gallery_dl, pillow, ffmpeg
   (`ffprobe`, `exifread` optional). Windows venv python: `%USERPROFILE%\MediaDownloader\helper\.venv\Scripts\python.exe`.
4. **The one manual step** (Chrome blocks automating it):
   1. "Type `chrome://extensions` in the address bar, press Enter."
   2. "Top right: turn on **Developer mode**."
   3. "Click **Load unpacked** and choose `<full path>`" (`C:\Users\<name>\MediaDownloader\extension`;
      Mac: Cmd+Shift+G, paste `~/MediaDownloader/extension`).
   4. "Click the puzzle icon and pin **Media Downloader**."
   5. "Click the icon. Does the top right say **Helper connected**?"
   An older copy from another folder must be **Removed** first (fixed ID, two copies conflict).
5. **Instagram (optional):** "Log in to instagram.com in Chrome, then extension → Settings → turn on *Use Chrome's login*."
6. **Usage in 3–4 lines:** right-click a post / reel / pin (or a link) → **Download this post**; the popup's link box;
   on an Instagram profile the **Analyze reels** button; on a Pinterest pin / board the round **Download** button in
   Pinterest's left menu; files go to **Downloads** (several = one ZIP).

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| *Helper not installed* | Registration missing → re-run the installer, then ↻ on the extension. |
| *Helper started but exited immediately* | Read `helper/logs` and `host-stderr.log`; with two profiles see §4 (wrapper lock, fixed in 2.22.1). |
| Popup shows an old version / *Update failed* | That profile still runs old code: ↻ in `chrome://extensions`; if the helper is too old for `self_update`, run `Update-Windows.bat` / `Update-Mac.command`. |
| *Developer mode is disabled by your administrator* | Managed Chrome; use another profile / computer. |
| `pip` fails | No internet / proxy; retry online. |
| Stuck at "Downloading" | ✕ Cancel → Retry; logs in `~/MediaDownloader/helper/logs/`. |
| *Instagram rate limit* | Wait 10–15 minutes; don't re-run Analyze repeatedly. |
| macOS "unidentified developer" | Right-click → Open, or run with `bash`. |

### Updating
- Normal: popup → **Update now** (helper `self_update`, then the extension reloads itself).
- Manual: `Update-Windows.bat` / `Update-Mac.command` (downloads main, re-runs the installer, keeps `.venv`, settings, logs).
