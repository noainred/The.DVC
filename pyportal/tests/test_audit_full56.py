"""전체 점검 56회차(서비스 허브 2차) 회귀.

F1 viewer 의 설정 화면이 admin 전용 백업 목록(403)에서 멈춰 분류 · 센터 전체 목록을 못 받았고, 표시 개수 밖 센터에 연결된 바로가기를
   수정 · 저장하면 연결이 '전체 공통' 으로 바뀌었다(Chromium 재현 — 여기서는 화면 코드 계약 · 서버 경계를 고정한다)
F2 로그인의 PBKDF2 가 계정 저장소 잠금 안에서 돌아, 겹친 로그인 시도 동안 로그인한 모든 요청(세션 판정)이 줄을 섰다
F3 권한 오류로 못 읽은 백업을 손상으로 보고 <이름>.corrupt.* 로 옮겼다(목록에서 사라짐)
F4 초기 계정(admin)을 지워도 초기 비밀번호 파일이 남았다
F5 README 가 약속한 '설정 변경' 감사에 데이터센터 생성 · 수정 · 삭제 · 이동, 분류 수정 · 이동, 바로가기 삭제 · 초기화가 빠져 있었다
F6 '점검 진행 중' 응답만 삭제된 바로가기의 옛 이력을 실었다
F7 사용자 중지 · 재개의 enabled 를 문자열로 보내면 bool("false") 가 True 라 중지 계정이 켜졌다
F8 NUL · 너무 긴 이름의 정적 경로가 _dispatch 의 try 밖에서 예외 — 응답 없이 끊기고 traceback 이 쌓였다
개선: 사용자명 제어문자 거부 · 서버 import 파일 읽기 오류 400 · 차단됨 상태 칩 · 좁은 화면 설정 칸 넘침
"""

import re
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from hub import auth as auth_mod  # noqa: E402
from hub.app import AppContext  # noqa: E402
from hub.auth import AuthError  # noqa: E402
from test_api import ServerCase, request  # noqa: E402

STATIC = Path(__file__).resolve().parents[1] / "static"


def _js_function(name):
    """app.js 에서 `function <name>(` 본문(다음 최상위 function 직전까지)을 잘라 온다."""
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    start = js.index("function " + name + "(")
    nxt = js.find("\n  function ", start + 10)
    return js[start: nxt if nxt != -1 else len(js)]


class _Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.ctx = AppContext(self.base, start_workers=False)

    def tearDown(self):
        self.ctx.close()
        self.tmp.cleanup()


class LoginHashOutsideLockTest(_Base):
    """F2: 느린 비밀번호 검증이 도는 동안에도 세션 판정은 기다리지 않는다."""

    def test_resolve_does_not_wait_for_password_hash(self):
        self.ctx.users.add("bob", "viewer", "bob-password-1")
        token = self.ctx.sessions.create(self.ctx.users.authenticate("bob", "bob-password-1"))["token"]
        inside = threading.Event()
        release = threading.Event()
        real_verify = auth_mod.verify_password

        def slow_verify(record, password):
            inside.set()
            release.wait(5)
            return real_verify(record, password)

        with mock.patch.object(auth_mod, "verify_password", slow_verify):
            worker = threading.Thread(target=self.ctx.users.authenticate, args=("bob", "wrong-password"))
            worker.start()
            try:
                self.assertTrue(inside.wait(5), "검증 함수에 들어가지 않았다")
                result = {}

                def resolve():
                    result["user"] = self.ctx.sessions.resolve(token)

                probe = threading.Thread(target=resolve)
                started = time.monotonic()
                probe.start()
                probe.join(1.0)
                waited = time.monotonic() - started
                self.assertFalse(probe.is_alive(), "세션 판정이 로그인의 비밀번호 해시를 기다렸다(잠금 안 PBKDF2)")
                self.assertLess(waited, 1.0)
                self.assertEqual(result["user"]["username"], "bob")
            finally:
                release.set()
                worker.join(5)

    def test_login_contract_unchanged(self):
        self.ctx.users.add("Carol", "admin", "carol-password-1")
        self.assertEqual(self.ctx.users.authenticate("carol", "carol-password-1")["username"], "Carol")
        self.assertIsNone(self.ctx.users.authenticate("carol", "wrong-password"))
        self.assertIsNone(self.ctx.users.authenticate("nobody", "carol-password-1"))
        self.ctx.users.update("Carol", enabled=False)
        self.assertIsNone(self.ctx.users.authenticate("Carol", "carol-password-1"), "중지 계정은 거부")


