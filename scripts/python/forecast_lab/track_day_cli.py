"""Audit or reconstruct a read-only NAR archive into a separate exchange."""
import argparse
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
import json
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    __package__ = "forecast_lab"

from .audit import audit
from .track_day import corner, grouped_races, starters, winning_time
from .track_day_source import load_archive

START, END = "2026-06-01", "2026-12-01"


def track_audit(rows, provenance):
    races = grouped_races(rows)
    per_track = defaultdict(Counter)
    months = defaultdict(Counter)
    cards = Counter()
    status = Counter()
    comparable = Counter()
    previous = defaultdict(list)
    for race in races:
        day, track, surface = (race[k] for k in ("date", "track_code", "surface"))
        entries = starters(race)
        n = len(entries)
        cards[day, track, surface or "unknown"] += 1
        month = months[track, day[:7]]
        month.update({"races": 1, "starters": n})
        counts = per_track[track]
        counts.update({"races": 1, "starters": n, "winning_time": winning_time(race) is None})
        for entry in race["entries"]:
            status[entry["status"]] += 1
        finishes = [e["finish"] for e in entries if e.get("finish") is not None]
        counts["dead_heat_races"] += len(finishes) != len(set(finishes))
        for e in entries:
            counts.update({
                "corner4": corner(e, -1, n) is None, "first_corner": corner(e, 0, n) is None,
                "intermediate_corner": not any(v is not None for v in (e.get("corners") or [])[1:-1]),
                **{k: not e.get(k) or e[k] == "unknown" for k in (
                    "last_3f_s", "finish_time_s", "going", "weather", "horse_number", "draw", "surface", "distance_m")},
            })
        if race["distance_m"] and surface in ("turf", "dirt"):
            key = day, track, surface, race.get("course_id")
            distances = previous[key]
            comparable[str(sum(abs(d - race["distance_m"]) <= 400 for d in distances))] += 1
            distances.append(race["distance_m"])
    compact_provenance = {k: v for k, v in provenance.items() if k not in ("race_list_ids", "race_list")}
    result = audit([e for r in races for e in starters(r)], provenance=compact_provenance)
    days = sorted({r["date"] for r in races})
    cutoff = int(len(days) * 0.8)
    result.update({
        "track_month": {f"{t}/{m}": dict(c) for (t, m), c in sorted(months.items())},
        "surface_cards": {"/".join(k): v for k, v in sorted(cards.items())},
        "card_distribution": dict(Counter(cards.values())),
        "by_track": {t: dict(c) for t, c in sorted(per_track.items())},
        "excluded_tracks_p3": sorted(t for t, c in per_track.items() if not c["starters"] or 5 * c["corner4"] > c["starters"]),
        "distinct_days": len(days), "development_dates": days[:cutoff], "reserved_dates": days[cutoff:],
        "statuses": dict(status), "comparable_prior_races": dict(comparable),
        "race_list_missing_results": sorted(
            set(tuple(key) for key in provenance["race_list_ids"] if START <= key[1] < END)
            - {(r["track_code"], r["date"], r["race_no"]) for r in races}
        ),
        "published_at_known": 0, "observed_at_known": 0,
    })
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("audit", "backfill", "evaluate", "ingest", "sync", "stage-nar"))
    parser.add_argument("--csv-dir", type=Path)
    parser.add_argument("--receipt", type=Path)
    parser.add_argument("--calibration", type=Path)
    parser.add_argument("--snapshot", type=Path)
    parser.add_argument("--zip", type=Path)
    parser.add_argument("--date")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    now = datetime.now(timezone.utc).isoformat()
    out = args.out.resolve()
    if args.command == "stage-nar":
        if not args.zip or not args.date:
            parser.error("--zip and --date are required")
        from .track_day_nar_receipt import stage_receipts
        cards = stage_receipts(args.zip, out, args.date, now)
        print(json.dumps([{"track_code": c["track_code"], "scheduled": len(c["schedule"]),
                           "received": len(c["results"]), "unknown_surface": len(c["unknown_surface_race_ids"])}
                          for c in cards]))
        return 0
    if args.command == "sync":
        if not args.snapshot:
            parser.error("--snapshot is required")
        from .track_day_sync import push_append
        print(json.dumps({"updated": push_append(out, args.snapshot.resolve())}))
        return 0
    if args.command == "ingest":
        if not args.receipt:
            parser.error("--receipt is required")
        from .track_day_live import ingest_card
        result = ingest_card(out, json.loads(args.receipt.read_text(encoding="utf-8-sig")), now)
        print(json.dumps(result, ensure_ascii=True))
        return int(any(r["failed"] for r in result["races"]))
    if not args.csv_dir:
        parser.error("--csv-dir is required")
    src = args.csv_dir.resolve()
    if not src.is_dir() or out.is_relative_to(src) or out.is_relative_to(
        (Path(os.environ["LOCALAPPDATA"]) / "TurfLab" / "local-predictions").resolve()
        if "LOCALAPPDATA" in os.environ else Path.home() / "AppData" / "Local" / "TurfLab" / "local-predictions"
    ):
        parser.error("use an existing archive and an isolated output outside production")
    rows, provenance = load_archive(src)
    rows = [r for r in rows if START <= r["date"] < END]
    if not rows:
        parser.error("no NAR results in scope")
    if args.command == "audit":
        out.write_text(json.dumps(track_audit(rows, provenance), ensure_ascii=False, indent=2), encoding="utf-8")
    elif args.command == "evaluate":
        from .track_day_eval import evaluate
        evaluate(grouped_races(rows), track_audit(rows, provenance), out, now)
    else:
        from .track_day import snapshot
        from .track_day_store import append
        config = {"lambda": None}
        if args.calibration:
            report = json.loads(args.calibration.read_text(encoding="utf-8"))
            config = {"lambda": report["lambda"], "calibration_trial": report["trial_id"],
                      "training_window": report["training_window"]}
        past, day_groups = defaultdict(list), defaultdict(list)
        for r in grouped_races(rows):
            if r["surface"] in ("turf", "dirt"):
                day_groups[r["date"], r["track_code"], r["surface"]].append(r)
        for (_, track, surface), card in sorted(day_groups.items()):
            for race in card:
                value = snapshot(card, race, config, mode="historical_replay",
                                 computed_at=now, history=past[track, surface])
                append(out, value)
            past[track, surface].extend(card)


if __name__ == "__main__":
    sys.exit(main())
