# Changelog

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
