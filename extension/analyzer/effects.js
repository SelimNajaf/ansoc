/* Visuals for "what works" results (PD.stats.groupEffect output), shared by the Reels Analyzer
 * and the Compare stores page. DOM is built with createElement/textContent only. */
(function (root) {
  "use strict";
  const PD = (root.PD = root.PD || {});
  const t = (k, s) => (PD.t ? PD.t(k, s) : k);

  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k === "style") n.setAttribute("style", v);
      else n.setAttribute(k, v);
    }
    for (const c of [].concat(children || [])) if (c) n.append(c);
    return n;
  }

  const LIMIT = 1.6; // log2 range shown: 1/3x .. 3x
  const pos = (ratio) => {
    const x = Math.max(-LIMIT, Math.min(LIMIT, Math.log2(ratio)));
    return 50 + (x / LIMIT) * 50; // percent from the left; 1x = 50%
  };
  const fmt = (r) => `${r >= 10 ? Math.round(r) : r.toFixed(1)}×`;

  /** Dots for how sure we are: ●●● clear, ●●○ likely, ●○○ few reels. */
  function confidence(e) {
    const c = PD.stats.effectConfidence(e);
    const dots = c === "clear" ? "●●●" : c === "likely" ? "●●○" : "●○○";
    return el("span", { class: `fx-conf ${c}`, title: t(`fx_conf_${c}`), text: dots });
  }

  /**
   * Horizontal bars, one per group, around a 1x line (= the store's normal level):
   * green to the right = better than usual, red to the left = worse. The thin line is the
   * 80% interval; the best group gets a star.
   */
  function bars(effects, opts) {
    opts = opts || {};
    const order = opts.order || effects.map((e) => e.group);
    const byGroup = new Map(effects.map((e) => [e.group, e]));
    const best = PD.stats.bestEffect(effects);
    const box = el("div", { class: "fx-bars" });
    for (const g of order) {
      const e = byGroup.get(g);
      const label = opts.label ? opts.label(g) : String(g);
      if (!e) {
        box.append(el("div", { class: "fx-row empty" }, [el("span", { class: "fx-label", text: label }), el("span", { class: "fx-track" }), el("span", { class: "fx-val muted", text: "–" }), el("span")]));
        continue;
      }
      const p = pos(e.ratio);
      const good = e.ratio >= 1;
      const track = el("span", { class: "fx-track" }, [el("span", { class: "fx-mid" })]);
      track.append(el("span", {
        class: `fx-bar ${good ? "good" : "bad"}`,
        style: good ? `left:50%;width:${p - 50}%` : `left:${p}%;width:${50 - p}%`,
      }));
      if (e.lo != null) {
        const a = pos(e.lo);
        const b = pos(e.hi);
        track.append(el("span", { class: "fx-ci", style: `left:${a}%;width:${Math.max(0.5, b - a)}%` }));
      }
      const isBest = best && best.group === g;
      const tip = t("fx_row_tip", [label, fmt(e.ratio), e.lo != null ? `${fmt(e.lo)} – ${fmt(e.hi)}` : "–", String(e.n), String(e.stores)]);
      box.append(el("div", { class: `fx-row${isBest ? " best" : ""}${e.enough ? "" : " few"}`, title: tip }, [
        el("span", { class: "fx-label", text: (isBest ? "★ " : "") + label }),
        track,
        el("span", { class: `fx-val ${good ? "good" : "bad"}`, text: fmt(e.ratio) }),
        el("span", { class: "fx-n" }, [confidence(e), el("span", { text: ` ${e.n}` })]),
      ]));
    }
    return box;
  }

  /** Summary tile: icon, title, the best group and how much better it does. */
  function tile(icon, titleKey, effects, label, onClick) {
    const best = PD.stats.bestEffect(effects);
    const node = el(onClick ? "button" : "div", { class: "fx-tile" + (best ? "" : " empty"), type: onClick ? "button" : null }, [
      el("div", { class: "fx-tile-top" }, [el("span", { class: "fx-icon", text: icon }), el("span", { class: "fx-tile-title", text: t(titleKey) })]),
      el("div", { class: "fx-tile-val", text: best ? label(best.group) : t("fx_not_enough") }),
      best ? el("div", { class: "fx-tile-sub" }, [
        el("span", { class: best.ratio >= 1 ? "good" : "bad", text: fmt(best.ratio) }),
        el("span", { text: ` · ${t("fx_reels", [String(best.n)])} ` }),
        confidence(best),
      ]) : el("div", { class: "fx-tile-sub muted", text: t("fx_need_more") }),
    ]);
    if (onClick) node.addEventListener("click", onClick);
    return node;
  }

  PD.effectsUI = { bars, tile, fmt };
})(typeof globalThis !== "undefined" ? globalThis : self);