class BackupReadErrorTest(_Base):
    """F3: 못 읽은 백업은 옮기지 않고 사유를 말한다(손상과 구분)."""

    def test_permission_error_keeps_backup_in_place(self):
        name = self.ctx.backups.create(reason="manual")["name"]
        real = Path.read_text

        def deny(path, *a, **k):
            if path.name == name:
                raise PermissionError(13, "Permission denied")
            return real(path, *a, **k)

        with mock.patch.object(Path, "read_text", deny):
            with self.assertRaises(ValueError) as caught:
                self.ctx.backups.read(name)
            self.assertIn("권한", str(caught.exception))
            with self.assertRaises(ValueError):
                self.ctx.backups.restore(name)
        self.assertEqual(list((self.base / "backups").glob("*.corrupt.*")), [], "읽기 오류를 손상으로 옮기면 안 된다")
        self.assertIn(name, [b["name"] for b in self.ctx.backups.list()])
        self.assertIsInstance(self.ctx.backups.read(name), dict, "권한이 돌아오면 그대로 읽힌다")

    def test_missing_backup_is_still_not_found(self):
        with self.assertRaises(FileNotFoundError):
            self.ctx.backups.read("backup-20200101-000000-manual.json")


class InitialPasswordFileTest(_Base):
    """F4: 초기 계정을 지우면 그 비밀번호가 적힌 파일도 지운다."""

    def test_delete_bootstrap_admin_drops_initial_file(self):
        self.assertTrue(self.ctx.users.initial_password_present())
        self.ctx.users.add("ops", "admin", "ops-password-1")
        self.ctx.users.delete("ops")
        self.assertTrue(self.ctx.users.initial_password_present(), "다른 계정 삭제는 파일을 건드리지 않는다")
        self.ctx.users.add("ops", "admin", "ops-password-1")
        self.ctx.users.delete("admin")
        self.assertFalse(self.ctx.users.initial_password_present(),
                         "지운 계정의 평문 비밀번호 파일이 남았다(화면은 '변경하면 자동 삭제' 라고 안내하지만 바꿀 계정이 없다)")


class UserEnabledTypeTest(_Base):
    """F7: 문자열 'false' 로 중지를 보내면 bool('false') 가 True 라 계정이 켜졌다 — 불리언만 받는다."""

    def test_string_enabled_is_rejected_without_change(self):
        self.ctx.users.add("dave", "viewer", "dave-password-1")
        self.ctx.users.update("dave", enabled=False)
        for bad in ("false", "true", 0, 1):
            with self.assertRaises(AuthError):
                self.ctx.users.update("dave", enabled=bad)
        self.assertFalse(next(u for u in self.ctx.users.public_list() if u["username"] == "dave")["enabled"],
                         "중지 계정이 문자열 값으로 다시 켜지면 안 된다")
        self.ctx.users.update("dave", enabled=True)
        self.assertTrue(next(u for u in self.ctx.users.public_list() if u["username"] == "dave")["enabled"])


class UsernameControlCharTest(_Base):
    """개선: 사용자명 제어문자(로그 줄 위조) 거부 — 다른 글자(한글 · . · @)는 그대로."""

    def test_control_chars_rejected(self):
        for bad in ("evil\n[auth] 설정 로그인: admin", "a\tb", "esc\x1b[31m", "del\x7f"):
            with self.assertRaises(AuthError):
                self.ctx.users.add(bad, "viewer", "pass-word-123")
        for ok in ("hong.gildong", "kim@corp", "홍길동", "a b"):
            self.ctx.users.add(ok, "viewer", "pass-word-123")


