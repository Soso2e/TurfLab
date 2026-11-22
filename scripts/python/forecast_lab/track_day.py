"""Pure Track Day Profile calculations and point-in-time eligibility."""
from collections import defaultdict
from datetime import datetime
from hashlib import sha256
import json
from statistics import mean, median

TRACK_DAY_VERSION = "track-day-profile-v1"
GROUPS = ("front", "middle", "rear")


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def digest(value):
    return sha256(canonical(value).encode()).hexdigest()


def instant(value):
    if value is None:
        return None
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.utcoffset() is None:
        raise ValueError("timezone required")
    return dt


def available(snapshot, prediction_time, race_start_time):
    cutoff = instant(prediction_time)
    return (
        snapshot["data_mode"] == "live_observed"
        and snapshot["availability_verified"]
        and cutoff < instant(race_start_time)
        and all(snapshot.get(key) and instant(snapshot[key]) <= cutoff for key in
                ("published_at_max", "observed_at_max", "computed_at"))
    )


def grouped_races(rows):
    groups = defaultdict(list)
    for row in rows:
        groups[row["date"], row["track"], row["race_no"]].append(row)
    races = []
    for (day, track, number), entries in sorted(groups.items()):
        # Race metadata is copied from the race table by the archive loader.
        first = min(entries, key=canonical)
        races.append({
            "date": day, "track_code": track, "race_no": number,
            "race_id": f"{day}/{track}/{number}", "entries": sorted(entries, key=canonical),
            **{key: first.get(key) for key in ("surface", "distance_m", "course_id",
                                               "race_class", "going", "weather")},
        })
    return races


def starters(race):
    return [e for e in race["entries"] if e.get("status") not in ("scratched", "excluded")]


def corner(entry, index, size):
    values = entry.get("corners") or []
    if not values or (index == -1 and entry.get("last_corner_known") is False):
        return None
    value = values[index]
    return value if isinstance(value, int) and 1 <= value <= size else None


def top3(entry):
    rank = entry.get("finish")
    return int(1 <= rank <= 3) if isinstance(rank, int) else (
        0 if entry.get("status") in ("dnf", "disqualified") else None
    )


def eligible(race):
    entries = starters(race)
    labels = [top3(e) for e in entries]
    return len(entries) >= 5 and None not in labels and sum(labels) == 3 and sorted(
        e["finish"] for e in entries if top3(e) == 1
    ) == [1, 2, 3]


def bucket(rank, size):
    scaled = 3 * (rank - 1)
    return "front" if scaled <= size - 1 else "rear" if scaled >= 2 * (size - 1) else "middle"


def avg(items):
    return mean(items) if items else None


def contrast(values, field):
    a, b = (values[group][field] for group in ("front", "rear"))
    return a - b if a is not None and b is not None else None


