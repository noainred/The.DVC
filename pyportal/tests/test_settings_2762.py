"""v2.762(H5 — 재현): settings.json 의 수 칸이 1e999·Infinity(float inf)면 int() 가 OverflowError 를 던져
설정 전체를 못 읽었다(자동 백업·자동 점검이 매 주기 실패 — B-08 과 같은 결과). 기본값으로 대체해야 한다."""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hub.settings import DEFAULTS, SettingsStore  # noqa: E402


class SettingsOverflowTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "settings.json"

    def tearDown(self):
        self.tmp.cleanup()

    def _load(self, text):
        self.path.write_text(text, encoding="utf-8")
        return SettingsStore(self.path)

    def test_infinite_int_field_falls_back(self):
        for raw in ("1e999", "-1e999", "Infinity", "-Infinity", "NaN"):
            store = self._load('{"backup": {"keep": %s}, "notify": {"failThreshold": %s}}' % (raw, raw))
            self.assertEqual(store.section("backup")["keep"], DEFAULTS["backup"]["keep"], raw)
            self.assertIn("health", store.all(), raw)

    def test_infinite_choice_field_falls_back(self):
        for raw in ("1e999", "Infinity"):
            store = self._load('{"backup": {"intervalMinutes": %s}, "health": {"intervalMinutes": %s}}' % (raw, raw))
            self.assertEqual(store.section("backup")["intervalMinutes"], DEFAULTS["backup"]["intervalMinutes"], raw)
            self.assertEqual(store.section("health")["intervalMinutes"], DEFAULTS["health"]["intervalMinutes"], raw)


if __name__ == "__main__":
    unittest.main()
