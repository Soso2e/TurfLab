"""Development-only replay. Reserved dates are never scored by this command."""
from collections import defaultdict
from datetime import date
import json
from pathlib import Path

import numpy as np

from .data import HistoryIndex
from .features import FEATURES, build_race_features
from .models import ConditionalLogit, top3_probabilities
from .track_day import TRACK_DAY_VERSION, comparable, digest, eligible, measure, starters, top3

SEED = 20261122
CONFIG = {
    "evaluation": "historical_replay_dev_v2", "persistence_bootstrap": 500, "seed": SEED, "bootstrap": 2000,
    "minimum_races": 300, "minimum_days": 20, "alpha": 0.05,
    "train_minimum": 150, "refit_days": 7, "holdout_fraction": 0.2,
    "distance_radius_m": 400, "lambda_calibration_days_fraction": 0.3,
    "lambda_grid": [0, 5, 10, 20, 40], "ridge": 10,
}
TRACK_DAY_FEATURES = ("track_day_position_effect", "track_day_draw_effect")


def paired_stats(delta, days):
    by_day = defaultdict(list)
    for d, value in zip(days, delta):
        by_day[d].append(value)
    if not delta:
        return {"races": 0, "days": 0, "delta_loss": None, "ci95": None, "p": None}
    blocks = [by_day[d] for d in sorted(by_day)]
    observed = float(np.mean(delta))
    rng = np.random.default_rng(SEED)
    count = np.array([len(block) for block in blocks])
    sums = np.array([sum(block) for block in blocks])
    draws = rng.integers(len(blocks), size=(CONFIG["bootstrap"], len(blocks)))
    values = sums[draws].sum(axis=1) / count[draws].sum(axis=1)
    # Null-centered day-block bootstrap, one-sided improvement.
    p = (1 + np.count_nonzero(values - observed <= observed)) / (1 + len(values))
    return {"races": len(delta), "days": len(blocks), "delta_loss": observed,
            "ci95": np.quantile(values, [0.025, 0.975]).tolist(), "p": float(p)}


def rank_correlation(x, y):
    def midranks(values):
        _, inverse, count = np.unique(values, return_inverse=True, return_counts=True)
        return (np.cumsum(count) - (count + 1) / 2)[inverse]
    a, b = midranks(x), midranks(y)
    return float(np.corrcoef(a, b)[0, 1]) if a.std() and b.std() else None


def persistence_stats(values):
    days = len({r[2] for r in values})
    blocks = defaultdict(list)
    for x, y, _, block in values:
        blocks[block].append((x, y))
    result = {"races": len(values), "days": days, "blocks": len(blocks), "spearman": None, "ci95": None}
    if len(values) < 30 or days < 5 or len(blocks) < 5:
        return result
    parts = [np.array(block) for _, block in sorted(blocks.items())]
    rng = np.random.default_rng(SEED)
    result["spearman"] = rank_correlation(*np.concatenate(parts).T)
    samples = []
    for draw in rng.integers(len(parts), size=(CONFIG["persistence_bootstrap"], len(parts))):
        estimate = rank_correlation(*np.concatenate([parts[i] for i in draw]).T)
        if estimate is not None:
            samples.append(estimate)
    if samples:
        result["ci95"] = np.quantile(samples, [0.025, 0.975]).tolist()
    return result


def scores(win, entries):
    p = top3_probabilities(win)
    if not np.isfinite(p).all() or (p < 0).any() or (p > 1).any() or abs(p.sum() - 3) > 1e-6:
        raise ValueError("invalid top-three probabilities")
    y = np.array([top3(e) for e in entries])
    w = next(i for i, e in enumerate(entries) if e["finish"] == 1)
    q = np.clip(p, 1e-15, 1 - 1e-15)
    rank = np.argsort(-win, kind="stable")[:3]
    return (float(-np.mean(y * np.log(q) + (1 - y) * np.log1p(-q))),
            float(np.mean((p - y) ** 2)), float(-np.log(max(win[w], 1e-15))),
            float(rank[0] == w), float(sum(y[rank]) / 3), p, y)


