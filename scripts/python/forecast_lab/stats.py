"""Paired comparison statistics. Deterministic (seeded) and clustered by day."""
from __future__ import annotations

import math
from collections import defaultdict

import numpy as np

MIN_RACES_NO_WORSE = 30
MIN_RACES_SUPERIORITY = 300


def paired_difference(a: list[float], b: list[float], days: list[str], boot: int = 2000, seed: int = 20261121) -> dict:
    """Mean of (a - b) with a day-block bootstrap 95% interval. Negative = a has lower loss."""
    d = np.array(a, dtype=float) - np.array(b, dtype=float)
    n = len(d)
    if n == 0:
        return {"races": 0, "mean": None, "ci95": None, "days": 0}
    by_day: dict[str, list[float]] = defaultdict(list)
    for x, day in zip(d, days):
        by_day[day].append(float(x))
    sums = np.array([sum(v) for v in by_day.values()])
    counts = np.array([len(v) for v in by_day.values()])
    rng = np.random.default_rng(seed)
    k = len(sums)
    idx = rng.integers(0, k, size=(boot, k))
    means = sums[idx].sum(axis=1) / counts[idx].sum(axis=1)
    lo, hi = np.percentile(means, [2.5, 97.5])
    return {"races": n, "mean": round(float(d.mean()), 5), "ci95": [round(float(lo), 5), round(float(hi), 5)], "days": k}


def verdict(diff: dict) -> str:
    """Claim ladder (docs/forecast-validation.md). Lower loss is better; never claims beyond the sample."""
    n, ci = diff["races"], diff["ci95"]
    if n < MIN_RACES_NO_WORSE or ci is None:
        return "insufficient_sample"
    if ci[1] < 0:
        return "superiority_candidate" if n >= MIN_RACES_SUPERIORITY else "better_but_below_claim_threshold"
    if ci[0] > 0:
        return "worse"
    return "no_difference_detected"


def pvalue_from_ci(mean: float, ci: list[float]) -> float:
    """Normal-approximation two-sided p from a 95% interval (used only to rank / BH-adjust)."""
    se = (ci[1] - ci[0]) / (2 * 1.96)
    if se <= 0:
        return 1.0
    return math.erfc(abs(mean) / se / math.sqrt(2))


def benjamini_hochberg(pvals: list[float], q: float = 0.1) -> list[bool]:
    m = len(pvals)
    order = sorted(range(m), key=lambda i: pvals[i])
    cutoff = 0
    for rank, i in enumerate(order, start=1):
        if pvals[i] <= q * rank / m:
            cutoff = rank
    keep = [False] * m
    for rank, i in enumerate(order, start=1):
        if rank <= cutoff:
            keep[i] = True
    return keep


def spearman(a: list[float], b: list[float]) -> float | None:
    if len(a) < 3:
        return None
    ra = np.argsort(np.argsort(a)).astype(float)
    rb = np.argsort(np.argsort(b)).astype(float)
    if ra.std() == 0 or rb.std() == 0:
        return None
    return float(np.corrcoef(ra, rb)[0, 1])
