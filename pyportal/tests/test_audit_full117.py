"""전체 점검 117회차(서비스 허브 3차) 회귀.

F1 로그인 비밀번호에 짝 없는 서로게이트("\\ud800")를 넣으면 있는 · 사용 중인 계정만 400(인코딩 오류 원문 · 실패 미집계 · 해시 없음),
   없는 · 중지 계정은 401 — 요청 한 번으로 계정이 열거됐다
F2 어느 계정이든 로그인에 성공하면 그 출발지의 실패 카운터가 통째로 지워져, viewer 계정 하나로 admin 비밀번호를 잠금 없이 대입할 수 있었다
F3 viewer 가 짝 없는 서로게이트가 든 이름으로 바로가기를 만들면 저장은 400 인데 메모리에 남아, 공개 목록 · 내보내기 · 이후의 모든 저장이 400 이었다
F4 깊게 중첩된 JSON 본문이 미인증 요청마다 500 + traceback 을 남겼다
F5 마지막 admin 보호가 메모리를 먼저 바꾼 뒤 거절해, 하나뿐인 admin 의 자기 강등 · 중지가 400 을 받고도 효력을 가졌다(재기동 전까지 admin 0명)
F6 손상된 health-history.db 하나로 허브 전체가 기동하지 못했다(차트용 부가 자료)
F7 점검 이력 적재 실패(디스크 가득 · 잠김)가 그 주기의 전환 알림과 [지금 점검] 응답까지 막았다
F8 큰 수 한 칸(310자리 넘는 정수 · 1e999)의 OverflowError 가 데이터센터 저장 500 · 계정 파일 전체 못 읽음이 됐다
"""

import json
import sqlite3
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from hub import auth as auth_mod  # noqa: E402
from hub import health as health_mod  # noqa: E402
from hub import history as history_mod  # noqa: E402
from hub.app import AppContext  # noqa: E402
from hub.auth import AuthError, SessionStore, UserStore  # noqa: E402
from hub.dcstore import DatacenterStore  # noqa: E402
from hub.history import HealthHistory  # noqa: E402
from test_api import ServerCase, request  # noqa: E402

LONE = "\\ud800"   # JSON 이스케이프 원문(파이썬 소스에 짝 없는 서로게이트를 직접 적지 않는다)


def raw_request(url, method, body: bytes, headers=None):
    """본문 바이트를 그대로 보낸다(json.dumps 를 거치지 않는 이스케이프 · 중첩)."""
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            return response.getcode(), json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(text)
        except ValueError:
            return exc.code, {"raw": text}


