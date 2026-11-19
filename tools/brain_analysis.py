"""Research: what separates the reels the user picked as successful from the rest?

Reads research/*.json (Reels Analyzer -> Export data). Every feature is compared WITHIN its own
store (percentile rank), so big and small stores count the same. Prints, per feature, the AUC
(0.5 = no signal, 1.0 = picks always higher, 0.0 = always lower) per store and pooled.
"""
import glob, json, math, os, sys
sys.stdout.reconfigure(encoding="utf-8")
import numpy as np

ROOT = os.path.join(os.path.dirname(__file__), "..", "research")


def load():
    stores = []
    for f in sorted(glob.glob(os.path.join(ROOT, "*.json"))):
        d = json.load(open(f, encoding="utf-8"))
        stores.append(d)
    return stores


def lg(x, eps=1e-9):
    return math.log10(max(x, 0) + eps) if x is not None else None


FEATURES = {
    "views": lambda r: lg(r["views"], 1),
    "likes": lambda r: lg(r["likes"], 1),
    "comments": lambda r: lg(r["comments"], 1),
    "er": lambda r: lg(r["er"], 1e-5),
    "like_rate": lambda r: lg(r["like_rate"], 1e-5),
    "comment_rate": lambda r: lg(r["comment_rate"], 1e-6),
    "comment_share": lambda r: r["comment_share"],
    "vs_typical": lambda r: lg(r["vs_typical"], 1e-3),
    "er_vs_expected": lambda r: lg(r["er_vs_expected"], 1e-3),
    "views_per_day": lambda r: lg(r["views_per_day"], 1),
    "age_days": lambda r: r["age_days"],
    "posts_same_day": lambda r: r["posts_same_day"],
    "hours_since_prev": lambda r: r["hours_since_prev"],
}


def auc(pos, neg):
    pos, neg = [p for p in pos if p is not None], [n for n in neg if n is not None]
    if not pos or not neg:
        return float("nan")
    wins = sum((p > n) + 0.5 * (p == n) for p in pos for n in neg)
    return wins / (len(pos) * len(neg))


def pct_rank(vals):
    v = np.array([np.nan if x is None else x for x in vals], dtype=float)
    out = np.full(len(v), np.nan)
    ok = ~np.isnan(v)
    order = v[ok].argsort().argsort()
    out[ok] = (order + 0.5) / ok.sum()
    return out


def main():
    stores = load()
    print(f"{len(stores)} stores")
    for d in stores:
        s = d["store"]
        n = len(d["all_reels"]); k = sum(r["selected"] for r in d["all_reels"])
        print(f"  {s['username']:18} followers {s['followers']:>7}  reels {n:>3}  picked {k:>2}  median views {s['views']['median']:>8}  median ER {s['er_median']}")
    print()
    print(f"{'feature':16}" + "".join(f"{d['store']['username'][:10]:>12}" for d in stores) + f"{'pooled':>10}")
    pooled = {}
    for name, fn in FEATURES.items():
        row = []
        P, N = [], []
        for d in stores:
            rows = d["all_reels"]
            pr = pct_rank([fn(r) for r in rows])
            pos = [pr[i] for i, r in enumerate(rows) if r["selected"] and not np.isnan(pr[i])]
            neg = [pr[i] for i, r in enumerate(rows) if not r["selected"] and not np.isnan(pr[i])]
            row.append(auc(pos, neg)); P += pos; N += neg
        pooled[name] = auc(P, N)
        print(f"{name:16}" + "".join(f"{a:12.2f}" for a in row) + f"{pooled[name]:10.2f}")
    print()
    # what the picks look like, in store percentiles
    print("picked reels, store percentile (0-100) of views / comments / comment rate / like rate:")
    for d in stores:
        rows = d["all_reels"]
        pv = pct_rank([FEATURES["views"](r) for r in rows]); pc = pct_rank([FEATURES["comments"](r) for r in rows])
        pcr = pct_rank([FEATURES["comment_rate"](r) for r in rows]); plr = pct_rank([FEATURES["like_rate"](r) for r in rows])
        print(" ", d["store"]["username"])
        for i, r in enumerate(rows):
            if r["selected"]:
                print(f"    {r['code']}  views {pv[i]*100:4.0f}  comments {pc[i]*100:4.0f}  c-rate {pcr[i]*100:4.0f}  l-rate {plr[i]*100:4.0f}   tier {r['tier']}")
    # top reels by views that were NOT picked
    print("\nhigh-view reels NOT picked (top 25% views):")
    for d in stores:
        rows = d["all_reels"]
        pv = pct_rank([FEATURES["views"](r) for r in rows]); pcr = pct_rank([FEATURES["comment_rate"](r) for r in rows]); plr = pct_rank([FEATURES["like_rate"](r) for r in rows])
        miss = [(pv[i], r, pcr[i], plr[i]) for i, r in enumerate(rows) if not r["selected"] and pv[i] >= 0.75]
        print(" ", d["store"]["username"], len(miss))
        for p, r, c, l in sorted(miss, key=lambda x: -x[0])[:8]:
            print(f"    views {p*100:4.0f}  c-rate {c*100:4.0f}  l-rate {l*100:4.0f}  comments {r['comments']:>5}  age {r['age_days']:>5}  caption {(r.get('caption') or '')[:50]!r}")


if __name__ == "__main__":
    main()
