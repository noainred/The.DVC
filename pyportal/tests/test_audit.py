"""감사 로그 — JSON Lines · 비밀값 제외 · 회전 · 권한(0600)."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hub import audit as audit_mod  # noqa: E402
from hub.audit import AuditLog  # noqa: E402


class AuditTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "audit.log"
        self.log = AuditLog(self.path)

    def tearDown(self):
        self.tmp.cleanup()

    def test_write_produces_one_json_line_per_event(self):
        self.log.write("login", actor="admin", client="10.0.0.1")
        self.log.write("settings.update", actor="admin", detail={"section": "backup"})
        lines = self.path.read_text(encoding="utf-8").strip().splitlines()
        self.assertEqual(len(lines), 2)
        first = json.loads(lines[0])
        self.assertEqual(first["action"], "login")
        self.assertEqual(first["actor"], "admin")
        self.assertTrue(first["ts"].endswith("Z"))

    def test_secret_looking_keys_are_dropped(self):
        self.log.write("user.create", detail={"target": "op1", "password": "hunter2",
                                              "apiToken": "abc", "passwordHash": "x"})
        raw = self.path.read_text(encoding="utf-8")
        self.assertIn("op1", raw)
        for secret in ("hunter2", "apiToken", "passwordHash"):
            self.assertNotIn(secret, raw)

    def test_file_mode_is_owner_only(self):
        self.log.write("login", actor="admin")
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o600,
                         "누가 무엇을 했는지도 운영 정보다 — 다른 계정이 읽으면 안 된다.")

    def test_tail_returns_newest_first(self):
        for index in range(5):
            self.log.write("event%d" % index)
        entries = self.log.tail(3)
        self.assertEqual([entry["action"] for entry in entries],
                         ["event4", "event3", "event2"])

    def test_tail_on_missing_file_is_empty(self):
        self.assertEqual(AuditLog(Path(self.tmp.name) / "none.log").tail(), [])

    def test_broken_line_does_not_break_tail(self):
        self.log.write("login")
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write("{깨진 줄\n")
        self.log.write("logout")
        self.assertEqual([entry["action"] for entry in self.log.tail()], ["logout", "login"])

    def test_rotation_keeps_file_bounded(self):
        original = audit_mod.MAX_BYTES
        audit_mod.MAX_BYTES = 512               # 회전을 빨리 유발
        try:
            for index in range(200):
                self.log.write("event", detail={"n": index, "pad": "x" * 60})
        finally:
            audit_mod.MAX_BYTES = original
        self.assertTrue(self.path.with_suffix(".log.1").exists(),
                        "상한을 넘으면 회전해서 디스크를 무한히 먹지 않아야 한다.")
        self.assertLess(self.path.stat().st_size, 512 * 4)

    def test_write_never_raises_on_unwritable_path(self):
        broken = AuditLog(Path(self.tmp.name) / "nodir" / "sub" / "a.log")
        broken._path = Path("/proc/definitely-not-writable/a.log")   # noqa: SLF001
        broken.write("login")       # 예외가 나면 요청 자체가 실패한다


if __name__ == "__main__":
    unittest.main()
