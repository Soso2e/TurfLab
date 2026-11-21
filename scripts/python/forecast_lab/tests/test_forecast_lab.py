import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from forecast_lab import synthetic  # noqa: E402
from forecast_lab.data import HistoryIndex, group_races, strip_prerace  # noqa: E402
from forecast_lab.evaluate import LeakageError, check_time_invariance, run_backtest  # noqa: E402
from forecast_lab.features import FEATURES, build_race_features  # noqa: E402
from forecast_lab.models import top3_probabilities  # noqa: E402
from forecast_lab.stats import benjamini_hochberg, paired_difference, verdict  # noqa: E402

RUNS = synthetic.generate(days=60, races_per_day=10, seed=3)


class Leakage(unittest.TestCase):
    def test_target_race_results_cannot_reach_features(self):
        races = group_races(RUNS)
        r = races[400]
        idx = HistoryIndex(RUNS)
        base = build_race_features(r, r["entries"], idx)
        poisoned = copy.deepcopy(r["entries"])
        for e in poisoned:  # scramble every post-race field of the target race
            e["finish"], e["finish_time_s"], e["last_3f_s"], e["corners"] = 99, 1.0, 1.0, [1, 1]
        self.assertTrue(np.array_equal(base, build_race_features(r, poisoned, idx)))
        self.assertEqual(set(strip_prerace(poisoned[0])), set(strip_prerace(r["entries"][0])))
        self.assertNotIn("finish", strip_prerace(r["entries"][0]))

    def test_future_rows_do_not_change_features(self):
        races = group_races(RUNS)
        self.assertGreater(check_time_invariance(RUNS, races, 25), 20)

    def test_invariance_check_catches_a_planted_leak(self):
        races = group_races(RUNS)
        import forecast_lab.features as F
        original = F.horse_features

        def leaky(entry, race, field, idx, wm):
            out = original(entry, race, field, idx, wm)
            future = [x for x in idx.horse.get(entry.get("horse_name") or "", []) if x["date"] >= race["date"]]
            out["form3"] += 0.01 * len(future)  # peeks at the future
            return out

        F.horse_features = leaky
        try:
            with self.assertRaises(LeakageError):
                check_time_invariance(RUNS, races, 60)
        finally:
            F.horse_features = original

    def test_no_odds_or_popularity_inputs(self):
        for name in FEATURES:
            self.assertFalse(any(w in name for w in ("odds", "pop", "ninki")))


class Evaluation(unittest.TestCase):
    def test_signal_is_recovered_and_holdout_is_one_shot(self):
        runs = synthetic.generate(days=80, races_per_day=12, seed=11)
        with tempfile.TemporaryDirectory() as d:
            st = Path(d)
            dev = run_backtest(runs, {}, "dev", st)
            self.assertEqual(dev["status"], "ok")
            self.assertLess(dev["paired_log_loss"]["M1_vs_uniform"]["mean"], -0.05)
            self.assertTrue(dev["window"]["test_days"] > 20)
            fin = run_backtest(runs, {}, "final", st)
            self.assertEqual(fin["mode"], "final")
            self.assertGreaterEqual(fin["window"]["test_races"], 30)
            with self.assertRaises(PermissionError):
                run_backtest(runs, {}, "final", st)
            self.assertEqual(len((st / "trial_log.jsonl").read_text().splitlines()), 2)

    def test_dev_and_final_windows_do_not_overlap(self):
        runs = synthetic.generate(days=70, races_per_day=10, seed=5)
        with tempfile.TemporaryDirectory() as d:
            dev = run_backtest(runs, {}, "dev", Path(d))
            fin = run_backtest(runs, {}, "final", Path(d))
            self.assertLessEqual(dev["window"]["holdout_start"], fin["window"]["holdout_start"])
            self.assertEqual(dev["window"]["holdout_start"], fin["window"]["holdout_start"])

    def test_no_false_superiority_on_pure_noise(self):
        """If outcomes are independent of every feature, the report must not claim superiority."""
        rng = np.random.default_rng(1)
        runs = copy.deepcopy(synthetic.generate(days=70, races_per_day=12, seed=2))
        by_race = {}
        for r in runs:
            by_race.setdefault((r["track"], r["date"], r["race_no"]), []).append(r)
        for rs in by_race.values():
            order = rng.permutation(len(rs)) + 1
            for r, f in zip(rs, order):
                r["finish"] = int(f)
        with tempfile.TemporaryDirectory() as d:
            rep = run_backtest(runs, {}, "dev", Path(d))
        self.assertNotEqual(rep["paired_log_loss"]["M1_vs_uniform"]["verdict"], "superiority_candidate")
        self.assertGreater(rep["paired_log_loss"]["M1_vs_uniform"]["ci95"][1], 0)

    def test_ablation_keeps_the_informative_group_only_with_evidence(self):
        runs = synthetic.generate(days=80, races_per_day=12, seed=11)
        with tempfile.TemporaryDirectory() as d:
            rep = run_backtest(runs, {"ablate": True}, "dev", Path(d))
        by = {a["group"]: a for a in rep["ablation"]}
        # planted: jockey skill and per-horse strength (carried by cond); draw/rest carry no signal
        self.assertEqual(by["jockey"]["decision"], "keep")
        self.assertEqual(by["draw"]["decision"], "no_evidence_candidate_for_removal")
        self.assertEqual(len(by), 7)

    def test_small_samples_are_never_claimed(self):
        d = paired_difference([1.0] * 10, [1.2] * 10, [f"d{i}" for i in range(10)])
        self.assertEqual(verdict(d), "insufficient_sample")


class Math(unittest.TestCase):
    def test_top3_sums_to_three(self):
        p = np.array([0.3, 0.2, 0.15, 0.1, 0.1, 0.08, 0.07])
        self.assertAlmostEqual(float(top3_probabilities(p).sum()), 3.0, places=9)

    def test_bh(self):
        self.assertEqual(benjamini_hochberg([0.001, 0.5, 0.9], 0.1), [True, False, False])


class Predict(unittest.TestCase):
    def test_live_forecast_record_is_odds_free_and_normalised(self):
        import subprocess
        with tempfile.TemporaryDirectory() as d:
            out = subprocess.run([sys.executable, str(Path(__file__).resolve().parents[1] / "cli.py"), "demo", "--out-dir", d],
                                 capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, out.stderr)
            f = json.loads((Path(d) / "forecast.json").read_text())
            self.assertAlmostEqual(sum(h["win_probability"] for h in f["horses"]), 1.0, places=4)
            self.assertFalse(f["inputs_attestation"]["odds_used"])
            blob = json.dumps(f).lower()
            self.assertNotIn("odds", blob.replace('"odds_used"', ""))


if __name__ == "__main__":
    unittest.main()
