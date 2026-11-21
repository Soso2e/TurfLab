"""Read-only bridge: compare the existing 6-evaluation softmax (exchange/outcomes)
against M model predictions (exchange/forecasts) on the same races.

The bridge never writes to exchange/. All inputs are read-only.

Race identity: (race_date_jst, track_name, race_number) derived by cross-joining
  outcomes/<date>/<file>  ←(race_id)→  packs/<date>/<file>

Softmax win probability: softmax over the per-horse mean of available 6 components
  (ability, course, pace, going, draw_weight, horse_jockey_course).  null components
  are excluded from the mean for that horse; if all are null the horse is assigned the
  field mean before softmax.
"""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Softmax helpers
# ---------------------------------------------------------------------------

SOFTMAX_COMPONENTS = ["ability", "course", "pace", "going", "draw_weight", "horse_jockey_course"]


def _component_mean(components: dict) -> float | None:
    vals = [v for k in SOFTMAX_COMPONENTS if (v := components.get(k)) is not None]
    return sum(vals) / len(vals) if vals else None


def _softmax(scores: list[float]) -> list[float]:
    m = max(scores)
    exp = [math.exp(s - m) for s in scores]
    total = sum(exp)
    return [e / total for e in exp]


def softmax_win_probs(evaluations: list[dict]) -> dict[int, float]:
    """Return {horse_number: win_prob} from a list of evaluation dicts."""
    horse_nums = [e["horse_number"] for e in evaluations]
    means: list[float | None] = [_component_mean(e.get("components", {})) for e in evaluations]
    # fill null with field mean
    valid = [m for m in means if m is not None]
    fallback = sum(valid) / len(valid) if valid else 50.0
    filled = [m if m is not None else fallback for m in means]
    probs = _softmax(filled)
    return {hn: p for hn, p in zip(horse_nums, probs)}


# ---------------------------------------------------------------------------
# Outcome reader
# ---------------------------------------------------------------------------

def _read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _load_outcomes(outcomes_dir: Path) -> list[dict]:
    """Read all outcome files. Returns list of raw outcome dicts."""
    rows = []
    if not outcomes_dir.exists():
        return rows
    for date_dir in sorted(outcomes_dir.iterdir()):
        if not date_dir.is_dir():
            continue
        for f in sorted(date_dir.glob("*.json")):
            obj = _read_json(f)
            if obj and obj.get("outcome_version") == "lab-outcome-v1":
                rows.append(obj)
    return rows


def _build_pack_index(packs_dir: Path) -> dict[str, dict]:
    """Return {race_id: pack_obj} for all packs."""
    index: dict[str, dict] = {}
    if not packs_dir.exists():
        return index
    for date_dir in sorted(packs_dir.iterdir()):
        if not date_dir.is_dir():
            continue
        for f in sorted(date_dir.glob("*.json")):
            obj = _read_json(f)
            if obj and "pack" in obj:
                p = obj["pack"]
                race = p.get("race", {})
                rid = race.get("race_id")
                if rid:
                    index[rid] = p
    return index


