"""설정 백업 서비스 + 데이터센터 구성 저장소."""

import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hub.backup import BackupService  # noqa: E402
from hub.dcstore import DatacenterStore  # noqa: E402
from hub.jsonfile import write_json  # noqa: E402
from hub.settings import SettingsStore  # noqa: E402
from hub.ssrf import ValidationError  # noqa: E402


class BackupTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.files = {
            "shortcuts": self.base / "shortcuts.json",
            "datacenters": self.base / "datacenters.json",
            "users": self.base / "users.json",
            "settings": self.base / "settings.json",
        }
        write_json(self.files["shortcuts"], [{"id": "sc-1", "name": "원본"}])
        write_json(self.files["users"], [{"username": "admin"}])
        self.settings = SettingsStore(self.files["settings"])
        self.service = BackupService(self.base / "backups", self.files, self.settings)

    def tearDown(self):
        self.tmp.cleanup()

    def test_create_writes_snapshot_with_all_members(self):
        info = self.service.create("manual")
        snapshot = self.service.read(info["name"])
        self.assertIn("shortcuts", snapshot["data"])
        self.assertIn("users", snapshot["data"])
        self.assertEqual(snapshot["data"]["shortcuts"][0]["name"], "원본")
        self.assertEqual((self.base / "backups" / info["name"]).stat().st_mode & 0o777, 0o600,
                         "백업에는 비밀번호 해시가 들어가므로 0600 이어야 한다.")

    def test_keep_setting_prunes_old_backups(self):
        self.settings.update_section("backup", {"keep": 2})
        for _ in range(4):
            self.service.create("manual")
            time.sleep(1.05)     # 파일명이 초 단위라 겹치지 않게
        self.assertEqual(len(self.service.list()), 2)

    def test_restore_puts_files_back_and_snapshots_current(self):
        info = self.service.create("manual")
        write_json(self.files["shortcuts"], [{"id": "sc-2", "name": "바뀐 값"}])
        time.sleep(1.05)
        result = self.service.restore(info["name"])
        self.assertIn("shortcuts", result["restored"])
        restored = json.loads(self.files["shortcuts"].read_text(encoding="utf-8"))
        self.assertEqual(restored[0]["name"], "원본")
        # 복원 직전 상태도 백업으로 남아 되돌리기가 가능해야 한다.
        self.assertGreaterEqual(len(self.service.list()), 2)

    def test_path_traversal_rejected(self):
        for bad in ("../../etc/passwd", "backup-x.json", "/etc/passwd", "backup-20260101-000000.txt"):
            with self.assertRaises((ValueError, FileNotFoundError), msg=bad):
                self.service.read(bad)

    def test_due_respects_interval_and_enabled(self):
        self.settings.update_section("backup", {"enabled": False, "intervalMinutes": 30})
        self.assertFalse(self.service.due())
        self.settings.update_section("backup", {"enabled": True, "intervalMinutes": 30})
        self.assertTrue(self.service.due(), "백업이 하나도 없으면 즉시 대상이어야 한다.")
        self.service.create("auto")
        self.assertFalse(self.service.due(), "방금 백업했으면 주기 전까지는 다시 돌지 않는다.")

    def test_status_reports_settings_and_totals(self):
        self.service.create("manual")
        status = self.service.status()
        self.assertEqual(status["count"], 1)
        self.assertGreater(status["totalBytes"], 0)
        self.assertIn("keep", status["settings"])


class DatacenterStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = DatacenterStore(Path(self.tmp.name) / "datacenters.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_seeds_28_sites_on_first_load(self):
        self.assertEqual(len(self.store.all()), 28)
        self.assertEqual(self.store.summary()["total"], 28)

    def test_add_requires_code_and_name(self):
        with self.assertRaises(ValidationError):
            self.store.add({"code": "", "name": "이름만"})

    def test_add_derives_id_and_clamps_numbers(self):
        created = self.store.add({"code": "BUS-1", "name": "부산 센터", "pue": 99, "lat": 500,
                                  "racks": -5})
        self.assertEqual(created["id"], "bus-1")
        self.assertLessEqual(created["pue"], 5.0)
        self.assertLessEqual(created["lat"], 90)
        self.assertEqual(created["racks"], 0)

    def test_duplicate_id_rejected(self):
        self.store.add({"code": "BUS-1", "name": "부산 센터"})
        with self.assertRaises(ValidationError):
            self.store.add({"code": "BUS-1", "name": "부산 센터 2"})

    def test_update_keeps_id_and_merges(self):
        updated = self.store.update("icn-01", {"racks": 2000, "id": "hacked"})
        self.assertEqual(updated["id"], "icn-01", "ID 를 바꾸면 연결된 바로가기가 끊긴다.")
        self.assertEqual(updated["racks"], 2000)
        self.assertEqual(updated["city"], "Seoul (서울)")

    def test_delete_and_reset(self):
        self.assertTrue(self.store.delete("icn-01"))
        self.assertFalse(self.store.delete("icn-01"))
        self.assertEqual(len(self.store.all()), 27)
        self.assertEqual(len(self.store.reset()), 28)

    def test_unknown_region_and_status_fall_back(self):
        created = self.store.add({"code": "X-1", "name": "X", "region": "MARS", "status": "melted"})
        self.assertEqual(created["region"], "APAC")
        self.assertEqual(created["status"], "operational")


if __name__ == "__main__":
    unittest.main()
