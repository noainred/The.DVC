"""설정 접근 인증 — 초기 비밀번호 파일 · 계정 · 세션 · 잠금."""

import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hub.auth import (AuthError, SessionStore, UserStore, generate_password,  # noqa: E402
                      hash_password, verify_password)


class PasswordTest(unittest.TestCase):
    def test_hash_and_verify(self):
        record = hash_password("correct horse battery")
        self.assertTrue(verify_password(record, "correct horse battery"))
        self.assertFalse(verify_password(record, "wrong password"))

    def test_salt_is_random(self):
        self.assertNotEqual(hash_password("same-password-1")["hash"],
                            hash_password("same-password-1")["hash"])

    def test_short_password_rejected(self):
        with self.assertRaises(AuthError):
            hash_password("1234567")

    def test_verify_tolerates_broken_record(self):
        self.assertFalse(verify_password({}, "x"))
        self.assertFalse(verify_password({"salt": "zz", "hash": "zz"}, "x"))

    def test_generated_password_avoids_confusing_chars(self):
        for _ in range(20):
            password = generate_password()
            self.assertEqual(len(password), 20)
            for ch in "0O1lI":
                self.assertNotIn(ch, password)


class UserStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.initial = base / "initial-settings-password.txt"
        self.store = UserStore(base / "users.json", self.initial)

    def tearDown(self):
        self.tmp.cleanup()

    def test_bootstrap_creates_admin_and_password_file(self):
        password = self.store.bootstrap()
        self.assertTrue(password)
        self.assertTrue(self.initial.exists())
        self.assertEqual(self.initial.stat().st_mode & 0o777, 0o600)
        # 파일에 적힌 비밀번호로 실제 로그인이 되어야 한다.
        self.assertEqual(self.store.authenticate(password)["username"], "admin")

    def test_bootstrap_is_idempotent(self):
        first = self.store.bootstrap()
        self.assertIsNone(self.store.bootstrap())
        self.assertEqual(self.store.authenticate(first)["role"], "admin")

    def test_password_change_removes_initial_file(self):
        self.store.bootstrap()
        self.assertTrue(self.store.initial_password_present())
        self.store.set_password("admin", "new-admin-password-1")
        self.assertFalse(self.initial.exists(),
                         "비밀번호를 바꿨는데 초기 비밀번호 파일이 남으면 낡은 값이 유효한 줄 알게 된다.")
        self.assertIsNotNone(self.store.authenticate("new-admin-password-1"))

    def test_duplicate_password_rejected(self):
        self.store.bootstrap()
        self.store.set_password("admin", "shared-password-123")
        with self.assertRaises(AuthError):
            # 로그인은 비밀번호만으로 계정을 찾으므로 중복은 '누구로 로그인되는지'를 흐린다.
            self.store.add("operator", "viewer", "shared-password-123")

    def test_disabled_user_cannot_login(self):
        self.store.bootstrap()
        self.store.add("viewer1", "viewer", "viewer-password-123")
        self.assertIsNotNone(self.store.authenticate("viewer-password-123"))
        self.store.update("viewer1", enabled=False)
        self.assertIsNone(self.store.authenticate("viewer-password-123"))

    def test_cannot_remove_last_admin(self):
        self.store.bootstrap()
        self.store.add("viewer1", "viewer", "viewer-password-123")
        with self.assertRaises(AuthError):
            self.store.delete("admin")
        with self.assertRaises(AuthError):
            self.store.update("admin", role="viewer")

    def test_public_list_hides_hashes(self):
        self.store.bootstrap()
        for entry in self.store.public_list():
            self.assertNotIn("password", entry)
            self.assertTrue(entry["hasPassword"])


class SessionTest(unittest.TestCase):
    def test_create_resolve_destroy(self):
        sessions = SessionStore(60, 3, 60)
        created = sessions.create({"username": "admin", "role": "admin"})
        self.assertEqual(sessions.resolve(created["token"])["username"], "admin")
        sessions.destroy(created["token"])
        self.assertIsNone(sessions.resolve(created["token"]))

    def test_expired_session_rejected(self):
        sessions = SessionStore(0, 3, 60)
        created = sessions.create({"username": "admin", "role": "admin"})
        time.sleep(0.01)
        self.assertIsNone(sessions.resolve(created["token"]))

    def test_lockout_after_failures(self):
        sessions = SessionStore(60, 3, 60)
        self.assertEqual(sessions.lock_remaining(), 0)
        for _ in range(3):
            sessions.note_failure()
        self.assertGreater(sessions.lock_remaining(), 0,
                           "무차별 대입에 잠금이 걸리지 않으면 비밀번호만으로 뚫린다.")

    def test_destroy_user_kills_all_their_sessions(self):
        sessions = SessionStore(60, 3, 60)
        a = sessions.create({"username": "admin", "role": "admin"})
        b = sessions.create({"username": "viewer1", "role": "viewer"})
        sessions.destroy_user("admin")
        self.assertIsNone(sessions.resolve(a["token"]))
        self.assertIsNotNone(sessions.resolve(b["token"]))


if __name__ == "__main__":
    unittest.main()
