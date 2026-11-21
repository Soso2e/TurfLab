import unittest
from forecast_lab.axis_x import Horse
from forecast_lab.axis_x_v02 import (
    PastRun, RaceContext, Needs, Skills, Entry,
    condition_similarity, historical_form, horse_jockey_fit, predict_v02,
)

def base(n, score=65):
    return Horse(n, score, 70, {"slow": 50, "normal": 50, "fast": 50})

class AxisXV02Tests(unittest.TestCase):
    def setUp(self):
        self.context = RaceContext(1600, "turf", "tokyo", "good", "normal")

    def test_weight_6211(self):
        values = (90, 30, 70, 10)
        runs = tuple(PastRun(x, 1600, "turf", "tokyo", "good", "normal") for x in values)
        out = historical_form(runs, self.context)
        self.assertAlmostEqual(out["score"], 68)
        self.assertEqual(out["coverage"], 1)

    def test_distance_mismatch_lowers_good_run_transfer(self):
        same = PastRun(90, 1600, "turf")
        other = PastRun(90, 2400, "turf")
        self.assertGreater(condition_similarity(same, self.context)["score"],
                           condition_similarity(other, self.context)["score"])
        self.assertGreater(historical_form((same,), self.context)["score"],
                           historical_form((other,), self.context)["score"])

    def test_missing_context_exposed(self):
        out = condition_similarity(PastRun(75, 1600, "turf"), self.context)
        self.assertIn("going", out["unknown"])
        self.assertNotIn("going", out["factors"])

    def test_partial_coverage(self):
        out = historical_form((PastRun(85, 1600, "turf"),), self.context)
        self.assertEqual(out["coverage"], 0.6)

    def test_jockey_match(self):
        hard = Needs(100, 10, 10)
        self.assertGreater(horse_jockey_fit(hard, Skills(90, 50, 50)),
                           horse_jockey_fit(hard, Skills(10, 50, 50)))
        self.assertIsNone(horse_jockey_fit(None, Skills(90, 50, 50)))

    def test_integration_and_legacy_fallback(self):
        run = PastRun(95, 1600, "turf", "tokyo", "good", "normal")
        entries = [Entry(base(1, 70), (run,), Needs(100, 0, 0), Skills(90, 50, 50)),
                   Entry(base(2, 60)), Entry(base(3, 50))]
        out = predict_v02(entries, self.context)
        self.assertEqual(out["model"], "axis-x-v0.2")
        self.assertEqual(out["axis"], 1)
        self.assertTrue(out["evidence"][1]["history_missing"])

    def test_invalid_data(self):
        with self.assertRaises(ValueError):
            historical_form((PastRun(120, 1600, "turf"),), self.context)
        with self.assertRaises(ValueError):
            historical_form(tuple(PastRun(70, 1600, "turf") for _ in range(5)), self.context)

if __name__ == "__main__":
    unittest.main()