class SurrogatePasswordTest(unittest.TestCase):
    """F1: 인코딩할 수 없는 비밀번호도 계정 존재와 무관하게 같은 결과 · 같은 비용."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.users = UserStore(Path(self.tmp.name) / "users.json")
        self.users.bootstrap()   # admin(마지막 admin 보호 때문에 먼저 있어야 한다)
        self.users.add("bob", "viewer", "bob-password-1")
        self.users.add("off", "viewer", "off-password-1")
        self.users.update("off", enabled=False)
        self.bad = json.loads('"' + LONE + 'abcdefgh"')

    def tearDown(self):
        self.tmp.cleanup()

    def _kdf_calls(self, username):
        real = auth_mod.hashlib.pbkdf2_hmac
        calls = []

        def counting(*args, **kwargs):
            calls.append(1)
            return real(*args, **kwargs)

        with mock.patch.object(auth_mod.hashlib, "pbkdf2_hmac", counting):
            result = self.users.authenticate(username, self.bad)
        return result, len(calls)

    def test_same_result_and_same_cost_for_every_account_state(self):
        for name in ("bob", "off", "nobody"):
            result, calls = self._kdf_calls(name)   # 예전: bob 은 UnicodeEncodeError, 나머지는 해시 0회
            self.assertIsNone(result, name)
            self.assertEqual(calls, 1, f"{name}: 해시를 한 번 태워야 한다")

    def test_verify_password_does_not_raise(self):
        record = self.users.get("bob")["password"]
        self.assertFalse(auth_mod.verify_password(record, self.bad))

    def test_existing_hashes_still_verify(self):
        # 정상 문자열의 KDF 입력 바이트는 예전(strict UTF-8)과 같다 — 저장된 해시 호환
        self.assertEqual(auth_mod._pw_bytes("비밀번호-pw-1"), "비밀번호-pw-1".encode("utf-8"))   # noqa: SLF001
        self.assertIsNotNone(self.users.authenticate("bob", "bob-password-1"))


class FailureCounterPerAccountTest(unittest.TestCase):
    """F2: 성공은 그 계정의 실패만 지운다."""

    def _store(self, max_fails=8):
        return SessionStore(600, max_fails, 300)

    def test_other_account_success_does_not_clear_failures(self):
        s = self._store()
        for _ in range(3):
            for _ in range(7):
                s.note_failure("10.9.9.9", "admin")
                if s.lock_remaining("10.9.9.9"):
                    break
            if s.lock_remaining("10.9.9.9"):
                break
            s.note_success("10.9.9.9", "viewer1")   # 공격자의 자기 계정 로그인
        self.assertGreater(s.lock_remaining("10.9.9.9"), 0, "admin 오답이 8회를 넘겼는데 잠기지 않았다")

    def test_own_success_clears_only_own_failures(self):
        s = self._store()
        for _ in range(3):
            s.note_failure("10.9.9.1", "Admin")
        for _ in range(2):
            s.note_failure("10.9.9.1", "bob")
        s.note_success("10.9.9.1", "BOB")           # 로그인은 대소문자를 가리지 않는다
        self.assertEqual(s._fails["10.9.9.1"][0], 3)   # noqa: SLF001
        s.note_success("10.9.9.1", "admin")
        self.assertNotIn("10.9.9.1", s._fails)         # noqa: SLF001
        self.assertNotIn("10.9.9.1", s._fail_names)    # noqa: SLF001

    def test_typo_then_success_starts_clean(self):
        s = self._store(max_fails=3)
        for _ in range(4):                          # 오타 2회 → 성공을 네 번 — 잠기지 않는다
            s.note_failure("10.9.9.2", "bob")
            s.note_failure("10.9.9.2", "bob")
            s.note_success("10.9.9.2", "bob")
        self.assertEqual(s.lock_remaining("10.9.9.2"), 0)

    def test_many_names_fold_into_one_bucket(self):
        s = self._store(max_fails=100)
        for i in range(SessionStore.FAIL_NAMES_MAX + 5):
            s.note_failure("10.9.9.3", f"user{i}")
        self.assertLessEqual(len(s._fail_names["10.9.9.3"]), SessionStore.FAIL_NAMES_MAX + 1)   # noqa: SLF001
        s.note_success("10.9.9.3", f"user{SessionStore.FAIL_NAMES_MAX + 2}")   # 넘친 이름 — 지워지지 않는다
        self.assertEqual(s._fails["10.9.9.3"][0], SessionStore.FAIL_NAMES_MAX + 5)   # noqa: SLF001

    def test_legacy_calls_without_username(self):
        s = self._store(max_fails=3)
        s.note_failure("10.9.9.4")
        s.note_failure("10.9.9.4")
        s.note_success("10.9.9.4")                  # 계정을 모르는 호출 — 그 출발지 전부(예전 동작)
        self.assertNotIn("10.9.9.4", s._fails)      # noqa: SLF001

    def test_lock_and_purge_drop_names(self):
        s = self._store(max_fails=2)
        s.note_failure("10.9.9.5", "admin")
        s.note_failure("10.9.9.5", "admin")
        self.assertGreater(s.lock_remaining("10.9.9.5"), 0)
        self.assertNotIn("10.9.9.5", s._fail_names)   # noqa: SLF001 — 잠기면 계정별 집계는 비운다(메모리가 자라지 않게)


class LastAdminGuardTest(unittest.TestCase):
    """F5: 마지막 admin 보호가 거절한 변경은 메모리에도 남지 않는다."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "users.json"
        self.users = UserStore(self.path)
        self.users.bootstrap()
        self.users.add("bob", "viewer", "bob-password-1")

    def tearDown(self):
        self.tmp.cleanup()

    def _admin(self):
        return dict(self.users.get("admin"))

    def test_refused_demotion_and_disable_leave_memory_untouched(self):
        before = self._admin()
        for change in ({"role": "viewer"}, {"enabled": False}, {"role": "viewer", "enabled": False}):
            with self.assertRaises(AuthError):
                self.users.update("admin", **change)
            self.assertEqual(self._admin(), before, change)   # 예전: role viewer · tokenVersion +1 이 메모리에 남았다
            self.assertEqual(self.users.role_of("admin"), "admin")
            self.assertEqual(self.users.token_version("admin"), before["tokenVersion"])

    def test_refused_change_is_not_persisted_by_a_later_save(self):
        """예전: 거절된 강등이 메모리에 남아, 다른 계정의 비밀번호 변경(저장)이 그 목록을 파일에 굳혔다 — admin 0명."""
        with self.assertRaises(AuthError):
            self.users.update("admin", role="viewer")
        self.users.set_password("bob", "bob-password-2")
        saved = {u["username"]: u for u in json.loads(self.path.read_text(encoding="utf-8"))}
        self.assertEqual(saved["admin"]["role"], "admin")
        self.assertTrue(saved["admin"]["enabled"])

    def test_allowed_changes_still_apply(self):
        self.users.add("root2", "admin", "root2-password-1")
        v0 = self._admin()["tokenVersion"]
        self.users.update("admin", role="viewer")            # admin 이 하나 더 있으면 강등된다
        self.assertEqual(self.users.role_of("admin"), "viewer")
        self.assertEqual(self.users.get("admin")["tokenVersion"], v0 + 1)
        self.users.update("admin", enabled=False)
        self.assertIsNone(self.users.token_version("admin"))
        saved = {u["username"]: u for u in json.loads(self.path.read_text(encoding="utf-8"))}
        self.assertEqual((saved["admin"]["role"], saved["admin"]["enabled"]), ("viewer", False))


