"""Walk-forward backtest with a day-level purge, a one-shot final holdout and a trial log."""
from __future__ import annotations

import hashlib
import json
import math
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np

from .data import HistoryIndex, group_races, strip_prerace
from .features import FEATURES, FEATURE_GROUPS, build_race_features
from . import pace as P
from .models import ConditionalLogit, top3_probabilities, uniform
from .stats import benjamini_hochberg, paired_difference, pvalue_from_ci, spearman, verdict

VERSION = "forecast-lab-v1"
DEFAULT_CONFIG = {"min_train_races": 150, "refit_days": 7, "holdout_frac": 0.2, "ablate": False, "invariance_samples": 40}
CAL_BINS = [0, 0.05, 0.1, 0.2, 0.3, 0.5, 1.0000001]
M0_COLS = [FEATURES.index("form3"), FEATURES.index("has_hist")]
ALL_COLS = list(range(len(FEATURES)))


def config_hash(cfg: dict) -> str:
    return hashlib.sha256(json.dumps(cfg, sort_keys=True).encode()).hexdigest()[:16]


class LeakageError(RuntimeError):
    pass


def check_time_invariance(runs: list[dict], races: list[dict], samples: int = 40) -> int:
    """Features of a race must not change when everything dated on/after it is removed."""
    step = max(1, len(races) // max(1, samples))
    checked = 0
    for r in races[::step]:
        full = build_race_features(r, r["entries"], HistoryIndex(runs))
        past = [x for x in runs if x["date"] < r["date"]]
        # the race's own rows are needed only for the field-size lookup, never their results
        shell = [dict(strip_prerace(e), finish=None, finish_time_s=None, last_3f_s=None, corners=[],
                      field_size=None) for e in r["entries"]]
        cut = build_race_features(r, r["entries"], HistoryIndex(past + shell))
        if not np.allclose(full, cut, atol=1e-12):
            raise LeakageError(f"features of {r['key']} depend on data dated on/after the race")
        checked += 1
    return checked


def _scores(p: np.ndarray, race: dict) -> tuple[float, float, float]:
    w = race["winner_index"]
    ll = -math.log(max(float(p[w]), 1e-12))
    y = np.zeros(len(p)); y[w] = 1
    brier = float(((p - y) ** 2).sum())
    y3 = np.array([1.0 if (e.get("finish") is not None and e["finish"] <= 3) else 0.0 for e in race["entries"]])
    return ll, brier, float(((top3_probabilities(p) - y3) ** 2).mean())


def _bucket_missing(frac: float) -> str:
    return "<10%" if frac < 0.1 else "10-30%" if frac < 0.3 else ">=30%"


def run_backtest(runs: list[dict], cfg: dict | None = None, mode: str = "dev", state_dir: Path | None = None,
                 allow_repeat_holdout: bool = False) -> dict[str, Any]:
    cfg = {**DEFAULT_CONFIG, **(cfg or {})}
    races = group_races(runs)
    excluded = dict(getattr(group_races, "last_excluded", {}))
    if len(races) < cfg["min_train_races"] + 30:
        return {"version": VERSION, "status": "insufficient_data", "races": len(races), "excluded": excluded}
    idx = HistoryIndex(runs)
    checked = check_time_invariance(runs, races, cfg["invariance_samples"])
    X = [build_race_features(r, r["entries"], idx) for r in races]
    winners = [r["winner_index"] for r in races]
    pace_t = P.pace_targets(races)
    dates = sorted({r["date"] for r in races})
    holdout_start = dates[int(len(dates) * (1 - cfg["holdout_frac"]))]
    chash = config_hash({**cfg, "mode": mode})
    lock = None
    if mode == "final":
        if state_dir is None:
            raise ValueError("final mode needs state_dir for the one-shot holdout lock")
        lock = state_dir / "holdout_used.json"
        if lock.exists() and not allow_repeat_holdout:
            raise PermissionError(f"final holdout already consumed ({lock}); a second look is a new trial, not a test")

    def in_window(d: str) -> bool:
        return d >= holdout_start if mode == "final" else d < holdout_start

    test_dates = [d for d in dates if in_window(d)]
    first_idx = defaultdict(list)
    for i, r in enumerate(races):
        first_idx[r["date"]].append(i)
    groups = FEATURE_GROUPS
    variants = {"M0r_form": M0_COLS, "M1_full": ALL_COLS}
    if cfg["ablate"]:
        for g, fs in groups.items():
            variants[f"M1_minus_{g}"] = [i for i, f in enumerate(FEATURES) if f not in fs]
    per = {k: {"ll": [], "brier": [], "top3": []} for k in ["uniform", *variants]}
    meta: list[dict] = []
    cal: list[tuple[float, int]] = []
    models: dict[str, ConditionalLogit] = {}
    pace_rows: list[dict] = []
    corner_rows: list[dict] = []
    last_fit_day, fit_n = None, 0
    pace_model = None
    corner_models: dict = {}
    for d in test_dates:
        train_ix = [i for i in range(len(races)) if races[i]["date"] < d]
        if len(train_ix) < cfg["min_train_races"]:
            continue
        if last_fit_day is None or _days(d, last_fit_day) >= cfg["refit_days"]:
            tx, tw = [X[i] for i in train_ix], [winners[i] for i in train_ix]
            models = {k: ConditionalLogit(cols).fit(tx, tw) for k, cols in variants.items()}
            pt = [i for i in train_ix if pace_t[i]["z"] is not None]
            pace_model = None
            if len(pt) >= 40:
                pace_model = (P.Ridge().fit(np.array([P.race_pace_features(X[i]) for i in pt]),
                                            np.array([pace_t[i]["z"] for i in pt])),
                              float(np.mean([pace_t[i]["z"] for i in pt])),
                              max(set(pace_t[i]["cls"] for i in pt), key=[pace_t[i]["cls"] for i in pt].count))
            corner_models = {}
            for which in ("first", "last"):
                xs, ys = [], []
                for i in train_ix:
                    n = len(races[i]["entries"])
                    for j, e in enumerate(races[i]["entries"]):
                        t = P.corner_rel(e, n, which)
                        if t is not None:
                            xs.append(X[i][j, P.CORNER_FEATURES]); ys.append(t)
                if len(xs) >= 200:
                    corner_models[which] = (P.Ridge().fit(np.array(xs), np.array(ys)), float(np.mean(ys)))
            last_fit_day, fit_n = d, fit_n + 1
        for i in first_idx[d]:
            r, x = races[i], X[i]
            n = len(r["entries"])
            probs = {"uniform": uniform(n), **{k: m.predict(x) for k, m in models.items()}}
            for k, p in probs.items():
                ll, br, t3 = _scores(p, r)
                per[k]["ll"].append(ll); per[k]["brier"].append(br); per[k]["top3"].append(t3)
            yv = np.zeros(n); yv[r["winner_index"]] = 1
            cal.extend(zip(probs["M1_full"].tolist(), yv.astype(int).tolist()))
            miss = float(1 - x[:, FEATURES.index("has_hist")].mean())
            meta.append({"day": d, "field": n, "miss": _bucket_missing(miss), "surface": r["surface"]})
            pz = pace_t[i]
            if pace_model is not None and pz["z"] is not None:
                reg, mean_y, maj = pace_model
                pred = float(reg.predict(P.race_pace_features(x)[None, :])[0])
                pace_rows.append({"day": d, "obs": pz["z"], "pred": pred, "base": mean_y,
                                  "cls_obs": pz["cls"], "cls_pred": P.classify(pred), "cls_base": maj})
            for which, (reg, mean_y) in corner_models.items():
                obs = [(j, P.corner_rel(e, n, which)) for j, e in enumerate(r["entries"])]
                obs = [(j, o) for j, o in obs if o is not None]
                if len(obs) >= 5:
                    js = [j for j, _ in obs]
                    pred = reg.predict(x[js][:, P.CORNER_FEATURES])
                    ov = [o for _, o in obs]
                    rho = spearman(pred.tolist(), ov)
                    corner_rows.append({"day": d, "which": which, "rho": rho,
                                        "mae": float(np.mean(np.abs(pred - ov))), "mae_base": float(np.mean(np.abs(mean_y - np.array(ov))))})
    days = [m["day"] for m in meta]
    if not days:
        return {"version": VERSION, "status": "no_test_races", "races": len(races), "excluded": excluded}

    def agg(k: str) -> dict:
        return {"log_loss": round(float(np.mean(per[k]["ll"])), 5), "brier": round(float(np.mean(per[k]["brier"])), 5),
                "top3_brier": round(float(np.mean(per[k]["top3"])), 5)}

    def pair(a: str, b: str, key: str = "ll") -> dict:
        d = paired_difference(per[a][key], per[b][key], days)
        return {**d, "verdict": verdict(d)}

    strata: dict[str, Any] = {}
    for label, keyf in (("missing_history", lambda m: m["miss"]), ("field_size", lambda m: "<=9" if m["field"] <= 9 else ">=10")):
        for val in sorted({keyf(m) for m in meta}):
            ix = [i for i, m in enumerate(meta) if keyf(m) == val]
            if len(ix) >= 10:
                dd = paired_difference([per["M1_full"]["ll"][i] for i in ix], [per["uniform"]["ll"][i] for i in ix], [days[i] for i in ix])
                strata[f"{label}={val}"] = {**dd, "verdict": verdict(dd)}
    rel = []
    for lo, hi in zip(CAL_BINS[:-1], CAL_BINS[1:]):
        sel = [(p, y) for p, y in cal if lo <= p < hi]
        if sel:
            rel.append({"bin": [lo, round(min(hi, 1.0), 3)], "n": len(sel), "mean_p": round(float(np.mean([p for p, _ in sel])), 4),
                        "win_rate": round(float(np.mean([y for _, y in sel])), 4)})
    report: dict[str, Any] = {
        "version": VERSION, "status": "ok", "mode": mode, "config": cfg, "config_hash": chash,
        "data": {"runs": len(runs), "races": len(races), "excluded": excluded, "date_range": [dates[0], dates[-1]],
                 "invariance_checked_races": checked, "odds_used": False, "popularity_used": False},
        "window": {"test_races": len(meta), "test_days": len(set(days)), "holdout_start": holdout_start, "refits": fit_n},
        "models": {k: agg(k) for k in per},
        "paired_log_loss": {"M1_vs_uniform": pair("M1_full", "uniform"), "M0r_vs_uniform": pair("M0r_form", "uniform"),
                            "M1_vs_M0r": pair("M1_full", "M0r_form")},
        "paired_top3_brier": {"M1_vs_uniform": pair("M1_full", "uniform", "top3")},
        "calibration_M1": rel, "strata_M1_vs_uniform": strata,
        "pace": _pace_report(pace_rows), "corner_position": _corner_report(corner_rows),
        "claim_note": "Odds-free. Superiority requires >=300 test races and a day-block 95% interval below 0.",
    }
    if cfg["ablate"]:
        report["ablation"] = _ablation(per, days)
    if mode == "final" and lock is not None:
        state_dir.mkdir(parents=True, exist_ok=True)  # type: ignore[union-attr]
        lock.write_text(json.dumps({"consumed_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "config_hash": chash,
                                    "test_races": len(meta)}, ensure_ascii=False, indent=1))
    if state_dir is not None:
        state_dir.mkdir(parents=True, exist_ok=True)
        with open(state_dir / "trial_log.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "config_hash": chash, "mode": mode,
                                "n_features": len(FEATURES), "ablate": cfg["ablate"],
                                "m1_vs_uniform": report["paired_log_loss"]["M1_vs_uniform"]["mean"]}) + "\n")
        report["trials_logged"] = len((state_dir / "trial_log.jsonl").read_text(encoding="utf-8").splitlines())
    return report


