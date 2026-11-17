# Changelog

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