def measure(races, shrink_lambda=None, predictions=None):
    position, draw, residual = (defaultdict(list) for _ in range(3))
    gains = defaultdict(list)
    missing = defaultdict(int)
    for race in races:
        entries = starters(race)
        n = len(entries)
        numbers = [e.get("horse_number") for e in entries]
        gates = {number: rank for rank, number in enumerate(sorted(numbers), 1)} if (
            all(isinstance(x, int) and x > 0 for x in numbers) and len(set(numbers)) == n
        ) else {}
        usable = eligible(race)
        missing["ineligible_races"] += not usable
        prediction = (predictions or {}).get(race["race_id"])
        probs = prediction.get("probabilities", {}) if prediction and (
            prediction.get("trained_through", race["date"]) < race["date"]
        ) else {}
        prob_values = [probs.get(str(number)) for number in numbers]
        has_probs = usable and bool(gates) and all(
            isinstance(p, (float, int)) and 0 <= p <= 1 for p in prob_values
        ) and abs(sum(prob_values) - 3) <= 1e-6
        missing["m1_races"] += usable and not has_probs
        l3fs = sorted(e["last_3f_s"] for e in entries if e.get("last_3f_s") is not None)
        for e, p in zip(entries, prob_values):
            first, last = corner(e, 0, n), corner(e, -1, n)
            positions = e.get("corners") or []
            finish, y = e.get("finish"), top3(e)
            missing["corner4"] += last is None
            if usable:
                if last is not None:
                    group = bucket(last, n)
                    position[group].append((y, 3 / n))
                    if has_probs:
                        residual[group].append(y - p)
                if gates:
                    draw[bucket(gates[e["horse_number"]], n)].append((y, 3 / n))
            if y == 1 and len(l3fs) == n and e.get("last_3f_s") is not None:
                gains["l3f_rank_top3"].append(l3fs.index(e["last_3f_s"]) + 1)
            if len(positions) >= 2 and first is not None and last is not None:
                gains["mid"].append(first - last)
                if y == 1:
                    gains["mid_top3"].append(first - last)
                if len(positions) >= 3 and all(isinstance(i, int) and 1 <= i <= n for i in positions):
                    gains["sweeps"].append(bucket(first, n) != "front" and bucket(last, n) == "front"
                                           and any(a - b >= 3 for a, b in zip(positions, positions[1:])))
            if isinstance(finish, int) and 1 <= finish <= n and last is not None:
                gains["late"].append(last - finish)
                if y == 1:
                    gains["late_top3"].append(last - finish)

    def summarize(groups):
        out = {}
        for group in GROUPS:
            items = groups[group]
            n = len(items)
            observed, expected = sum(y for y, _ in items), sum(p for _, p in items)
            excess = (observed - expected) / n if n else None
            out[group] = {
                "n": n, "top3": observed, "observed_top3_rate": observed / n if n else None,
                "expected_top3_count": expected, "expected_top3_rate": expected / n if n else None,
                "excess": excess, "shrunk_excess": excess * n / (n + shrink_lambda)
                if n and shrink_lambda is not None else None,
            }
        return out

    pos, gates = summarize(position), summarize(draw)
    res = {group: {"mean": avg(residual[group])} for group in GROUPS}
    return {
        "pos_groups": pos, "pos_excess_raw": contrast(pos, "excess"),
        "pos_excess_shrunk": contrast(pos, "shrunk_excess"),
        "pos_residual": contrast(res, "mean") if missing["m1_races"] == 0 else None,
        **{f"pos_residual_{group}": res[group]["mean"] if missing["m1_races"] == 0 else None for group in GROUPS},
        "draw_groups": gates, "draw_excess": contrast(gates, "excess"),
        "mid_gain_mean": avg(gains["mid"]), "late_gain_mean": avg(gains["late"]),
        "mid_gain_top3_mean": avg(gains["mid_top3"]), "late_gain_top3_mean": avg(gains["late_top3"]),
        "closers_4plus": sum(x >= 4 for x in gains["late"]) if gains["late"] else None,
        "sweeps": sum(gains["sweeps"]) if gains["sweeps"] else None,
        "l3f_rank_top3": avg(gains["l3f_rank_top3"]), "missing": dict(missing),
    }


def comparable(target, races, radius=400):
    if not target.get("distance_m"):
        return []
    return [r for r in races if r["track_code"] == target["track_code"]
            and r["surface"] == target["surface"] and r.get("distance_m")
            and abs(r["distance_m"] - target["distance_m"]) <= radius
            and (not (target.get("course_id") or r.get("course_id")) or
                 r.get("course_id") == target.get("course_id"))]


def winning_time(race):
    values = [e["finish_time_s"] for e in starters(race)
              if e.get("finish") == 1 and e.get("finish_time_s")]
    return values[0] if len(values) == 1 else None


