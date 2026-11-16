"""전체 점검 31회차(서비스 허브) 회귀 — 확정 10건.

F1 라우트 패턴 밖 사용자명 관리 · F2 복원 후 tokenVersion 인상 · F3 읽기 오류는 손상이 아니다 · F4 viewer 백업 현황 가림 ·
F5 로그아웃 폐기 목록 영속 · F6 실패 카운터 시간 창 · F7 센터 id 'all' 예약 · F8 재지 않은 지연 미표시 ·
F9 핀 연결은 환경 프록시를 쓰지 않는다 · F10 콘솔 복구 대소문자.
"""

import sys
import tempfile
import unittest
import urllib.parse
import urllib.request
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from hub import auth as auth_mod  # noqa: E402
from hub.app import AppContext  # noqa: E402
from hub.auth import AuthError, SessionStore, UserStore  # noqa: E402
from hub.dcstore import DatacenterStore  # noqa: E402
from hub.jsonfile import read_json, write_json  # noqa: E402
from hub.notify import _latency_measured  # noqa: E402
from hub.pinned import build_pinned_opener  # noqa: E402
from test_api import ServerCase, request  # noqa: E402


class UserRouteNamesTest(ServerCase):
    """F1: '.'·'@'·한글 사용자명도 중지 · 비밀번호 변경 · 삭제가 된다."""

    def test_manage_users_with_names_outside_id_pattern(self):
        for name in ("hong.gildong", "kim@corp", "홍길동"):
            code, payload, _ = request(self.url + "/api/settings/users", "POST",
                                       {"username": name, "role": "admin", "password": "pass-word-123"}, self.auth())
            self.assertEqual(code, 201, payload)
            q = urllib.parse.quote(name, safe="")
            code, payload, _ = request(self.url + "/api/settings/users/" + q, "PUT", {"enabled": False}, self.auth())
            self.assertEqual(code, 200, (name, payload))
            code, payload, _ = request(self.url + "/api/settings/users/" + q + "/password", "POST",
                                       {"password": "another-pass-456"}, self.auth())
            self.assertEqual(code, 200, (name, payload))
            code, payload, _ = request(self.url + "/api/settings/users/" + q, "DELETE", None, self.auth())
            self.assertEqual(code, 200, (name, payload))
            self.assertNotIn(name, [u["username"] for u in payload["users"]])

    def test_too_long_or_unknown_name_is_404_or_400(self):
        q = urllib.parse.quote("x" * 65, safe="")
        code, _, _ = request(self.url + "/api/settings/users/" + q, "DELETE", None, self.auth())
        self.assertEqual(code, 404)

    def test_viewer_settings_state_hides_backup_paths(self):
        """F4"""
        request(self.url + "/api/settings/users", "POST",
                {"username": "viewer31", "role": "viewer", "password": "viewer-pass-31"}, self.auth())
        self.ctx.backups.create(reason="manual")
        token = self._login("viewer-pass-31", username="viewer31")
        code, payload, _ = request(self.url + "/api/settings", headers=self.auth(token))
        self.assertEqual(code, 200)
        self.assertTrue(payload["backup"].get("redacted"))
        self.assertNotIn("directory", payload["backup"])
        self.assertNotIn("latest", payload["backup"])
        self.assertIsNone(payload["dataDir"])
        self.assertNotIsInstance(payload["initialPasswordFile"], str, "R4: 초기 비밀번호 파일 경로도 admin 에게만")
        code, meta, _ = request(self.url + "/api/meta", headers=self.auth(token))
        self.assertNotIsInstance(meta["initialPasswordFile"], str)
        code, payload, _ = request(self.url + "/api/settings", headers=self.auth())
        self.assertIn("directory", payload["backup"])
        self.assertIsNotNone(payload["dataDir"])


class TokenAndFileTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_restore_does_not_revive_revoked_tokens(self):
        """F2: 백업 → 로그인 → 비밀번호 변경 → 재기동 → 복원 → 옛 토큰 거부."""
        ctx = AppContext(self.base, start_workers=False)
        ctx.users.add("ops", "admin", "first-pass-123")
        name = ctx.backups.create(reason="manual")["name"]
        user = ctx.users.authenticate("ops", "first-pass-123")
        token = ctx.sessions.create(user)["token"]
        ctx.users.set_password("ops", "second-pass-456")
        self.assertIsNone(ctx.sessions.resolve(token))
        ctx.close()
        ctx2 = AppContext(self.base, start_workers=False)
        ctx2.backups.restore(name)
        ctx2.reload_stores()
        self.assertIsNone(ctx2.sessions.resolve(token), "복원 직후 옛 토큰이 다시 통과하면 안 된다")
        ctx2.close()
        ctx3 = AppContext(self.base, start_workers=False)
        self.assertIsNone(ctx3.sessions.resolve(token), "재기동 뒤에도")
        ctx3.close()

    def test_read_error_is_not_corruption_for_users(self):
        """F3: 권한 오류면 원본을 옮기지 않고 · 새 admin 을 만들지 않고 · 저장을 거절한다."""
        path = self.base / "users.json"
        write_json(path, [{"username": "keep", "role": "admin", "enabled": True,
                           "password": "x", "tokenVersion": 5, "createdAt": "", "updatedAt": ""}])
        real = Path.read_text

        def deny(self_path, *a, **k):
            if self_path.name == "users.json":
                raise PermissionError(13, "Permission denied")
            return real(self_path, *a, **k)

        with mock.patch.object(Path, "read_text", deny):
            with self.assertRaises(OSError):
                read_json(path, [], expect=list, strict_io=True)
            store = UserStore(path, self.base / "initial.txt")
            self.assertIsNone(store.bootstrap())
            self.assertFalse((self.base / "initial.txt").exists(), "새 admin 초기 비밀번호를 만들지 않는다")
            with self.assertRaises(AuthError):
                store.add("new", "viewer", "pass-word-123")
        self.assertTrue(path.exists())
        self.assertEqual(list(self.base.glob("users.json.corrupt.*")), [], "원본을 손상으로 옮기지 않는다")
        self.assertEqual(read_json(path, [])[0]["username"], "keep")

    def test_logout_survives_restart(self):
        """F5"""
        secret = self.base / "session-secret"
        revoked = self.base / "session-revoked.json"
        s1 = SessionStore(3600, 8, 300, secret_path=secret, revoked_path=revoked)
        token = s1.create({"username": "a", "role": "admin", "tokenVersion": 1})["token"]
        self.assertIsNotNone(s1.resolve(token))
        s1.destroy(token)
        s2 = SessionStore(3600, 8, 300, secret_path=secret, revoked_path=revoked)
        self.assertIsNone(s2.resolve(token))
        other = s2.create({"username": "a", "role": "admin", "tokenVersion": 1})["token"]
        self.assertIsNotNone(s2.resolve(other), "다른 토큰은 그대로")
        self.assertNotIn(token, revoked.read_text(encoding="utf-8"), "토큰 원문은 파일에 남기지 않는다")

    def test_login_failures_have_a_time_window(self):
        """F6"""
        clock = [1_000_000.0]
        with mock.patch.object(auth_mod.time, "time", lambda: clock[0]):
            s = SessionStore(3600, 8, 300)
            for _ in range(7):
                s.note_failure("10.1.1.5")
            clock[0] += 30 * 86400
            s.note_failure("10.1.1.5")
            self.assertEqual(s.lock_remaining("10.1.1.5"), 0, "30일 전 실패 + 오타 1회로 잠기지 않는다")
            for i in range(79):
                clock[0] += 20 * 86400 / 79
                s.note_failure(f"10.2.{i}.1")
            s.note_failure("10.3.3.3")
            self.assertEqual(s.lock_remaining("10.9.9.9"), 0, "장기간 쌓인 실패로 전원이 잠기지 않는다")
            for _ in range(8):
                s.note_failure("10.4.4.4")
            self.assertGreater(s.lock_remaining("10.4.4.4"), 0, "창 안 8회는 여전히 잠긴다")

    def test_datacenter_id_all_is_reserved(self):
        """F7"""
        store = DatacenterStore(self.base / "datacenters.json")
        store.add({"code": "ALL", "name": "All Airport"})
        self.assertNotIn("all", store.ids())
        self.assertIn("dc-all", store.ids())

    def test_console_recover_is_case_insensitive(self):
        """F10"""
        users = UserStore(self.base / "users.json")
        users.add("admin", "admin", "admin-pass-123")
        users.add("Admin2", "admin", "admin2-pass-123")
        r = users.recover("admin2")
        self.assertEqual(r["username"], "Admin2")
        self.assertFalse(r["created"])
        self.assertIsNotNone(users.authenticate("Admin2", r["password"]))


