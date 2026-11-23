"""Post-race horse_result_analyses feedback connector for forecast_lab.

Maps each horse's `learning_flag` into training sample weights (never dropping
irregulars blindly; keeping them with attenuated weight while excluding only
`pending`), strict as-of horse risk history (`date < target_date`), and
diagnostic summaries for ability/pace model improvement candidates.
"""
from __future__ import annotations

import bisect
from collections import Counter, defaultdict
from typing import Any

LEARNING_FLAGS = (
    "normal",
    "ability_model_candidate",
    "pace_model_candidate",
    "irregular_one_time",
    "horse_risk_accumulate",
    "pending",
)

# Training weight by learning_flag:
# - irregular_one_time is retained at attenuated weight (not mechanically discarded)
# - horse_risk_accumulate is retained at half weight while accumulating horse risk
# - pending is excluded (0.0) until investigation completes
FLAG_TRAINING_WEIGHT: dict[str, float] = {
    "normal": 1.0,
    "ability_model_candidate": 1.0,
    "pace_model_candidate": 1.0,
    "irregular_one_time": 0.25,
    "horse_risk_accumulate": 0.5,
    "pending": 0.0,
}


def flag_weight(flag: str | None) -> float:
    """Return training weight for a learning_flag (defaults to 1.0 if absent/unknown)."""
    if not flag:
        return 1.0
    return FLAG_TRAINING_WEIGHT.get(flag, 1.0)


def _date_of(row: dict[str, Any]) -> str:
    return str(row.get("race_date") or row.get("date") or "")


def _horse_key(row: dict[str, Any]) -> str:
    return str(row.get("horse_name") or row.get("horse_id") or "")


class AnalysisIndex:
    """Strict as-of index over horse_result_analyses (`race_date < target_date`)."""

    def __init__(self, analyses: list[dict[str, Any]] | None = None):
        self.analyses = list(analyses or [])
        self._by_race_horse: dict[tuple[str, str], dict[str, Any]] = {}
        self._horse_rows: dict[str, list[tuple[str, str]]] = defaultdict(list)
        self._horse_dates: dict[str, list[str]] = {}
        self._horse_cum_risk: dict[str, list[int]] = {}

        for row in sorted(self.analyses, key=_date_of):
            d = _date_of(row)
            h = _horse_key(row)
            flag = str(row.get("learning_flag") or "normal")
            if d and h:
                self._by_race_horse[(d, h)] = row
                self._horse_rows[h].append((d, flag))

        for h, items in self._horse_rows.items():
            self._horse_dates[h] = [d for d, _ in items]
            cum, acc = [0], 0
            for _, flag in items:
                if flag == "horse_risk_accumulate":
                    acc += 1
                cum.append(acc)
            self._horse_cum_risk[h] = cum

    def horse_risk_before(self, horse_name: str, target_date: str) -> tuple[int, int]:
        """Return (risk_accumulate_count, total_analyses_count) strictly before target_date."""
        if not horse_name or horse_name not in self._horse_dates:
            return 0, 0
        k = bisect.bisect_left(self._horse_dates[horse_name], target_date)
        return self._horse_cum_risk[horse_name][k], k

    def race_training_weight(self, race: dict[str, Any], entries: list[dict[str, Any]]) -> float:
        """Compute training weight for a race from its entries' learning_flags.

        Used ONLY during model fitting on past training races, never at prediction time.
        """
        if not self._by_race_horse:
            return 1.0
        d = str(race.get("date") or race.get("race_date_jst") or "")
        weights: list[float] = []
        for e in entries:
            h = _horse_key(e)
            row = self._by_race_horse.get((d, h))
            if row is not None:
                weights.append(flag_weight(row.get("learning_flag")))
        if not weights:
            return 1.0
        return sum(weights) / len(weights)


def summarize_feedback(analyses: list[dict[str, Any]] | None) -> dict[str, Any]:
    """Summarize learning_flag counts and improvement candidates."""
    rows = list(analyses or [])
    counts: Counter[str] = Counter()
    ability_candidates: list[dict[str, Any]] = []
    pace_candidates: list[dict[str, Any]] = []
    horse_risk_counts: Counter[str] = Counter()

    for r in rows:
        flag = str(r.get("learning_flag") or "normal")
        counts[flag] += 1
        h = _horse_key(r)
        d = _date_of(r)
        if flag == "ability_model_candidate":
            ability_candidates.append({"date": d, "horse": h, "race_id": r.get("race_id")})
        elif flag == "pace_model_candidate":
            pace_candidates.append({"date": d, "horse": h, "race_id": r.get("race_id")})
        elif flag == "horse_risk_accumulate" and h:
            horse_risk_counts[h] += 1

    return {
        "total_analyses": len(rows),
        "by_flag": {f: counts[f] for f in LEARNING_FLAGS if counts[f] > 0},
        "pending_excluded": counts["pending"],
        "irregular_downweighted": counts["irregular_one_time"],
        "ability_model_candidates": ability_candidates[:20],
        "pace_model_candidates": pace_candidates[:20],
        "horse_risk_horses": [
            {"horse": h, "count": c} for h, c in horse_risk_counts.most_common(20)
        ],
    }
