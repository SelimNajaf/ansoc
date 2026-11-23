# Changelog

## 2.29.1

- **What works: the chart under the tiles is gone** (it said little). Only the tiles stay:
  - *Best time* jumps to Posting schedule;
  - *Posts per day* shows the reels from days with the ideal count in the table (click again to clear).

## 2.29.0

- **Best time and Posting schedule are now one chart.** Posting schedule is the main view and carries the Best time brain:
  - **right side, wider:** reels per hour as bars, **green / rose = reels posted then do better / worse than usual** (Success), ★ = hits; the **blue line** = success vs usual (1× dashed);
  - **left side:** every hour row is tinted green / rose the same way, so you see good and bad hours behind the dots;
  - the green best-window band now runs across both sides.
- *What works → Best time* no longer opens its own chart: clicking it jumps to Posting schedule. The other tiles work as before (*Reels per day* is shown first).

## 2.28.0

- **Reaction map, more to read at a glance:**
  - taller chart;
  - every corner shows its share and numbers: e.g. *Winners · 18 (9%)* and *10 hits · median 1.2M views*;
  - **hover a corner** for what it means and the pictures of its best reels;
  - **Views × Success:** a blue dashed *Typical* line = the usual Success for that many views. Dots above it did better than their reach suggests;
  - **Comments × Likes:** bigger dot = more views, so you see which *Talkers* also had reach.
- Hovering a dot now shows the same card as the other charts (picture, time, views, Success, comment and like rate).

## 2.27.1

- **Posting schedule, taller and clearer:** every hour now has its own label and grid line (midnight stands out), so you can read the exact posting time of each dot.
- **New on the right: reels per hour.** A small bar for each hour with how many reels went out then; the gold part = hits. Hover for the numbers and pictures, click to see that hour's reels in the table.

## 2.27.0

- **Calendar replaced by Posting schedule.** The calendar repeated what *Posting activity* already shows. The new chart shows *when in the day* each reel went out:
  - left to right = the day, top to bottom = the time (12:00 at the top, midnight in the middle, like *Best time*);
  - every reel is a dot: bigger = more views, gold = hit, green = good;
  - the store's best window is a green band across the chart, with how many reels fell into it.
  - You see the store's daily rhythm, the day it changed its posting times, and where the hits land.
- Hover a dot for the reel, click it for details; click the green band to see its reels in the table. A chart pick elsewhere fades the other dots.
- Fixed: the hover card could show the word "null" when a reel had no picture.

## 2.26.1

- **Removed:** the *Repeats* section of the Reels Analyzer (it took space without telling much). The two image-server permissions it needed are gone too.

## 2.26.0

- **Reels Analyzer: new Repeats section** (above the Reels table). It finds reels whose covers are the same picture: the store posted the same video (or the same opening shot) again. Stores repeat what sells.
  - Each group shows its covers in date order with views (gold / green frame = hit / good), the number of repeats (×4) and their total views.
  - The title line compares: median views of repeated reels vs all reels (on napwrap.store: 99.6K vs 40.1K).
  - **Show in table** puts the group's reels in the table; click a cover for its details.
- How: each cover gets a small fingerprint on your computer. Free, no AI; the pictures come from Instagram's image server, not its API (no rate limit). Fingerprints are kept with the saved analysis.
- An older saved analysis has no pictures: press **Analyze** once to check its covers.

## 2.25.0

- **Every chart now leads to its reels.** Click and the Reels table shows exactly those reels:
  - *Views distribution* bar, *Posting activity* bar, a *Calendar* day (as before),
  - **new:** an hour in the *Best time* chart, the ★ best window label (e.g. *03:00–11:00*), a bar in *Reels per day*.
  - Click the same thing again (or *Clear*) to go back.
- **Your table filters step aside** while a chart pick is on (a low-views bar under *Views ≥ avg* used to show nothing) and come back when you clear it.
- **Hover shows the reels:** bars, hours and days now show a small card with the numbers and the pictures of the best reels in it (gold / green frame = hit / good).

## 2.24.0

- **Reels Analyzer: new Calendar** (under *Posting activity*). One square per day, a row per month (no weekdays):
  - **gold** = a hit was posted that day, **green** = a good reel, **gray** = posted, empty = no reel;
  - the number = reels posted that day; a ring = a reel younger than 3 days.
  - The title line says how many posting days there were and how many had a hit.
