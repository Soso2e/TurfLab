import json
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
import tempfile
import unittest

import numpy as np

from ..data import HistoryIndex
from ..track_day_eval import feature_matrix

from ..track_day import available, bucket, measure, snapshot
from ..track_day_source import corner_ranks
from ..track_day_store import append, Conflict
from ..track_day_live import ingest_card

DAY = "2026-11-22"
NOW = DAY + "T05:20:00Z"


def race(number, **fields):
    return {"race_id": f"race-{number}", "race_no": number, "date": DAY, "track_code": "test",
            "surface": "dirt", "distance_m": 1200, "entries": [
                {"horse_number": i, "finish": i, "corners": [i, i, i], "status": "finished"}
                for i in range(1, 8)
            ], **fields}


def write(root, number):
    r = race(number)
    return append(root, snapshot([r], r, {}, mode="historical_replay"))[1]


class TrackDay(unittest.TestCase):
    def test_boundaries_and_status(self):
        self.assertEqual([bucket(i, 7) for i in range(1, 8)],
                         ["front", "front", "front", "middle", "rear", "rear", "rear"])
        r = race(1)
        r["entries"] += [{"horse_number": 8, "status": "scratched"}, {"horse_number": 9, "status": "excluded"}]
        r["entries"][5].update(finish=None, status="dnf", corners=[])
        stats = measure([r], 5)
        self.assertEqual(stats["pos_groups"]["rear"]["n"], 2)
        self.assertAlmostEqual(stats["pos_groups"]["rear"]["expected_top3_count"], 6 / 7)
        self.assertIsNone(stats["pos_residual"])
        r["entries"][3].update(finish=None, status="unknown")
        self.assertEqual(measure([r])["missing"]["ineligible_races"], 1)
        r["entries"][3].update(finish=3, status="finished")
        self.assertEqual(measure([r])["missing"]["ineligible_races"], 1)
        self.assertEqual(measure([{**r, "entries": r["entries"][:3]}])["missing"]["ineligible_races"], 1)
        self.assertEqual(corner_ranks("10-4,2,(5,*8)-(3,7)-6-1-9")[8], 4)

    def test_as_of_and_order(self):
        a, b, future = race(1), race(2), race(3)
        x = snapshot([future, a, b], b, {}, mode="historical_replay", computed_at=NOW)
        a["entries"].reverse()
        future["entries"][0]["finish"] = 99
        self.assertEqual(x, snapshot([b, a], b, {}, mode="historical_replay", computed_at=NOW))
        self.assertFalse(available(x, DAY + "T06:00:00Z", DAY + "T07:00:00Z"))
        self.assertIsNone(x["published_at_max"])
        self.assertIsNone(x["pos_excess_shrunk"])

    def test_target_result_cannot_change_features(self):
        prior, target = race(1), race(2)
        idx = HistoryIndex([])
        before = feature_matrix(target, idx, {}, [prior], 5)
        target["entries"][0].update(finish=7, corners=[7], last_3f_s=1)
        np.testing.assert_array_equal(before, feature_matrix(target, idx, {}, [prior], 5))

    def test_live_receipt_order(self):
        a = race(1, observed_at=DAY + "T05:25:00Z")
        b = race(2, observed_at=DAY + "T05:10:00Z", published_at=DAY + "T05:05:00Z")
        c = race(3, observed_at=DAY + "T05:10:00Z", published_at=DAY + "T05:05:00Z")
        result = snapshot([c, a, b], b, {}, mode="live_observed", computed_at=NOW, expected_ids=["race-1", "race-2"])
        self.assertEqual(result["source_race_ids"], ["race-2"])
        self.assertEqual(result["missing_race_ids"], ["race-1"])
        self.assertTrue(available(result, NOW, DAY + "T06:00:00Z"))
        self.assertFalse(available(result, DAY + "T05:19:59Z", DAY + "T06:00:00Z"))
        b["published_at"] = None
        self.assertFalse(snapshot([b], b, {}, mode="live_observed", computed_at=NOW)["availability_verified"])

    def test_live_receipt_extends_with_late_result(self):
        first = race(1, observed_at=DAY + "T05:15:00Z")
        second = race(2, observed_at=DAY + "T05:10:00Z")
        kwargs = {"mode": "live_observed", "computed_at": NOW, "expected_ids": ["race-1", "race-2"]}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            before, _ = append(root, snapshot([second], second, {}, **kwargs))
            updated, written = append(root, snapshot([first, second], second, {}, **kwargs))
            self.assertTrue(written)
            self.assertEqual(updated["revision_reason"], "late_delivery")
            self.assertEqual(updated["previous_input_hash"], before["input_hash"])
            second["observed_at"] = NOW
            self.assertFalse(append(root, snapshot([first, second], second, {}, **kwargs))[1])
            second["entries"][0].update(corners=[2, 2, 2])
            with self.assertRaisesRegex(Conflict, "OFFICIAL_CORRECTION_EVIDENCE_REQUIRED"):
                append(root, snapshot([first, second], second, {}, **kwargs))

    def test_parallel_append_repeat_correction_and_conflict(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with ProcessPoolExecutor(3) as executor:
                results = list(executor.map(write, [root] * 5, [1, 2, 2, 3, 3]))
            self.assertEqual(sum(results), 3)
            path = next(root.rglob("*.jsonl"))
            original = path.read_bytes()
            r = race(1)
            before = snapshot([r], r, {}, mode="historical_replay")
            r["entries"][0]["corners"] = [2, 2, 2]
            after = snapshot([r], r, {}, mode="historical_replay")
            with self.assertRaisesRegex(Conflict, "REVISION_CONFLICT"):
                append(root, {**after, "revision": 1})
            self.assertTrue(append(root, after, correction_of=before["input_hash"],
                                   correction_evidence="official notice")[1])
            self.assertFalse(append(root, after)[1])
            self.assertTrue(path.read_bytes().startswith(original))
            self.assertEqual(json.loads(path.read_text(encoding="utf-8").splitlines()[-1])["revision"], 2)
            path.write_bytes(path.read_bytes().replace(b"race-1", b"race-X", 1))
            with self.assertRaisesRegex(Conflict, "LOCAL_FILE_CONFLICT"):
                append(root, after)

    def test_card_reports_missing_unregistered_source_race(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = race(1, observed_at=DAY + "T05:10:00Z")
            card = {"date": DAY, "track_code": "test", "source_url": "https://www.keiba.go.jp/",
                    "schedule": [{"race_no": i, "race_id": f"race-{i}", "surface": "dirt"} for i in (1, 2)],
                    "results": [r]}
            report = ingest_card(Path(tmp), card, NOW)
            self.assertEqual(report["missing_race_ids"], ["race-2"])
            self.assertEqual(report["races"][0]["written"], 1)
