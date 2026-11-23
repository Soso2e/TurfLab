"""Official NAR race-list corner tables, joined to the existing archive loader."""
import csv
import io
import re

from .source import staged_copy
from analyze_history import decode_csv_bytes, norm_date, norm_text, norm_track, norm_surface, parse_int, load_nar_csv_dir

TOKEN = re.compile(r"\((?:\*?\d+,)*\*?\d+\)|\*?\d+")


def corner_ranks(text):
    text = norm_text(text)
    if re.sub(r"[,=\-\s]", "", TOKEN.sub("", text)):
        return {}
    ranks, rank = {}, 1
    for item in TOKEN.findall(text):
        numbers = [int(n) for n in re.findall(r"\d+", item)]
        for number in numbers:
            if number in ranks or number <= 0:
                return {}
            ranks[number] = rank
        rank += len(numbers)
    return ranks


def load_archive(path):
    with staged_copy(path) as (staged, provenance):
        metadata, conflicts = {}, set()
        for path in sorted(staged.glob("*.csv")):
            rows = csv.DictReader(io.StringIO(decode_csv_bytes(path.read_bytes())))
            if not {"距離", "馬場", "レース番号"}.issubset(rows.fieldnames or []):
                continue
            for row in rows:
                key = (norm_track(row["競馬場"]), norm_date(row["競走年月日"]), parse_int(row["レース番号"]))
                if not key[1] or not key[2]:
                    continue
                corners = [(norm_text(row.get(f"コーナー名称{i}")), corner_ranks(row.get(f"コーナー通過順{i}") or ""))
                           for i in range(1, 9) if re.search(r"[1-4](?:角|コーナー)$", norm_text(row.get(f"コーナー名称{i}")))]
                value = {
                    "corners_by_gate": corners, "weather": norm_text(row.get("天候")) or None,
                    "race_class": norm_text(row.get("条件")) or None,
                    "course_id": norm_text(row.get("回り")) or None, "declared_size": parse_int(row.get("頭数")),
                    "surface_raw": norm_text(row.get("芝ダート区分")),
                    "distance_raw": parse_int(row.get("距離")), "going_raw": norm_text(row.get("馬場")),
                }
                if key in metadata and metadata[key] != value:
                    conflicts.add(key)
                metadata[key] = value
        loaded = load_nar_csv_dir(staged, preserve_status=True)["runs"]

    seen, exact = {}, 0
    for row in loaded:
        key = (row["track"], row["date"], row["race_no"])
        meta = metadata.get(key, {})
        number = row["horse_number"]
        if meta:
            corners = meta["corners_by_gate"]
            if corners:
                row["corners"] = [ranks.get(number) for _, ranks in corners]
            row["last_corner_known"] = bool(corners and re.search(r"4(?:角|コーナー)$", corners[-1][0]))
            row.update({k: meta[k] for k in ("weather", "race_class", "course_id", "declared_size")})
        identity = (key, number if number is not None else row["horse_name"])
        # The legacy loader field_size counts input rows, including duplicates.
        row.pop("field_size", None)
        if identity not in seen:
            seen[identity] = row
        elif seen[identity] == row:
            exact += 1
        else:
            conflicts.add(key)
    confirmed = {key for (key, _), r in seen.items() if r.get("finish") == 1}
    kept = [r for (key, _), r in seen.items() if key not in conflicts and key in confirmed]
    return kept, {**provenance, "rows_in": len(loaded), "exact_duplicates_removed": exact,
                  "conflicting_races_quarantined": len(conflicts),
                  "race_list_ids": sorted([list(key) for key in metadata]),
                  "race_list": [
                      {"track_code": track, "date": day, "race_no": number,
                       "race_id": f"{day}/{track}/{number}", "surface": norm_surface(value["surface_raw"])}
                      for (track, day, number), value in sorted(metadata.items())
                      if (track, day, number) not in conflicts
                  ]}
