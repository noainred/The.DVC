"""링크 점검 이력 DB — 적재 · 기간별 집계 · 보관기간 정리."""

import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hub.history import BUCKETS, RANGES, HealthHistory  # noqa: E402


def result(shortcut_id, status="healthy", latency=30, code=200):
    return {"id": shortcut_id, "url": "https://x.internal/" + shortcut_id, "status": status,
            "statusCode": code, "latencyMs": latency, "message": "HTTP " + str(code)}


class HistoryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.history = HealthHistory(Path(self.tmp.name) / "h.db", retention_days=3)

    def tearDown(self):
        self.history.close()
        self.tmp.cleanup()

    def test_record_and_stats(self):
        self.assertEqual(self.history.record([result("a"), result("b")]), 2)
        stats = self.history.stats()
        self.assertEqual(stats["rows"], 2)
        self.assertEqual(stats["retentionDays"], 3)

    def test_record_empty_is_noop(self):
        self.assertEqual(self.history.record([]), 0)

    def test_latest_returns_newest_per_shortcut(self):
        now = int(time.time())
        self.history.record([result("a", latency=10)], ts=now - 100)
        self.history.record([result("a", latency=99)], ts=now)
        latest = self.history.latest()
        self.assertEqual(latest["a"]["latencyMs"], 99)

    def test_series_buckets_and_summary(self):
        now = int(time.time())
        # 1시간 범위, 버킷 120초 → 서로 다른 버킷에 들어가도록 간격을 둔다.
        for offset in (0, 300, 600, 900):
            self.history.record([result("a", latency=40 + offset // 100)], ts=now - offset)
        self.history.record([result("a", status="unreachable", latency=0, code=0)], ts=now - 60)

        series = self.history.series("1h")
        self.assertEqual(series["range"], "1h")
        self.assertEqual(series["bucketSeconds"], BUCKETS["1h"])
        self.assertGreaterEqual(len(series["points"]), 3)
        self.assertEqual(series["summary"]["samples"], 5)
        self.assertEqual(series["summary"]["failures"], 1)
        self.assertLess(series["summary"]["uptimePct"], 100)

    def test_series_filters_by_shortcut(self):
        now = int(time.time())
        self.history.record([result("a"), result("b")], ts=now)
        only_a = self.history.series("1h", "a")
        self.assertEqual(only_a["summary"]["samples"], 1)

    def test_series_window_excludes_old_rows(self):
        now = int(time.time())
        self.history.record([result("a")], ts=now - 7200)     # 2시간 전
        self.history.record([result("a")], ts=now)
        self.assertEqual(self.history.series("1h")["summary"]["samples"], 1)
        self.assertEqual(self.history.series("24h")["summary"]["samples"], 2)

    def test_unknown_range_falls_back_to_24h(self):
        self.assertEqual(self.history.series("bogus")["range"], "24h")

    def test_all_ranges_have_buckets(self):
        # 화면 버튼과 서버 집계가 어긋나면 특정 기간만 빈 차트가 된다.
        self.assertEqual(set(RANGES), set(BUCKETS))
        for key in RANGES:
            self.assertGreater(RANGES[key], BUCKETS[key])

    def test_prune_removes_rows_past_retention(self):
        now = int(time.time())
        self.history.record([result("a")], ts=now - 10 * 86400)   # 보관기간(3일) 밖
        self.history.record([result("a")], ts=now)
        self.assertEqual(self.history.stats()["rows"], 2)
        self.assertEqual(self.history.prune(), 1)
        self.assertEqual(self.history.stats()["rows"], 1)

    def test_uptime_percentage(self):
        now = int(time.time())
        rows = [result("a") for _ in range(3)] + [result("a", status="unreachable")]
        self.history.record(rows, ts=now)
        point = self.history.series("1h")["points"][0]
        self.assertEqual(point["total"], 4)
        self.assertEqual(point["up"], 3)
        self.assertEqual(point["uptimePct"], 75.0)


if __name__ == "__main__":
    unittest.main()