def snapshot(races, target, config, *, mode, computed_at=None, history=(), predictions=None, expected_ids=()):
    if mode not in ("historical_replay", "live_observed"):
        raise ValueError("invalid data mode")
    day, track, surface = (target[key] for key in ("date", "track_code", "surface"))
    number = target["race_no"]
    if surface not in ("turf", "dirt"):
        raise ValueError("unknown surface")
    cutoff = instant(computed_at)
    if mode == "live_observed" and cutoff is None:
        raise ValueError("live observations require a calculation time")
    admitted = []
    for race in races:
        if (race["date"], race["track_code"], race["surface"]) != (day, track, surface) or race["race_no"] > number:
            continue
        if mode == "live_observed":
            observed = instant(race.get("observed_at"))
            published = instant(race.get("published_at"))
            finished = instant(race.get("race_finished_at"))
            if not observed or observed > cutoff or (published and published > observed) or (
                finished and finished > (published or observed)
            ):
                continue
        admitted.append({**race, "entries": sorted(race["entries"], key=canonical)})
    admitted.sort(key=lambda r: (r["race_no"], r["race_id"]))
    ids = [r["race_id"] for r in admitted]
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate source race")
    if target["race_id"] not in ids:
        raise ValueError("target race has no eligible source result")
    anchor = next(r for r in admitted if r["race_id"] == target["race_id"])
    comparable_races = comparable(anchor, admitted)
    prior = comparable(anchor, [r for r in history if r["date"] < day])
    prior.sort(key=lambda r: (r["date"], r["race_no"], r["race_id"]))
    usual = measure(prior) if len(prior) >= 5 else {}
    ref = [t for r in prior if r["distance_m"] == anchor.get("distance_m")
           and anchor.get("race_class") and r.get("race_class") == anchor["race_class"]
           and (t := winning_time(r)) is not None]
    win_time = winning_time(anchor)
    predictions = {key: predictions[key] for key in ids if predictions and key in predictions}
    missing_ids = sorted(set(expected_ids) - set(ids))
    def latest(key):
        if mode != "live_observed" or not admitted or any(not r.get(key) for r in admitted):
            return None
        return max((r[key] for r in admitted), key=instant)
    published, observed = latest("published_at"), latest("observed_at")
    source_hash = digest(admitted)
    config_hash = digest(config)
    metrics = measure(comparable_races, config.get("lambda"), predictions)
    return {
        "version": TRACK_DAY_VERSION, "schema_version": 1, "calculation_version": TRACK_DAY_VERSION,
        "data_mode": mode, "date": day, "track_code": track, "surface": surface, "as_of_race_no": number,
        "source_race_ids": ids, "races": [{k: v for k, v in r.items() if k != "entries"}
                                        for r in admitted],
        "runners": sum(len(starters(r)) for r in admitted),
        "distance_m": anchor.get("distance_m"), "course_id": anchor.get("course_id"),
        "distance_band": [anchor["distance_m"] - 400, anchor["distance_m"] + 400]
        if anchor.get("distance_m") else None,
        "distance_scope": "within_400m" if comparable_races else "missing_distance",
        "comparable_races": [r["race_id"] for r in comparable_races],
        "usual_pos_excess": usual.get("pos_excess_raw"), "usual_draw_excess": usual.get("draw_excess"),
        **metrics, "missing_race_ids": missing_ids, "coverage_verified": bool(expected_ids),
        "published_at_max": published, "observed_at_max": observed,
        "race_finished_at": latest("race_finished_at"), "computed_at": computed_at,
        "availability_verified": bool(published and observed),
        "source_hash": source_hash, "config_hash": config_hash,
        "input_hash": digest([source_hash, config_hash, predictions, missing_ids, usual, sorted(ref)]),
        "going": anchor.get("going"), "weather": anchor.get("weather"),
        "cushion": anchor.get("cushion") if anchor.get("authority") == "JRA" else None,
        "moisture": anchor.get("moisture") if anchor.get("authority") == "JRA" else None,
        "time_index": win_time - median(ref) if win_time is not None and len(ref) >= 5 else None,
    }
