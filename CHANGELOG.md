# Changelog

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