- **Click a day** to see its reels in the table (the activity chart follows); click it again to go back. Hover a day for views, best Success and hits.

## 2.23.0

- **Reels Analyzer: new Reaction map** (right above the Reels table). Every reel is a dot; dashed lines split them into four corners.
  - **Views × Success:** *Winners* (many views, high Success), *Buyers* (fewer views but people react), *Just views* (watched, nobody acts), *Weak*.
  - **Comments × Likes:** *Hot*, *Talkers* (many comments for the likes: buying intent), *Likers*, *Quiet*.
  - Gold = hit, green = good, hollow = younger than 3 days.
- **Click a corner** and the table shows only those reels; click it again (or *Clear*) and your table filters come back.
- **Hover a dot** to see its picture, date, views, Success and rates; **click it** for the details panel.

## 2.22.1

- **Fixed (Windows): "Helper not installed" in a second Chrome profile.** When Media Downloader runs in two Chrome profiles at once, the second one's helper could not start ("the helper started but exited immediately"), because the first was holding its log file. Each one now starts on its own.
- Needs the helper update: use **Update now** in the popup of the profile where the helper still works, then press ↻ on the extension in the other profile once.

## 2.22.0

- **Pinterest: a fixed Download button**, like *Analyze reels* on Instagram. On a pin it downloads the pin (hover it: *Download image* / *Download video*); on a board it downloads the whole board. It sits in Pinterest's own left menu, under its icons (same size, same spacing), so it never covers Pinterest's buttons, the search bar or the pins. Progress shows in the small note at the bottom, and the button spins while it works. In a very narrow window, where Pinterest hides that menu, the button stays hidden (right-click still works).

## 2.21.1

- Analyzing: reels now appear at a steady pace (about one a second): the first group of 12 is shown while the next group is read, so it looks like one reel is checked every second.

## 2.21.0

- **Instagram profile: a fixed "Analyze reels" button at the top right.** One click opens the Reels Analyzer for that profile (only on profile pages).
- **Analyzing feels smoother:** reels now appear one by one instead of jumping 12 at a time (Instagram still sends them in groups of 12; they are spread over the wait until the next group).

## 2.20.0

- **No more button on top of Instagram / TikTok / Pinterest.** Instead, right-click: **Download this post** on a post, reel or pin (also on any link to one, e.g. a reel in a profile grid), **Open in Reels Analyzer** on Instagram, **Download the whole board** on a Pinterest board. A small note at the bottom shows the progress and disappears when done. The toolbar popup works as before.
- Fixed: after an update, a second (dead) copy of the old page button could appear.
- Reels Analyzer: the profile card shows the whole bio (it was cut off) and no longer repeats the follower count.
- Removed the "What to do" and "Top reels" blocks.

## 2.19.0

- **Reels Analyzer, verdicts first:** a new **What to do** block at the top turns the analysis into actions (best hours to post, reels per day, gap between posts, hits in the period, posting trend, long pauses). Click one to jump to the chart that proves it.
- **Top reels:** the 8 best reels of the period (success score) as a gallery with score and views; click one for details.
- New order: profile → time range → What to do → key numbers → top reels → posting activity → views distribution → the full reel list.
- The profile is no longer shown twice after an analysis.

## 2.18.3

- **The page panel no longer covers Instagram / TikTok / Pinterest:** it is now a small tab on the right edge of the window. Hover or click it to open the actions; drag it up or down to move it (the place is remembered). While downloading, the tab shows a progress ring; when done, a green or red dot.
- **Cleaner popup:** only the actions that fit the open page are shown (no greyed-out buttons), nothing runs off the side any more, and recent downloads show a platform icon, the status and "Open post".

## 2.18.2

- **Dark theme only**, the same on Windows and macOS.
- Primary buttons are easier to read (the white text keeps full contrast on the whole gradient).
- No text smaller than 12px any more; small buttons and links are easier to click.
- The Reels Analyzer uses clean line icons instead of emoji (they looked different on every computer).
- The panel on Instagram / TikTok / Pinterest pages now takes its colors from the same design tokens.

## 2.18.1