def feature_matrix(race, idx, usual, prior, shrink_lambda):
    entries = starters(race)
    base = build_race_features({"date": race["date"], "track": race["track_code"],
                                **race}, entries, idx)
    early = -base[:, FEATURES.index("early3")]
    has_early = base[:, FEATURES.index("has_corner")]
    numbers = [e.get("horse_number") for e in entries]
    offsets = dict(zip(sorted(numbers), np.linspace(0.5, -0.5, len(numbers)))) if (
        all(isinstance(n, int) for n in numbers) and len(set(numbers)) == len(numbers)) else {}
    draw = np.array([offsets.get(n, 0) for n in numbers])
    u = [usual.get(key) for key in ("pos_excess_raw", "draw_excess")]
    stats = measure(prior, shrink_lambda)
    pos, gates = (stats[key] for key in ("pos_excess_shrunk", "draw_excess"))
    matrix = np.column_stack((base, early * (u[0] or 0), draw * (u[1] or 0),
                              np.full(len(entries), u[0] is not None) * has_early,
                              np.full(len(entries), u[1] is not None and bool(offsets)),
                              early * (pos or 0) * has_early, has_early * (pos is not None),
                              draw * (gates or 0), np.full(len(entries), gates is not None and bool(offsets))))
    return matrix


def panels(races):
    daily, history = defaultdict(list), defaultdict(list)
    output = []
    meeting = {}
    for race in races:
        day, track, surface = (race[k] for k in ("date", "track_code", "surface"))
        key = track, surface
        yesterday = (date.fromordinal(date.fromisoformat(day).toordinal() - 1)).isoformat()
        prior = comparable(race, daily[day, key])
        prev = comparable(race, daily[yesterday, key])
        older = comparable(race, [r for r in history[key] if r["date"] < day])
        latest_day, block = meeting.get(key, (None, day))
        if latest_day not in (day, yesterday):
            block = day
        meeting[key] = day, block
        output.append((race, prior, prev, older, (track, surface, block)))
        daily[day, key].append(race)
        history[key].append(race)
    return output


def choose_lambda(items):
    errors = defaultdict(list)
    for race, prior, _, _, _ in items:
        observed = measure([race])["pos_excess_raw"]
        if observed is None:
            continue
        for value in CONFIG["lambda_grid"]:
            estimate = measure(prior, value)["pos_excess_shrunk"]
            if estimate is not None:
                errors[value].append((estimate - observed) ** 2)
    return min(errors, key=lambda value: (np.mean(errors[value]), -value)) if errors else None