class Review35Test(unittest.TestCase):
    """35회차 반증 — R1 · R2 · R5 · R6."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_logout_of_invalid_token_is_not_recorded(self):
        """R1: 서명 안 된 토큰 로그아웃은 폐기 목록 · 파일에 남지 않는다."""
        revoked = self.base / "session-revoked.json"
        s = SessionStore(3600, 8, 300, secret_path=self.base / "session-secret", revoked_path=revoked)
        for i in range(50):
            s.destroy(f"junk-{i}.sig")
        self.assertEqual(len(s._revoked), 0)
        self.assertFalse(revoked.exists())
        token = s.create({"username": "a", "role": "admin", "tokenVersion": 1})["token"]
        s.destroy(token)
        self.assertEqual(len(s._revoked), 1)

    def test_backup_does_not_move_unreadable_users_file(self):
        """R2: 자동 · 수동 백업도 읽기 오류면 원본을 옮기지 않고 실패한다."""
        ctx = AppContext(self.base, start_workers=False)
        users = self.base / "users.json"
        real = Path.read_text

        def deny(self_path, *a, **k):
            if self_path.name == "users.json":
                raise PermissionError(13, "Permission denied")
            return real(self_path, *a, **k)

        with mock.patch.object(Path, "read_text", deny):
            with self.assertRaises(ValueError):
                ctx.backups.create(reason="auto")
        self.assertTrue(users.exists())
        self.assertEqual(list(self.base.glob("users.json.corrupt.*")), [])
        ctx.close()

    def test_dot_names_are_rejected(self):
        """R5"""
        users = UserStore(self.base / "users.json")
        for bad in (".", "..", "a/b"):
            with self.assertRaises(AuthError):
                users.add(bad, "viewer", "pass-word-123")

    def test_writes_refused_before_mutation_while_unreadable(self):
        """R6: 못 읽음 상태의 쓰기는 메모리를 바꾸기 전에 거절한다."""
        path = self.base / "users.json"
        users = UserStore(path)
        users.add("admin", "admin", "admin-pass-123")
        users.add("bob", "viewer", "bob-pass-1234")
        v_before = users.token_version("bob")
        real = Path.read_text

        def deny(self_path, *a, **k):
            if self_path.name == "users.json":
                raise PermissionError(13, "Permission denied")
            return real(self_path, *a, **k)

        import os as _os
        _os.utime(path, ns=(1, 1))   # mtime 을 바꿔 다시 읽게 한다
        with mock.patch.object(Path, "read_text", deny):
            with self.assertRaises(AuthError):
                users.set_password("bob", "new-pass-5678")
            self.assertIsNotNone(users.authenticate("bob", "bob-pass-1234"), "옛 비밀번호가 그대로")
            self.assertIsNone(users.authenticate("bob", "new-pass-5678"))
            self.assertEqual(users.token_version("bob"), v_before)
            with self.assertRaises(AuthError):
                users.delete("bob")
            self.assertIn("bob", [u["username"] for u in users.public_list()])


class Review37Test(unittest.TestCase):
    """37회차 반증 — R5 · R6."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_revoked_overflow_does_not_revive_other_accounts_tokens(self):
        """R5: 한 계정이 로그인 · 로그아웃을 반복해 상한을 넘겨도 다른 계정의 로그아웃 토큰은 되살아나지 않는다."""
        users = UserStore(self.base / "users.json")
        users.add("admin", "admin", "admin-pass-123")
        users.add("mallory", "viewer", "mallory-pass-1")
        s = SessionStore(3600, 8, 300, secret_path=self.base / "session-secret", users=users,
                         revoked_path=self.base / "session-revoked.json")
        s.REVOKED_MAX = 20
        s.REVOKED_PER_USER = 5
        admin_tok = s.create(users.authenticate("admin", "admin-pass-123"))["token"]
        s.destroy(admin_tok)
        for _ in range(40):
            t = s.create(users.authenticate("mallory", "mallory-pass-1"))["token"]
            s.destroy(t)
        self.assertIsNone(s.resolve(admin_tok), "admin 이 로그아웃한 토큰은 계속 거부")
        s2 = SessionStore(3600, 8, 300, secret_path=self.base / "session-secret", users=users,
                          revoked_path=self.base / "session-revoked.json")
        self.assertIsNone(s2.resolve(admin_tok), "재기동 뒤에도")
        self.assertLessEqual(len(s._revoked), 20)

    def test_auto_backup_failure_is_visible_and_throttled(self):
        """R6"""
        ctx = AppContext(self.base, start_workers=False)
        ctx.settings.update_section("backup", {"enabled": True, "intervalMinutes": 60, "keep": 3})
        real = Path.read_text

        def deny(self_path, *a, **k):
            if self_path.name == "users.json":
                raise PermissionError(13, "Permission denied")
            return real(self_path, *a, **k)

        with mock.patch.object(Path, "read_text", deny):
            self.assertIsNone(ctx.backups.run_if_due())
            st = ctx.backups.status()
            self.assertIsNotNone(st["lastError"])
            self.assertIn("users.json", st["lastError"]["reason"])
            self.assertIsNone(ctx.backups.run_if_due(), "바로 다시 시도하지 않는다(10분 뒤)")
        self.assertTrue((self.base / "users.json").exists())
        ctx.close()


class SmallTest(unittest.TestCase):
    def test_latency_only_when_measured(self):
        """F8"""
        self.assertTrue(_latency_measured({"status": "healthy", "latencyMs": 12}))
        self.assertTrue(_latency_measured({"status": "warning", "latencyMs": 12}))
        self.assertFalse(_latency_measured({"status": "blocked", "latencyMs": 0}))
        self.assertFalse(_latency_measured({"status": "unreachable", "latencyMs": 4000}))

    def test_pinned_opener_ignores_env_proxy(self):
        """F9"""
        import ssl
        with mock.patch.dict("os.environ", {"http_proxy": "http://127.0.0.1:9", "https_proxy": "http://127.0.0.1:9"}):
            opener = build_pinned_opener("127.0.0.1", tls_context=ssl.create_default_context())
        # 빈 ProxyHandler 는 프로토콜 메서드가 없어 등록되지 않고, 대신 환경 프록시를 읽는 기본 ProxyHandler 도 빠진다.
        proxies = [h for h in opener.handlers if isinstance(h, urllib.request.ProxyHandler)]
        self.assertFalse(any(h.proxies for h in proxies), "환경 프록시가 붙은 핸들러가 없어야 한다")


if __name__ == "__main__":
    unittest.main()