- **Retry works after a failed save:** if Chrome stopped a download (or you cancelled it in Chrome's list), Retry now downloads it again instead of saying "already downloaded".
- **Bulk downloads interrupted by closing Chrome** are marked as interrupted, and Retry downloads them again.
- A bulk download no longer needs twice the disk space while its ZIP is made.
- Windows: a file briefly locked by antivirus no longer breaks the save; it is cleaned up later.
- A file you just deleted from Downloads is recognised as gone right away.
- Leftover temporary files are now also cleaned up while the helper keeps running.

## 2.18.0

- **Downloads now go to your Downloads folder and show up in Chrome's download list**, like any other download (Windows and macOS alike). No more folders on the Desktop.
- **Several files at once come as one ZIP**: a carousel or slideshow, a Pinterest board, or reels picked in the Reels Analyzer. A single video or photo still comes as the file itself.
- Your earlier downloads on the Desktop (*Medias* / *MediaDownloader*) are left where they are and are still recognised as duplicates. If you delete a downloaded file, it can be downloaded again.
- **Open folder** and **Show file** now open the Downloads folder / the file through Chrome.
- How it works: the helper prepares the file, then hands it to Chrome over a one-time link that only this computer can open (127.0.0.1). Nothing leaves your computer.
- Needs the helper update: use **Update now** in the popup.

## 2.17.0

- **The download folder is now *Desktop → Medias*** (was *Desktop → MediaDownloader*). Your old folder is renamed automatically the first time the helper runs, so all earlier downloads stay where they are and duplicates are still recognised. Works the same on Windows and macOS.
- Needs the helper update: use **Update now** in the popup.

## 2.16.3

- **macOS: newer Python for the helper.** macOS ships Python 3.9, on which yt-dlp no longer updates, so Instagram/TikTok downloads would slowly break. The Mac installer now uses Python 3.10+ (and installs Python 3.12 with Homebrew when it is available), and moves an existing helper to it automatically.
- Already installed on a Mac with Python 3.9? Run **Update-Mac.command** once. Windows: nothing changes.

## 2.16.2

- **Removed:** *Current season* from *What to read*. The default is now *Last 60 days*; the seasons (active periods) are still found and shown on the *Time range* after analysing.

## 2.16.1

- **Seasons: one rule everywhere.** *Current season* (what is read) and the active periods on the *Time range* now use exactly the same rule, so they always agree. A pause ends a season only when it is at least 14 days **and** at least 10× the store's own posting rhythm in that season (so a weekly poster's 2 quiet weeks are not a "pause"), and a season needs at least 3 reels — 1–2 stray reels after a long silence join the season before them. Pinned reels no longer split periods.
- **Fixed:** the profile card could show the word "null" when a store has no category.
- Needs the helper update: use **Update now** in the popup.

## 2.16.0

- **See the store before analysing:** type or open a profile and a card shows followers, number of posts (reels are at most that many), category, bio and the link in bio — one quick request.
- **Choose what to read instead of guessing a number:** *Current season* (reads newest → oldest and stops at the first pause of 14+ days — for seasonal stores), *Last 30 / 60 / 90 / 180 days*, *Everything (up to 500)*, or *Newest 60 / 120 / 240*. Your choice is remembered. Old pinned reels outside the period are left out.
- The results card says which part was read (e.g. *Current season: since 12.10.2026*) and shows the bio, link and category.
- Extra data: **shares** (when Instagram gives them) in the reel details, and the profile + Instagram's image description in *Export data*.
- Needs the helper update: use **Update now** in the popup.

## 2.15.1

- **Updates show up right away:** the popup now checks for a new version every time you open it (it used to wait up to 30 minutes).

## 2.15.0

- **Best time, found per store and any width:** What works now finds the store's own best stretch of posting hours — from 1 to 12 hours wide, also across midnight (e.g. *21:00–04:00* or *03:00–11:00*). A narrow window has to be clearly better to win over a wide one with more reels behind it, so the window widens or narrows with the evidence. A second good window is shown when there is one.
- **New hours chart** (replaces *Posting hours*): bars = reels posted per hour (green / red = more / less success than usual), a blue success curve, and the best window as a green band of any width.
- **Ideal posts per day:** the fewest reels a day that already bring about 90 % of the best day (in expected hits per day), with a chart of the real days and the trend. "4+ / day" means it was still rising at the most they ever posted.
- The CSV button moved next to *What works*.

