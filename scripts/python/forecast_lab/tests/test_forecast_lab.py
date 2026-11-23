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


class Source(unittest.TestCase):
    def test_zip_and_duplicates_are_handled_without_touching_the_source(self):
        import hashlib
        import zipfile
        from forecast_lab.audit import audit
        from forecast_lab.source import load_runs
        runs = synthetic.generate(days=20, races_per_day=6, seed=9)
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            synthetic.write_nar_csv(runs, root / "a")
            with zipfile.ZipFile(root / "a" / "again.zip", "w") as z:  # same data again, as a ZIP
                z.write(root / "a" / "races.csv", "month/races.csv")
                z.write(root / "a" / "horses.csv", "month/horses.csv")
            before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (root / "a").iterdir()}
            loaded, prov = load_runs(root / "a")
            after = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (root / "a").iterdir()}
            self.assertEqual(before, after)  # read-only
            self.assertEqual(prov["zip_files"], 1)
            self.assertEqual(prov["dedupe"]["exact_duplicates_removed"], len(runs))
            self.assertEqual(len(loaded), len(runs))
            rep = audit(loaded, provenance=prov)
            self.assertEqual(rep["status"], "ok")
            self.assertGreater(rep["name_identity"]["same_name_in_two_races_same_day"], 0)  # synthetic horses re-run daily

    def test_conflicting_duplicate_races_are_quarantined(self):
        from forecast_lab.data import clean_runs
        runs = synthetic.generate(days=3, races_per_day=2, seed=1)
        bad = dict(runs[0]); bad["finish"] = 99
        kept, rep = clean_runs(runs + [bad])
        self.assertEqual(rep["conflicting_races_quarantined"], 1)
        self.assertTrue(all((r["date"], r["race_no"]) != (runs[0]["date"], runs[0]["race_no"]) for r in kept))


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


class LearningFlagFeedback(unittest.TestCase):
    def test_flag_weights_and_as_of_risk_isolation(self):
        from forecast_lab.analysis_feedback import AnalysisIndex, flag_weight, summarize_feedback
        self.assertEqual(flag_weight("normal"), 1.0)
        self.assertEqual(flag_weight("irregular_one_time"), 0.25)
        self.assertEqual(flag_weight("horse_risk_accumulate"), 0.5)
        self.assertEqual(flag_weight("pending"), 0.0)

        analyses = [
            {"race_date": "2026-10-01", "horse_name": "HorseA", "learning_flag": "horse_risk_accumulate", "race_id": "r1"},
            {"race_date": "2026-10-15", "horse_name": "HorseA", "learning_flag": "horse_risk_accumulate", "race_id": "r2"},
            {"race_date": "2026-10-20", "horse_name": "HorseA", "learning_flag": "normal", "race_id": "r3"},
            {"race_date": "2026-10-15", "horse_name": "HorseB", "learning_flag": "pending", "race_id": "r2"},
            {"race_date": "2026-10-15", "horse_name": "HorseC", "learning_flag": "ability_model_candidate", "race_id": "r2"},
            {"race_date": "2026-10-15", "horse_name": "HorseD", "learning_flag": "pace_model_candidate", "race_id": "r2"},
        ]
        idx = AnalysisIndex(analyses)
        # Strict < cutoff: 2026-10-15 itself is excluded when predicting 2026-10-15
        self.assertEqual(idx.horse_risk_before("HorseA", "2026-10-01"), (0, 0))
        self.assertEqual(idx.horse_risk_before("HorseA", "2026-10-15"), (1, 1))
        self.assertEqual(idx.horse_risk_before("HorseA", "2026-10-20"), (2, 2))
        self.assertEqual(idx.horse_risk_before("HorseA", "2026-10-21"), (2, 3))

        w = idx.race_training_weight({"date": "2026-10-15"}, [{"horse_name": "HorseB"}])
        self.assertEqual(w, 0.0)
        summary = summarize_feedback(analyses)
        self.assertEqual(summary["pending_excluded"], 1)
        self.assertEqual(len(summary["ability_model_candidates"]), 1)
        self.assertEqual(len(summary["pace_model_candidates"]), 1)
        self.assertEqual(summary["horse_risk_horses"][0], {"horse": "HorseA", "count": 2})

    def test_backtest_with_analyses_runs_and_reports_feedback(self):
        runs = synthetic.generate(days=70, races_per_day=10, seed=7)
        races = group_races(runs)
        analyses = []
        for i, r in enumerate(races[:30]):
            flag = ["normal", "irregular_one_time", "pending", "ability_model_candidate", "pace_model_candidate"][i % 5]
            analyses.append({
                "race_date": r["date"],
                "race_id": f"{r['track']}-{r['date']}-{r['race_no']}",
                "horse_name": r["entries"][0]["horse_name"],
                "learning_flag": flag,
            })
        with tempfile.TemporaryDirectory() as d:
            rep = run_backtest(runs, {}, "dev", Path(d), analyses=analyses)
        self.assertEqual(rep["status"], "ok")
        self.assertIn("learning_flag_feedback", rep)
        self.assertEqual(rep["learning_flag_feedback"]["total_analyses"], 30)
        self.assertEqual(rep["learning_flag_feedback"]["pending_excluded"], 6)


if __name__ == "__main__":
    unittest.main()