def evaluate(races, audit, out: Path, now):
    days = audit["development_dates"]
    reserved = audit["reserved_dates"]
    if len(days) < 4:
        raise ValueError("too few development days")
    calibration_end = days[max(0, int(len(days) * CONFIG["lambda_calibration_days_fraction"]) - 1)]
    scope = [r for r in races if r["date"] <= days[-1] and r["surface"] in ("turf", "dirt")
             and r["track_code"] not in audit["excluded_tracks_p3"]]
    source_data_hash = digest(scope)
    config = {**CONFIG, "lambda_training_end": calibration_end}
    trial_id = digest([source_data_hash, config, days, reserved])
    state = out.parent / "trial_log.jsonl"
    # A committed reservation precedes scoring, including failures.
    if state.exists() and any(json.loads(line)["trial_id"] == trial_id
                              for line in state.read_text(encoding="utf-8").splitlines()):
        raise FileExistsError("trial already registered in this state directory")
    registration = {
        "trial_id": trial_id, "registered_at": now, "model_version": "M1",
        "feature_version": TRACK_DAY_VERSION, "source_data_hash": source_data_hash,
        "config_hash": digest(config), "training_window": [days[0], calibration_end],
        "evaluation_window": [d for d in days if d > calibration_end],
        "reserved_dates": reserved, "holdout_consumed": False,
        "hypotheses": ["H1", "H2", "H3", "H4"], "thresholds": config,
        "limitations": ["historical_replay", "official publication times unknown", "reserved dates not scored"],
    }
    def log(value):
        with state.open("a", encoding="utf-8") as file:
            file.write(json.dumps(value, ensure_ascii=False, allow_nan=False) + "\n")

    log({**registration, "status": "registered"})
    data = panels(scope)
    lam = choose_lambda([p for p in data if p[0]["date"] <= calibration_end])
    stats = defaultdict(list)
    idx = HistoryIndex([
        {**e, "corners": e["corners"] if e.get("corners") and e["corners"][0] is not None else []}
        for r in scope for e in starters(r) if top3(e) is not None
    ])
    matrices, winners, train_days = [], [], []
    predictions = defaultdict(list)
    last_fit = None
    for race, prior, prev, older, meeting_block in data:
        if not eligible(race):
            continue
        day = race["date"]
        train_n = len(train_days)
        while train_n and train_days[train_n - 1] == day:
            train_n -= 1
        usual = measure(older) if len(older) >= 5 else {}
        if day > calibration_end:
            obs = measure([race])
            for h, preceding, key in (("H1", prior, "pos_excess_raw"), ("H2", prev, "pos_excess_raw"),
                                      ("H4", prior, "draw_excess")):
                x, y, baseline = measure(preceding).get(key), obs.get(key), usual.get(key)
                if x is not None and y is not None and baseline is not None:
                    stats[h].append((x - baseline, y - baseline, day, meeting_block if h == "H2" else (day,)))
                    if h == "H1" and preceding[-1].get("going") and race.get("going"):
                        transition = f"{preceding[-1]['going']}->{race['going']}"
                        stats[f"H3:{transition}"].append((x - baseline, y - baseline, day, (day,)))
                        if preceding[-1]["going"] != race["going"]:
                            stats["H3"].append((x - baseline, y - baseline, day, (day,)))
        matrix = feature_matrix(race, idx, usual, prior, lam)
        entries = starters(race)
        if day > calibration_end and train_n >= CONFIG["train_minimum"]:
            fit_day = date.fromisoformat(day)
            if last_fit is None or (fit_day - last_fit).days >= CONFIG["refit_days"]:
                base = list(range(len(FEATURES) + 4))
                variants = {"M1": base, "H1": base + [base[-1] + 1, base[-1] + 2],
                            "H4": base + [base[-1] + 3, base[-1] + 4]}
                models = {key: ConditionalLogit(cols, (CONFIG["ridge"],)).fit(
                    matrices[:train_n], winners[:train_n]) for key, cols in variants.items()}
                last_fit = fit_day
            for key, model in models.items():
                predictions[key].append((day, scores(model.predict(matrix), entries)))
        matrices.append(matrix)
        train_days.append(day)
        winners.append(next(i for i, e in enumerate(entries) if e["finish"] == 1))

    persistence = {h: persistence_stats(stats[h]) for h in sorted(set(stats) | {"H1", "H2", "H3", "H4"})}
    baseline = predictions["M1"]
    paired = {h: paired_stats([s[0] - b[0] for (_, s), (_, b) in zip(predictions[h], baseline)],
                             [d for d, _ in baseline]) for h in ("H1", "H4")}
    ordered = sorted(paired, key=lambda h: paired[h]["p"] if paired[h]["p"] is not None else 1)
    adjusted = 1
    for rank, h in reversed(list(enumerate(ordered, 1))):
        row = paired[h]
        if row["p"] is not None:
            adjusted = min(adjusted, 2 * row["p"] / rank)
        row["bh_p"] = adjusted if row["p"] is not None else None
        row["verdict"] = ("indeterminate" if row["races"] < 30 else
                          "exploratory_improvement" if row["delta_loss"] < 0 else "no_improvement_in_replay")
    summaries = {}
    for key, rows in predictions.items():
        if rows:
            values = [s for _, s in rows]
            cal = [(float(p), int(y)) for s in values for p, y in zip(s[5], s[6])]
            bins = [[(p, y) for p, y in cal if min(int(10 * p), 9) == i] for i in range(10)]
            summaries[key] = dict(zip(("top3_log_loss", "top3_brier", "win_log_loss", "top1", "top3_overlap"),
                                      np.mean([s[:5] for s in values], axis=0).tolist()))
            summaries[key]["calibration"] = [{"n": len(b), "predicted": float(np.mean([p for p, _ in b])),
                                               "observed": float(np.mean([y for _, y in b]))} if b else {"n": 0}
                                              for b in bins]
    report = {**registration, "status": "complete", "lambda": lam, "persistence": persistence,
              "metrics": summaries, "paired": paired, "verdict": "strict_evaluation_pending"}
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    log(report)
