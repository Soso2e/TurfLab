#!/usr/bin/env python3
"""TurfLab Python History & NAR CSV Quantitative Analyzer.

Reads local NAR official CSVs (UTF-8 / Shift_JIS) and optional TurfLab race
context / past runs / outcomes JSON, then computes course biases, jockey
profiles, horse time/pace indices, and model feedback for AI predictions.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import os
import re
import statistics
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path
from typing import Any


def norm_text(val: Any) -> str:
    if val is None:
        return ""
    s = unicodedata.normalize("NFKC", str(val))
    return re.sub(r"[\s\u3000]+", "", s)


def norm_track(val: Any) -> str:
    return re.sub(r"競馬場$", "", norm_text(val))


def norm_surface(val: Any) -> str:
    s = norm_text(val).lower()
    if "芝" in s or s == "turf":
        return "turf"
    if "ダ" in s or s == "dirt":
        return "dirt"
    return "unknown"


def norm_going(val: Any) -> str | None:
    s = norm_text(val)
    return s if s in ("良", "稍重", "重", "不良") else None


def norm_date(val: Any) -> str | None:
    s = norm_text(val)
    m = re.match(r"^(\d{4})\D?(\d{1,2})\D?(\d{1,2})", s)
    if not m:
        return None
    return f"{m.group(1)}-{m.group(2).zfill(2)}-{m.group(3).zfill(2)}"


def parse_int(val: Any) -> int | None:
    s = re.sub(r"[^\d]", "", norm_text(val))
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        return None


def parse_float(val: Any) -> float | None:
    s = norm_text(val)
    if not s:
        return None
    try:
        v = float(s)
        return v if math.isfinite(v) and v > 0 else None
    except ValueError:
        return None


def parse_seconds(val: Any) -> float | None:
    s = norm_text(val)
    m = re.match(r"^(?:(\d{1,2})[:.])?(\d{1,2}\.\d)$", s)
    if not m:
        return None
    sec = (int(m.group(1)) * 60 if m.group(1) else 0) + float(m.group(2))
    return round(sec, 1) if 0 < sec < 600 else None


def parse_corners(val: Any) -> list[int]:
    if isinstance(val, list):
        out = []
        for x in val:
            iv = parse_int(x)
            if iv is not None and iv > 0:
                out.append(iv)
        return out
    s = norm_text(val)
    if not s:
        return []
    nums = re.findall(r"\d+", s)
    return [int(n) for n in nums if int(n) > 0]


def decode_csv_bytes(raw: bytes) -> str:
    for enc in ("utf-8-sig", "utf-8", "cp932", "shift_jis"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("cp932", errors="replace")


def find_col(header_norm: list[str], candidates: tuple[str, ...]) -> int:
    for c in candidates:
        nc = norm_text(c)
        if nc in header_norm:
            return header_norm.index(nc)
    return -1


def load_nar_csv_dir(csv_dir: Path, before_date: str | None = None) -> dict[str, Any]:
    if not csv_dir.exists() or not csv_dir.is_dir():
        return {"files": 0, "runs": [], "date_range": None, "tracks": []}

    csv_files = sorted(
        p for p in csv_dir.rglob("*") if p.is_file() and p.suffix.lower() == ".csv"
    )
    races_meta: dict[tuple[str, str, int], dict[str, Any]] = {}
    horse_tables: list[tuple[list[str], list[list[str]]]] = []

    for fpath in csv_files:
        text = decode_csv_bytes(fpath.read_bytes())
        reader = csv.reader(io.StringIO(text))
        rows_raw = [r for r in reader if any(cell.strip() for cell in r)]
        if len(rows_raw) < 2:
            continue
        header = [norm_text(h) for h in rows_raw[0]]
        body = rows_raw[1:]

        has_horse = (
            find_col(header, ("馬番",)) >= 0
            and find_col(header, ("着順",)) >= 0
            and find_col(header, ("騎手名", "騎手")) >= 0
        )
        has_race = (
            find_col(header, ("距離",)) >= 0
            and find_col(header, ("馬場",)) >= 0
            and find_col(header, ("レース番号", "R")) >= 0
        )

        if has_race:
            idx_tr = find_col(header, ("競馬場", "場名"))
            idx_dt = find_col(header, ("競走年月日", "開催日", "日付"))
            idx_no = find_col(header, ("レース番号", "R"))
            idx_sf = find_col(header, ("芝ダート区分", "芝ダ", "コース"))
            idx_ds = find_col(header, ("距離",))
            idx_gg = find_col(header, ("馬場", "馬場状態"))
            idx_rn = find_col(header, ("レース名", "競走名"))
            if idx_tr >= 0 and idx_dt >= 0 and idx_no >= 0:
                for r in body:
                    if max(idx_tr, idx_dt, idx_no) >= len(r):
                        continue
                    dt = norm_date(r[idx_dt])
                    no = parse_int(r[idx_no])
                    if not dt or no is None:
                        continue
                    tr = norm_track(r[idx_tr])
                    races_meta[(tr, dt, no)] = {
                        "surface": norm_surface(r[idx_sf]) if idx_sf >= 0 and idx_sf < len(r) else "unknown",
                        "distance_m": parse_int(r[idx_ds]) if idx_ds >= 0 and idx_ds < len(r) else None,
                        "going": norm_going(r[idx_gg]) if idx_gg >= 0 and idx_gg < len(r) else None,
                        "race_name": r[idx_rn].strip() if idx_rn >= 0 and idx_rn < len(r) else None,
                    }

        if has_horse:
            horse_tables.append((header, body))

    runs: list[dict[str, Any]] = []
    race_field_sizes: dict[tuple[str, str, int], int] = defaultdict(int)

    for header, body in horse_tables:
        idx_tr = find_col(header, ("競馬場", "場名"))
        idx_dt = find_col(header, ("競走年月日", "開催日", "日付"))
        idx_no = find_col(header, ("レース番号", "R"))
        idx_gate = find_col(header, ("枠番", "枠"))
        idx_hn = find_col(header, ("馬番",))
        idx_jk = find_col(header, ("騎手名", "騎手"))
        idx_fin = find_col(header, ("着順",))
        idx_nm = find_col(header, ("馬名",))
        idx_tm = find_col(header, ("タイム", "走破タイム"))
        idx_3f = find_col(header, ("上り", "上がり", "上り3F", "上がり3F", "推定上り"))
        idx_cor = find_col(header, ("通過順", "コーナー通過順", "通過"))
        idx_wt = find_col(header, ("負担重量", "斤量"))

        for r in body:
            if max(idx_tr, idx_dt, idx_no, idx_hn, idx_jk, idx_fin) >= len(r):
                continue
            dt = norm_date(r[idx_dt])
            if not dt:
                continue
            if before_date and dt >= before_date:
                continue
            raw_fin = norm_text(r[idx_fin])
            if not raw_fin or re.search(r"[取除欠]", raw_fin):
                continue
            if re.match(r"^\d+$", raw_fin):
                finish: int | None = int(raw_fin)
            elif re.search(r"[中止失降]", raw_fin):
                finish = None
            else:
                continue

            tr = norm_track(r[idx_tr])
            no = parse_int(r[idx_no])
            if no is None:
                continue
            race_field_sizes[(tr, dt, no)] += 1
            meta = races_meta.get((tr, dt, no), {})
            runs.append(
                {
                    "track": tr,
                    "date": dt,
                    "race_no": no,
                    "surface": meta.get("surface", "unknown"),
                    "distance_m": meta.get("distance_m"),
                    "going": meta.get("going"),
                    "draw": parse_int(r[idx_gate]) if idx_gate >= 0 and idx_gate < len(r) else None,
                    "horse_number": parse_int(r[idx_hn]),
                    "jockey": norm_text(r[idx_jk]),
                    "horse_name": norm_text(r[idx_nm]) if idx_nm >= 0 and idx_nm < len(r) else "",
                    "finish": finish,
                    "finish_time_s": parse_seconds(r[idx_tm]) if idx_tm >= 0 and idx_tm < len(r) else None,
                    "last_3f_s": parse_float(r[idx_3f]) if idx_3f >= 0 and idx_3f < len(r) else None,
                    "corners": parse_corners(r[idx_cor]) if idx_cor >= 0 and idx_cor < len(r) else [],
                    "carried_weight_kg": parse_float(r[idx_wt]) if idx_wt >= 0 and idx_wt < len(r) else None,
                    "source": "nar_csv",
                }
            )

    for run in runs:
        run["field_size"] = race_field_sizes.get((run["track"], run["date"], run["race_no"]))

    dates = sorted({r["date"] for r in runs})
    tracks = sorted({r["track"] for r in runs if r["track"]})
    return {
        "files": len(csv_files),
        "runs": runs,
        "date_range": {"min": dates[0], "max": dates[-1]} if dates else None,
        "tracks": tracks,
    }


def rate(num: int, den: int) -> float | None:
    return round(num / den, 4) if den > 0 else None


def safe_mean(vals: list[float]) -> float | None:
    return round(statistics.fmean(vals), 2) if vals else None


def safe_stdev(vals: list[float]) -> float | None:
    return round(statistics.stdev(vals), 2) if len(vals) >= 2 else None


def style_bucket(corners: list[int], field_size: int | None) -> str | None:
    if not corners or not field_size or field_size <= 0:
        return None
    pos = corners[0]
    ratio = pos / field_size
    if pos == 1:
        return "front_runner"
    if ratio <= 0.35:
        return "stalker"
    if ratio <= 0.70:
        return "mid_pack"
    return "closer"


def draw_bucket(horse_number: int | None, field_size: int | None) -> str | None:
    if horse_number is None or not field_size or field_size <= 0:
        return None
    ratio = horse_number / field_size
    if ratio <= 0.34:
        return "inner"
    if ratio <= 0.67:
        return "middle"
    return "outer"


def compute_course_bias(
    runs: list[dict[str, Any]],
    track: str,
    surface: str,
    distance_m: int | None,
    going: str | None,
) -> dict[str, Any]:
    same_track = [r for r in runs if r["track"] == track]
    same_course = [
        r
        for r in same_track
        if (surface == "unknown" or r["surface"] == surface)
        and (distance_m is None or r["distance_m"] == distance_m)
    ]
    exact_going = [r for r in same_course if going and r["going"] == going]
    pool = exact_going if len(exact_going) >= 20 else same_course
    scope = "exact_going" if len(exact_going) >= 20 else "course_all_goings"

    if not pool:
        return {"scope": "none", "sample_runs": 0, "sample_races": 0}

    race_keys = {(r["track"], r["date"], r["race_no"]) for r in pool}
    draw_stats: dict[str, dict[str, Any]] = {
        k: {"starts": 0, "wins": 0, "top3": 0, "finishes": []}
        for k in ("inner", "middle", "outer")
    }
    style_stats: dict[str, dict[str, Any]] = {
        k: {"starts": 0, "wins": 0, "top3": 0}
        for k in ("front_runner", "stalker", "mid_pack", "closer")
    }
    times: list[float] = []
    last3fs: list[float] = []

    for r in pool:
        fin = r["finish"]
        db = draw_bucket(r.get("horse_number"), r.get("field_size"))
        if db:
            d = draw_stats[db]
            d["starts"] += 1
            if fin == 1:
                d["wins"] += 1
            if fin is not None and fin <= 3:
                d["top3"] += 1
            if fin is not None:
                d["finishes"].append(fin)
        sb = style_bucket(r.get("corners", []), r.get("field_size"))
        if sb:
            s = style_stats[sb]
            s["starts"] += 1
            if fin == 1:
                s["wins"] += 1
            if fin is not None and fin <= 3:
                s["top3"] += 1
        if r.get("finish_time_s"):
            times.append(float(r["finish_time_s"]))
        if r.get("last_3f_s"):
            last3fs.append(float(r["last_3f_s"]))

    return {
        "scope": scope,
        "sample_races": len(race_keys),
        "sample_runs": len(pool),
        "draw_bias": {
            k: {
                "starts": v["starts"],
                "win_rate": rate(v["wins"], v["starts"]),
                "top3_rate": rate(v["top3"], v["starts"]),
                "avg_finish": safe_mean([float(x) for x in v["finishes"]]),
            }
            for k, v in draw_stats.items()
        },
        "style_bias": {
            k: {
                "starts": v["starts"],
                "win_rate": rate(v["wins"], v["starts"]),
                "top3_rate": rate(v["top3"], v["starts"]),
            }
            for k, v in style_stats.items()
        },
        "pace_time_stats": {
            "avg_finish_time_s": safe_mean(times),
            "stdev_finish_time_s": safe_stdev(times),
            "avg_last_3f_s": safe_mean(last3fs),
            "fastest_last_3f_s": min(last3fs) if last3fs else None,
        },
    }


def compute_jockey_profiles(
    runs: list[dict[str, Any]],
    entries: list[dict[str, Any]],
    track: str,
    surface: str,
    distance_m: int | None,
) -> list[dict[str, Any]]:
    by_jockey: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in runs:
        jk = r.get("jockey")
        if jk:
            by_jockey[jk].append(r)

    profiles: list[dict[str, Any]] = []
    seen = set()
    for e in entries:
        jk = norm_text(e.get("jockey_name") or e.get("jockey"))
        if not jk or jk in seen:
            continue
        seen.add(jk)
        jruns = by_jockey.get(jk, [])
        at_track = [r for r in jruns if r["track"] == track]
        at_course = [
            r
            for r in at_track
            if (surface == "unknown" or r["surface"] == surface)
            and (distance_m is None or r["distance_m"] == distance_m)
        ]

        def agg(sub: list[dict[str, Any]]) -> dict[str, Any]:
            wins = sum(1 for r in sub if r["finish"] == 1)
            top3 = sum(1 for r in sub if r["finish"] is not None and r["finish"] <= 3)
            front = sum(
                1
                for r in sub
                if style_bucket(r.get("corners", []), r.get("field_size")) in ("front_runner", "stalker")
            )
            with_corners = sum(1 for r in sub if r.get("corners") and r.get("field_size"))
            return {
                "starts": len(sub),
                "wins": wins,
                "top3": top3,
                "win_rate": rate(wins, len(sub)),
                "top3_rate": rate(top3, len(sub)),
                "early_lead_rate": rate(front, with_corners),
            }

        profiles.append(
            {
                "jockey": jk,
                "overall": agg(jruns),
                "at_track": agg(at_track),
                "at_course": agg(at_course),
            }
        )
    return profiles


def compute_horse_profiles(
    csv_runs: list[dict[str, Any]],
    context: dict[str, Any],
    track: str,
    surface: str,
    distance_m: int | None,
    course_stats: dict[str, Any],
) -> list[dict[str, Any]]:
    by_name: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in csv_runs:
        nm = r.get("horse_name")
        if nm:
            by_name[nm].append(r)

    # Also build course baseline lookup for time_diff_s
    baseline_time: dict[tuple[str, str, int], float] = {}
    baseline_3f: dict[tuple[str, str, int], float] = {}
    grouped_time: dict[tuple[str, str, int], list[float]] = defaultdict(list)
    grouped_3f: dict[tuple[str, str, int], list[float]] = defaultdict(list)
    for r in csv_runs:
        if r.get("distance_m"):
            key = (r["track"], r["surface"], int(r["distance_m"]))
            if r.get("finish_time_s"):
                grouped_time[key].append(float(r["finish_time_s"]))
            if r.get("last_3f_s"):
                grouped_3f[key].append(float(r["last_3f_s"]))
    for k, vals in grouped_time.items():
        if len(vals) >= 3:
            baseline_time[k] = statistics.fmean(vals)
    for k, vals in grouped_3f.items():
        if len(vals) >= 3:
            baseline_3f[k] = statistics.fmean(vals)

    research_horses = {
        h.get("horse_number"): h
        for h in context.get("research_horses", [])
        if isinstance(h, dict) and h.get("horse_number") is not None
    }

    profiles: list[dict[str, Any]] = []
    for e in context.get("entries", []):
        hn = e.get("horse_number")
        name = norm_text(e.get("horse_name"))
        merged_by_date: dict[str, dict[str, Any]] = {}

        for r in by_name.get(name, []):
            merged_by_date[r["date"]] = dict(r)

        rh = research_horses.get(hn, {})
        for r in rh.get("recent_runs", []) if isinstance(rh.get("recent_runs"), list) else []:
            dt = norm_date(r.get("date_jst") or r.get("date"))
            if not dt:
                continue
            existing = merged_by_date.get(dt, {})
            merged_by_date[dt] = {
                "track": norm_track(r.get("track")) or existing.get("track", ""),
                "date": dt,
                "surface": norm_surface(r.get("surface")) if r.get("surface") else existing.get("surface", "unknown"),
                "distance_m": r.get("distance_m") or existing.get("distance_m"),
                "finish": r.get("finish") if r.get("finish") is not None else existing.get("finish"),
                "finish_time_s": r.get("finish_time_s") or existing.get("finish_time_s"),
                "last_3f_s": r.get("last_3f_s") or existing.get("last_3f_s"),
                "corners": r.get("corners") or existing.get("corners") or [],
                "field_size": r.get("field_size") or existing.get("field_size"),
            }

        all_runs = sorted(merged_by_date.values(), key=lambda x: x["date"], reverse=True)
        finishes = [r["finish"] for r in all_runs if r.get("finish") is not None]
        wins = sum(1 for f in finishes if f == 1)
        top3 = sum(1 for f in finishes if f <= 3)
        at_track = [r for r in all_runs if r.get("track") == track]
        at_dist = [
            r
            for r in all_runs
            if distance_m is not None
            and r.get("distance_m") == distance_m
            and (surface == "unknown" or r.get("surface") == surface)
        ]

        time_diffs: list[float] = []
        l3f_diffs: list[float] = []
        l3fs: list[float] = []
        c1_ratios: list[float] = []
        c4_ratios: list[float] = []

        for r in all_runs[:8]:
            if r.get("distance_m"):
                k = (r.get("track", ""), r.get("surface", "unknown"), int(r["distance_m"]))
                if r.get("finish_time_s") and k in baseline_time:
                    time_diffs.append(float(r["finish_time_s"]) - baseline_time[k])
                if r.get("last_3f_s") and k in baseline_3f:
                    l3f_diffs.append(float(r["last_3f_s"]) - baseline_3f[k])
            if r.get("last_3f_s"):
                l3fs.append(float(r["last_3f_s"]))
            corners = r.get("corners") or []
            fs = r.get("field_size")
            if corners and fs and fs > 0:
                c1_ratios.append(corners[0] / fs)
                c4_ratios.append(corners[-1] / fs)

        recent_finishes = [r["finish"] for r in all_runs[:3] if r.get("finish") is not None]
        trend = "unknown"
        if len(recent_finishes) >= 2:
            if recent_finishes[0] < recent_finishes[-1]:
                trend = "improving"
            elif recent_finishes[0] > recent_finishes[-1]:
                trend = "declining"
            else:
                trend = "stable"

        profiles.append(
            {
                "horse_number": hn,
                "horse_name": name,
                "total_runs": len(all_runs),
                "wins": wins,
                "top3": top3,
                "win_rate": rate(wins, len(finishes)),
                "top3_rate": rate(top3, len(finishes)),
                "at_track_runs": len(at_track),
                "at_track_top3": sum(1 for r in at_track if r.get("finish") is not None and r["finish"] <= 3),
                "at_distance_runs": len(at_dist),
                "at_distance_top3": sum(1 for r in at_dist if r.get("finish") is not None and r["finish"] <= 3),
                "avg_time_diff_s": safe_mean(time_diffs),
                "avg_last3f_diff_s": safe_mean(l3f_diffs),
                "best_last3f_s": min(l3fs) if l3fs else None,
                "avg_corner1_ratio": safe_mean(c1_ratios),
                "avg_corner4_ratio": safe_mean(c4_ratios),
                "recent_finishes": recent_finishes,
                "recent_trend": trend,
            }
        )
    return profiles


def summarize_feedback(context: dict[str, Any]) -> dict[str, Any] | None:
    lr = context.get("learning_report")
    if not isinstance(lr, dict):
        return None
    return {
        "races": lr.get("races"),
        "top1_win_rate": lr.get("top1_win_rate"),
        "top1_flat_win": lr.get("top1_flat_win"),
        "hit_plans": lr.get("hit_plans"),
        "ev_plans": lr.get("ev_plans"),
        "recorded_probabilities": lr.get("recorded_probabilities"),
    }


def analyze(csv_dir: Path, context: dict[str, Any]) -> dict[str, Any]:
    track = norm_track(context.get("track"))
    date = norm_date(context.get("race_date_jst"))
    surface = norm_surface(context.get("surface"))
    distance_m = parse_int(context.get("distance_m"))
    going = norm_going(context.get("going"))

    loaded = load_nar_csv_dir(csv_dir, before_date=date)
    csv_runs = loaded["runs"]
    course_bias = compute_course_bias(csv_runs, track, surface, distance_m, going) if track else {}
    jockey_profiles = (
        compute_jockey_profiles(csv_runs, context.get("entries", []), track, surface, distance_m)
        if context.get("entries")
        else []
    )
    horse_profiles = (
        compute_horse_profiles(csv_runs, context, track, surface, distance_m, course_bias)
        if context.get("entries")
        else []
    )

    return {
        "version": "python-history-v1",
        "csv_summary": {
            "dir": str(csv_dir),
            "files": loaded["files"],
            "total_runs": len(csv_runs),
            "date_range": loaded["date_range"],
            "tracks": loaded["tracks"],
        },
        "course_bias": course_bias,
        "jockey_profiles": jockey_profiles,
        "horse_profiles": horse_profiles,
        "model_feedback": summarize_feedback(context),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="TurfLab Python History & CSV Analyzer")
    parser.add_argument("--csv-dir", type=str, default=None, help="Path to NAR CSV directory")
    parser.add_argument("--input", type=str, default=None, help="Path to context JSON (or '-' for stdin)")
    args = parser.parse_args()

    default_home = Path(os.environ.get("LOCALAPPDATA", ".")) / "TurfLab" / "local-predictions" / "nar-csv"
    csv_dir = Path(args.csv_dir) if args.csv_dir else default_home

    context: dict[str, Any] = {}
    if args.input == "-":
        raw = sys.stdin.read().strip()
        if raw:
            context = json.loads(raw)
    elif args.input:
        context = json.loads(Path(args.input).read_text(encoding="utf-8"))

    result = analyze(csv_dir, context)
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
