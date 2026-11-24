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


def parse_nar_archive_seconds(value: Any) -> float | None:
    text = norm_text(value)
    match = re.fullmatch(r"(\d{0,2})([0-5]\d)(\d)", text)
    if match:
        return parse_seconds(f"{match[1] or 0}:{match[2]}.{match[3]}")
    return parse_seconds(value)


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


def load_nar_csv_dir(csv_dir: Path, before_date: str | None = None, *, preserve_status: bool = False) -> dict[str, Any]:
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
        idx_margin = find_col(header, ("着差",))
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
            if not preserve_status and (not raw_fin or re.search(r"[取除欠]", raw_fin)):
                continue
            if re.match(r"^\d+$", raw_fin):
                finish: int | None = int(raw_fin)
            elif preserve_status or re.search(r"[中止失降]", raw_fin):
                finish = None
            else:
                continue

            status_text = raw_fin + (norm_text(r[idx_margin]) if 0 <= idx_margin < len(r) else "")
            status = next((value for label, value in (("取消", "scratched"), ("除外", "excluded"),
                           ("中止", "dnf"), ("失格", "disqualified")) if label in status_text),
                          "finished" if finish is not None else "unknown")
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
                    **({"status": status} if preserve_status else {}),
                    "finish_time_s": (parse_nar_archive_seconds if preserve_status else parse_seconds)(r[idx_tm]) if idx_tm >= 0 and idx_tm < len(r) else None,
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


def _merged_horse_runs(
    csv_runs: list[dict[str, Any]],
    context: dict[str, Any],
) -> dict[Any, list[dict[str, Any]]]:
    by_name: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in csv_runs:
        nm = r.get("horse_name")
        if nm:
            by_name[nm].append(r)

    research_horses = {
        h.get("horse_number"): h
        for h in context.get("research_horses", [])
        if isinstance(h, dict) and h.get("horse_number") is not None
    }

    out: dict[Any, list[dict[str, Any]]] = {}
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

        out[hn] = sorted(merged_by_date.values(), key=lambda x: x["date"], reverse=True)
    return out


def compute_horse_profiles(
    csv_runs: list[dict[str, Any]],
    context: dict[str, Any],
    track: str,
    surface: str,
    distance_m: int | None,
    course_stats: dict[str, Any],
    merged_runs: dict[Any, list[dict[str, Any]]] | None = None,
) -> list[dict[str, Any]]:
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

    runs_by_hn = merged_runs if merged_runs is not None else _merged_horse_runs(csv_runs, context)
    profiles: list[dict[str, Any]] = []
    for e in context.get("entries", []):
        hn = e.get("horse_number")
        name = norm_text(e.get("horse_name"))
        all_runs = runs_by_hn.get(hn, [])
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


def _pos_bucket(last_corner: int | None, field_size: int | None) -> str | None:
    if last_corner is None or not field_size or field_size <= 0:
        return None
    if last_corner < 1 or last_corner > field_size:
        return None
    scaled = 3 * (last_corner - 1)
    if scaled <= field_size - 1:
        return "front"
    if scaled >= 2 * (field_size - 1):
        return "rear"
    return "middle"


