"""Phase 5 test: do reel length and audio (original vs music) go with Success?

Input: Export data files (Reels Analyzer -> select reels -> Export data) saved in research/audio/
(a sub-folder, so the brain scripts that read research/*.json never see these samples).
Only the selected reels carry details (audio, exact length); pick a mix of strong and weak reels.

Success is already judged within each store (0-100), so stores can be pooled.
Significance: permutation tests (no SciPy needed). Run:  py -3 tools/audio_length_test.py
"""
from __future__ import annotations

import glob
import json
import os
import random
import statistics as st
from collections import Counter

ROOT = os.path.join(os.path.dirname(__file__), "..", "research", "audio")
MIN_N = 8  # fewer reels than this in a group: no verdict
random.seed(1)


def ranks(xs):
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    r = [0.0] * len(xs)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        for k in range(i, j + 1):
            r[order[k]] = (i + j) / 2 + 1
        i = j + 1
    return r


def spearman(x, y):
    rx, ry = ranks(x), ranks(y)
    mx, my = st.mean(rx), st.mean(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = (sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry)) ** 0.5
    return num / den if den else 0.0


def perm_p(stat, x, y, n=4000):
    """Two-sided p-value of stat(x, y) against shuffled y."""
    obs = abs(stat(x, y))
    yy = list(y)
    hits = 0
    for _ in range(n):
        random.shuffle(yy)
        if abs(stat(x, yy)) >= obs - 1e-12:
            hits += 1
    return (hits + 1) / (n + 1)


def med_diff(a_flags, vals):
    a = [v for f, v in zip(a_flags, vals) if f]
    b = [v for f, v in zip(a_flags, vals) if not f]
    return (st.median(a) - st.median(b)) if a and b else 0.0


def load():
    rows = []
    for f in sorted(glob.glob(os.path.join(ROOT, "*.json"))):
        d = json.load(open(f, encoding="utf-8"))
        store = (d.get("store") or {}).get("username") or os.path.basename(f)
        for r in d.get("selected") or []:
            if not r.get("details_loaded") or r.get("success_score") is None:
                continue
            a = r.get("audio") or {}
            rows.append({
                "store": store,
                "success": float(r["success_score"]),
                "hit": r.get("success_tier") == "hit",
                "dur": r.get("duration_s"),
                "original": a.get("original") if a else None,
                "song": f'{a.get("title", "")} - {a.get("artist", "")}' if a and not a.get("original") else "",
            })
    return rows


def line(label, xs):
    if not xs:
        return f"  {label:<14} n=0"
    hits = sum(1 for x in xs if x["hit"])
    return f"  {label:<14} n={len(xs):<4} median Success {st.median(x['success'] for x in xs):5.1f}   hits {hits}/{len(xs)}"


def main():
    rows = load()
    if not rows:
        print(f"No export files with loaded details in {os.path.abspath(ROOT)}")
        return
    stores = Counter(r["store"] for r in rows)
    print("Reels with details:", len(rows), "|", ", ".join(f"{s} {n}" for s, n in stores.items()))

    # ---------------------------------------------------------------- length
    print("\nLENGTH (seconds)")
    dr = [r for r in rows if isinstance(r["dur"], (int, float))]
    for lo, hi in ((0, 10), (10, 15), (15, 20), (20, 30), (30, 1e9)):
        g = [r for r in dr if lo <= r["dur"] < hi]
        if g:
            print(line(f"{lo}s+" if hi > 1e8 else f"{lo}-{int(hi)}s", g))
    if len(dr) >= 2 * MIN_N and len({round(r["dur"]) for r in dr}) >= 4:
        x = [r["dur"] for r in dr]
        y = [r["success"] for r in dr]
        rho = spearman(x, y)
        p = perm_p(spearman, x, y)
        print(f"  correlation length vs Success: {rho:+.2f} (p = {p:.3f})",
              "-> signal" if p < 0.1 else "-> no clear signal")
    else:
        print("  not enough different lengths for a verdict")

    # ---------------------------------------------------------------- audio
    print("\nAUDIO")
    ar = [r for r in rows if r["original"] is not None]
    orig = [r for r in ar if r["original"]]
    music = [r for r in ar if not r["original"]]
    print(line("original", orig))
    print(line("music", music))
    if len(orig) >= MIN_N and len(music) >= MIN_N:
        flags = [r["original"] for r in ar]
        vals = [r["success"] for r in ar]
        diff = med_diff(flags, vals)
        p = perm_p(lambda f, v: med_diff(f, v), flags, vals)
        print(f"  original minus music (median Success): {diff:+.1f} (p = {p:.3f})",
              "-> signal" if p < 0.1 else "-> no clear signal")
    else:
        print(f"  need at least {MIN_N} reels in both groups for a verdict")
    songs = Counter(r["song"] for r in music if r["song"])
    reused = [(s, n) for s, n in songs.most_common() if n > 1]
    if reused:
        print("  songs used more than once:")
        for s, n in reused[:10]:
            g = [r for r in music if r["song"] == s]
            print(f"    {n}x  median Success {st.median(r['success'] for r in g):5.1f}  {s[:60]}")


if __name__ == "__main__":
    main()
