/* Statistics + histogram binning for the Reels Analyzer. Pure functions (also run under Node for tests). */
(function (root) {
  "use strict";
  const PD = (root.PD = root.PD || {});

  function quantile(sorted, q) {
    if (!sorted.length) return NaN;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  /** Summary statistics of view counts (null / missing values are ignored). */
  function summarize(values) {
    const v = values.filter((x) => typeof x === "number" && isFinite(x)).sort((a, b) => a - b);
    const n = v.length;
    if (!n) return { n: 0 };
    const sum = v.reduce((a, b) => a + b, 0);
    const mean = sum / n;
    const variance = n > 1 ? v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
    const median = quantile(v, 0.5);
    const p25 = quantile(v, 0.25);
    const p75 = quantile(v, 0.75);
    const p90 = quantile(v, 0.9);
    const p95 = quantile(v, 0.95);
    const iqr = p75 - p25;
    const topK = Math.max(1, Math.ceil(n * 0.1));
    const topSum = v.slice(n - topK).reduce((a, b) => a + b, 0);
    const outlierFence = p75 + 1.5 * iqr; // Tukey fence
    return {
      n, sum, mean, median, p25, p75, p90, p95, iqr,
      min: v[0], max: v[n - 1], stdev: Math.sqrt(variance),
      cv: mean ? Math.sqrt(variance) / mean : 0, // coefficient of variation (spread relative to mean)
      top10Share: sum ? topSum / sum : 0,
      top10Count: topK,
      outlierFence,
      outlierCount: v.filter((x) => x > outlierFence).length,
      skewed: mean > median * 1.5,
    };
  }

  /** "Nice" step (1, 2, 2.5, 5 x 10^k) so that `range` splits into about `target` bins. */
  function niceStep(range, target) {
    if (!(range > 0)) return 1;
    const raw = range / (target || 12);
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / pow;
    const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return Math.max(1, nice * pow);
  }

  /**
   * Linear histogram. The interval width adapts to the profile's own min/max
   * (e.g. 5K, 10K, 50K, 100K ...). With `groupOutliers`, values above P95 go
   * into one last "≥ X" bar so a few viral hits don't squash the rest.
   */
  function linearBins(values, stats, groupOutliers) {
    const v = values.filter((x) => typeof x === "number" && isFinite(x));
    if (!v.length) return [];
    let hi = stats.max;
    const lo = stats.min;
    let overflow = false;
    if (groupOutliers && v.length >= 8 && stats.max > stats.p95 * 1.5 && stats.p95 > lo) {
      hi = stats.p95;
      overflow = true;
    }
    let step = niceStep(hi - lo || hi || 1, 16);
    let start = Math.floor(lo / step) * step;
    let end = Math.ceil((hi + (overflow ? 0 : 1)) / step) * step;
    if (end <= start) end = start + step;
    while ((end - start) / step > 30) {
      step = niceStep(end - start, 16) * 2;
      start = Math.floor(lo / step) * step;
      end = Math.ceil((hi + 1) / step) * step;
    }
    const bins = [];
    for (let x = start; x < end - 1e-9; x += step) bins.push({ from: x, to: x + step, count: 0, items: [] });
    if (overflow) bins.push({ from: end, to: Infinity, count: 0, items: [], overflow: true });
    for (const x of v) {
      let i = x >= end ? (overflow ? bins.length - 1 : bins.length - 1) : Math.floor((x - start) / step);
      i = Math.max(0, Math.min(bins.length - 1, i));
      bins[i].count++;
    }
    bins.step = step;
    return bins;
  }

  /** Logarithmic histogram with 1-2-5 edges (100, 200, 500, 1K, 2K, 5K ...). */
  function logBins(values) {
    const v = values.filter((x) => typeof x === "number" && isFinite(x));
    if (!v.length) return [];
    const min = Math.max(1, Math.min(...v));
    const max = Math.max(...v);
    const edges = [];
    let p = Math.pow(10, Math.floor(Math.log10(min)));
    const mult = [1, 2, 5];
    outer: for (;;) {
      for (const m of mult) {
        const e = m * p;
        if (e > min && !edges.length) {
          edges.push(mult[(mult.indexOf(m) + 2) % 3] * (m === 1 ? p / 10 : p)); // edge just below min
        }
        if (edges.length) edges.push(e);
        if (e > max) break outer;
      }
      p *= 10;
    }
    const clean = Array.from(new Set(edges.filter((e) => e > 0))).sort((a, b) => a - b);
    while (clean.length > 2 && clean[1] <= min) clean.shift();
    const bins = [];
    for (let i = 0; i < clean.length - 1; i++) bins.push({ from: clean[i], to: clean[i + 1], count: 0, items: [] });
    for (const x of v) {
      const xx = Math.max(x, 1);
      let i = bins.findIndex((b) => xx >= b.from && xx < b.to);
      if (i < 0) i = xx < bins[0].from ? 0 : bins.length - 1;
      bins[i].count++;
    }
    bins.log = true;
    return bins;
  }

  /** Densest consecutive run of bins that holds >= `share` of all items (for the insight text). */
  function densestRange(bins, share) {
    const total = bins.reduce((a, b) => a + b.count, 0);
    if (!total) return null;
    let best = null;
    for (let i = 0; i < bins.length; i++) {
      let c = 0;
      for (let j = i; j < bins.length; j++) {
        c += bins[j].count;
        if (c / total >= share) {
          if (!best || j - i < best.j - best.i) best = { i, j, count: c };
          break;
        }
      }
    }
    return best ? { from: bins[best.i].from, to: bins[best.j].to, count: best.count, share: best.count / total } : null;
  }

  const compactFmt = typeof Intl !== "undefined" ? new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }) : null;
  function compact(n) {
    if (n === Infinity) return "∞";
    if (typeof n !== "number" || !isFinite(n)) return "–";
    return compactFmt ? compactFmt.format(n) : String(Math.round(n));
  }

  // ---------------------------------------------------------------- posting activity
  const DAY = 86400000;
  const HOUR = 3600000;

  /** Local midnight of a timestamp. */
  function dayStart(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  /** Local midnight `n` calendar days after `ts` (DST safe). */
  function addDays(ts, n) {
    const d = new Date(ts);
    d.setDate(d.getDate() + n);
    return d.getTime();
  }
  /** Monday = 0 ... Sunday = 6 (local time). */
  function weekdayMon(ts) {
    return (new Date(ts).getDay() + 6) % 7;
  }

  /**
   * Time buckets of `days` calendar days from the oldest post's day to today.
   * `items` holds the indices (into `timestamps`) of the posts in each bucket.
   */
  function activityBins(timestamps, days, now) {
    const ts = timestamps.map((x, i) => [x, i]).filter(([x]) => x > 0);
    if (!ts.length) return [];
    now = now || Date.now();
    days = Math.max(1, days | 0);
    const first = dayStart(Math.min(...ts.map(([x]) => x)));
    const end = addDays(dayStart(Math.max(now, ...ts.map(([x]) => x))), 1);
    const bins = [];
    for (let from = first; from < end; ) {
      const to = addDays(from, days);
      bins.push({ from, to, count: 0, items: [] });
      from = to;
      if (bins.length > 5000) break; // safety: a 1-day interval over many years
    }
    for (const [x, i] of ts) {
      let lo = 0;
      let hi = bins.length - 1;
      while (lo < hi) { // binary search: last bin with from <= x
        const mid = (lo + hi + 1) >> 1;
        if (bins[mid].from <= x) lo = mid;
        else hi = mid - 1;
      }
      bins[lo].count++;
      bins[lo].items.push(i);
    }
    bins.days = days;
    return bins;
  }

  /** Interval (1, 3, 7 or 30 days) that gives a readable number of bars for this span. */
  function autoInterval(spanDays) {
    if (spanDays <= 45) return 1;
    if (spanDays <= 150) return 3;
    if (spanDays <= 600) return 7;
    return 30;
  }

  /**
   * Posting frequency statistics from post timestamps (ms). Times of day and weekdays
   * are in the viewer's local time zone.
   */
  function postingStats(timestamps, now) {
    const t = timestamps.filter((x) => x > 0).sort((a, b) => a - b);
    const n = t.length;
    if (!n) return { n: 0 };
    now = now || Date.now();
    const first = t[0];
    const last = t[n - 1];
    // span counted in whole calendar days, from the first post's day through today
    const spanDays = Math.max(1, Math.round((addDays(dayStart(Math.max(now, last)), 1) - dayStart(first)) / DAY));
    const perDay = n / spanDays;
    const gaps = [];
    let maxGap = null;
    for (let i = 1; i < n; i++) {
      const g = (t[i] - t[i - 1]) / HOUR;
      gaps.push(g);
      if (!maxGap || g > maxGap.hours) maxGap = { hours: g, from: t[i - 1], to: t[i] };
    }
    const sortedGaps = gaps.slice().sort((a, b) => a - b);
    const meanGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;
    const sdGap = gaps.length > 1 ? Math.sqrt(gaps.reduce((a, b) => a + (b - meanGap) ** 2, 0) / (gaps.length - 1)) : 0;
    const activeDays = new Set(t.map(dayStart)).size;
    const perDayCounts = new Map();
    for (const x of t) perDayCounts.set(dayStart(x), (perDayCounts.get(dayStart(x)) || 0) + 1);
    const weekday = new Array(7).fill(0);
    const hour = new Array(24).fill(0);
    const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const x of t) {
      const w = weekdayMon(x);
      const h = new Date(x).getHours();
      weekday[w]++;
      hour[h]++;
      grid[w][h]++;
    }
    const argmax = (a) => a.reduce((best, v, i) => (v > a[best] ? i : best), 0);
    const last30 = t.filter((x) => x > now - 30 * DAY).length;
    const prev30 = t.filter((x) => x > now - 60 * DAY && x <= now - 30 * DAY).length;
    return {
      n, first, last, spanDays,
      perDay, per3: perDay * 3, per7: perDay * 7, per30: perDay * 30,
      meanGap, medianGap: sortedGaps.length ? quantile(sortedGaps, 0.5) : null, maxGap,
      gapCv: meanGap ? sdGap / meanGap : 0,
      sinceLastDays: (now - last) / DAY,
      activeDays, activeShare: activeDays / spanDays,
      maxPerDay: Math.max(...perDayCounts.values()),
      weekday, hour, grid,
      topWeekday: argmax(weekday), topHour: argmax(hour),
      last30, prev30,
      // the last 60 days are only comparable when the data reaches back that far
      trendComparable: first <= now - 60 * DAY,
    };
  }

  // ---------------------------------------------------------------- performance model
  /*
   * Why not "3x median" or "2x average"?
   * Views on social video are heavy-tailed (roughly log-normal: Szabo & Huberman 2010).
   * A fixed multiplier then means something different on every profile: on a steady
   * account 3x median is ~0.3% of reels, on a volatile one ~20%. The mean is pulled up by
   * the hits themselves, so "above average" is just "the top ~30%".
   *
   * Method used here:
   *  1. Work on log(views): multiplicative differences become additive and the
   *     distribution becomes roughly normal.
   *  2. Baseline = median log-views of the ~30 reels posted closest in time (excluding
   *     the reel itself), so a growing or shrinking account is compared with its own
   *     level at that moment, not with its whole history.
   *  3. Spread = MAD of the residuals x 1.4826 (robust standard deviation: the hits do
   *     not inflate it; Leys et al. 2013, Iglewicz & Hoaglin 1993).
   *  4. z = residual / spread. Viral: z >= 2 (about the top 2.3%), Strong: z >= 1
   *     (about the top 16%), Weak: z <= -1. The same meaning on every profile.
   *     Floors (viral >= 3x, strong >= 1.5x the baseline) keep very steady accounts
   *     from calling a small bump "viral".
   *  5. Reels younger than 3 days are still collecting views: they are left out of the
   *     baselines and never called "weak".
   *
   * Checked on real profiles (82 and 140 reels): the log-views are right-skewed (+0.6 and
   * +1.3), so z >= 2 catches 7-9% of reels instead of the ~2% a log-normal body alone
   * would give. That excess is the genuine viral tail, which is reported as such.
   *
   * Engagement is NOT independent of reach: on the same profiles log(likes + comments)
   * grows with log(views) with slope 1.2-1.4 (Spearman ER vs views +0.5 to +0.65), because
   * the algorithm pushes reels people react to. Raw ER therefore mostly repeats the
   * views signal. Engagement is judged against what is expected *for that reach*:
   *   log(eng + 1) = a + b * log(views + 1)   (Theil-Sen: robust to the hits)
   * and the residual is scored with the same robust z. On real data this removes ~40%
   * of the ER spread (0.91 -> 0.54 and 0.75 -> 0.48). Comments get their own fit
   * (slope ~0.8: the comment rate falls as reach grows).
   */
  const MAD_K = 1.4826;
  const NEW_AGE_DAYS = 3;
  const NEIGHBOURS = 30;

  function median(arr) {
    if (!arr.length) return NaN;
    return quantile(arr.slice().sort((a, b) => a - b), 0.5);
  }
  function robust(values, floor) {
    const m = median(values);
    const s = MAD_K * median(values.map((x) => Math.abs(x - m)));
    return { m, s: Math.max(s || 0, floor) };
  }

  /**
   * Theil-Sen line y = a + b * x over items with x = item.L (log views): the slope is the
   * median of all pairwise slopes, so a few viral hits cannot tilt it. Returns the line
   * plus the robust centre/spread of its residuals.
   */
  function reachFit(items, yOf) {
    const xs = items.map((x) => x.L);
    const ys = items.map(yOf);
    const slopes = [];
    for (let i = 0; i < xs.length; i++) {
      for (let j = i + 1; j < xs.length; j++) {
        const dx = xs[j] - xs[i];
        if (Math.abs(dx) > 1e-9) slopes.push((ys[j] - ys[i]) / dx);
      }
    }
    let b = slopes.length ? median(slopes) : 0;
    b = Math.max(0, Math.min(2, b)); // keep it physical if the data is degenerate
    const a = median(ys.map((y, i) => y - b * xs[i]));
    const sp = robust(ys.map((y, i) => y - (a + b * xs[i])), 0.05);
    return { a, b, m: sp.m, s: sp.s };
  }

  /**
   * Post time from an Instagram shortcode. The shortcode is the media ID in base64
   * ("A-Za-z0-9-_"); the top 41 bits of the ID are milliseconds since Instagram's
   * epoch (2011-08-24). Used when the API returns no `taken_at`.
   */
  const IG_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  function codeTime(code) {
    if (typeof BigInt === "undefined" || !code) return 0;
    let n = BigInt(0);
    for (const ch of String(code).slice(0, 11)) {
      const d = IG_ALPHABET.indexOf(ch);
      if (d < 0) return 0;
      n = n * BigInt(64) + BigInt(d);
    }
    const ms = Number(n >> BigInt(23)) + 1314220021721;
    // sanity: between Instagram's launch and a day in the future
    return ms > 1286000000000 && ms < Date.now() + DAY ? ms : 0;
  }

  /**
   * rows: [{views, likes, comments, ts}] in any order. Returns {items, ...summary};
   * items[i] belongs to rows[i] (null when the reel has no view count).
   */
  function performance(rows, now) {
    now = now || Date.now();
    const items = rows.map(() => null);
    const valid = [];
    rows.forEach((r, i) => {
      if (typeof r.views === "number" && isFinite(r.views) && r.views >= 0) {
        const isNew = r.ts > 0 && now - r.ts < NEW_AGE_DAYS * DAY;
        valid.push({ i, L: Math.log(r.views + 1), ts: r.ts || 0, isNew });
      }
    });
    const res = { items, n: valid.length, enough: false };
    if (valid.length < 8) return res;
    res.enough = true;

    // --- reach: rolling baseline from mature reels close in time
    let mature = valid.filter((x) => !x.isNew);
    if (mature.length < 8) mature = valid;
    const local = mature.length >= 20;
    const globalMed = median(mature.map((x) => x.L));
    for (const x of valid) {
      let base = globalMed;
      if (local) {
        const near = mature
          .filter((y) => y !== x)
          .map((y) => [Math.abs(y.ts - x.ts), y.L])
          .sort((a, b) => a[0] - b[0])
          .slice(0, NEIGHBOURS)
          .map((p) => p[1]);
        base = median(near);
      }
      x.base = base;
      x.resid = x.L - base;
    }
    const sp = robust(mature.map((x) => x.resid), 0.15);
    const sigma = sp.s;
    const viralMult = Math.max(3, Math.exp(2 * sigma));
    const strongMult = Math.max(1.5, Math.exp(sigma));
    res.sigma = sigma;
    res.viralMult = viralMult;
    res.strongMult = strongMult;
    res.local = local;
    res.typicalViews = Math.exp(globalMed) - 1;

    // --- engagement + comments relative to what is expected for the reel's reach
    const eng = valid.filter((x) => rows[x.i].views > 0 && typeof rows[x.i].likes === "number");
    let erFit = null;
    let crFit = null;
    if (eng.length >= 8) {
      const R = (x) => rows[x.i];
      const engOf = (x) => R(x).likes + (R(x).comments || 0);
      erFit = reachFit(eng, (x) => Math.log(engOf(x) + 1));
      crFit = reachFit(eng, (x) => Math.log((R(x).comments || 0) + 1));
      for (const x of eng) {
        x.erResid = Math.log(engOf(x) + 1) - (erFit.a + erFit.b * x.L);
        x.crResid = Math.log((R(x).comments || 0) + 1) - (crFit.a + crFit.b * x.L);
        x.erExpected = Math.max(0, Math.exp(erFit.a + erFit.b * x.L) - 1) / R(x).views;
      }
      res.erSlope = erFit.b;
      res.crSlope = crFit.b;
      res.er0 = median(eng.map((x) => engOf(x) / R(x).views));
    }

    let nViral = 0;
    let nStrong = 0;
    let nWeak = 0;
    let nHighEr = 0;
    let nTalk = 0;
    let nWinner = 0;
    let viralViews = 0;
    let totalViews = 0;
    for (const x of valid) {
      const r = rows[x.i];
      const ratio = Math.exp(x.resid); // views vs. the baseline, e.g. 4.2 = 4.2x typical
      const z = x.resid / sigma;
      let tier = "normal";
      if (ratio >= viralMult) tier = "viral";
      else if (ratio >= strongMult) tier = "strong";
      else if (z <= -1 && !x.isNew) tier = "weak";
      const erZ = erFit && x.erResid != null ? (x.erResid - erFit.m) / erFit.s : null;
      const crZ = crFit && x.crResid != null ? (x.crResid - crFit.m) / crFit.s : null;
      const engCount = (r.likes || 0) + (r.comments || 0);
      // tiny counts make the residual noise: require some evidence before flagging
      const highEr = erZ != null && erZ >= 2 && engCount >= 20;
      const talk = crZ != null && crZ >= 2 && (r.comments || 0) >= 5;
      // reach AND engagement above what that reach normally brings: watched and reacted to
      const winner = (tier === "viral" || tier === "strong") && erZ != null && erZ >= 1;
      // still collecting views and already above the strong line: its final number will only be higher
      const rising = x.isNew && ratio >= strongMult;
      items[x.i] = {
        baseline: Math.exp(x.base) - 1, ratio, z, tier, isNew: x.isNew, rising,
        ageHours: r.ts > 0 ? (now - r.ts) / HOUR : null,
        erExpected: x.erExpected ?? null,
        erVsExpected: x.erResid != null ? Math.exp(x.erResid) : null, // 1.5 = 50% more engagement than expected
        erZ, crZ, highEr, talk, winner,
      };
      totalViews += r.views;
      if (tier === "viral") { nViral++; viralViews += r.views; }
      if (tier === "strong") nStrong++;
      if (tier === "weak") nWeak++;
      if (highEr) nHighEr++;
      if (talk) nTalk++;
      if (winner) nWinner++;
    }
    Object.assign(res, {
      nViral, nStrong, nWeak, nHighEr, nTalk, nWinner,
      nRising: valid.filter((x) => items[x.i].rising).length,
      viralShare: totalViews ? viralViews / totalViews : 0,
      viralRate: valid.length ? nViral / valid.length : 0, // ~2% would be chance alone
      // viral reels with clearly weaker engagement than usual: watched, but not acted on
      nViralLowEr: valid.filter((x) => items[x.i].tier === "viral" && items[x.i].erZ != null && items[x.i].erZ <= -1).length,
    });
    return res;
  }

  /**
   * Split a posting history into active periods separated by pauses.
   * Gaps are judged relative to the profile's usual (median) gap between posts:
   *   pause: >= 14 days AND >= 10x the usual gap -> splits the history into periods
   *   lull:  >=  5 days AND >=  5x the usual gap -> slowdown, shown but not split
   * So 6 silent days are a lull for a store posting 4 times a day, normal for a weekly one.
   */
  function activePeriods(timestamps, opts) {
    opts = opts || {};
    const minDays = opts.minDays || 14;
    const factor = opts.factor || 10;
    const lullDays = opts.lullDays || 5;
    const lullFactor = opts.lullFactor || 5;
    const t = timestamps.filter((x) => x > 0).sort((a, b) => a - b);
    if (!t.length) return { periods: [], pauses: [], pauseHours: null };
    const gaps = [];
    for (let i = 1; i < t.length; i++) gaps.push((t[i] - t[i - 1]) / HOUR);
    const medGap = gaps.length ? median(gaps) : 0;
    const pauseHours = Math.max(minDays * 24, factor * medGap);
    const lullHours = Math.min(pauseHours, Math.max(lullDays * 24, lullFactor * medGap));
    const periods = [];
    const pauses = [];
    const lulls = [];
    let start = 0;
    for (let i = 1; i <= t.length; i++) {
      const gapH = i < t.length ? (t[i] - t[i - 1]) / HOUR : 0;
      if (i < t.length && gapH >= lullHours && gapH < pauseHours) {
        lulls.push({ from: t[i - 1], to: t[i], days: gapH / 24 });
      }
      if (i === t.length || gapH >= pauseHours) {
        periods.push({ from: t[start], to: t[i - 1], n: i - start });
        if (i < t.length) pauses.push({ from: t[i - 1], to: t[i], days: gapH / 24 });
        start = i;
      }
    }
    return { periods, pauses, lulls, pauseHours, lullHours, medianGapHours: medGap };
  }

  // ---------------------------------------------------------------- "what works" (timing / pace)
  /*
   * Effect of a grouping (time window, weekday, posts per day ...) on performance.
   * Input items: {group, ratio, store}, where ratio = views / typical views of that store at that
   * time ("vs typical"), so stores of different size are comparable.
   * Per group: median log-ratio per store, then the median over stores -> every store weighs the
   * same, a big store cannot drown the others. An 80% interval comes from a (hierarchical)
   * bootstrap: resample stores, then reels inside each store.
   */
  function seeded(seed) {
    let s = seed >>> 0 || 1;
    return () => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return (s >>> 0) / 4294967296;
    };
  }

  function groupEffect(items, opts) {
    opts = opts || {};
    const minN = opts.minN || 5;
    // across several stores a pattern must show up in at least minStores of them
    const minStores = opts.minStores || 1;
    const iters = opts.iters || 400;
    const byGroup = new Map();
    for (const it of items) {
      if (!(it.ratio > 0) || it.group == null) continue;
      if (!byGroup.has(it.group)) byGroup.set(it.group, new Map());
      const g = byGroup.get(it.group);
      const k = it.store || "";
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(Math.log(it.ratio));
    }
    const rnd = seeded(12345);
    const est = (lists) => median(lists.map((l) => median(l)));
    const out = [];
    for (const [group, stores] of byGroup) {
      const lists = [...stores.values()];
      const n = lists.reduce((a, l) => a + l.length, 0);
      const value = est(lists);
      let lo = null;
      let hi = null;
      const enough = n >= minN && lists.length >= minStores;
      if (enough) {
        const sims = [];
        for (let k = 0; k < iters; k++) {
          const pick = lists.length > 1 ? lists.map(() => lists[Math.floor(rnd() * lists.length)]) : lists;
          sims.push(est(pick.map((l) => l.map(() => l[Math.floor(rnd() * l.length)]))));
        }
        sims.sort((a, b) => a - b);
        lo = Math.exp(quantile(sims, 0.1));
        hi = Math.exp(quantile(sims, 0.9));
      }
      out.push({ group, n, stores: lists.length, ratio: Math.exp(value), lo, hi, enough });
    }
    return out;
  }

  /** "clear" = interval entirely above (or below) 1x, "likely" = enough reels, "few" = too few. */
  function effectConfidence(e) {
    if (!e.enough) return "few";
    if (e.lo > 1 || e.hi < 1) return "clear";
    return "likely";
  }

  /** Best group: highest LOWER bound among groups with enough reels (a sure 1.6x beats a lucky 3x). */
  function bestEffect(effects) {
    const ok = effects.filter((e) => e.enough);
    if (!ok.length) return null;
    return ok.reduce((b, e) => (e.lo > b.lo || (e.lo === b.lo && e.ratio > b.ratio) ? e : b));
  }
  function worstEffect(effects) {
    const ok = effects.filter((e) => e.enough);
    if (ok.length < 2) return null;
    return ok.reduce((b, e) => (e.hi < b.hi ? e : b));
  }

  // groupings shared by the analyzer and the "Compare stores" page
  const BUCKETS = {
    window: { order: [0, 3, 6, 9, 12, 15, 18, 21], of: (hour) => Math.floor(hour / 3) * 3 },
    weekday: { order: [0, 1, 2, 3, 4, 5, 6], of: (w) => w },
    perDay: { order: ["1", "2", "3", "4+"], of: (n) => (n >= 4 ? "4+" : String(Math.max(1, n))) },
    perWeek: { order: ["1–3", "4–7", "8–14", "15+"], of: (n) => (n <= 3 ? "1–3" : n <= 7 ? "4–7" : n <= 14 ? "8–14" : "15+") },
    gap: {
      order: ["< 3 h", "3–12 h", "12–24 h", "1–3 d", "3 d +"],
      of: (h) => (h == null ? null : h < 3 ? "< 3 h" : h < 12 ? "3–12 h" : h < 24 ? "12–24 h" : h < 72 ? "1–3 d" : "3 d +"),
    },
  };

  PD.stats = {
    quantile, summarize, niceStep, linearBins, logBins, densestRange, compact,
    DAY, HOUR, dayStart, addDays, weekdayMon, activityBins, autoInterval, postingStats, performance, codeTime, activePeriods,
    groupEffect, effectConfidence, bestEffect, worstEffect, BUCKETS,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
