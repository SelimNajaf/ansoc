# Design system

Every page of the extension (popup, Reels Analyzer, the on-page panel) follows these rules.
The values live in **`extension/ui/tokens.css`**; every page links it before its own stylesheet.

## 1. Principles

1. **Color = meaning.** A color is only used when it says something. Everything else is neutral gray.
2. **Show, don't tell.** A bar, a chip, a color or an icon instead of a sentence. Explanations go in tooltips (`title`).
3. **Short English text.** Labels of 1–3 words. No sentences in the UI unless it is an error.
4. **One look everywhere.** A new screen reuses the tokens and components below; it never invents a color, radius or font size.
5. **Light and dark.** Every token has a dark value; never hard-code a color that only works on white.

## 2. Colors

| Token | Light | Use for |
|---|---|---|
| `--brand-grad` (`--brand-1 → --brand-2 → --brand-3`) | red `#e60023` → orange `#ff6a3d` → amber `#f59e0b` | the logo, primary buttons, progress bars, big counters |
| `--brand-grad-up` | red → orange, bottom to top | plain data bars (one reel, one bin, one period) |
| `--brand` | `#f0412f` | solid stand-in for the gradient: focus rings, outlines, selected item |
| `--data`, `--data-hover`, `--data-dim` | coral | lines, selection tints, hover, faded bars |
| `--hit`, `--hit-grad`, `--hit-glow` | gold | **a hit**: viral, winner, best reel. Gold is reserved for this (SVG: `fill: url(#gHit)`) |
| `--good` | green | better than usual, success, "best window" |
| `--bad` | rose | worse than usual, errors, cancel |
| `--warn` | dark amber | needs attention (cached data, duplicate, paid) |
| `--info` | blue | links, hashtags, averages, comments, secondary lines |
| `--neutral` | gray | a bar with no verdict |
| `--bg`, `--surface`, `--soft`, `--line`, `--fg`, `--muted` | grays | page, cards, chips/tracks, borders, text, secondary text |
| `--on-color`, `--on-hit` | white, dark brown | text on a colored fill / on gold |

**Mixing:** tints are made with `color-mix(in srgb, var(--token) 12–16%, transparent)` for chip backgrounds,
not with new colors. Platform colors (`--pinterest`, `--instagram`, `--tiktok`) are for platform chips only.

Chart bars in SVG use the shared gradient: put the `<svg class="defs">` block with `<linearGradient id="gData">`
in the page (see `analyzer.html`) and style the bar with `fill: url(#gData) var(--data)`.

## 3. Type

System font (`--font`), numbers with `font-variant-numeric: tabular-nums`.

| Token | Size | Use |
|---|---|---|
| `--fs-xs` | 11px | tooltips, chart axes, tiny chips |
| `--fs-s` | 12px | labels, chips, secondary text |
| `--fs-m` | 13px | body text, buttons |
| `--fs-l` | 15px | section titles |
| `--fs-xl` | 18px | page title |
| `--fs-hero` | 40px | one big number per screen (e.g. reels found), filled with `--brand-grad` |

Weights: 400 text, 600 buttons/labels, 700–800 numbers and titles.

## 4. Shape and depth

- Radius: `--r-xs` 4 (bars), `--r-s` 6 (small chips), `--r-m` 10 (inputs, cells), `--r-l` 14 (cards), `--r-pill` (buttons, chips, badges).
- Shadow: `--sh-1` (pressed segment), `--sh-2` (floating panel), `--sh-3` (drawer / dialog). Cards have a 1px `--line` border, no shadow.
- Spacing: multiples of 4px — 4, 6, 8, 10, 12, 14, 16, 24.

## 5. Components (in `tokens.css`)

| Component | Markup |
|---|---|
| Primary button | `<button class="primary">` — brand gradient, white text. One per area. |
| Secondary button | `<button>` — `--soft` pill |
| Danger button | `<button class="danger">` — rose outline |
| Link button | `<button class="link">` |
| Status badge | `<span class="badge ok|bad|warn">` |
| Progress bar | `<div class="bar"><div class="fill">` (`.fill.indet` = unknown length) |
| Job status | `<span class="st success|failed|duplicate|cancelled">` |
| Logo | `<span class="logo">↓</span>` — gradient circle, size set by the page |

Page-level components (in `analyzer.css`): `.card`, `.kpi` tiles (`.kgroup` for a titled group, `.kpi.hero` with the brand accent, `.kpi-row`), `.chart-bar` (a chart's own switches, right above it), `.fact` chips, `.sig` signal chips,
`.fx-tile` / `.fx-bar` result tiles and effect bars, `.seg` segmented switch, the loader (`.ld-*`),
the filter panel (`.fpop`: opens with `--ease-io`, slider thumbs `.fp-thumb`, numbered steps `.fc-chip` / `.fh-i` in the brand gradient).

## 6. Motion

- `--t-fast` .15s for hover, `--t` .25s for state changes, `--ease` for slides, `--ease-pop` for bars that grow,
  `--ease-io` (ease-in-out) for panels that open and close.
- Loops only while something is happening (loading, a rising reel). `prefers-reduced-motion` turns animations off globally.

## 7. Checklist for a new screen or feature

- [ ] Links `../ui/tokens.css` first.
- [ ] No hex / rgb colors in the page stylesheet or in JS — only `var(--token)` (shadows from `--sh-*`).
- [ ] Gold only for hits, green/rose only for better/worse.
- [ ] Looks right in light **and** dark mode.
- [ ] Text is short English; the rest is in a tooltip.
- [ ] The on-page panel (`content/content.js`, shadow DOM) cannot load `tokens.css`: it mirrors the few values it needs at the top of its CSS — keep them in sync.
