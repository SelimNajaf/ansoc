"""Fit and validate candidate 'success' models on research/*.json (leave-one-store-out).

Features are robust z-scores within each store (log scale): z = (x - median) / (1.4826 * MAD).
Model = logistic regression (numpy, L2). Reported: AUC on the held-out store and how many of its
picks land in its top-N (N = number of picks) and top-2N.
"""
import glob, json, math, os, sys
import numpy as np
sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.join(os.path.dirname(__file__), "..", "research")
stores = [json.load(open(f, encoding="utf-8")) for f in sorted(glob.glob(os.path.join(ROOT, "*.json")))]

def L(x, eps): return math.log10(max(x or 0, 0) + eps)
RAW = {
    "views": lambda r: L(r["views"], 1),
    "comments": lambda r: L(r["comments"], 1),
    "likes": lambda r: L(r["likes"], 1),
    "c_rate": lambda r: L(r["comment_rate"], 1e-5),
    "l_rate": lambda r: L(r["like_rate"], 1e-4),
    "vpd": lambda r: L(r["views_per_day"], 1),
    "age": lambda r: L(r["age_days"], 0.5),
}

def rz(v):
    v = np.asarray(v, float); m = np.median(v); mad = np.median(np.abs(v - m)) * 1.4826 or (np.std(v) or 1)
    return (v - m) / mad

def table():
    out = []
    for d in stores:
        rows = d["all_reels"]
        X = {k: rz([f(r) for r in rows]) for k, f in RAW.items()}
        # comment rate relative to what this reach usually gets (bigger reels get a lower rate)
        b = np.polyfit(X["views"], X["c_rate"], 1); X["c_rate_adj"] = X["c_rate"] - np.polyval(b, X["views"])
        b = np.polyfit(X["views"], X["l_rate"], 1); X["l_rate_adj"] = X["l_rate"] - np.polyval(b, X["views"])
        y = np.array([1 if r["selected"] else 0 for r in rows])
        out.append((d["store"]["username"], X, y))
    return out

def fit(X, y, lam=0.3, it=4000, lr=0.1):
    X = np.c_[np.ones(len(X)), X]; w = np.zeros(X.shape[1])
    pw = (len(y) - y.sum()) / max(1, y.sum())  # balance classes
    sw = np.where(y == 1, pw, 1.0)
    for _ in range(it):
        p = 1 / (1 + np.exp(-X @ w)); g = X.T @ (sw * (p - y)) / len(y) + lam * np.r_[0, w[1:]] / len(y)
        w -= lr * g
    return w

def auc(s, y):
    pos, neg = s[y == 1], s[y == 0]
    return np.mean([(p > n) + 0.5 * (p == n) for p in pos for n in neg])

T = table()
MODELS = {
    "comments": ["comments"],
    "views": ["views"],
    "views+c_rate": ["views", "c_rate"],
    "views+c_rate_adj": ["views", "c_rate_adj"],
    "views+c_rate+l_rate": ["views", "c_rate", "l_rate"],
    "views+c_adj+l_adj": ["views", "c_rate_adj", "l_rate_adj"],
    "comments+l_rate": ["comments", "l_rate"],
    "comments+likes": ["comments", "likes"],
    "views+c_adj+l_adj+age": ["views", "c_rate_adj", "l_rate_adj", "age"],
}
print(f"{'model':26}" + "".join(f"{n[:9]:>10}" for n, _, _ in T) + "   mean   top-N  top-2N")
for name, feats in MODELS.items():
    aucs, hitN, hit2N, tot = [], 0, 0, 0
    for i, (n, X, y) in enumerate(T):
        tr = [t for j, t in enumerate(T) if j != i]
        Xtr = np.vstack([np.c_[[t[1][f] for f in feats]].T for t in tr]); ytr = np.concatenate([t[2] for t in tr])
        w = fit(Xtr, ytr)
        Xte = np.c_[[X[f] for f in feats]].T; s = np.c_[np.ones(len(Xte)), Xte] @ w
        aucs.append(auc(s, y)); k = y.sum(); top = np.argsort(-s)
        hitN += y[top[:k]].sum(); hit2N += y[top[:2 * k]].sum(); tot += k
    print(f"{name:26}" + "".join(f"{a:10.2f}" for a in aucs) + f"{np.mean(aucs):7.2f}  {hitN:>3}/{tot}  {hit2N:>3}/{tot}")

print("\nweights on all 4 stores (z units):")
for name in ["views+c_rate", "views+c_adj+l_adj", "comments+l_rate", "views+c_rate+l_rate"]:
    feats = MODELS[name]
    Xa = np.vstack([np.c_[[t[1][f] for f in feats]].T for t in T]); ya = np.concatenate([t[2] for t in T])
    w = fit(Xa, ya); print(f"  {name:22}", " ".join(f"{f}={c:+.2f}" for f, c in zip(["bias"] + feats, w)))

print("\nfinal brain: S = a + b*z(comments) + c*z(like rate) -> p = sigmoid(S)")
feats = ["comments", "l_rate"]
Xa = np.vstack([np.c_[[t[1][f] for f in feats]].T for t in T]); ya = np.concatenate([t[2] for t in T])
w = fit(Xa, ya); print("  weights", np.round(w, 2))
for n, X, y in T:
    s = w[0] + w[1] * X["comments"] + w[2] * X["l_rate"]; p = 1 / (1 + np.exp(-s))
    print(f"  {n:16} reels {len(y):>3}  p>=.5: {int((p>=.5).sum()):>3}  p>=.8: {int((p>=.8).sum()):>3}  p>=.9: {int((p>=.9).sum()):>3}"
          f"   picks p: {' '.join(f'{x:.2f}' for x in sorted(p[y==1], reverse=True))}")
    print(f"  {'':16} best unpicked p: {' '.join(f'{x:.2f}' for x in sorted(p[y==0], reverse=True)[:8])}")
