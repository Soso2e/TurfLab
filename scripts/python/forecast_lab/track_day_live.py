"""Apply an official card receipt without depending on prediction registration."""
from time import perf_counter

from .track_day import instant, snapshot
from .track_day_store import Conflict, append


def ingest_card(root, card, now):
    if not card.get("source_url", "").startswith(("https://www.keiba.go.jp/", "https://www.jra.go.jp/")):
        raise ValueError("official source URL required")
    schedule = {}
    for item in card["schedule"]:
        if item["race_id"] in schedule or item["surface"] not in ("turf", "dirt"):
            raise ValueError("invalid card schedule")
        schedule[item["race_id"]] = item
    received = {}
    for race in card["results"]:
        race_id = race["race_id"]
        expected = schedule.get(race_id)
        if expected is None or race_id in received or not race.get("observed_at"):
            raise ValueError("invalid result receipt")
        if instant(race["observed_at"]) > instant(now):
            raise ValueError("result receipt is in the future")
        received[race_id] = {**race, **expected, "date": card["date"], "track_code": card["track_code"],
                             "source_url": card["source_url"]}
    report = {"covered_race_ids": sorted(received), "missing_race_ids": sorted(set(schedule) - set(received)),
              "unknown_surface_race_ids": sorted(card.get("unknown_surface_race_ids", [])),
              "races": []}
    for race in sorted(received.values(), key=lambda r: (r["race_no"], r["race_id"])):
        start = perf_counter()
        expected = [rid for rid, item in schedule.items() if item["surface"] == race["surface"]
                    and item["race_no"] <= race["race_no"]]
        record = {"race_id": race["race_id"], "written": 0, "failed": 0}
        try:
            value = snapshot(received.values(), race, {"lambda": None}, mode="live_observed",
                             computed_at=now, expected_ids=expected)
            correction = card.get("revisions", {}).get(race["race_id"], {})
            _, written = append(root, value, correction_of=correction.get("previous_input_hash"),
                                correction_evidence=correction.get("official_evidence"))
            record["written"] = int(written)
        except (Conflict, ValueError, OSError) as error:
            record.update(failed=1, error=str(error))
        record["seconds"] = round(perf_counter() - start, 6)
        report["races"].append(record)
    return report