class AuditAndHealthRouteTest(ServerCase):
    """F5 · F6 · F8 · F1(서버 경계) · 개선(import 읽기 오류)."""

    def _actions(self):
        return [entry.get("action") for entry in self.ctx.audit.tail(300)]

    def test_settings_changes_are_audited(self):
        code, payload, _ = request(self.url + "/api/settings/datacenters", "POST",
                                   {"code": "AUD-56", "name": "Audit 56", "id": "aud-56"}, self.auth())
        self.assertEqual(code, 201, payload)
        request(self.url + "/api/settings/datacenters/aud-56", "PUT", {"name": "Audit 56b"}, self.auth())
        request(self.url + "/api/settings/datacenters/aud-56/move", "POST", {"direction": "up"}, self.auth())
        request(self.url + "/api/settings/datacenters/aud-56", "DELETE", None, self.auth())
        request(self.url + "/api/settings/categories/monitoring", "PUT", {"label": "모니터링 56"}, self.auth())
        request(self.url + "/api/settings/categories/monitoring/move", "POST", {"direction": "down"}, self.auth())
        actions = self._actions()
        for action in ("datacenter.create", "datacenter.update", "datacenter.move", "datacenter.delete",
                       "category.update", "category.move"):
            self.assertIn(action, actions)

    def test_shortcut_delete_and_reset_are_audited(self):
        code, payload, _ = request(self.url + "/api/shortcuts", "POST",
                                   {"name": "audit-56", "url": "https://audit56.internal/"}, self.auth())
        self.assertEqual(code, 201, payload)
        sid = payload["shortcut"]["id"]
        self.assertEqual(request(self.url + "/api/shortcuts/" + sid, "DELETE", None, self.auth())[0], 200)
        self.assertEqual(request(self.url + "/api/shortcuts/reset", "POST", {}, self.auth())[0], 200)
        entries = self.ctx.audit.tail(300)
        deleted = [e for e in entries if e.get("action") == "shortcut.delete"]
        self.assertTrue(deleted and deleted[0]["detail"]["name"] == "audit-56", deleted)
        self.assertIn("shortcuts.reset", [e.get("action") for e in entries])

    def test_skipped_health_check_hides_deleted_shortcuts(self):
        alive = self.ctx.shortcuts.all()[0]["id"]
        self.ctx.history.record([
            {"id": alive, "url": "https://a.internal/", "status": "healthy", "latencyMs": 3},
            {"id": "sc-deleted-56", "url": "https://gone.internal/", "status": "unreachable"},
        ])
        with mock.patch.object(self.ctx, "run_health_check", lambda targets: None):
            code, payload, _ = request(self.url + "/api/health/check", "POST", {}, self.auth())
        self.assertEqual(code, 200, payload)
        self.assertTrue(payload["skipped"])
        ids = {row["id"] for row in payload["results"]}
        self.assertIn(alive, ids)
        self.assertNotIn("sc-deleted-56", ids, "진행 중 응답이 삭제된 바로가기의 옛 이력을 실었다(/api/health/latest 와 다른 규칙)")

    def test_viewer_backup_list_is_admin_only_but_settings_lists_are_open(self):
        """F1 의 서버 경계 — 화면은 이 403 을 피해야 분류 · 센터 '전체' 목록까지 받는다."""
        request(self.url + "/api/settings/users", "POST",
                {"username": "viewer56", "role": "viewer", "password": "viewer-pass-56"}, self.auth())
        token = self._login("viewer-pass-56", username="viewer56")
        self.assertEqual(request(self.url + "/api/settings/backups", headers=self.auth(token))[0], 403)
        for path in ("/api/settings", "/api/settings/categories", "/api/settings/datacenters"):
            self.assertEqual(request(self.url + path, headers=self.auth(token))[0], 200, path)

    def test_unreadable_server_import_file_is_400_not_500(self):
        folder = self.base / "import"
        folder.mkdir(exist_ok=True)
        (folder / "links56.csv").write_text("name,url\nA,https://a56.internal/\n", encoding="utf-8")
        real = Path.read_text

        def deny(path, *a, **k):
            if path.name == "links56.csv":
                raise PermissionError(13, "Permission denied")
            return real(path, *a, **k)

        with mock.patch.object(Path, "read_text", deny):
            code, payload, _ = request(self.url + "/api/settings/import-files/run", "POST",
                                       {"name": "links56.csv", "mode": "append"}, self.auth())
        self.assertEqual(code, 400, payload)
        self.assertIn("읽지 못했습니다", payload["error"])

    def test_bad_static_paths_get_a_response(self):
        """F8: NUL · 너무 긴 파일 이름의 정적 경로도 응답한다(예전엔 _dispatch 의 try 밖 예외로 무응답 끊김)."""
        port = self.server.server_address[1]
        for target in (b"/a\x00b.js", b"/" + b"a" * 5000 + b".js"):
            sock = socket.create_connection(("127.0.0.1", port), timeout=5)
            try:
                sock.sendall(b"GET " + target + b" HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
                head = sock.recv(64)
            finally:
                sock.close()
            self.assertTrue(head.startswith(b"HTTP/1.1 404"), (target[:12], head))
        self.assertEqual(request(self.url + "/no-such-page.js")[0], 200, "모르는 정적 경로는 예전처럼 첫 화면")


class FrontendContractTest(unittest.TestCase):
    """F1 · 개선 — 화면 코드 계약(동작은 Chromium 으로 확인했다)."""

    def test_load_settings_skips_admin_only_backup_list_for_viewer(self):
        body = _js_function("loadSettings")
        call = body.index('api("/api/settings/backups")')
        guard = body.rfind('role === "admin"', 0, call)
        self.assertNotEqual(guard, -1, "viewer 도 admin 전용 백업 목록을 불러 403 으로 체인이 끊긴다")
        self.assertIn("/api/settings/categories", body[call:])
        self.assertIn("/api/settings/datacenters", body[call:])

    def test_edit_form_keeps_unknown_datacenter_value(self):
        self.assertIn('selectKeeping($("f-datacenter")', _js_function("startEdit"),
                      "선택지에 없는 센터 값이 '' 로 떨어져 저장 때 '전체 공통' 이 된다")
        self.assertIn("selectKeeping(dcSelect", _js_function("fillFormSelects"))

    def test_blocked_status_has_filter_chip(self):
        js = (STATIC / "app.js").read_text(encoding="utf-8")
        filters = js[js.index("var STATUS_FILTERS"): js.index("];", js.index("var STATUS_FILTERS"))]
        self.assertIn('id: "blocked"', filters)

    def test_narrow_settings_layout_does_not_overflow(self):
        css = (STATIC / "styles.css").read_text(encoding="utf-8")
        media = css[css.index("@media (max-width: 1080px)"):]
        media = media[: media.index("}\n@media")]
        self.assertRegex(media, r"\.settings-layout\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)")
        self.assertRegex(media, r"\.settings-layout\s*>\s*\*\s*\{\s*min-width:\s*0")
        self.assertIsNone(re.search(r"\.settings-layout\s*\{\s*grid-template-columns:\s*1fr\s*;", media))


if __name__ == "__main__":
    unittest.main()
