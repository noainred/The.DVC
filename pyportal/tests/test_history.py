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

    def test_rollup_is_updated_on_record(self):
        now = int(time.time())
        self.history.record([result("a", latency=10), result("a", latency=30),
                             result("b", status="unreachable", latency=0, code=0)], ts=now)
        row = self.history._db.execute(                         # noqa: SLF001 — 롤업 내용 직접 확인
            "SELECT total, up, down, lat_sum, lat_n, lat_max FROM checks_hourly "
            "WHERE shortcut_id='a'").fetchone()
        self.assertEqual((row["total"], row["up"], row["down"]), (2, 2, 0))
        self.assertEqual((row["lat_sum"], row["lat_n"], row["lat_max"]), (40, 2, 30))

    def test_long_range_series_uses_rollup(self):
        """일주일·한달 차트는 롤업 테이블만 읽는다 — 원본을 지워도 값이 유지된다."""
        now = int(time.time())
        for day in range(5):
            self.history.record([result("a"), result("a", status="unreachable", code=0)],
                                ts=now - day * 86400)
        before = self.history.series("7d")["summary"]
        self.assertEqual(before["samples"], 10)
        self.assertEqual(before["failures"], 5)

        self.history._db.execute("DELETE FROM checks")          # noqa: SLF001 — 원본만 제거
        self.history._db.commit()                               # noqa: SLF001
        after = self.history.series("7d")["summary"]
        self.assertEqual(after["samples"], 10)                  # 롤업에서 그대로 나온다
        self.assertEqual(self.history.series("1h")["summary"]["samples"], 0)   # 짧은 범위는 원본

    def test_rollup_backfills_existing_db(self):
        """롤업 도입 이전 DB 를 열면 원본을 한 번 접어 넣는다(빈 장기 차트 방지)."""
        now = int(time.time())
        self.history.record([result("a"), result("a")], ts=now - 3600)
        self.history._db.execute("DELETE FROM checks_hourly")   # noqa: SLF001 — 구버전 상태 재현
        self.history._db.commit()                               # noqa: SLF001
        path = self.history._path                               # noqa: SLF001
        self.history.close()

        reopened = HealthHistory(path, retention_days=3)
        try:
            self.assertEqual(reopened.series("7d")["summary"]["samples"], 2)
        finally:
            reopened.close()
            self.history = HealthHistory(path, retention_days=3)   # tearDown 이 닫을 수 있게

    def test_prune_also_clears_rollup(self):
        now = int(time.time())
        self.history.record([result("a")], ts=now - 10 * 86400)
        self.history.prune()
        self.assertIsNone(self.history._db.execute(              # noqa: SLF001
            "SELECT 1 FROM checks_hourly LIMIT 1").fetchone())

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
