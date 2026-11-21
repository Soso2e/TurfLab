"""AXIS-X v0.1: an experimental, odds-independent contender selector.

Scores are uncalibrated research inputs, never probabilities or expected returns.
This module does not place bets or alter production predictions.
"""
from dataclasses import dataclass, field
from typing import Mapping

SCENARIOS = ("slow", "normal", "fast")

@dataclass(frozen=True)
class Horse:
    number: int
    base: float
    stability: float  # 0..100, higher means less fragile
    scenarios: Mapping[str, float]  # 0..100 affinity for each pace
    jockey_fit: float = 0  # -3..3
    hidden_upside: float = 0  # 0..3
    excuse_rebound: float = 0  # 0..2
    downside_risk: float = 0  # -2..0

@dataclass(frozen=True)
class Config:
    contender_gap: float = 5.0
    stability_weight: float = 0.12
    x_weight: float = 1.0
    scenario_weight: float = 0.15
    max_partners: int = 3

def _check(h: Horse) -> None:
    assert 1 <= h.number <= 18, "invalid horse number"
    assert 0 <= h.base <= 100 and 0 <= h.stability <= 100
    assert set(h.scenarios) == set(SCENARIOS)
    assert all(0 <= h.scenarios[s] <= 100 for s in SCENARIOS)
    assert -3 <= h.jockey_fit <= 3
    assert 0 <= h.hidden_upside <= 3
    assert 0 <= h.excuse_rebound <= 2
    assert -2 <= h.downside_risk <= 0

def predict(horses: list[Horse], pace: str, config: Config = Config()) -> dict:
    if pace not in SCENARIOS:
        raise ValueError("pace must be slow, normal or fast")
    if not horses or len({h.number for h in horses}) != len(horses):
        raise ValueError("horses must be nonempty and uniquely numbered")
    if config.contender_gap < 0 or config.max_partners < 0:
        raise ValueError("invalid config")
    for horse in horses:
        _check(horse)

    # Determine the strength cluster from raw ability only: avoid circularly
    # defining the 'top three' after X-Factor corrections.
    by_base = sorted(horses, key=lambda h: (-h.base, h.number))
    leader = by_base[0].base
    close = [h for h in by_base if leader - h.base <= config.contender_gap]
    tier = f"{len(close)}-strong" if 1 <= len(close) <= 3 else "open"
    if len(horses) < 3:
        tier = "insufficient-field"

    scored = []
    for h in horses:
        pace_x = (h.scenarios[pace] - 50) / 10  # -5..+5
        x = pace_x + h.jockey_fit + h.hidden_upside + h.excuse_rebound + h.downside_risk
        x = max(-15.0, min(15.0, x))
        final = (h.base + config.stability_weight * (h.stability - 50)
                 + config.scenario_weight * (h.scenarios[pace] - 50)
                 + config.x_weight * x)
        scored.append({"number": h.number, "base": h.base, "stability": h.stability,
                       "pace_fit": h.scenarios[pace], "x_factor": round(x, 3),
                       "score": round(final, 3)})
    ranked = sorted(scored, key=lambda x: (-x["score"], -x["stability"], x["number"]))
    # Axis uses the same evidence as partner selection; research may later
    # introduce a distinct robustness objective from walk-forward results.
    axis = ranked[0]
    partners = [r for r in ranked if r["number"] != axis["number"]][:config.max_partners]
    return {"model": "axis-x-v0.1", "pace": pace, "tier": tier,
            "contenders": [h.number for h in close] if tier != "open" else [],
            "axis": axis["number"], "partners": [h["number"] for h in partners],
            "ranked": ranked, "status": "experimental-uncalibrated"}