def _load_m_forecasts(forecasts_dir: Path) -> dict[str, dict]:
    """Return {race_id: forecast_obj} from exchange/forecasts/ (write-once AI forecast-v1 files).
    Key = race_key_human or race_id inside the forecast."""
    index: dict[str, dict] = {}
    if not forecasts_dir.exists():
        return index
    for date_dir in sorted(forecasts_dir.iterdir()):
        if not date_dir.is_dir():
            continue
        for f in sorted(date_dir.rglob("*.json")):
            obj = _read_json(f)
            if not obj:
                continue
            rid = obj.get("race", {}).get("race_id") if isinstance(obj.get("race"), dict) else None
            if rid:
                index[rid] = obj
    return index


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def bridge_compare(exchange_dir: Path) -> dict[str, Any]:
    """Compare 6-eval softmax vs M forecast on races present in both.

    Parameters
    ----------
    exchange_dir : Path
        Path to the exchange root (e.g. %LOCALAPPDATA%/TurfLab/local-predictions/exchange).
        All reads are strictly read-only.

    Returns
    -------
    dict  with keys:
      status, exchange_dir, outcomes_loaded, packs_loaded, m_forecasts_loaded,
      matched_races, softmax_log_loss_mean, softmax_brier_mean,
      m_log_loss_mean, m_brier_mean, comparison_note, records (list of per-race dicts)
    """
    exchange_dir = Path(exchange_dir)
    outcomes_dir = exchange_dir / "outcomes"
    packs_dir = exchange_dir / "packs"
    forecasts_dir = exchange_dir / "forecasts"

    outcomes = _load_outcomes(outcomes_dir)
    pack_index = _build_pack_index(packs_dir)
    m_index = _load_m_forecasts(forecasts_dir)

    records: list[dict] = []
    softmax_lls: list[float] = []
    m_lls: list[float] = []
    softmax_briers: list[float] = []
    m_briers: list[float] = []

    for oc in outcomes:
        race_id = oc.get("race_id", "")
        race_date = oc.get("race_date_jst", "")
        evals = oc.get("evaluations", [])
        actual_winners = oc.get("actual_winners", [])

        if not evals or not actual_winners:
            continue
        actual_winner_hn = actual_winners[0]

        # softmax probabilities from 6-component scores
        try:
            sm_probs = softmax_win_probs(evals)
        except Exception:
            continue

        winner_sm_p = sm_probs.get(actual_winner_hn, 1e-9)
        sm_ll = -math.log(max(winner_sm_p, 1e-9))
        n = len(evals)
        uniform_ll = math.log(n)
        sm_brier = sum((p - (1 if hn == actual_winner_hn else 0)) ** 2 for hn, p in sm_probs.items())

        # get track/race_no from pack
        pack = pack_index.get(race_id, {})
        track_name = (pack.get("track") or {}).get("name", "unknown")
        race_number = (pack.get("race") or {}).get("race_number")

        # M forecast (if available for this race)
        m_rec: dict | None = m_index.get(race_id)
        m_ll: float | None = None
        m_brier: float | None = None
        if m_rec:
            m_horses = m_rec.get("horses", [])
            m_probs = {h["horse_number"]: h.get("win_prob", 0) for h in m_horses if "win_prob" in h}
            if m_probs and actual_winner_hn in m_probs:
                m_winner_p = max(m_probs[actual_winner_hn], 1e-9)
                m_ll = -math.log(m_winner_p)
                m_brier = sum((p - (1 if hn == actual_winner_hn else 0)) ** 2 for hn, p in m_probs.items())

        rec = {
            "race_id": race_id,
            "race_date": race_date,
            "track": track_name,
            "race_no": race_number,
            "actual_winner_hn": actual_winner_hn,
            "softmax_win_p": round(winner_sm_p, 4),
            "softmax_log_loss": round(sm_ll, 4),
            "softmax_brier": round(sm_brier, 4),
            "uniform_log_loss": round(uniform_ll, 4),
            "m_log_loss": round(m_ll, 4) if m_ll is not None else None,
            "m_brier": round(m_brier, 4) if m_brier is not None else None,
            "has_m_forecast": m_ll is not None,
        }
        records.append(rec)
        softmax_lls.append(sm_ll)
        softmax_briers.append(sm_brier)
        if m_ll is not None:
            m_lls.append(m_ll)
            m_briers.append(m_brier)

    matched = sum(1 for r in records if r["has_m_forecast"])

    # comparison note: explain the temporal gap
    outcome_dates = sorted({r["race_date"] for r in records}) if records else []
    note_parts = [
        f"Outcomes span {outcome_dates[0]}..{outcome_dates[-1]}." if outcome_dates else "No outcomes found.",
        f"M dev-backtest holdout start: 2026-10-13 (dev window ends before holdout).",
        f"Matched races (both softmax outcome and M forecast present): {matched}.",
    ]
    if matched == 0:
        note_parts.append(
            "Temporal gap: M dev window predates outcomes data. "
            "Comparison will populate once M is run on the same future races."
        )

    return {
        "status": "ok",
        "exchange_dir": str(exchange_dir),
        "outcomes_loaded": len(outcomes),
        "packs_loaded": len(pack_index),
        "m_forecasts_loaded": len(m_index),
        "matched_races": matched,
        "softmax_log_loss_mean": round(sum(softmax_lls) / len(softmax_lls), 5) if softmax_lls else None,
        "softmax_brier_mean": round(sum(softmax_briers) / len(softmax_briers), 5) if softmax_briers else None,
        "m_log_loss_mean": round(sum(m_lls) / len(m_lls), 5) if m_lls else None,
        "m_brier_mean": round(sum(m_briers) / len(m_briers), 5) if m_briers else None,
        "comparison_note": " ".join(note_parts),
        "records": records,
    }
