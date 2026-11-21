"""Synthetic NAR-like data with a planted, learnable signal (tests and `demo`). Not real data."""
from __future__ import annotations

import csv
import math
from datetime import date, timedelta
from pathlib import Path

import numpy as np


def generate(days: int = 90, races_per_day: int = 12, seed: int = 7, start: str = "2026-06-01"):
    rng = np.random.default_rng(seed)
    n_horses = 160
    names = [f"馬{i:03d}" for i in range(n_horses)]
    strength = rng.normal(0, 1.0, n_horses)
    early = 0.4 * strength + rng.normal(0, 1.0, n_horses)
    jockeys = [f"騎手{j:02d}" for j in range(14)]
    jskill = rng.normal(0, 0.4, len(jockeys))
    y, m, d = map(int, start.split("-"))
    d0 = date(y, m, d)
    runs = []
    for day in range(days):
        ds = (d0 + timedelta(days=day)).isoformat()
        for rno in range(1, races_per_day + 1):
            n = int(rng.integers(8, 13))
            pick = rng.choice(n_horses, n, replace=False)
            dist = int(rng.choice([1200, 1400, 1600]))
            jk = rng.choice(len(jockeys), n)
            perf = strength[pick] + jskill[jk] + rng.gumbel(0, 1.0, n)
            order = np.argsort(-perf)
            finish = np.empty(n, dtype=int)
            finish[order] = np.arange(1, n + 1)
            e = early[pick] + rng.normal(0, 0.8, n)
            c1 = np.empty(n, dtype=int)
            c1[np.argsort(-e)] = np.arange(1, n + 1)
            pressure = float((e > 0.8).sum()) - 2.0
            front200 = 12.3 - 0.25 * pressure + rng.normal(0, 0.12)
            last200 = 12.2 + 0.2 * pressure + rng.normal(0, 0.12)
            l3 = 3 * last200 - 0.35 * (strength[pick] - strength[pick].mean()) + rng.normal(0, 0.25, n)
            total = front200 * (dist - 600) / 200 + 3 * last200
            nums = rng.permutation(n) + 1
            for i in range(n):
                runs.append({
                    "track": "高知", "date": ds, "race_no": rno, "surface": "dirt", "distance_m": dist,
                    "going": "良", "draw": int(math.ceil(nums[i] / (n / 8))), "horse_number": int(nums[i]),
                    "jockey": jockeys[jk[i]], "horse_name": names[pick[i]], "finish": int(finish[i]),
                    "finish_time_s": round(total + 0.2 * (finish[i] - 1), 1), "last_3f_s": round(float(l3[i]), 1),
                    "corners": [int(c1[i]), int(c1[i])], "carried_weight_kg": 55.0, "source": "synthetic",
                })
    runs = _field_size(runs)
    return runs


def _field_size(runs):
    from collections import Counter
    c = Counter((r["track"], r["date"], r["race_no"]) for r in runs)
    for r in runs:
        r["field_size"] = c[(r["track"], r["date"], r["race_no"])]
    return runs


def write_nar_csv(runs, out_dir: Path) -> None:
    """Write the two NAR-style CSVs that analyze_history.load_nar_csv_dir understands."""
    out_dir.mkdir(parents=True, exist_ok=True)
    races = {}
    for r in runs:
        races[(r["track"], r["date"], r["race_no"])] = r
    with open(out_dir / "races.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["競馬場", "競走年月日", "レース番号", "芝ダート区分", "距離", "馬場", "レース名"])
        for (tr, dt, no), r in races.items():
            w.writerow([tr, dt.replace("-", "/"), no, "ダート", r["distance_m"], "良", "テスト"])
    with open(out_dir / "horses.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["競馬場", "競走年月日", "レース番号", "枠番", "馬番", "馬名", "騎手名", "着順", "タイム", "上り3F", "通過順", "負担重量"])
        for r in runs:
            t = r["finish_time_s"]
            tm = f"{int(t // 60)}:{t - 60 * int(t // 60):04.1f}"
            w.writerow([r["track"], r["date"].replace("-", "/"), r["race_no"], r["draw"], r["horse_number"],
                        r["horse_name"], r["jockey"], r["finish"], tm, r["last_3f_s"],
                        "-".join(str(c) for c in r["corners"]), r["carried_weight_kg"]])
