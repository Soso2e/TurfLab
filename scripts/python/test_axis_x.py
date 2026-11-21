import unittest
from forecast_lab.axis_x import Horse, Config, predict

def horse(n, base, stability=70, fast=50):
    return Horse(n, base, stability, {"slow": 50, "normal": 50, "fast": fast})

class AxisXTests(unittest.TestCase):
    def test_two_strong(self):
        out = predict([horse(1, 90), horse(2, 88), horse(3, 75), horse(4, 70)], "normal")
        self.assertEqual(out["tier"], "2-strong")
        self.assertEqual(out["contenders"], [1, 2])
        self.assertEqual(out["axis"], 1)

    def test_three_strong(self):
        out = predict([horse(1, 90), horse(2, 87), horse(3, 86), horse(4, 72)], "normal")
        self.assertEqual(out["tier"], "3-strong")

    def test_open_when_four_close(self):
        out = predict([horse(1, 90), horse(2, 89), horse(3, 88), horse(4, 87)], "normal")
        self.assertEqual(out["tier"], "open")

    def test_pace_changes_partner(self):
        hs = [horse(1, 95), horse(2, 80, fast=100), horse(3, 82, fast=0)]
        out = predict(hs, "fast", Config(max_partners=2))
        self.assertEqual(out["axis"], 1)
        self.assertEqual(out["partners"][0], 2)

    def test_x_factor_bounded(self):
        h = Horse(1, 80, 80, {"slow": 100, "normal": 100, "fast": 100},
                  jockey_fit=3, hidden_upside=3, excuse_rebound=2)
        out = predict([h], "normal")
        self.assertLessEqual(abs(out["ranked"][0]["x_factor"]), 15)

    def test_duplicate_rejected(self):
        with self.assertRaises(ValueError):
            predict([horse(1, 90), horse(1, 88)], "normal")

if __name__ == "__main__":
    unittest.main()