## 2.14.2

- **📷 screenshot:** the picture now ends where the page ends (no empty dark strip at the bottom).

## 2.14.1

- **Fixed: 📷 screenshot** came out as the top of the page repeated many times. It now works like DevTools' full-size capture: the page is laid out at full height for a moment and captured in one go (2× sharp), after Chrome's "started debugging" bar has appeared. The "Capturing…" text no longer shows up in the picture.

## 2.14.0

- **📷 Screenshot of the whole page** (camera button at the top of the Reels Analyzer): top to bottom in one image, at 2× sharpness (zoom in and it still looks like the real screen). Saved to *Downloads → MediaDownloader → Screenshots* and copied to the clipboard (paste with Ctrl+V). Chrome shows a short "started debugging" bar while it captures — that is normal.
- New permission: *debugger* (needed for the sharp full-page capture).

## 2.13.0

- **Removed:** the *Compare stores* page and its button in the Reels Analyzer.

## 2.12.0

- **What works** and **Posting hours** now use the brain: every time window, posts-per-day, posts-per-week and gap is judged by the **Success** of its reels (comments + like rate), not by views. *2×* = that group brings twice the success of the store's average reel. Reels younger than 3 days are left out (their comments are still coming).
- Posting hours tooltip shows how many 🎯 hits each hour had.
- The CSV export has *success_score* and *success_tier* columns.

## 2.11.0

- **The brain — Success score (0–100)** replaces *vs typical* in the Reels table. Learned from the reels you picked as successful in 4 stores: what sets them apart is **many comments** (with "Comment X" calls to action, every comment is a lead) and a **high like rate**, both compared with the store's own reels. Tested on stores it did not learn from, it puts your picks on top far better than views alone (23 of 28 vs 12 of 28).
  - 🎯 **Hit** = 80+ (gold), ✓ **Good** = 50+ (green). Hover the chip to see why (comments: top 2 % of the store · like rate: top 10 % …).
  - Filter it like any column: *✓ Good ≥ 50 · 🎯 Hit ≥ 80 · ≥ 90*.
  - Gold in the charts and on the time range now means a hit (not "viral by views").
  - *Export data* includes the score.

## 2.10.1

- **Reels table:** keeps room for about 10 rows, so the filter panel never gets squeezed at the bottom when only a few reels are left.
- **Starts with Views ≥ average** as the first filter. *Above avg / Top 25% / Top 10%* now follow the reels in front of them (date range, earlier filters).
- **Smart quick picks:** rates get round thresholds chosen from the data — e.g. *≥ 0.5% · 1.0% · 1.5% …* for engagement, *≥ 0.05% · 0.10% …* (or smaller) for comment rate; *vs typical* gets *≥ 1× 1.5× 2× 3× 5×*. Counts keep *Above avg / Top 25% / Top 10%*.
- **Finer sliders** for tiny rates (comment rate moves in 0.005 % steps when needed).
- **Fixed:** the *Export data* button could show its internal name instead of the label.

## 2.10.0

- **⬇ Export data** (Reels table toolbar, temporary research tool): saves the selected reels as one JSON file — every number (views, engagement, vs typical, viral / winner …), posting time and pace, and their details (description, audio, location, tagged accounts, duration; missing details are loaded first) — plus the numbers of every reel of the store for comparison.

## 2.9.1

- **Reels table:** fixed column widths. The number columns now share the space (no empty gap next to *Views*), and the columns no longer change width when you filter or values change.
- **Filter panel:** a quicker, springier opening (about a quarter second) and a fast close.

## 2.9.0

