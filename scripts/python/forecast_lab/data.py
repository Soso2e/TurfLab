"""Race grouping and the strict pre-race / post-race field boundary."""
from __future__ import annotations

import bisect
import statistics
from collections import defaultdict
from typing import Any

# Fields that exist before the start. Anything else on a target-race row is a result and is dropped.
PRE_RACE_FIELDS = (
    "track", "date", "race_no", "surface", "distance_m",
    "draw", "horse_number", "jockey", "horse_name", "carried_weight_kg",
)
MIN_FIELD = 5


def strip_prerace(entry: dict[str, Any]) -> dict[str, Any]:
    """Return only pre-race fields. The target race never exposes finish/time/corners."""
    return {k: entry.get(k) for k in PRE_RACE_FIELDS}


def group_races(runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Group runs into races. Dead heats for 1st and tiny fields are excluded (documented, counted)."""
    grouped: dict[tuple[str, str, int], list[dict[str, Any]]] = defaultdict(list)
    for r in runs:
        grouped[(r["track"], r["date"], r["race_no"])].append(r)
    races, excluded = [], {"small_field": 0, "no_unique_winner": 0}
    for key, rs in grouped.items():
        if len(rs) < MIN_FIELD:
            excluded["small_field"] += 1
            continue
        winners = [r for r in rs if r.get("finish") == 1]
        if len(winners) != 1:
            excluded["no_unique_winner"] += 1
            continue
        rs = sorted(rs, key=lambda r: (r.get("horse_number") is None, r.get("horse_number") or 0))
        races.append({
            "key": key, "track": key[0], "date": key[1], "race_no": key[2],
            "surface": rs[0].get("surface"), "distance_m": rs[0].get("distance_m"),
            "entries": rs, "winner_index": next(i for i, r in enumerate(rs) if r.get("finish") == 1),
        })
    races.sort(key=lambda r: (r["date"], r["track"], r["race_no"]))
    group_races.last_excluded = excluded  # type: ignore[attr-defined]
    return races


class HistoryIndex:
    """Per-horse and per-jockey history addressable strictly by date (< cutoff)."""

    def __init__(self, runs: list[dict[str, Any]]):
        self.horse: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self.horse_dates: dict[str, list[str]] = {}
        self.jockey_dates: dict[str, list[str]] = {}
        self.jockey_cum: dict[str, list[float]] = {}
        l3f_by_race: dict[tuple[str, str, int], list[float]] = defaultdict(list)
        size: dict[tuple[str, str, int], int] = defaultdict(int)
        for r in runs:
            size[(r["track"], r["date"], r["race_no"])] += 1
            if r.get("last_3f_s"):
                l3f_by_race[(r["track"], r["date"], r["race_no"])].append(r["last_3f_s"])
        self.race_size = dict(size)
        self.race_l3f_median = {k: statistics.median(v) for k, v in l3f_by_race.items() if len(v) >= 3}
        jock: dict[str, list[tuple[str, float]]] = defaultdict(list)
        for r in sorted(runs, key=lambda x: x["date"]):
            if r.get("horse_name"):
                self.horse[r["horse_name"]].append(r)
            n = self.race_size[(r["track"], r["date"], r["race_no"])]
            f = r.get("finish")
            if r.get("jockey") and n >= MIN_FIELD:
                expected = min(1.0, 3.0 / n)
                jock[r["jockey"]].append((r["date"], (1.0 if f is not None and f <= 3 else 0.0) - expected))
        for name, lst in self.horse.items():
            self.horse_dates[name] = [x["date"] for x in lst]
        for name, lst in jock.items():
            self.jockey_dates[name] = [d for d, _ in lst]
            cum, acc = [0.0], 0.0
            for _, v in lst:
                acc += v
                cum.append(acc)
            self.jockey_cum[name] = cum

    def horse_before(self, name: str, date: str) -> list[dict[str, Any]]:
        if not name or name not in self.horse:
            return []
        return self.horse[name][: bisect.bisect_left(self.horse_dates[name], date)]

    def jockey_before(self, name: str, date: str) -> tuple[int, float]:
        if not name or name not in self.jockey_dates:
            return 0, 0.0
        k = bisect.bisect_left(self.jockey_dates[name], date)
        return k, self.jockey_cum[name][k]
