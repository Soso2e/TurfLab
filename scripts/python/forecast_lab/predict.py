"""Live M forecast for one upcoming race, emitted as a forecast-v1 record (odds-free)."""
from __future__ import annotations

import hashlib
import json
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from analyze_history import load_nar_csv_dir  # noqa: E402

from . import pace as P  # noqa: E402
from .data import HistoryIndex, group_races  # noqa: E402
from .evaluate import ALL_COLS, VERSION  # noqa: E402
from .features import FEATURES, build_race_features  # noqa: E402
from .models import ConditionalLogit, top3_probabilities  # noqa: E402

MIN_TRAIN = 150


def canonical(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def predict_race(runs: list[dict], pack: dict, cutoff_at: str, generated_at: str | None = None) -> dict[str, Any]:
    date = pack["race_date_jst"]
    runs = [r for r in runs if r["date"] < date]  # defence in depth on top of the loader's before_date
    races = group_races(runs)
    if len(races) < MIN_TRAIN:
        raise ValueError(f"only {len(races)} completed races before {date}; need {MIN_TRAIN} to fit M")
    idx = HistoryIndex(runs)
    X = [build_race_features(r, r["entries"], idx) for r in races]
    winners = [r["winner_index"] for r in races]
    m1 = ConditionalLogit(ALL_COLS).fit(X, winners)
    entries = [e for e in pack["entries"] if e.get("status", "active") != "scratched"]
    race = {"track": pack["track"], "date": date, "race_no": pack.get("race_no"), "surface": pack.get("surface"),
            "distance_m": pack.get("distance_m")}
    pre = [{"track": race["track"], "date": date, "race_no": race["race_no"], "surface": race["surface"],
            "distance_m": race["distance_m"], "draw": e.get("draw_number"), "horse_number": e["horse_number"],
            "jockey": e.get("jockey_name"), "horse_name": e.get("horse_name"), "carried_weight_kg": e.get("weight_kg")}
           for e in entries]
    x = build_race_features(race, pre, idx)
    p = m1.predict(x)
    t3 = top3_probabilities(p)
    corners: dict[str, np.ndarray] = {}
    for which in ("first", "last"):
        xs, ys = [], []
        for i, r in enumerate(races):
            n = len(r["entries"])
            for j, e in enumerate(r["entries"]):
                t = P.corner_rel(e, n, which)
                if t is not None:
                    xs.append(X[i][j, P.CORNER_FEATURES]); ys.append(t)
        if len(xs) >= 200:
            reg = P.Ridge().fit(np.array(xs), np.array(ys))
            corners[which] = reg.predict(x[:, P.CORNER_FEATURES])
    ranks = {w: (np.argsort(np.argsort(v)) + 1).tolist() for w, v in corners.items()}
    pace_z = None
    targets = P.pace_targets(races)
    pt = [i for i, t in enumerate(targets) if t["z"] is not None]
    if len(pt) >= 40:
        reg = P.Ridge().fit(np.array([P.race_pace_features(X[i]) for i in pt]), np.array([targets[i]["z"] for i in pt]))
        pace_z = float(reg.predict(P.race_pace_features(x)[None, :])[0])
    hist_col = FEATURES.index("has_hist")
    horses = []
    for j, e in enumerate(entries):
        horses.append({
            "horse_number": e["horse_number"], "win_probability": round(float(p[j]), 6),
            "top3_probability": round(float(min(1.0, t3[j])), 6),
            "corner_ranks": {w: int(ranks[w][j]) for w in ranks} or None,
            "missing": {"history": bool(x[j, hist_col] == 0.0)},
        })
    inputs_digest = hashlib.sha256(canonical({"pre": pre, "n_runs": len(runs), "through": max(r["date"] for r in runs),
                                              "model": VERSION}).encode()).hexdigest()
    return {
        "schema_version": "forecast-v1", "report_type": "race_forecast",
        "forecaster": {"id": "math-m1", "kind": "math", "model_version": f"{VERSION}/M1", "model_knowledge_cutoff": None},
        "race": {"race_key_human": f"{date}|{race['track']}|{race['race_no']}R", "date_jst": date, "track": race["track"],
                 "race_no": race["race_no"], "distance_m": race["distance_m"], "surface": race["surface"]},
        "cutoff_at": cutoff_at,
        "generated_at": generated_at or time.strftime("%Y-%m-%dT%H:%M:%S+09:00", time.gmtime(time.time() + 9 * 3600)),
        "input_hash": inputs_digest,
        "inputs_attestation": {"odds_used": False, "popularity_used": False, "external_forecasts_used": False},
        "horses": horses,
        "pace": {"class": P.classify(pace_z), "z": round(pace_z, 4)} if pace_z is not None else None,
        "reason_categories": [],
        "training": {"races": len(races), "data_through": max(r["date"] for r in runs), "ridge": m1.ridge},
    }


def run(csv_dir: Path, pack_path: Path, out_path: Path, cutoff_at: str, generated_at: str | None) -> dict:
    pack = json.loads(pack_path.read_text(encoding="utf-8"))
    loaded = load_nar_csv_dir(csv_dir, before_date=pack["race_date_jst"])
    rec = predict_race(loaded["runs"], pack, cutoff_at, generated_at)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
    return rec