def compute_same_day_analysis(
    same_day_prior_races: list[dict[str, Any]] | None,
    surface: str,
    distance_m: int | None,
) -> dict[str, Any]:
    empty_pos = {
        k: {"runners": 0, "top3": 0, "top3_rate": None, "shrunk_excess": None}
        for k in ("front", "middle", "rear")
    }
    empty_draw = {
        k: {"runners": 0, "top3": 0, "top3_rate": None, "shrunk_excess": None}
        for k in ("inner", "middle", "outer")
    }
    if not isinstance(same_day_prior_races, list) or not same_day_prior_races:
        return {
            "scope": "none",
            "sampled_races": 0,
            "sampled_runners": 0,
            "pos_groups": empty_pos,
            "draw_groups": empty_draw,
            "front_minus_rear_excess": None,
            "inner_minus_outer_excess": None,
            "top_l3f_top3_rate": None,
            "bias_summary": "当日確定済み前レースなし",
        }

    valid = [r for r in same_day_prior_races if isinstance(r, dict) and isinstance(r.get("runners"), list) and r.get("runners")]
    if surface == "unknown":
        surface_pool = valid
    else:
        surface_pool = [r for r in valid if norm_surface(r.get("surface")) == surface]
        if not surface_pool and any(r.get("surface") is None for r in valid):
            surface_pool = [r for r in valid if r.get("surface") is None]

    comparable = [
        r for r in surface_pool
        if distance_m is not None and parse_int(r.get("distance_m")) is not None
        and abs(int(parse_int(r.get("distance_m")) or 0) - distance_m) <= 400
    ]
    if len(comparable) >= 3:
        pool = comparable
        scope = "within_400m"
    elif surface_pool:
        pool = surface_pool
        scope = "same_surface"
    else:
        return {
            "scope": "none",
            "sampled_races": 0,
            "sampled_runners": 0,
            "pos_groups": empty_pos,
            "draw_groups": empty_draw,
            "front_minus_rear_excess": None,
            "inner_minus_outer_excess": None,
            "top_l3f_top3_rate": None,
            "bias_summary": "当日確定済み前レースなし",
        }

    pos_acc = {k: {"runners": 0, "top3": 0, "expected": 0.0} for k in ("front", "middle", "rear")}
    draw_acc = {k: {"runners": 0, "top3": 0, "expected": 0.0} for k in ("inner", "middle", "outer")}
    sampled_races = 0
    sampled_runners = 0
    l3f_top_hits = 0
    l3f_top_total = 0

    for race in pool:
        runners = [rn for rn in race.get("runners", []) if isinstance(rn, dict)]
        fs = parse_int(race.get("field_size")) or len(runners)
        if fs < 2 or not runners:
            continue
        sampled_races += 1
        exp_p = min(1.0, 3.0 / fs)
        l3f_candidates: list[tuple[float, int]] = []

        for rn in runners:
            fin = parse_int(rn.get("finish"))
            if fin is None or fin < 1:
                continue
            sampled_runners += 1
            is_top3 = 1 if fin <= 3 else 0
            corners = parse_corners(rn.get("corners"))
            last_c = corners[-1] if corners else None
            pb = _pos_bucket(last_c, fs)
            if pb:
                pos_acc[pb]["runners"] += 1
                pos_acc[pb]["top3"] += is_top3
                pos_acc[pb]["expected"] += exp_p

            hn = parse_int(rn.get("horse_number")) or parse_int(rn.get("draw_number"))
            db = draw_bucket(hn, fs)
            if db:
                draw_acc[db]["runners"] += 1
                draw_acc[db]["top3"] += is_top3
                draw_acc[db]["expected"] += exp_p

            l3f = parse_float(rn.get("last_3f_s"))
            if l3f is not None:
                l3f_candidates.append((l3f, is_top3))

        if len(l3f_candidates) >= 3:
            l3f_candidates.sort(key=lambda x: x[0])
            top3_l3f = l3f_candidates[:3]
            l3f_top_total += len(top3_l3f)
            l3f_top_hits += sum(x[1] for x in top3_l3f)

    def _summarize(acc: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
        res: dict[str, dict[str, Any]] = {}
        for k, v in acc.items():
            n = v["runners"]
            if n > 0:
                excess = (v["top3"] - v["expected"]) / n
                shrunk = round(excess * (n / (n + 6.0)), 4)
            else:
                shrunk = None
            res[k] = {
                "runners": n,
                "top3": v["top3"],
                "top3_rate": rate(v["top3"], n),
                "shrunk_excess": shrunk,
            }
        return res

    pos_groups = _summarize(pos_acc)
    draw_groups = _summarize(draw_acc)
    f_ex = pos_groups["front"]["shrunk_excess"]
    r_ex = pos_groups["rear"]["shrunk_excess"]
    front_minus_rear = round(f_ex - r_ex, 4) if (f_ex is not None and r_ex is not None) else None
    i_ex = draw_groups["inner"]["shrunk_excess"]
    o_ex = draw_groups["outer"]["shrunk_excess"]
    inner_minus_outer = round(i_ex - o_ex, 4) if (i_ex is not None and o_ex is not None) else None

    if front_minus_rear is None:
        pos_label = "脚質標本不足"
    elif front_minus_rear >= 0.08:
        pos_label = "先行有利"
    elif front_minus_rear >= 0.03:
        pos_label = "先行やや有利"
    elif front_minus_rear <= -0.08:
        pos_label = "差し有利"
    elif front_minus_rear <= -0.03:
        pos_label = "差しやや有利"
    else:
        pos_label = "脚質フラット"

    if inner_minus_outer is None:
        draw_label = "枠順標本不足"
    elif inner_minus_outer >= 0.08:
        draw_label = "内枠有利"
    elif inner_minus_outer >= 0.03:
        draw_label = "内枠やや有利"
    elif inner_minus_outer <= -0.08:
        draw_label = "外枠有利"
    elif inner_minus_outer <= -0.03:
        draw_label = "外枠やや有利"
    else:
        draw_label = "枠順フラット"

    return {
        "scope": scope,
        "sampled_races": sampled_races,
        "sampled_runners": sampled_runners,
        "pos_groups": pos_groups,
        "draw_groups": draw_groups,
        "front_minus_rear_excess": front_minus_rear,
        "inner_minus_outer_excess": inner_minus_outer,
        "top_l3f_top3_rate": rate(l3f_top_hits, l3f_top_total),
        "bias_summary": f"{pos_label}・{draw_label}（当日{sampled_races}R観測）" if sampled_races else "当日確定済み前レースなし",
    }


def _zscore_list(values: list[float | None]) -> list[float]:
    valid = [v for v in values if v is not None]
    if len(valid) < 2:
        return [0.0] * len(values)
    mu = statistics.fmean(valid)
    var = sum((v - mu) ** 2 for v in valid) / len(valid)
    sd = math.sqrt(var)
    if sd < 1e-9:
        return [0.0] * len(values)
    return [0.0 if v is None else (v - mu) / sd for v in values]


def compute_math_prediction(
    entries: list[dict[str, Any]],
    horse_profiles: list[dict[str, Any]],
    jockey_profiles: list[dict[str, Any]],
    course_bias: dict[str, Any],
    same_day_analysis: dict[str, Any],
    context: dict[str, Any],
    merged_runs: dict[Any, list[dict[str, Any]]] | None = None,
) -> dict[str, Any] | None:
    if not isinstance(entries, list) or len(entries) < 2:
        return None

    n_horses = len(entries)
    hp_by_hn = {h.get("horse_number"): h for h in horse_profiles if isinstance(h, dict)}
    jp_by_name = {norm_text(j.get("jockey")): j for j in jockey_profiles if isinstance(j, dict)}

    jstats_raw = context.get("jockey_stats") if isinstance(context.get("jockey_stats"), dict) else {}
    jstats_by_hn = {}
    for j in jstats_raw.get("jockeys", []) if isinstance(jstats_raw.get("jockeys"), list) else []:
        if isinstance(j, dict) and j.get("horse_number") is not None:
            jstats_by_hn[j.get("horse_number")] = j

    runs_by_hn = merged_runs or {}
    target_distance = parse_int(context.get("distance_m"))

    raw_form: list[float | None] = []
    raw_time: list[float | None] = []
    raw_l3f: list[float | None] = []
    raw_l3f_fallback: list[float | None] = []
    raw_course: list[float | None] = []
    raw_jockey: list[float | None] = []
    early_ratios: list[float | None] = []
    weights_kg: list[float | None] = []
    horse_numbers: list[int] = []
    horse_names: list[str] = []

    for idx, e in enumerate(entries):
        hn_parsed = parse_int(e.get("horse_number"))
        hn = hn_parsed if hn_parsed is not None else (idx + 1)
        horse_numbers.append(hn)
        horse_names.append(norm_text(e.get("horse_name")))

        hp = hp_by_hn.get(e.get("horse_number"), {})
        h_runs = runs_by_hn.get(e.get("horse_number"), [])

        # 1) form: decayed normalized finish over up to 5 recent runs
        w_sum = 0.0
        p_sum = 0.0
        for r_idx, run in enumerate(h_runs[:5]):
            fin = parse_int(run.get("finish"))
            fs = parse_int(run.get("field_size"))
            if fin is not None and fs is not None and fs >= 2:
                perf = min(1.0, max(0.0, 1.0 - (fin - 1) / (fs - 1)))
                w = 0.72 ** r_idx
                w_sum += w
                p_sum += w * perf
        raw_form.append(((p_sum + 2.0 * 0.5) / (w_sum + 2.0)) if w_sum > 0 else None)

        # 2) speed
        raw_time.append(-float(hp["avg_time_diff_s"]) if hp.get("avg_time_diff_s") is not None else None)
        if hp.get("avg_last3f_diff_s") is not None:
            raw_l3f.append(-float(hp["avg_last3f_diff_s"]))
        else:
            raw_l3f.append(None)

        near_l3fs = [
            float(r["last_3f_s"])
            for r in h_runs[:5]
            if r.get("last_3f_s") is not None
            and (target_distance is None or r.get("distance_m") is None or abs(int(r["distance_m"]) - target_distance) <= 200)
        ]
        if near_l3fs:
            raw_l3f_fallback.append(-statistics.fmean(near_l3fs))
        elif hp.get("best_last3f_s") is not None:
            raw_l3f_fallback.append(-float(hp["best_last3f_s"]))
        else:
            raw_l3f_fallback.append(None)

        # 3) course fit
        tr_r = int(hp.get("at_track_runs") or 0)
        tr_t3 = int(hp.get("at_track_top3") or 0)
        ds_r = int(hp.get("at_distance_runs") or 0)
        ds_t3 = int(hp.get("at_distance_top3") or 0)
        if tr_r == 0 and ds_r == 0:
            raw_course.append(None)
        else:
            tr_rate = (tr_t3 + 2.0 * 0.25) / (tr_r + 2.0)
            ds_rate = (ds_t3 + 2.0 * 0.25) / (ds_r + 2.0)
            raw_course.append(0.45 * tr_rate + 0.55 * ds_rate)

        # 4) jockey
        jk_name = norm_text(e.get("jockey_name") or e.get("jockey"))
        jp = jp_by_name.get(jk_name, {})
        jk_bucket = None
        for b_name in ("at_course", "at_track", "overall"):
            cand = jp.get(b_name)
            if isinstance(cand, dict) and int(cand.get("starts") or 0) >= (3 if b_name != "overall" else 1):
                jk_bucket = cand
                break
        if jk_bucket is None:
            js = jstats_by_hn.get(e.get("horse_number"), {})
            for b_name in ("at_track", "overall"):
                cand = js.get(b_name)
                if isinstance(cand, dict) and int(cand.get("starts") or 0) >= (3 if b_name != "overall" else 1):
                    jk_bucket = cand
                    break
        if jk_bucket is not None:
            st = int(jk_bucket.get("starts") or 0)
            wn = int(jk_bucket.get("wins") or 0)
            t3 = int(jk_bucket.get("top3") or 0)
            t3_s = (t3 + 6.0 * 0.25) / (st + 6.0)
            wn_s = (wn + 6.0 * 0.08) / (st + 6.0)
            raw_jockey.append(0.7 * t3_s + 0.3 * wn_s)
        else:
            raw_jockey.append(None)

        # 5) early pace ratio
        er = hp.get("avg_corner1_ratio")
        if er is None:
            er = hp.get("avg_corner4_ratio")
        early_ratios.append(float(er) if er is not None else None)

        # 6) carried weight
        weights_kg.append(parse_float(e.get("carried_weight_kg")))

    form_z = _zscore_list(raw_form)

    has_diff_l3f = sum(1 for v in raw_l3f if v is not None) >= 2
    effective_l3f = raw_l3f if has_diff_l3f else raw_l3f_fallback
    zt = _zscore_list(raw_time)
    zl = _zscore_list(effective_l3f)
    speed_combined: list[float | None] = []
    for i in range(n_horses):
        has_t = raw_time[i] is not None and sum(1 for v in raw_time if v is not None) >= 2
        has_l = effective_l3f[i] is not None and sum(1 for v in effective_l3f if v is not None) >= 2
        if has_t and has_l:
            speed_combined.append(0.55 * zt[i] + 0.45 * zl[i])
        elif has_t:
            speed_combined.append(zt[i])
        elif has_l:
            speed_combined.append(zl[i])
        else:
            speed_combined.append(None)
    speed_z = _zscore_list(speed_combined)

    course_fit_z = _zscore_list(raw_course)
    jockey_z = _zscore_list(raw_jockey)

    # 5) Pace & same-day style bias
    known_early = [r for r in early_ratios if r is not None]
    if len(known_early) >= 3:
        front_runner_share = sum(1 for r in known_early if r <= 0.35) / len(known_early)
    elif known_early:
        front_runner_share = sum(1 for r in known_early if r <= 0.35) / n_horses
    else:
        front_runner_share = 0.30

    if front_runner_share >= 0.40:
        expected_pace = "high"
        pace_edge = -0.10
    elif front_runner_share <= 0.22:
        expected_pace = "slow"
        pace_edge = 0.10
    else:
        expected_pace = "middle"
        pace_edge = 0.0

    style_bias = course_bias.get("style_bias") if isinstance(course_bias.get("style_bias"), dict) else {}
    f_rates = [
        float(style_bias[k]["top3_rate"])
        for k in ("front_runner", "stalker")
        if isinstance(style_bias.get(k), dict) and (style_bias[k].get("starts") or 0) >= 3 and style_bias[k].get("top3_rate") is not None
    ]
    r_rates = [
        float(style_bias[k]["top3_rate"])
        for k in ("mid_pack", "closer")
        if isinstance(style_bias.get(k), dict) and (style_bias[k].get("starts") or 0) >= 3 and style_bias[k].get("top3_rate") is not None
    ]
    past_front_edge = (statistics.fmean(f_rates) - statistics.fmean(r_rates)) if (f_rates and r_rates) else 0.0

    sd_races = int(same_day_analysis.get("sampled_races") or 0)
    same_day_weight = min(1.0, sd_races / 5.0)
    sd_front_edge = float(same_day_analysis.get("front_minus_rear_excess") or 0.0)
    front_env = 0.45 * past_front_edge + same_day_weight * sd_front_edge + pace_edge

    raw_pace_bias: list[float | None] = [
        ((0.5 - er) * front_env) if er is not None else None
        for er in early_ratios
    ]
    pace_bias_z = _zscore_list(raw_pace_bias)

    # 6) Draw bias & weight
    draw_bias = course_bias.get("draw_bias") if isinstance(course_bias.get("draw_bias"), dict) else {}
    in_b = draw_bias.get("inner") if isinstance(draw_bias.get("inner"), dict) else {}
    out_b = draw_bias.get("outer") if isinstance(draw_bias.get("outer"), dict) else {}
    if (in_b.get("starts") or 0) >= 3 and (out_b.get("starts") or 0) >= 3 and in_b.get("top3_rate") is not None and out_b.get("top3_rate") is not None:
        past_draw_edge = float(in_b["top3_rate"]) - float(out_b["top3_rate"])
    else:
        past_draw_edge = 0.0
    sd_inner_edge = float(same_day_analysis.get("inner_minus_outer_excess") or 0.0)
    inner_env = 0.5 * past_draw_edge + same_day_weight * sd_inner_edge

    valid_w = [w for w in weights_kg if w is not None]
    w_mean = statistics.fmean(valid_w) if len(valid_w) >= 2 else None
    raw_draw_weight: list[float | None] = []
    for i in range(n_horses):
        draw_pos = 0.5 - (horse_numbers[i] - 1) / (n_horses - 1) if n_horses > 1 else 0.0
        draw_component = draw_pos * inner_env
        wt = weights_kg[i]
        wt_component = -0.03 * (wt - w_mean) if (wt is not None and w_mean is not None) else 0.0
        if inner_env == 0.0 and wt_component == 0.0:
            raw_draw_weight.append(None)
        else:
            raw_draw_weight.append(draw_component + wt_component)
    draw_weight_z = _zscore_list(raw_draw_weight)

    scores: list[float] = []
    for i in range(n_horses):
        sc = (
            0.32 * form_z[i]
            + 0.20 * speed_z[i]
            + 0.14 * course_fit_z[i]
            + 0.14 * jockey_z[i]
            + 0.13 * pace_bias_z[i]
            + 0.07 * draw_weight_z[i]
        )
        scores.append(max(-3.0, min(3.0, sc)))

    max_s = max(scores)
    exps = [math.exp((s - max_s) / 0.85) for s in scores]
    exp_sum = sum(exps)
    win_probs = [e / exp_sum for e in exps]

    # Discounted Plackett-Luce exact top2 / top3 and ticket candidates
    top2_probs = [0.0] * n_horses
    top3_probs = [0.0] * n_horses
    trio_probs: dict[tuple[int, int, int], float] = defaultdict(float)
    quinella_probs: dict[tuple[int, int], float] = defaultdict(float)
    exacta_probs: dict[tuple[int, int], float] = defaultdict(float)
    trifecta_probs: dict[tuple[int, int, int], float] = defaultdict(float)

    if n_horses >= 3:
        w2 = [p ** 0.81 for p in win_probs]
        w3 = [p ** 0.65 for p in win_probs]
        sum2 = sum(w2)
        sum3 = sum(w3)
        for a in range(n_horses):
            pa = win_probs[a]
            rest2 = sum2 - w2[a]
            if rest2 <= 0:
                continue
            for b in range(n_horses):
                if b == a:
                    continue
                pab = pa * w2[b] / rest2
                rest3 = sum3 - w3[a] - w3[b]
                if rest3 <= 0:
                    continue
                ha, hb = horse_numbers[a], horse_numbers[b]
                for c in range(n_horses):
                    if c == a or c == b:
                        continue
                    prob = pab * w3[c] / rest3
                    hc = horse_numbers[c]
                    top2_probs[a] += prob
                    top2_probs[b] += prob
                    top3_probs[a] += prob
                    top3_probs[b] += prob
                    top3_probs[c] += prob
                    q_key = (min(ha, hb), max(ha, hb))
                    quinella_probs[q_key] += prob
                    exacta_probs[(ha, hb)] += prob
                    t_key = tuple(sorted((ha, hb, hc)))
                    trio_probs[(t_key[0], t_key[1], t_key[2])] += prob
                    trifecta_probs[(ha, hb, hc)] += prob
    else:
        # 2-horse fallback
        for a in range(n_horses):
            b = 1 - a
            prob = win_probs[a]
            ha, hb = horse_numbers[a], horse_numbers[b]
            top2_probs[a] = 1.0
            top3_probs[a] = 1.0
            q_key = (min(ha, hb), max(ha, hb))
            quinella_probs[q_key] += prob
            exacta_probs[(ha, hb)] += prob

    entropy = -sum(p * math.log(max(p, 1e-12)) for p in win_probs)
    h_norm = entropy / math.log(n_horses)
    sorted_p = sorted(win_probs, reverse=True)
    p1 = sorted_p[0]
    p2 = sorted_p[1]
    top_gap = p1 - p2
    confidence_score = round(
        min(1.0, max(0.0, 0.55 * (1.0 - h_norm) + 0.30 * min(1.0, top_gap / 0.18) + 0.15 * min(1.0, p1 / 0.45))),
        4,
    )
    recommended_focus = (
        "trio_or_high_confidence_exacta_quinella_trifecta"
        if confidence_score >= 0.60 and (top_gap >= 0.08 or p1 >= 0.30)
        else "trio"
    )

    ranking_rows = []
    for i in range(n_horses):
        ranking_rows.append({
            "horse_number": horse_numbers[i],
            "horse_name": horse_names[i],
            "math_score": round(scores[i], 4),
            "win_prob": round(win_probs[i], 6),
            "top2_prob": round(min(1.0, top2_probs[i]), 6),
            "top3_prob": round(min(1.0, top3_probs[i]), 6),
            "components": {
                "form_z": round(form_z[i], 3),
                "speed_z": round(speed_z[i], 3),
                "course_fit_z": round(course_fit_z[i], 3),
                "jockey_z": round(jockey_z[i], 3),
                "pace_bias_z": round(pace_bias_z[i], 3),
                "draw_weight_z": round(draw_weight_z[i], 3),
            },
        })
    ranking_rows.sort(key=lambda r: (-r["win_prob"], r["horse_number"]))
    for rank_idx, row in enumerate(ranking_rows, start=1):
        row["rank"] = rank_idx

    def _top_cands(table: dict[Any, float], limit: int) -> list[dict[str, Any]]:
        ordered = sorted(table.items(), key=lambda kv: (-kv[1], kv[0]))[:limit]
        return [{"selections": list(k), "prob": round(v, 6)} for k, v in ordered]

    return {
        "version": "math-algo-v1",
        "expected_pace": expected_pace,
        "front_runner_share": round(front_runner_share, 4),
        "confidence_score": confidence_score,
        "top1_win_prob": round(p1, 6),
        "top1_top2_gap": round(top_gap, 6),
        "recommended_ticket_focus": recommended_focus,
        "same_day_weight_applied": round(same_day_weight, 4),
        "rankings": ranking_rows,
        "ticket_candidates": {
            "trio": _top_cands(trio_probs, 10),
            "quinella": _top_cands(quinella_probs, 5),
            "exacta": _top_cands(exacta_probs, 5),
            "trifecta": _top_cands(trifecta_probs, 5),
        },
    }


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
    entries = context.get("entries", []) if isinstance(context.get("entries"), list) else []
    course_bias = compute_course_bias(csv_runs, track, surface, distance_m, going) if track else {}
    jockey_profiles = (
        compute_jockey_profiles(csv_runs, entries, track, surface, distance_m)
        if entries
        else []
    )
    merged_runs = _merged_horse_runs(csv_runs, context) if entries else {}
    horse_profiles = (
        compute_horse_profiles(csv_runs, context, track, surface, distance_m, course_bias, merged_runs=merged_runs)
        if entries
        else []
    )
    same_day_analysis = compute_same_day_analysis(
        context.get("same_day_prior_races"),
        surface,
        distance_m,
    )
    math_prediction = compute_math_prediction(
        entries,
        horse_profiles,
        jockey_profiles,
        course_bias,
        same_day_analysis,
        context,
        merged_runs=merged_runs,
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
        "same_day_analysis": same_day_analysis,
        "math_prediction": math_prediction,
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
