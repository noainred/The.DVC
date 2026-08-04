"""콘솔 복구(v2.225) — 비밀번호 초기화·계정 재생성·외부 프로세스 변경 반영."""
import tempfile
import unittest
from pathlib import Path

from hub.auth import UserStore


class RecoverTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.store = UserStore(base / "users.json", base / "initial.txt")
        self.store.bootstrap()  # admin 생성

    def tearDown(self):
        self.tmp.cleanup()

    def test_recover_existing_resets_password_and_kills_sessions(self):
        before = self.store.token_version("admin")
        r = self.store.recover("admin")
        self.assertFalse(r["created"])
        self.assertTrue(self.store.authenticate("admin", r["password"]))
        self.assertGreater(self.store.token_version("admin"), before)  # 기존 세션 무효

    def test_recover_disabled_account_reenables(self):
        self.store.add("ops", "viewer", "old-password-123")
        self.store.update("ops", enabled=False)
        r = self.store.recover("ops")
        self.assertEqual(r["role"], "viewer")  # 역할은 승격하지 않는다
        self.assertTrue(self.store.authenticate("ops", r["password"]))

    def test_recover_missing_creates_admin(self):
        r = self.store.recover("rescue")
        self.assertTrue(r["created"])
        self.assertEqual(r["role"], "admin")
        self.assertTrue(self.store.authenticate("rescue", r["password"]))

    def test_external_file_change_is_picked_up_without_restart(self):
        """CLI(별도 프로세스)가 바꾼 users.json 을 실행 중 서버가 재시작 없이 반영."""
        other = UserStore(Path(self.tmp.name) / "users.json")  # 같은 파일의 두 번째 핸들 = 별도 프로세스 재현
        r = other.recover("admin")
        # mtime 이 같은 나노초일 수 없도록 강제 갱신 확인 — 첫 핸들에서 새 비밀번호로 로그인돼야 한다.
        self.assertTrue(self.store.authenticate("admin", r["password"]))


if __name__ == "__main__":
    unittest.main()
