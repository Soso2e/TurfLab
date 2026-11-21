"""Data audit (stage 0): counts, missingness, duplicates and horse-name mis-joins. Read-only."""
from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any

from .data import HistoryIndex, group_races

FIELDS = ["horse_name", "jockey", "draw", "horse_number", "finish", "finish_time_s", "last_3f_s", "corners",
          "carried_weight_kg", "distance_m", "going"]


def _missing(r: dict, f: str) -> bool:
    v = r.get(f)
    return v is None or v == "" or v == [] or (f == "surface" and v == "unknown")


def audit(runs: list[dict[str, Any]], raw_rows: int | None = None, provenance: dict | None = None) -> dict[str, Any]:
    n = len(runs)
    out: dict[str, Any] = {"provenance": provenance or {}, "runs": n}
    if not n:
        return {**out, "status": "empty"}
    races = group_races(runs)
    excluded = dict(getattr(group_races, "last_excluded", {}))
    by_month = Counter(r["date"][:7] for r in runs)
    out["date_range"] = [min(r["date"] for r in runs), max(r["date"] for r in runs)]
    out["runs_by_month"] = dict(sorted(by_month.items()))
    out["tracks"] = dict(Counter(r["track"] for r in runs).most_common())
    out["races_usable"] = len(races)
    out["races_excluded"] = excluded
    sizes = Counter(len(r["entries"]) for r in races)
    out["field_size_distribution"] = dict(sorted(sizes.items()))
    out["missing_rate"] = {f: round(sum(_missing(r, f) for r in runs) / n, 4) for f in FIELDS}
    out["surface_unknown_rate"] = round(sum(r.get("surface") == "unknown" for r in runs) / n, 4)
    out["finish_non_numeric_rate"] = round(sum(r.get("finish") is None for r in runs) / n, 4)

    # Horse-name identity risks: a name is the only key we have.
    per_day: dict[tuple[str, str], set[tuple]] = defaultdict(set)
    per_race: Counter = Counter()
    for r in runs:
        if r.get("horse_name"):
            per_day[(r["horse_name"], r["date"])].add((r["track"], r["race_no"]))
            per_race[(r["horse_name"], r["track"], r["date"], r["race_no"])] += 1
    same_day_multi = [(k, sorted(v)) for k, v in per_day.items() if len(v) > 1]
    twice_in_race = [k for k, c in per_race.items() if c > 1]
    names = Counter(r["horse_name"] for r in runs if r.get("horse_name"))
    out["name_identity"] = {
        "distinct_names": len(names),
        "same_name_in_two_races_same_day": len(same_day_multi),
        "same_name_twice_in_one_race": len(twice_in_race),
        "short_names_le2_chars": sum(1 for k in names if len(k) <= 2),
        "examples_same_day": [{"horse": k[0], "date": k[1], "races": v[:3]} for k, v in same_day_multi[:10]],
        "interpretation": "同日に別レースへ出走する同名は誤結合の強いシグナル（NARでは通常1日1走）。"
                          "割合が高ければ馬名のみの結合は不可で、血統登録番号等のIDが必要。",
    }
    # How much history would a model really see? (as-of, strictly earlier dates)
    idx = HistoryIndex(runs)
    has1 = has3 = tot = 0
    for r in races:
        for e in r["entries"]:
            h = idx.horse_before(e.get("horse_name") or "", r["date"])
            tot += 1; has1 += len(h) >= 1; has3 += len(h) >= 3
    out["history_coverage_as_of"] = {"entries": tot, "with_ge1_prior_run": round(has1 / tot, 4), "with_ge3_prior_runs": round(has3 / tot, 4)}
    by_day = Counter(r["date"] for r in races)
    out["races_per_day"] = {"days": len(by_day), "median": sorted(by_day.values())[len(by_day) // 2] if by_day else 0}
    return {**out, "status": "ok"}
