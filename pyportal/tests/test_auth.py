"""설정 접근 인증 — 초기 비밀번호 파일 · 계정 · 세션 · 잠금."""

import base64
import json
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
        self.assertEqual(self.store.authenticate("admin", password)["username"], "admin")

    def test_bootstrap_is_idempotent(self):
        first = self.store.bootstrap()
        self.assertIsNone(self.store.bootstrap())
        self.assertEqual(self.store.authenticate("admin", first)["role"], "admin")

    def test_password_change_removes_initial_file(self):
        self.store.bootstrap()
        self.assertTrue(self.store.initial_password_present())
        self.store.set_password("admin", "new-admin-password-1")
        self.assertFalse(self.initial.exists(),
                         "비밀번호를 바꿨는데 초기 비밀번호 파일이 남으면 낡은 값이 유효한 줄 알게 된다.")
        self.assertIsNotNone(self.store.authenticate("admin", "new-admin-password-1"))

    def test_same_password_on_two_accounts_is_allowed(self):
        # v2.216: 로그인이 사용자명+비밀번호가 되면서 비밀번호는 더 이상 식별자가 아니다.
        self.store.bootstrap()
        self.store.set_password("admin", "shared-password-123")
        self.store.add("operator", "viewer", "shared-password-123")
        self.assertEqual(self.store.authenticate("operator", "shared-password-123")["role"],
                         "viewer")
        self.assertEqual(self.store.authenticate("admin", "shared-password-123")["role"], "admin")

    def test_wrong_username_is_rejected(self):
        self.store.bootstrap()
        self.store.add("viewer1", "viewer", "viewer-password-123")
        self.assertIsNone(self.store.authenticate("nosuchuser", "viewer-password-123"),
                          "다른 계정의 비밀번호로는 로그인할 수 없어야 한다.")
        self.assertIsNone(self.store.authenticate("", "viewer-password-123"))

    def test_username_match_is_case_insensitive(self):
        self.store.bootstrap()
        self.store.add("Viewer1", "viewer", "viewer-password-123")
        self.assertEqual(self.store.authenticate("viewer1", "viewer-password-123")["username"],
                         "Viewer1")

    def test_disabled_user_cannot_login(self):
        self.store.bootstrap()
        self.store.add("viewer1", "viewer", "viewer-password-123")
        self.assertIsNotNone(self.store.authenticate("viewer1", "viewer-password-123"))
        self.store.update("viewer1", enabled=False)
        self.assertIsNone(self.store.authenticate("viewer1", "viewer-password-123"))

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
        self.assertEqual(sessions.lock_remaining("10.0.0.1"), 0)
        for _ in range(3):
            sessions.note_failure("10.0.0.1")
        self.assertGreater(sessions.lock_remaining("10.0.0.1"), 0,
                           "무차별 대입에 잠금이 걸리지 않으면 비밀번호만으로 뚫린다.")

    def test_lockout_is_per_client_not_global(self):
        # 6차 감사: 전역 잠금만 있으면 아무나 몇 번 틀리는 것으로 정상 관리자까지
        # 설정 화면에서 밀어낼 수 있다(가용성 공격).
        sessions = SessionStore(60, 3, 60)
        for _ in range(3):
            sessions.note_failure("203.0.113.9")
        self.assertGreater(sessions.lock_remaining("203.0.113.9"), 0)
        self.assertEqual(sessions.lock_remaining("10.0.0.5"), 0,
                         "다른 출발지까지 잠기면 공격자가 설정 화면을 영구 차단할 수 있다.")

    def test_global_lockout_still_backs_up_per_client(self):
        # 분산 시도(출발지를 바꿔 가며)는 전역 임계값으로 막는다.
        sessions = SessionStore(60, 2, 60)
        for index in range(2 * SessionStore.GLOBAL_FACTOR):
            sessions.note_failure("10.0.0.%d" % index)
        self.assertGreater(sessions.lock_remaining("198.51.100.7"), 0)

    def test_destroy_user_kills_all_their_sessions(self):
        sessions = SessionStore(60, 3, 60)
        a = sessions.create({"username": "admin", "role": "admin"})
        b = sessions.create({"username": "viewer1", "role": "viewer"})
        sessions.destroy_user("admin")
        self.assertIsNone(sessions.resolve(a["token"]))
        self.assertIsNotNone(sessions.resolve(b["token"]))

    def test_relogin_after_destroy_user_works(self):
        # 계정 단위 폐기가 '폐기 이후 발급분'까지 막으면 비밀번호를 바꾼 사용자가
        # 재로그인해도 곧바로 튕긴다.
        sessions = SessionStore(60, 3, 60)
        sessions.destroy_user("admin")
        fresh = sessions.create({"username": "admin", "role": "admin"})
        self.assertIsNotNone(sessions.resolve(fresh["token"]))

    def test_token_survives_restart_when_secret_is_persisted(self):
        # 무상태 서명 세션(v2.215) — 서버를 재시작해도 전원 로그아웃되지 않아야 한다.
        with tempfile.TemporaryDirectory() as tmp:
            secret = Path(tmp) / "session-secret"
            first = SessionStore(60, 3, 60, secret_path=secret)
            token = first.create({"username": "admin", "role": "admin"})["token"]
            second = SessionStore(60, 3, 60, secret_path=secret)      # 재기동 재현
            self.assertEqual(second.resolve(token)["username"], "admin")

    def test_token_is_rejected_by_a_different_secret(self):
        with tempfile.TemporaryDirectory() as tmp:
            token = SessionStore(60, 3, 60, secret_path=Path(tmp) / "a") \
                .create({"username": "admin", "role": "admin"})["token"]
            other = SessionStore(60, 3, 60, secret_path=Path(tmp) / "b")
            self.assertIsNone(other.resolve(token))

    def test_tampered_payload_is_rejected(self):
        sessions = SessionStore(60, 3, 60)
        token = sessions.create({"username": "viewer1", "role": "viewer"})["token"]
        encoded, _, signature = token.rpartition(".")
        forged = base64.urlsafe_b64encode(
            json.dumps({"u": "admin", "r": "admin", "v": 1, "e": time.time() + 60, "i": 1},
                       separators=(",", ":"), sort_keys=True).encode("utf-8")
        ).decode("ascii").rstrip("=")
        self.assertIsNone(sessions.resolve(forged + "." + signature),
                          "서명 없이 role 을 admin 으로 바꿔 넣을 수 있으면 안 된다.")


if __name__ == "__main__":
    unittest.main()