- **Reels table, rebuilt:** the table fits the page, no sideways scrolling and no cut-off links.
  - One **Reel** column: preview, date + time, and the description on one line (or *Open on Instagram ↗* when it isn't loaded yet). Click its header to sort by date.
  - Columns in two groups with a thin divider: *Views · vs typical · Views/day* | *Likes · Comments · Engagement · Like rate · Comment rate · ER vs exp.*
  - The *Average* row keeps *Average / Median* on the left and the number of reels, total views and the dates on the right, on one line each.
  - The *Download* column only appears once you download something from this page.
  - Slimmer toolbar (📁 folder field instead of a label); the colour legend moved under the table.

## 2.8.1

- **No empty spaces:** the top tiles, the posting tiles and the *What works* tiles stretch to fill their row. Short one-line subtitles everywhere.
- **Posting activity:** the views line uses a logarithmic scale (1K · 10K · 100K …), so one big week no longer flattens the rest.
- **Filter panel:** opens and closes like a water drop. The chart inside is a smooth curve (no empty columns). *Above avg* / *Top 25%* / *Top 10%* stay highlighted when you open the panel again; click again to clear. Click *High* / *Low* a second time to go back to the normal order.
- **Table:** the *Average* row no longer changes the width of the table when you filter.

## 2.8.0

- **Top numbers, cleaner:** two groups, *Views* and *Engagement*. *Typical range* now has a small bar (min – max, the middle 50 %, median, P90). *Engagement mix* shows likes : comments as a bar. Removed: Viral / Strong / Winner / High engagement / Top 10 % tiles and *How is this calculated?*.
- **Views distribution:** logarithmic by default. Bars of viral reels are gold, the typical range is a soft band, and the viral line shows how many there are (click it to list them in the table). The row of facts under the chart is gone.
- **Posting activity:** new tiles: posts per day (with per week / 30 d), last 30 days vs the 30 before, typical gap, longest pause, last post, active days, most in one day and 🔥 *Hot now* (views/day of the best new reel; click to open it). The interval and line switches sit right above the chart; the line shows total views by default. Viral reels show as a gold part of each bar.
- **What works:** new tiles and effect bars with a 0.5× · 1× · 2× scale; results around 1× are grey instead of red.
- **Posting hours:** clearer green / red / grey bars and one continuous outline for the best window.

## 2.7.0

- **Filters on the Reels table:** click a column header (Views, Engagement, Comment rate …) and a panel slides open with a slider, a small chart of the values and the average. Drag the two handles, or pick *Above avg* / *Top 25%* / *Top 10%*. *Data* = slider from the lowest to the highest reel, *Standard* = a fixed typical range.
- **Filters in order:** each filter gets a number (① ② ③) and only sees the reels the filters before it kept. The chain above the table shows how many are left after each step; drag a chip to change the order, × to remove it.
- **Sort** from the same panel (High / Low); without a choice the table is sorted by the first filter.
- The *Select: Viral / Winners / Hot …* buttons and the *Metric / Show* menus are gone. Clicking 🚀 viral or 🏆 winners in the facts still shows them, as the first filter.

## 2.6.0

- **One look everywhere:** the popup, the Reels Analyzer, Compare stores and the panel on Pinterest / TikTok / Instagram now share one design: the red → orange → gold colors of the loading screen.
- **Colors mean something:** gold = a hit (viral, winner), green = better than usual, red = worse, blue = links and averages. The purple and pink are gone.
- Buttons, progress bars and chart bars use the same flame gradient; winner chips are gold.

## 2.5.5

- **New loading screen** for *Analyze*: a big counter of reels found, the profile and follower count, the three steps (Connect → Read reels → Fill gaps) and a live strip where every reel found appears as a bar (taller = more views, gold = a hit).
- **Fixed:** the old loading bar started over from zero halfway through, stopped half-full when a profile had fewer reels than asked for, and showed nothing while connecting.

## 2.5.4

- **Posting hours** (Reels Analyzer): the weekday × hour grid is replaced by one bar per hour. Bar height = how many reels were posted in that hour, color and number on top = how well they did (green = better than usual, red = worse). The best 3-hour window is outlined.
- Weekdays are no longer analyzed: *Best day* is removed from *What works* and from **Compare stores** (the CSV still has a weekday column).

## 2.5.3

- **Reels Analyzer:** the bar with *Download selected*, *Copy links* and *Copy descriptions* no longer sticks to the bottom of the screen. It now sits in the Reels section, right under the *Select* buttons.

## 2.5.2

- **Fixed:** in the Reels Analyzer, clicking a row did nothing while some text was selected anywhere on the page. A click anywhere on a row selects it again; dragging across a caption to copy text still does not.

## 2.5.1

- **Fixed:** after an update, the popup kept showing "Updated to …" for a day and hid newer versions. A newer version is now always shown first with **Update now**.

## 2.5.0

- **What works** (Reels Analyzer, above *When do they post?*): best time window, weekday, posts per day, posts per week and gap between posts, each with how much better it does than usual and how sure that is (●●● clear · ●●○ likely · ●○○ too few reels). The best window is outlined on the heatmap.
- **📊 Compare stores**: a new page. Drop the CSV files of several stores (Excel or Standard format) and see what works across all of them. Every store counts equally; a result needs 8+ reels from 2+ stores. **Copy summary for AI** gives a short text to paste into any free AI chat.
- **Much less text:** the long lists of sentences are now short, clickable facts (🚀 viral, 🏆 winners, 🔥 hot …); explanations moved into tooltips; labels, legends and settings shortened.

## 2.4.7

- **Download CSV** next to *When do they post?*: one row per reel of the selected time range with posting date, weekday, hour (local and UTC), results, **vs typical / z-score / tier** (comparable between stores of different size) and posting frequency (posts that day, posts in the last 7 days, hours since the previous post). Built for combining several stores' files to find the best posting hours and the best number of posts per day / week. Two formats: **Excel (;)** (decimal comma, opens correctly in Excel with Azerbaijani / Russian / Turkish settings) and **Standard (,)** (Google Sheets, Python).

## 2.4.6

- **Fixed: Copy descriptions** loaded nothing when the helper on the computer was older than the extension. It now falls back to loading descriptions one by one, and the popup / analyzer show **"Helper outdated"** with an **Update helper** button.
- The reels table shows **Above average** by default (instead of Strong or viral).
- Clicking the preview of the reel that is already open closes the details panel.

## 2.4.5

- **Copy descriptions is much faster:** missing descriptions are now loaded in one go with a 1–2 second pause between Instagram requests (it used to wait 6–12 seconds per reel plus an extra pause). 4 reels take a few seconds instead of half a minute. It still stops at the first rate-limit answer from Instagram, and loaded descriptions are remembered.

## 2.4.4

- **Reels table:** clicking a row now ticks / unticks it (Shift+click selects a whole range). The details panel opens from the reel's **preview image** ("Details" appears on hover).

## 2.4.3

- **Reel details panel** no longer squeezes the page: it floats over the content as a card, stays above the bottom bar, and can be resized by dragging its left edge (double-click resets the width). Click outside to close; the selected row scrolls into view when moving with the arrow keys.

## 2.4.2

- **When do they post?** The hours now run from 12:00 to 11:00 with midnight in the middle, so night-time posting shows as one block instead of being split over both edges.

## 2.4.1

- **Copy descriptions:** select reels in the Reels Analyzer and copy all their descriptions with one button (header with rank, views, date and link for each). Descriptions not loaded yet are fetched one at a time to stay under Instagram's limit; the result can also be saved as a .txt file.
- The popup now looks for updates every 30 minutes while you use it.

## 2.4.0

**New**
- **Reels Analyzer, rebuilt:**
  - *Viral / Strong / Winner* now use statistics (robust z-score on log views, compared with the reels posted around the same time) instead of fixed "3× median" rules. A *Winner* has strong reach **and** more engagement than that reach normally gets.
  - **Time range** slider with an activity curve, detected pauses and active periods; everything is recalculated for the selected period.
  - **Posting activity**: posts per 1 / 3 / 7 / 30 days, gaps, longest pause, median or total views per interval.
  - **When do they post?** heatmap, with a *Performance* mode (which hours/weekdays do best).
  - Like rate, comment rate, likes/comments split, **ER vs expected**, views per day, **RISING** marker for new reels that are already strong.
  - Average / median row over the reels shown; filter by any metric (above average or a custom value).
  - Click a reel for its **full description** (calls to action, prices, hashtags), music, location and quick actions.
- **Cancel** buttons for downloads (one or all).
- Downloaded file names end with the view count, e.g. `…_3.1M-views.mp4`.
- **macOS installer** (`Install-Mac.command`), update and uninstall scripts for Windows and Mac.
- **One-click updates** from the extension popup.
- The app is in English.

**Fixed**
- Downloads could hang at "Downloading" on Windows (child processes inherited the helper's input pipe).
- Instagram post dates were missing (they are now read from the post code).
- Rate-limit waits are shown ("Instagram rate limit · retrying at 11:52") instead of looking frozen.
- Temporary download folders no longer land in the (OneDrive-synced) Desktop folder.

## 2.3.3
- First version.
