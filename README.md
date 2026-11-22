# Media Downloader — Instagram · TikTok · Pinterest

A Chrome extension that downloads Instagram, TikTok and Pinterest photos and videos in the best quality, plus a **Reels Analyzer** that shows which reels of an Instagram profile went viral, when they post, and what their descriptions say. Built for researching products and competitors (for example dropshipping stores).

Everything runs on your own computer. Nothing is uploaded anywhere.

> **No coding needed.** Installing takes about 5 minutes: download, double-click, and one step in Chrome.

---

## 1. Install

### Step 1 — Download

**[⬇ Download the ZIP](https://github.com/SelimNajaf/ansoc/archive/refs/heads/main.zip)** and unzip it (double-click the file).

- **Windows:** right-click the ZIP → **Extract All…** → Extract. Don't run anything from inside the ZIP.
- **Mac:** double-click the ZIP; a folder `ansoc-main` appears next to it.

### Step 2 — Run the installer

| Windows | Mac |
|---|---|
| Double-click **`Install-Windows.bat`** | Right-click **`Install-Mac.command`** → **Open** → **Open** |
| If you see *"Windows protected your PC"*: click **More info** → **Run anyway**. | The first time, macOS only allows it through right-click → Open. |
| Python is installed automatically if it's missing. | If Python is missing, python.org opens: install it, then run the installer again. |

A black window shows the progress. Wait until it says **DONE!** (the first time it downloads about 150 MB of tools).

### Step 3 — Add it to Chrome (only once)

1. In Chrome open **`chrome://extensions`** (type it in the address bar).
2. Turn on **Developer mode** (switch at the top right).
3. Click **Load unpacked** and choose this folder:
   - **Windows:** `C:\Users\<your name>\MediaDownloader\extension`
   - **Mac:** `/Users/<your name>/MediaDownloader/extension`
     *(tip: in the folder window press **⌘ Cmd + ⇧ Shift + G** and type `~/MediaDownloader/extension`)*
4. Click the puzzle icon 🧩 in Chrome's toolbar and **pin** Media Downloader.

Click the extension icon: the badge at the top should say **Helper connected**. ✅

### Install with AI (Claude) instead

Have [Claude Code](https://claude.com/claude-code) (desktop app or terminal)? Just say:

> *Install this for me: https://github.com/SelimNajaf/ansoc*

It follows [`CLAUDE.md`](CLAUDE.md): it runs the installer, checks that everything works, and tells you in plain words the one thing you have to click in Chrome.

---

## 2. Use

- **Download from a page:** open a Pinterest, TikTok or Instagram post. A **Media Downloader** panel appears at the bottom right. Or click the extension icon, paste a link and press **Download**.
- **Instagram:** log in to instagram.com in Chrome, then in the extension's settings turn on **"Use Chrome's login"** (the Reels Analyzer also offers a **Use my Chrome login** button).
- **Reels Analyzer:** on an Instagram profile click the extension icon → **Reels Analyzer** → **Analyze**. You get:
  - a **Success score** for every reel (🎯 hit / ✓ good): comments + like rate compared with that store's own reels — learned from successful reels of real stores,
  - a **time range** slider with pauses and active periods,
  - **posting hours** and **what works**: best time window, posts per day / week, gap between posts — judged by success (with how sure that is),
  - likes vs comments, engagement, and **views per day** (what's hot right now),
  - click any reel for its **full description** (calls to action, prices, hashtags, music used).
  - Select reels and download them into one folder. File names end with the view count, e.g. `…_3.1M-views.mp4`.
  - **Download CSV** (next to *When do they post?*): one row per reel with posting time, results, success score and posting frequency. Export several stores and combine the files to find the best posting hours and posts per day. Pick **Excel (;)** or **Standard (,)** and use the same for all stores.
- **Your files** go to your **Downloads** folder and show up in Chrome's download list, like any download. Several files at once (a carousel, a board, reels picked in the Analyzer) come as **one ZIP**.

---

## 3. Updates

When a new version is out, the extension's popup shows **"Update available → Update now"**. Click it — that's all. The extension downloads the new version and restarts itself.

If that ever fails: double-click **`Update-Windows.bat`** or **`Update-Mac.command`** in the `MediaDownloader` folder in your home folder.

> Coming from version 2.3.x or older? Use the Update script **once**; after that, updates are one click.

## 4. Uninstall

Double-click **`Uninstall-Windows.bat`** / **`Uninstall-Mac.command`** (in the `MediaDownloader` folder in your home folder), then click **Remove** on the extension in `chrome://extensions`. Your downloaded files are kept.

---

## Problems?

| What you see | What to do |
|---|---|
| Badge says **Helper not installed** | Run the installer again, then click the reload icon ↻ on the extension in `chrome://extensions`. |
| A download stays at **Downloading** | Press **✕ Cancel** and **Retry**. If it says *Instagram rate limit*, wait 10–15 minutes: Instagram slows down accounts that make many requests. |
| Mac: *"cannot be opened because it is from an unidentified developer"* | Right-click the file → **Open** → **Open**. Or in Terminal: `bash ~/Downloads/ansoc-main/Install-Mac.command` |
| **Developer mode** can't be turned on | Your computer is managed by an organisation (office PC). Use a personal computer. |
| Installer says *package install failed* | Check your internet connection (a company proxy can block it) and run it again. |

Still stuck? Open an [issue](https://github.com/SelimNajaf/ansoc/issues) and paste the installer's message.

## Privacy

- Downloads happen directly between your computer and the site.
- Your Instagram login stays in Chrome; the local helper only uses it to talk to Instagram, never stores it on disk, never sends it anywhere else.
- The only other connection is the update check: it reads the version number from this GitHub repository.

---

## For developers

- `extension/` — the Chrome extension (Manifest V3). `helper/` — a local Python helper (yt-dlp, gallery-dl, FFmpeg) the extension talks to over Chrome Native Messaging.
- **Publishing an update:** raise `"version"` in `extension/manifest.json`, add a line to `CHANGELOG.md`, push to `main`. Every installed copy sees it within 6 hours and updates with one click. Details in [`CLAUDE.md`](CLAUDE.md).

---

## Azərbaycanca qısa təlimat

1. **[ZIP-i yükləyin](https://github.com/SelimNajaf/ansoc/archive/refs/heads/main.zip)** və açın (Windows: sağ klik → *Extract All*).
2. **Windows:** `Install-Windows.bat` faylına iki dəfə klikləyin (*"Windows protected your PC"* çıxsa: *More info* → *Run anyway*).
   **Mac:** `Install-Mac.command` faylına sağ klik → *Open* → *Open*.
3. Chrome-da `chrome://extensions` açın → sağ yuxarıda **Developer mode** → **Load unpacked** → ev qovluğunuzdakı `MediaDownloader/extension` qovluğunu seçin.
4. Yeniləmə çıxanda extension-ın popup-ında **"Update now"** düyməsi görünəcək — basın, bu qədər.
5. Fayllar **Downloads** qovluğuna düşür və Chrome-un yükləmələr siyahısında görünür. Bir neçə fayl birlikdə bir **ZIP** kimi gəlir.

Claude Code istifadə edirsinizsə, sadəcə yazın: *"Bunu mənim üçün qur: https://github.com/SelimNajaf/ansoc"* — qalanını Claude edəcək.
