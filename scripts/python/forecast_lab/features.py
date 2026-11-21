"""As-of feature construction. The only entry point for model inputs."""
from __future__ import annotations

import math
from typing import Any

import numpy as np

from .data import HistoryIndex, strip_prerace

FEATURE_GROUPS: dict[str, list[str]] = {
    "form": ["form3", "top3_rate5", "n_prev", "has_hist"],
    "speed": ["l3f_rel3", "has_l3f"],
    "early": ["early3", "has_corner"],
    "rest": ["rest_log", "long_rest"],
    "cond": ["same_surf_dist", "same_track"],
    "jockey": ["jk_excess", "jk_n"],
    "draw": ["draw_rel", "weight_rel"],
}
FEATURES = [f for g in FEATURE_GROUPS.values() for f in g]
GROUP_OF = {f: g for g, fs in FEATURE_GROUPS.items() for f in fs}
K_SHRINK = 2.0


def _days(a: str, b: str) -> int:
    from datetime import date
    ya, ma, da = map(int, a.split("-"))
    yb, mb, db = map(int, b.split("-"))
    return (date(ya, ma, da) - date(yb, mb, db)).days


def _pct(finish: int | None, field: int | None) -> float:
    if not field or field < 2:
        return 0.5
    if finish is None:
        return 1.0  # did not finish counts as worst; documented
    return min(1.0, max(0.0, (finish - 1) / (field - 1)))


def horse_features(entry: dict[str, Any], race: dict[str, Any], field: int, idx: HistoryIndex,
                   weight_mean: float | None) -> dict[str, float]:
    date = race["date"]
    hist = idx.horse_before(entry.get("horse_name") or "", date)
    last3, last5 = hist[-3:], hist[-5:]
    f: dict[str, float] = {}
    pcts = [_pct(r.get("finish"), idx.race_size.get((r["track"], r["date"], r["race_no"]))) for r in last3]
    f["form3"] = (sum(pcts) + K_SHRINK * 0.5) / (len(pcts) + K_SHRINK) - 0.5
    t3 = [1.0 if (r.get("finish") is not None and r["finish"] <= 3) else 0.0 for r in last5]
    f["top3_rate5"] = (sum(t3) + K_SHRINK * 0.3) / (len(t3) + K_SHRINK) - 0.3
    f["n_prev"] = math.log1p(min(len(hist), 20))
    f["has_hist"] = 1.0 if hist else 0.0
    rel = []
    for r in last3:
        med = idx.race_l3f_median.get((r["track"], r["date"], r["race_no"]))
        if r.get("last_3f_s") and med:
            rel.append(r["last_3f_s"] - med)
    f["l3f_rel3"] = sum(rel) / (len(rel) + K_SHRINK)
    f["has_l3f"] = 1.0 if rel else 0.0
    early = []
    for r in last3:
        n = idx.race_size.get((r["track"], r["date"], r["race_no"]))
        if r.get("corners") and n and n >= 2:
            early.append((r["corners"][0] - 1) / (n - 1))
    f["early3"] = (sum(early) + K_SHRINK * 0.5) / (len(early) + K_SHRINK) - 0.5
    f["has_corner"] = 1.0 if early else 0.0
    if hist:
        gap = max(0, _days(date, hist[-1]["date"]))
        f["rest_log"] = math.log1p(min(gap, 180)) - math.log1p(28)
        f["long_rest"] = 1.0 if gap > 90 else 0.0
    else:
        f["rest_log"] = 0.0
        f["long_rest"] = 0.0
    dist = race.get("distance_m")
    sd = [_pct(r.get("finish"), idx.race_size.get((r["track"], r["date"], r["race_no"])))
          for r in hist if r.get("surface") == race.get("surface") and dist and r.get("distance_m")
          and abs(r["distance_m"] - dist) <= 200]
    f["same_surf_dist"] = (sum(sd) + 3 * 0.5) / (len(sd) + 3) - 0.5
    st = [_pct(r.get("finish"), idx.race_size.get((r["track"], r["date"], r["race_no"])))
          for r in hist if r["track"] == race["track"]]
    f["same_track"] = (sum(st) + 3 * 0.5) / (len(st) + 3) - 0.5
    n, excess = idx.jockey_before(entry.get("jockey") or "", date)
    f["jk_excess"] = excess / (n + 30.0)
    f["jk_n"] = math.log1p(min(n, 500))
    hn = entry.get("horse_number")
    f["draw_rel"] = ((hn - 1) / (field - 1) - 0.5) if hn and field > 1 else 0.0
    w = entry.get("carried_weight_kg")
    f["weight_rel"] = (w - weight_mean) if (w and weight_mean) else 0.0
    return f


def build_race_features(race_prerace: dict[str, Any], entries: list[dict[str, Any]], idx: HistoryIndex) -> np.ndarray:
    """Feature matrix (n_horses x len(FEATURES)). ``entries`` are stripped to pre-race fields here."""
    es = [strip_prerace(e) for e in entries]
    field = len(es)
    ws = [e["carried_weight_kg"] for e in es if e.get("carried_weight_kg")]
    wm = sum(ws) / len(ws) if ws else None
    rows = [horse_features(e, race_prerace, field, idx, wm) for e in es]
    return np.array([[r[name] for name in FEATURES] for r in rows], dtype=float)


def early_values(X: np.ndarray) -> np.ndarray:
    return X[:, FEATURES.index("early3")]
