"""CLI: python scripts/python/forecast_lab/cli.py <backtest|predict|demo> ..."""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from analyze_history import load_nar_csv_dir  # noqa: E402

from forecast_lab import predict as predict_mod  # noqa: E402
from forecast_lab import synthetic  # noqa: E402
from forecast_lab.evaluate import run_backtest  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="TurfLab forecast lab (odds-free)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("backtest")
    b.add_argument("--csv-dir", required=True)
    b.add_argument("--out", required=True)
    b.add_argument("--state-dir", required=True)
    b.add_argument("--mode", choices=["dev", "final"], default="dev")
    b.add_argument("--ablate", action="store_true")
    b.add_argument("--allow-repeat-holdout", action="store_true")
    p = sub.add_parser("predict")
    p.add_argument("--csv-dir", required=True)
    p.add_argument("--pack", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--cutoff-at", required=True, help="information cutoff (ISO, tz); must be <= generated-at")
    p.add_argument("--generated-at")
    d = sub.add_parser("demo", help="synthetic end-to-end run (not real data)")
    d.add_argument("--out-dir", required=True)
    a = ap.parse_args(argv)
    if a.cmd == "backtest":
        runs = load_nar_csv_dir(Path(a.csv_dir))["runs"]
        rep = run_backtest(runs, {"ablate": a.ablate}, a.mode, Path(a.state_dir), a.allow_repeat_holdout)
        Path(a.out).write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")
        print(json.dumps({k: rep.get(k) for k in ("status", "mode", "window", "paired_log_loss")}, ensure_ascii=False, indent=1))
        return 0
    if a.cmd == "predict":
        rec = predict_mod.run(Path(a.csv_dir), Path(a.pack), Path(a.out), a.cutoff_at, a.generated_at)
        print(json.dumps({"race": rec["race"]["race_key_human"], "horses": len(rec["horses"])}, ensure_ascii=False))
        return 0
    out = Path(a.out_dir)
    runs = synthetic.generate()
    synthetic.write_nar_csv(runs, out / "csv")
    last = runs[-1]["date"]
    rep = run_backtest(load_nar_csv_dir(out / "csv")["runs"], {}, "dev", out / "state")
    (out / "report.json").write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")
    from datetime import date, timedelta
    y, m, dd = map(int, last.split("-"))
    target = (date(y, m, dd) + timedelta(days=1)).isoformat()
    names = sorted({r["horse_name"] for r in runs})[:10]
    pack = {"track": "高知", "race_date_jst": target, "race_no": 11, "surface": "dirt", "distance_m": 1400,
            "entries": [{"horse_number": i + 1, "horse_name": n, "jockey_name": "騎手01", "draw_number": i // 2 + 1}
                        for i, n in enumerate(names)]}
    (out / "pack.json").write_text(json.dumps(pack, ensure_ascii=False), encoding="utf-8")
    predict_mod.run(out / "csv", out / "pack.json", out / "forecast.json", f"{target}T08:00:00+09:00", f"{target}T09:00:00+09:00")
    print(json.dumps({"status": rep.get("status"), "forecast": str(out / "forecast.json")}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