class HistoryDbTest(unittest.TestCase):
    """F6 · F7: 점검 이력(부가 자료)의 손상 · 적재 실패가 허브 기동 · 알림을 막지 않는다."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _copies(self):
        return sorted(p.name for p in self.base.glob("health-history.db.corrupt.*"))

    def test_corrupt_history_db_is_preserved_and_hub_starts(self):
        garbage = b"this is not a sqlite database at all\n" * 200
        (self.base / "health-history.db").write_bytes(garbage)
        (self.base / "health-history.db-wal").write_bytes(b"stale wal")
        ctx = AppContext(self.base, start_workers=False)   # 예전: sqlite3.DatabaseError 'file is not a database' 로 기동 실패
        try:
            mains = [n for n in self._copies() if not n.endswith(("-wal", "-shm"))]
            self.assertEqual(len(mains), 1, self._copies())
            self.assertEqual((self.base / mains[0]).read_bytes(), garbage)   # 원본은 그대로 보존
            wal = self.base / "health-history.db-wal"                        # 옛 WAL 이 새 DB 곁에 남지 않는다(sqlite 가 지우거나 함께 옮긴다)
            self.assertFalse(wal.exists() and wal.read_bytes() == b"stale wal")
            self.assertEqual(ctx.history.record([{"id": "sc-1", "url": "http://a", "status": "healthy", "latencyMs": 3}]), 1)
            self.assertEqual(ctx.history.stats()["rows"], 1)
        finally:
            ctx.close()

    def test_open_failure_is_not_corruption(self):
        """열지 못함(권한 · 잠김 — OperationalError)은 손상이 아니다 — 옮기지 않고 그대로 올린다(읽기 오류 ≠ 손상)."""
        target = self.base / "health-history.db"
        HealthHistory(target).close()
        with mock.patch.object(history_mod.sqlite3, "connect",
                               side_effect=sqlite3.OperationalError("unable to open database file")):
            with self.assertRaises(sqlite3.OperationalError):
                HealthHistory(target)
        self.assertTrue(target.exists())
        self.assertEqual(self._copies(), [])

    def test_healthy_db_is_reopened_in_place(self):
        target = self.base / "health-history.db"
        first = HealthHistory(target)
        first.record([{"id": "sc-1", "url": "http://a", "status": "healthy", "latencyMs": 3}])
        first.close()
        second = HealthHistory(target)
        try:
            self.assertEqual(second.stats()["rows"], 1)
            self.assertEqual(self._copies(), [])
        finally:
            second.close()

    def test_record_failure_does_not_block_alerts_or_the_response(self):
        ctx = AppContext(self.base, start_workers=False)
        try:
            sc = ctx.shortcuts.all()[0]
            rows = [{"id": sc["id"], "url": sc["url"], "status": "unreachable", "statusCode": 0, "latencyMs": 0, "message": "x"}]
            judged = []
            with mock.patch.object(health_mod, "check_many", lambda *a, **k: [dict(r) for r in rows]), \
                    mock.patch.object(ctx.notifier, "notify_transitions",
                                      side_effect=lambda keep, names=None: judged.append(len(keep)) or []):
                with mock.patch.object(ctx.history, "record",
                                       side_effect=sqlite3.OperationalError("database or disk is full")):
                    out = ctx.run_health_check()            # 예전: OperationalError 가 그대로 올라와 알림 판정 0회 · 수동 점검 500
                    self.assertEqual(len(out), 1)
                    self.assertEqual(judged, [1])
                    self.assertIn("disk is full", ctx._history_error)   # noqa: SLF001
                ctx.run_health_check()                      # 다시 적재되면 표지를 지운다
                self.assertIsNone(ctx._history_error)       # noqa: SLF001
                self.assertEqual(judged, [1, 1])
        finally:
            ctx.close()


class BigNumberTest(unittest.TestCase):
    """F8: 큰 수 한 칸(OverflowError)이 요청 · 파일 전체를 깨뜨리지 않는다."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_datacenter_number_fields(self):
        store = DatacenterStore(self.base / "datacenters.json")
        created = store.add({"code": "BIG", "name": "big", "racks": 10 ** 400, "pue": 10 ** 400})   # 예전: OverflowError → 500
        self.assertEqual(created["racks"], 0)
        self.assertEqual(created["pue"], 1.2)

    def test_users_file_with_infinite_token_version(self):
        path = self.base / "users.json"
        users = UserStore(path)
        users.bootstrap()
        raw = json.loads(path.read_text(encoding="utf-8"))
        text = json.dumps(raw).replace('"tokenVersion": %d' % raw[0]["tokenVersion"], '"tokenVersion": 1e999')
        self.assertIn("1e999", text)
        path.write_text(text, encoding="utf-8")
        again = UserStore(path)
        self.assertEqual(again.token_version("admin"), 1)   # 예전: OverflowError — 로그인 · 세션 판정 전부 500
        self.assertEqual(len(again.public_list()), 1)


