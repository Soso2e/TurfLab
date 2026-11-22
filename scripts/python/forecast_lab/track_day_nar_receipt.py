"""Convert an operator-delivered official NAR race ZIP to per-track receipts."""
import hashlib
from pathlib import Path
import re
import tempfile

from .track_day import canonical, grouped_races
from .track_day_source import load_archive

SOURCE_URL = "https://www.keiba.go.jp/KeibaWeb/TodayRaceInfo/TodayRaceInfoTop"


def nar_receipts(source: Path, day: str, observed_at: str):
    if source.suffix.lower() != ".zip":
        raise ValueError("official NAR race ZIP required")
    contents = source.read_bytes()
    with tempfile.TemporaryDirectory(prefix="track-day-nar-") as tmp:
        directory = Path(tmp)
        (directory / "race.zip").write_bytes(contents)
        rows, provenance = load_archive(directory)
    if provenance["unreadable_zips"]:
        raise ValueError("unreadable NAR race ZIP")
    results = {r["race_id"]: r for r in grouped_races(rows) if r["date"] == day}
    cards = {}
    for item in provenance["race_list"]:
        if item["date"] != day:
            continue
        track = item["track_code"]
        card = cards.setdefault(track, {
            "date": day, "track_code": track, "source_url": SOURCE_URL,
            "source_sha256": hashlib.sha256(contents).hexdigest(), "schedule": [], "results": [],
            "unknown_surface_race_ids": [],
        })
        if item["surface"] not in ("turf", "dirt"):
            card["unknown_surface_race_ids"].append(item["race_id"])
            continue
        card["schedule"].append(item)
        if item["race_id"] in results:
            card["results"].append({**results[item["race_id"]], "observed_at": observed_at,
                                    "published_at": None, "race_finished_at": None})
    if not cards:
        raise ValueError(f"no official schedule for {day} in delivered ZIP")
    return list(cards.values())


def stage_receipts(source: Path, out: Path, day: str, now: str):
    from datetime import timedelta, timezone
    from .track_day import instant
    if day != instant(now).astimezone(timezone(timedelta(hours=9))).date().isoformat():
        raise ValueError("use backfill for deliveries outside the current Japan date")
    cards = nar_receipts(source, day, now)
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".track-day-", dir=out) as tmp:
        for card in cards:
            if not re.fullmatch(r"[\w-]+", card["track_code"]):
                raise ValueError("invalid official track name")
            name = f"{day}-{card['track_code']}-{card['source_sha256']}.json"
            target = out / name
            if target.exists() or (out / "processed" / name).exists():
                continue
            temporary = Path(tmp) / name
            temporary.write_text(canonical(card) + "\n", encoding="utf-8")
            try:
                # Link a complete file into the inbox without replacing another receipt.
                target.hardlink_to(temporary)
            except FileExistsError:
                continue
    return cards
