"""AXIS-X v0.2 experimental context-aware historical form and horse/jockey fit.

No betting, no persistence, no odds. Historical scores must have been obtained
from information available before the target race. All weights are hypotheses.
"""
from dataclasses import dataclass
from typing import Optional

from .axis_x import Horse, Config, predict

RECENCY_WEIGHTS = (0.6, 0.2, 0.1, 0.1)
SURFACES = ("turf", "dirt")
PACES = ("slow", "normal", "fast")

@dataclass(frozen=True)
class PastRun:
    performance: float  # evidence-based pre-race form score, 0..100
    distance_m: int
    surface: str
    track: Optional[str] = None
    going: Optional[str] = None
    pace: Optional[str] = None
    jockey_id: Optional[str] = None

@dataclass(frozen=True)
class RaceContext:
    distance_m: int
    surface: str
    track: Optional[str] = None
    going: Optional[str] = None
    pace: Optional[str] = None

@dataclass(frozen=True)
class Needs:
    # Observed difficulty in each dimension, not claimed psychological traits.
    start: float
    settling: float
    timing: float

@dataclass(frozen=True)
class Skills:
    # Evidence-backed jockey skills, 0..100; not a jockey's popularity.
    start: float
    settling: float
    timing: float

@dataclass(frozen=True)
class Entry:
    horse: Horse  # existing v0.1 shape; original base is retained as baseline
    past_runs: tuple[PastRun, ...] = ()  # newest first, at most four
    needs: Optional[Needs] = None
    jockey_skills: Optional[Skills] = None

def _check_score(value: float) -> None:
    if not 0 <= value <= 100:
        raise ValueError("scores must be between 0 and 100")

def condition_similarity(run: PastRun, target: RaceContext) -> dict:
    if run.distance_m <= 0 or target.distance_m <= 0:
        raise ValueError("distance must be positive")
    if run.surface not in SURFACES or target.surface not in SURFACES:
        raise ValueError("unsupported surface")
    if target.pace not in (*PACES, None) or run.pace not in (*PACES, None):
        raise ValueError("unsupported pace")
    # Distance decay over a 400m scale is provisional; surface change is
    # strongly discounted, but not impossible.
    distance = max(0.0, 1.0 - abs(run.distance_m - target.distance_m) / 800.0)
    surface = 1.0 if run.surface == target.surface else 0.35
    factors = {"distance": distance, "surface": surface}
    for field in ("track", "going", "pace"):
        old, new = getattr(run, field), getattr(target, field)
        if old is not None and new is not None:
            factors[field] = 1.0 if old == new else 0.7
    # Unknown factors are excluded, not silently imputed as matching.
    score = distance * surface
    for field in ("track", "going", "pace"):
        if field in factors:
            score *= factors[field]
    return {"score": round(score, 6), "factors": factors,
            "unknown": [field for field in ("track", "going", "pace")
                        if field not in factors]}

def historical_form(runs: tuple[PastRun, ...], target: RaceContext) -> Optional[dict]:
    if not runs:
        return None
    if len(runs) > 4:
        raise ValueError("at most four runs, newest first")
    weighted = 0.0
    available_weight = 0.0
    details = []
    for i, run in enumerate(runs):
        _check_score(run.performance)
        match = condition_similarity(run, target)
        # Mismatch reduces the evidential impact of a win OR a loss.
        adjusted = 50 + (run.performance - 50) * match["score"]
        weighted += RECENCY_WEIGHTS[i] * adjusted
        available_weight += RECENCY_WEIGHTS[i]
        details.append({"run_index": i + 1, "weight": RECENCY_WEIGHTS[i],
                        "performance": run.performance, "similarity": match,
                        "adjusted": round(adjusted, 4)})
    return {"score": round(weighted / available_weight, 4),
            "coverage": round(available_weight, 4), "runs": details}

def horse_jockey_fit(needs: Optional[Needs], skills: Optional[Skills]) -> Optional[float]:
    if needs is None or skills is None:
        return None
    for value in (needs.start, needs.settling, needs.timing,
                  skills.start, skills.settling, skills.timing):
        _check_score(value)
    # Higher observed need makes the matching skill more important.
    weights = (needs.start, needs.settling, needs.timing)
    total = sum(weights)
    if total == 0:
        return 0.0
    # Bounded [-3, 3] compatibility term for v0.1's existing input contract.
    return round(3 * sum(w * (s - 50) / 50 for w, s in zip(
        weights, (skills.start, skills.settling, skills.timing))) / total, 4)

def predict_v02(entries: list[Entry], context: RaceContext,
                config: Config = Config()) -> dict:
    if not entries:
        raise ValueError("entries are required")
    if context.pace not in PACES:
        raise ValueError("target pace required")
    if context.distance_m <= 0 or context.surface not in SURFACES:
        raise ValueError("invalid race context")
    horses = []
    evidence = []
    for entry in entries:
        history = historical_form(entry.past_runs, context)
        fit = horse_jockey_fit(entry.needs, entry.jockey_skills)
        h = entry.horse
        # No runs: keep v0.1 base and flag explicitly. Never fabricate a run.
        # The historic score replaces, rather than adds to, base to avoid
        # double counting form. Fit replaces jockey_fit when evidenced.
        horses.append(Horse(
            number=h.number, base=history["score"] if history else h.base,
            stability=h.stability, scenarios=h.scenarios,
            jockey_fit=fit if fit is not None else h.jockey_fit,
            hidden_upside=h.hidden_upside, excuse_rebound=h.excuse_rebound,
            downside_risk=h.downside_risk))
        evidence.append({"number": h.number, "historical": history,
                         "jockey_fit": fit,
                         "history_missing": history is None,
                         "jockey_fit_missing": fit is None})
    out = predict(horses, context.pace, config)
    out["model"] = "axis-x-v0.2"
    out["evidence"] = evidence
    out["status"] = "experimental-uncalibrated-no-live-integration"
    return out
