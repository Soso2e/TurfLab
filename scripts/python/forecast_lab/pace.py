"""Pace/position model P (v0). Quantifies a race's shape and scores it against what actually happened.

Observed pace is *relative to the course/distance baseline known before the race*; it is a
descriptive baseline built from winner time and last 3F (200m laps are not in NAR CSVs). Races
without enough as-of reference stay null and are never imputed.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Any

import numpy as np

from .features import FEATURES

PACE_REF_MIN = 10
PACE_Z = 0.5
I_EARLY, I_HASC, I_DRAW, I_FORM = (FEATURES.index(n) for n in ("early3", "has_corner", "draw_rel", "form3"))
PACE_FEATURES = ["mean_early", "std_early", "front_share", "min_early", "log_field"]
CORNER_FEATURES = [I_EARLY, I_HASC, I_DRAW, I_FORM]


def observed_pace_diff(race: dict[str, Any]) -> float | None:
    w = race["entries"][race["winner_index"]]
    dist, total, last = race.get("distance_m"), w.get("finish_time_s"), w.get("last_3f_s")
    if not (dist and total and last) or dist < 1000 or total <= last:
        return None
    front = (total - last) / (dist - 600) * 200
    return front - last / 3  # negative = faster early than late


def pace_targets(races: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Per race: pace_diff, as-of z and class (fast front = 'high'). Reference uses earlier dates only."""
    ref: dict[tuple, list[float]] = defaultdict(list)
    pending: list[tuple[tuple, float]] = []
    out, last_date = [], None
    for r in races:
        if r["date"] != last_date:
            for c, d in pending:
                ref[c].append(d)
            pending, last_date = [], r["date"]
        cond = (r["track"], r["surface"], r["distance_m"])
        diff = observed_pace_diff(r)
        base = ref[cond]
        if diff is None or len(base) < PACE_REF_MIN:
            out.append({"diff": diff, "z": None, "cls": None})
        else:
            sd = max(float(np.std(base)), 0.05)
            z = (diff - float(np.mean(base))) / sd
            out.append({"diff": diff, "z": z, "cls": "high" if z <= -PACE_Z else "slow" if z >= PACE_Z else "middle"})
        if diff is not None:
            pending.append((cond, diff))
    return out


def race_pace_features(X: np.ndarray) -> np.ndarray:
    e = X[:, I_EARLY]
    return np.array([e.mean(), e.std(), float((e < -0.08).mean()), e.min(), float(np.log(len(e)))])


class Ridge:
    def __init__(self, lam: float = 5.0):
        self.lam = lam

    def fit(self, X: np.ndarray, y: np.ndarray) -> "Ridge":
        self.mu, sd = X.mean(axis=0), X.std(axis=0)
        self.sd = np.where(sd < 1e-9, 1.0, sd)
        Z = (X - self.mu) / self.sd
        self.b0 = float(y.mean())
        self.w = np.linalg.solve(Z.T @ Z + self.lam * np.eye(Z.shape[1]), Z.T @ (y - self.b0))
        return self

    def predict(self, X: np.ndarray) -> np.ndarray:
        return ((X - self.mu) / self.sd) @ self.w + self.b0


def corner_rel(entry: dict[str, Any], field: int, which: str) -> float | None:
    cs = entry.get("corners") or []
    if not cs or field < 2:
        return None
    pos = cs[0] if which == "first" else cs[-1]
    return (pos - 1) / (field - 1)


def classify(z: float) -> str:
    return "high" if z <= -PACE_Z else "slow" if z >= PACE_Z else "middle"