def _days(a: str, b: str) -> int:
    from .features import _days as d
    return d(a, b)


def _ablation(per: dict, days: list[str]) -> list[dict]:
    out = []
    for g in FEATURE_GROUPS:
        d = paired_difference(per[f"M1_minus_{g}"]["ll"], per["M1_full"]["ll"], days)  # >0 means removing hurts
        out.append({"group": g, **d, "p": pvalue_from_ci(d["mean"], d["ci95"]) if d["ci95"] else 1.0})
    keep = benjamini_hochberg([o["p"] for o in out])
    for o, k in zip(out, keep):
        helps = o["mean"] is not None and o["mean"] > 0
        o["decision"] = "keep" if (k and helps) else "no_evidence_candidate_for_removal"
        o["p"] = round(o["p"], 4)
    return out


def _pace_report(rows: list[dict]) -> dict:
    if len(rows) < 20:
        return {"status": "insufficient", "races": len(rows)}
    mse = float(np.mean([(r["obs"] - r["pred"]) ** 2 for r in rows]))
    mse0 = float(np.mean([(r["obs"] - r["base"]) ** 2 for r in rows]))
    acc = float(np.mean([r["cls_obs"] == r["cls_pred"] for r in rows]))
    acc0 = float(np.mean([r["cls_obs"] == r["cls_base"] for r in rows]))
    d = paired_difference([(r["obs"] - r["pred"]) ** 2 for r in rows], [(r["obs"] - r["base"]) ** 2 for r in rows], [r["day"] for r in rows])
    return {"status": "ok", "races": len(rows), "mse": round(mse, 4), "mse_baseline": round(mse0, 4),
            "skill": round(1 - mse / mse0, 4) if mse0 else None, "paired_mse": {**d, "verdict": verdict(d)},
            "class_accuracy": round(acc, 4), "class_accuracy_majority": round(acc0, 4),
            "note": "observed pace = winner time/last-3F relative to as-of course baseline; descriptive, not 200m laps"}


def _corner_report(rows: list[dict]) -> dict:
    out: dict[str, Any] = {}
    for which in ("first", "last"):
        sel = [r for r in rows if r["which"] == which and r["rho"] is not None]
        if len(sel) < 20:
            out[which] = {"status": "insufficient", "races": len(sel)}
            continue
        out[which] = {"status": "ok", "races": len(sel), "mean_spearman": round(float(np.mean([r["rho"] for r in sel])), 4),
                      "mae": round(float(np.mean([r["mae"] for r in sel])), 4),
                      "mae_baseline": round(float(np.mean([r["mae_base"] for r in sel])), 4)}
    return out