class HttpCase(ServerCase):
    def setUp(self):
        self.ctx.sessions._fails.clear()          # noqa: SLF001 — 같은 출발지(127.0.0.1)의 다른 시험에 잠금이 번지지 않게
        self.ctx.sessions._fail_names.clear()     # noqa: SLF001
        self.ctx.sessions._global_fails.clear()   # noqa: SLF001

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.ctx.users.add("viewer1", "viewer", "viewer-password-1")
        cls.viewer = cls._login("viewer-password-1", "viewer1")


class LoginHttpTest(HttpCase):
    def test_lockout_is_not_reset_by_another_accounts_login(self):
        """F2(재현): admin 오답 → viewer 로그인 성공을 되풀이해도 admin 오답 누계가 임계에 닿으면 잠긴다."""
        with mock.patch.object(self.ctx.sessions, "_max_fails", 3):
            codes = []
            for i in range(2):
                codes.append(request(self.url + "/api/settings/session", "POST",
                                     {"username": "admin", "password": f"wrong-{i}"})[0])
            codes.append(request(self.url + "/api/settings/session", "POST",
                                 {"username": "viewer1", "password": "viewer-password-1"})[0])
            codes.append(request(self.url + "/api/settings/session", "POST",
                                 {"username": "admin", "password": "wrong-2"})[0])
            self.assertEqual(codes, [401, 401, 200, 401])
            code, payload, _ = request(self.url + "/api/settings/session", "POST",
                                       {"username": "admin", "password": "wrong-3"})
            self.assertEqual(code, 429, payload)

    def test_own_login_still_clears_own_typos(self):
        with mock.patch.object(self.ctx.sessions, "_max_fails", 3):
            for _ in range(3):
                for i in range(2):
                    self.assertEqual(request(self.url + "/api/settings/session", "POST",
                                             {"username": "viewer1", "password": f"typo-{i}"})[0], 401)
                self.assertEqual(request(self.url + "/api/settings/session", "POST",
                                         {"username": "viewer1", "password": "viewer-password-1"})[0], 200)

    def test_current_password_failures_are_counted_for_the_actor(self):
        """본인 비밀번호 확인(31회차 E3)의 실패도 그 계정 이름으로 센다 — 다른 계정 로그인으로 지워지지 않는다."""
        with mock.patch.object(self.ctx.sessions, "_max_fails", 3):
            for i in range(2):
                code, payload, _ = request(self.url + "/api/settings/users/admin/password", "POST",
                                           {"password": "new-password-123", "currentPassword": f"wrong-{i}"}, self.auth())
                self.assertEqual(code, 403, payload)
            self.assertEqual(request(self.url + "/api/settings/session", "POST",
                                     {"username": "viewer1", "password": "viewer-password-1"})[0], 200)
            self.assertEqual(self.ctx.sessions._fails["127.0.0.1"][0], 2)   # noqa: SLF001

    def test_last_admin_refusal_keeps_the_admin_session(self):
        """F5(재현): 하나뿐인 admin 의 자기 강등 · 중지는 400 이고, 그 뒤에도 같은 세션이 admin 으로 남는다(예전: 401 → 다시 로그인하면 viewer)."""
        for change in ({"role": "viewer"}, {"enabled": False}):
            code, payload, _ = request(self.url + "/api/settings/users/admin", "PUT", change, self.auth())
            self.assertEqual(code, 400, payload)
            code, payload, _ = request(self.url + "/api/settings/session", headers=self.auth())
            self.assertEqual(code, 200, payload)
            self.assertEqual(payload["user"]["role"], "admin")

    def test_unencodable_password_gets_the_same_answer_for_any_account(self):
        """F1(재현): 예전에는 admin(있는 계정) 400 · nobody 401 로 갈렸다."""
        answers = []
        for name in ("admin", "viewer1", "nobody"):
            body = ('{"username":"' + name + '","password":"' + LONE + 'abcdefgh"}').encode("ascii")
            code, payload = raw_request(self.url + "/api/settings/session", "POST", body)
            answers.append((code, payload.get("error")))
        self.assertEqual(len(set(answers)), 1, answers)
        self.assertNotIn("codec", str(answers[0][1]))   # 인코딩 오류 원문을 싣지 않는다


class LoneSurrogateBoundaryTest(HttpCase):
    """F3: 저장할 수 없는 글자는 저장소에 닿기 전에 400 — 메모리 목록 · 공개 조회가 깨지지 않는다."""

    def _assert_store_intact(self, before):
        code, payload, _ = request(self.url + "/api/shortcuts")
        self.assertEqual(code, 200, payload)
        self.assertEqual(len(payload["shortcuts"]), before)
        self.assertEqual(len(self.ctx.shortcuts._items), before)   # noqa: SLF001
        self.assertEqual([p.name for p in self.base.glob("*.tmp.*")], [])

    def test_viewer_cannot_poison_shortcuts(self):
        before = len(self.ctx.shortcuts.all())
        body = ('{"name":"x' + LONE + 'y","url":"http://a.example"}').encode("ascii")
        code, payload = raw_request(self.url + "/api/shortcuts", "POST", body, self.auth(self.viewer))
        self.assertEqual(code, 400, payload)
        self.assertIn("서로게이트", payload["error"])
        self._assert_store_intact(before)
        # 그 뒤의 정상 저장 · 내보내기도 된다(예전에는 전부 400)
        code, payload, _ = request(self.url + "/api/shortcuts", "POST",
                                   {"name": "정상 117", "url": "http://b.example"}, self.auth(self.viewer))
        self.assertEqual(code, 201, payload)
        created = payload["shortcut"]["id"]
        self.assertEqual(request(self.url + "/api/export/csv", headers=self.auth(self.viewer))[0], 200)
        # 수정 · 가져오기 경로도 같은 경계
        body = ('{"description":"' + LONE + '"}').encode("ascii")
        self.assertEqual(raw_request(self.url + "/api/shortcuts/" + created, "PUT", body, self.auth(self.viewer))[0], 400)
        body = ('{"mode":"append","shortcuts":[{"name":"n' + LONE + '","url":"http://c.example"}]}').encode("ascii")
        self.assertEqual(raw_request(self.url + "/api/import", "POST", body, self.auth(self.viewer))[0], 400)
        body = ('{"mode":"append","csv":"name,url\\nn' + LONE + ',http://d.example"}').encode("ascii")
        self.assertEqual(raw_request(self.url + "/api/import/csv", "POST", body, self.auth(self.viewer))[0], 400)
        self._assert_store_intact(before + 1)
        self.ctx.shortcuts.delete(created)

    def test_paired_surrogate_escape_is_accepted(self):
        """짝이 맞는 이스케이프(이모지)는 정상 문자다 — 막지 않는다."""
        body = b'{"name":"\\ud83d\\ude00 smile","url":"http://e.example"}'
        code, payload = raw_request(self.url + "/api/shortcuts", "POST", body, self.auth(self.viewer))
        self.assertEqual(code, 201, payload)
        self.assertEqual(payload["shortcut"]["name"], "\U0001F600 smile")
        self.ctx.shortcuts.delete(payload["shortcut"]["id"])

    def test_admin_stores_are_not_poisoned(self):
        users_before = len(self.ctx.users.public_list())
        body = ('{"username":"u' + LONE + '","role":"viewer","password":"some-password-1"}').encode("ascii")
        self.assertEqual(raw_request(self.url + "/api/settings/users", "POST", body, self.auth())[0], 400)
        self.assertEqual(len(self.ctx.users.public_list()), users_before)
        dcs_before = len(self.ctx.datacenters.all())
        body = ('{"code":"X' + LONE + '","name":"center"}').encode("ascii")
        self.assertEqual(raw_request(self.url + "/api/settings/datacenters", "POST", body, self.auth())[0], 400)
        self.assertEqual(len(self.ctx.datacenters.all()), dcs_before)
        code, payload, _ = request(self.url + "/api/datacenters")
        self.assertEqual(code, 200, payload)

    def test_server_file_import_passes_the_same_boundary(self):
        before = len(self.ctx.shortcuts.all())
        folder = self.base / "import"
        folder.mkdir(exist_ok=True)
        (folder / "bad117.json").write_text('[{"name":"s' + LONE + '","url":"http://f.example"}]', encoding="ascii")
        code, payload, _ = request(self.url + "/api/settings/import-files/run", "POST",
                                   {"name": "bad117.json", "mode": "append"}, self.auth())
        self.assertEqual(code, 400, payload)
        self._assert_store_intact(before)


class SettingsWithoutHistoryTest(HttpCase):
    def test_settings_state_survives_a_history_db_error(self):
        """F7: 이력 DB 를 못 읽어도 설정 화면 응답은 온다(예전: 500 — 백업 · 복원 · 계정 관리 진입 불가)."""
        with mock.patch.object(self.ctx.history, "stats", side_effect=sqlite3.OperationalError("database is locked")):
            code, payload, _ = request(self.url + "/api/settings", headers=self.auth())
        self.assertEqual(code, 200, payload)
        self.assertIsNone(payload["history"])
        self.assertIn("users", payload)
        code, payload, _ = request(self.url + "/api/settings", headers=self.auth())
        self.assertIsInstance(payload["history"], dict)


class DeepJsonTest(HttpCase):
    def test_deeply_nested_body_is_a_400(self):
        """F4(재현): 예전에는 RecursionError → 500 + traceback(미인증 요청마다)."""
        body = b"[" * 200000 + b"]" * 200000
        code, payload = raw_request(self.url + "/api/health/check", "POST", body)
        self.assertEqual(code, 400, payload)
        self.assertNotEqual(payload.get("code"), "internal_error")


if __name__ == "__main__":
    unittest.main()
