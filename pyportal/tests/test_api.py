"""HTTP API E2E — 실제 서버를 띄워 REST 계약·인증·정적 서빙을 검증한다."""

import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hub import server as server_mod  # noqa: E402
from hub.app import AppContext  # noqa: E402
from hub.config import config  # noqa: E402


def _maybe_json(raw):
    """정적 파일(HTML/CSS)도 같은 헬퍼로 받으므로 JSON 이 아니면 원문을 그대로 준다."""
    if not raw:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return {"raw": raw.decode("utf-8", "replace")}


def request(url, method="GET", body=None, headers=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/json")
    if data:
        req.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=8) as response:
            return response.getcode(), _maybe_json(response.read()), dict(response.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, _maybe_json(exc.read()), dict(exc.headers)


class ServerCase(unittest.TestCase):
    """임시 데이터 폴더로 서버를 띄우고 admin 세션을 확보한다."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.base = Path(cls.tmp.name)
        # 워커(자동 점검/백업)는 테스트에서 켜지 않는다 — 결과가 흔들린다.
        cls.ctx = AppContext(cls.base, start_workers=False)
        cls.password = cls._read_initial_password()
        cls.server = server_mod.create_server("127.0.0.1", 0, cls.ctx)
        cls.url = "http://127.0.0.1:{}".format(cls.server.server_address[1])
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.token = cls._login(cls.password)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.ctx.close()
        cls.tmp.cleanup()

    @classmethod
    def _read_initial_password(cls):
        text = (cls.base / "initial-settings-password.txt").read_text(encoding="utf-8")
        for line in text.splitlines():
            if line.startswith("password:"):
                return line.split(":", 1)[1].strip()
        raise AssertionError("초기 비밀번호 파일에 password 줄이 없습니다.")

    @classmethod
    def _login(cls, password, username="admin"):
        code, payload, _ = request(cls.url + "/api/settings/session", "POST",
                                   {"username": username, "password": password})
        assert code == 200, payload
        return payload["token"]

    def auth(self, token=None):
        return {"X-Settings-Token": token or self.token}


class PublicApiTest(ServerCase):
    def test_meta_exposes_catalog_and_ranges(self):
        code, payload, _ = request(self.url + "/api/meta")
        self.assertEqual(code, 200)
        self.assertEqual(payload["datacenterCount"], 28)
        self.assertEqual(len(payload["historyRanges"]), 8)
        self.assertIsNone(payload["session"], "토큰 없이 조회하면 세션은 비어 있어야 한다.")

    def test_meta_reports_session_when_logged_in(self):
        code, payload, _ = request(self.url + "/api/meta", headers=self.auth())
        self.assertEqual(payload["session"]["username"], "admin")

    def test_datacenters_and_shortcuts_are_public(self):
        self.assertEqual(request(self.url + "/api/datacenters")[0], 200)
        self.assertEqual(request(self.url + "/api/shortcuts")[0], 200)

    def test_history_endpoint_returns_series(self):
        code, payload, _ = request(self.url + "/api/health/history?range=1h")
        self.assertEqual(code, 200)
        self.assertEqual(payload["range"], "1h")
        self.assertIn("points", payload)
        self.assertIn("summary", payload)

    def test_health_check_blocks_loopback_targets(self):
        # 임의 URL 점검은 로그인 필요(6차 감사) — 로그인해도 루프백은 여전히 차단된다.
        code, payload, _ = request(self.url + "/api/health/check", "POST",
                                   {"urls": ["http://127.0.0.1:9/"]}, self.auth())
        self.assertEqual(code, 200)
        self.assertEqual(payload["results"][0]["status"], "blocked")


class AuditSixTest(ServerCase):
    """6차 감사 회귀 방지 — 정보노출·SSRF 스캐너·CSRF·잠금 DoS."""

    def test_meta_hides_initial_password_path_from_anonymous(self):
        # 미인증 응답에 절대경로를 실으면 서버 구조가 드러나고, 초기 비밀번호가
        # 아직 유효하다는 사실까지 알려 주게 된다.
        code, payload, _ = request(self.url + "/api/meta")
        self.assertEqual(code, 200)
        self.assertIsNone(payload["initialPasswordFile"])
        self.assertIsNone(payload["setupPending"])

    def test_meta_shows_path_to_logged_in_user(self):
        code, payload, _ = request(self.url + "/api/meta", headers=self.auth())
        self.assertTrue(payload["initialPasswordFile"])
        self.assertTrue(payload["setupPending"])

    def test_arbitrary_url_check_requires_login(self):
        # 로그인 없이 임의 URL 을 찌를 수 있으면 사내망 포트 스캐너가 된다.
        code, payload, _ = request(self.url + "/api/health/check", "POST",
                                   {"urls": ["http://192.0.2.2:9999/"]})
        self.assertEqual(code, 401)
        self.assertEqual(payload["code"], "settings_login_required")

    def test_arbitrary_url_check_allowed_with_session(self):
        code, payload, _ = request(self.url + "/api/health/check", "POST",
                                   {"urls": ["http://192.0.2.2:9/"]}, self.auth())
        self.assertEqual(code, 200)
        self.assertEqual(len(payload["results"]), 1)

    def test_anonymous_recheck_is_rate_limited(self):
        first = request(self.url + "/api/health/check", "POST", {})[0]
        self.assertEqual(first, 200)
        code, _, _ = request(self.url + "/api/health/check", "POST", {})
        self.assertEqual(code, 429, "미인증 재점검이 무제한이면 부하 증폭에 쓰인다.")
        # 로그인 상태에서는 쿨다운이 적용되지 않는다.
        self.assertEqual(request(self.url + "/api/health/check", "POST", {}, self.auth())[0], 200)

    def test_cookie_credential_rejected_for_mutations(self):
        # 쿠키가 상태변경까지 인증하면 교차출처 POST(CSRF)가 성립한다.
        code, _, _ = request(self.url + "/api/shortcuts", "POST",
                             {"name": "csrf", "url": "csrf.internal"},
                             {"Cookie": "hub_settings=" + self.token})
        self.assertEqual(code, 401)

    def test_cookie_credential_still_works_for_reads(self):
        code, payload, _ = request(self.url + "/api/settings",
                                   headers={"Cookie": "hub_settings=" + self.token})
        self.assertEqual(code, 200)

    def test_cross_site_mutation_blocked(self):
        code, _, _ = request(self.url + "/api/shortcuts", "POST",
                             {"name": "x", "url": "x.internal"},
                             {"X-Settings-Token": self.token, "Origin": "http://evil.example"})
        self.assertEqual(code, 403)

    def test_same_origin_mutation_allowed(self):
        host = self.url.replace("http://", "")
        code, _, _ = request(self.url + "/api/shortcuts", "POST",
                             {"name": "same-origin 링크", "url": "ok.internal.dc"},
                             {"X-Settings-Token": self.token, "Origin": self.url,
                              "Sec-Fetch-Site": "same-origin"})
        self.assertEqual(code, 201, "같은 출처 요청까지 막으면 화면이 동작하지 않는다. host=" + host)


class MutationGuardTest(ServerCase):
    """조회는 열려 있고 변경은 설정 로그인이 필요하다."""

    def test_create_without_session_is_401(self):
        code, payload, _ = request(self.url + "/api/shortcuts", "POST",
                                   {"name": "x", "url": "x.internal"})
        self.assertEqual(code, 401)
        self.assertEqual(payload["code"], "settings_login_required")

    def test_all_write_routes_guarded(self):
        cases = [("POST", "/api/shortcuts", {}), ("PUT", "/api/shortcuts/sc-1", {}),
                 ("DELETE", "/api/shortcuts/sc-1", None), ("POST", "/api/shortcuts/reset", {}),
                 ("POST", "/api/import", {}), ("GET", "/api/export", None),
                 ("GET", "/api/settings", None), ("PUT", "/api/settings/backup", {}),
                 ("GET", "/api/settings/users", None), ("POST", "/api/settings/users", {}),
                 ("POST", "/api/settings/datacenters", {}), ("GET", "/api/settings/backups", None),
                 ("POST", "/api/settings/backups", {})]
        for method, path, body in cases:
            code, _, _ = request(self.url + path, method, body)
            self.assertEqual(code, 401, "{} {}".format(method, path))

    def test_create_update_delete_with_session(self):
        code, payload, _ = request(self.url + "/api/shortcuts", "POST",
                                   {"name": "테스트 링크", "url": "test.internal.dc/path"},
                                   self.auth())
        self.assertEqual(code, 201)
        created = payload["shortcut"]
        self.assertEqual(created["url"], "https://test.internal.dc/path")

        code, payload, _ = request(self.url + "/api/shortcuts/" + created["id"], "PUT",
                                   {"isFavorite": True}, self.auth())
        self.assertEqual(code, 200)
        self.assertTrue(payload["shortcut"]["isFavorite"])

        code, _, _ = request(self.url + "/api/shortcuts/" + created["id"], "DELETE", None,
                             self.auth())
        self.assertEqual(code, 200)

    def test_invalid_token_rejected(self):
        code, _, _ = request(self.url + "/api/settings", headers={"X-Settings-Token": "nope"})
        self.assertEqual(code, 401)


class SettingsApiTest(ServerCase):
    def test_settings_state_shape(self):
        code, payload, _ = request(self.url + "/api/settings", headers=self.auth())
        self.assertEqual(code, 200)
        self.assertIn("backup", payload["settings"])
        self.assertIn("health", payload["settings"])
        self.assertEqual(payload["users"][0]["username"], "admin")
        self.assertIn("backupIntervalMinutes", payload["choices"])

    def test_update_backup_settings(self):
        code, payload, _ = request(self.url + "/api/settings/backup", "PUT",
                                   {"enabled": True, "intervalMinutes": 360, "keep": 5},
                                   self.auth())
        self.assertEqual(code, 200)
        self.assertEqual(payload["settings"]["backup"]["intervalMinutes"], 360)
        self.assertEqual(payload["settings"]["backup"]["keep"], 5)

    def test_invalid_interval_falls_back_to_previous(self):
        request(self.url + "/api/settings/health", "PUT",
                {"autoEnabled": True, "intervalMinutes": 5}, self.auth())
        code, payload, _ = request(self.url + "/api/settings/health", "PUT",
                                   {"intervalMinutes": 7}, self.auth())   # 허용 목록 밖
        self.assertEqual(code, 200)
        self.assertEqual(payload["settings"]["health"]["intervalMinutes"], 5)

    def test_display_limit_controls_public_list(self):
        code, payload, _ = request(self.url + "/api/datacenters")
        self.assertEqual(len(payload["datacenters"]), 28)
        self.assertEqual(payload["displayLimit"], 0)

        code, payload, _ = request(self.url + "/api/settings/display", "PUT",
                                   {"datacenterLimit": 13}, self.auth())
        self.assertEqual(code, 200)
        self.assertEqual(payload["settings"]["display"]["datacenterLimit"], 13)

        code, payload, _ = request(self.url + "/api/datacenters")
        self.assertEqual(len(payload["datacenters"]), 13)
        self.assertEqual(payload["totalRegistered"], 28)
        self.assertEqual(payload["summary"]["total"], 13, "통계도 표시 목록 기준이어야 한다.")

        # 편집 목록은 표시 개수와 무관하게 전부 나와야 한다(줄였다고 수정 불가가 되면 안 됨).
        code, payload, _ = request(self.url + "/api/settings/datacenters", headers=self.auth())
        self.assertEqual(len(payload["datacenters"]), 28)
        self.assertEqual(payload["displayLimit"], 13)

        code, payload, _ = request(self.url + "/api/meta")
        self.assertEqual(payload["datacenterCount"], 13)
        self.assertEqual(payload["datacenterRegistered"], 28)

        # 0 = 전체로 복귀
        request(self.url + "/api/settings/display", "PUT", {"datacenterLimit": 0}, self.auth())
        self.assertEqual(len(request(self.url + "/api/datacenters")[1]["datacenters"]), 28)

    def test_display_limit_is_clamped(self):
        code, payload, _ = request(self.url + "/api/settings/display", "PUT",
                                   {"datacenterLimit": 99999}, self.auth())
        self.assertLessEqual(payload["settings"]["display"]["datacenterLimit"], 300)
        code, payload, _ = request(self.url + "/api/settings/display", "PUT",
                                   {"datacenterLimit": -5}, self.auth())
        self.assertEqual(payload["settings"]["display"]["datacenterLimit"], 0)

    def test_display_limit_requires_admin(self):
        code, _, _ = request(self.url + "/api/settings/display", "PUT", {"datacenterLimit": 5})
        self.assertEqual(code, 401)

    def test_datacenter_crud(self):
        code, payload, _ = request(self.url + "/api/settings/datacenters", "POST",
                                   {"code": "BUS-1", "name": "부산 센터", "city": "Busan",
                                    "region": "APAC", "lat": 35.1, "lng": 129.0, "racks": 300},
                                   self.auth())
        self.assertEqual(code, 201)
        self.assertEqual(payload["datacenter"]["id"], "bus-1")
        self.assertEqual(len(payload["datacenters"]), 29)

        code, payload, _ = request(self.url + "/api/settings/datacenters/bus-1", "PUT",
                                   {"racks": 900}, self.auth())
        self.assertEqual(payload["datacenter"]["racks"], 900)

        # 새 DC 에 바로가기를 연결할 수 있어야 한다(고정 목록이면 'all' 로 떨어진다).
        code, payload, _ = request(self.url + "/api/shortcuts", "POST",
                                   {"name": "부산 콘솔", "url": "bus.internal.dc",
                                    "datacenterId": "bus-1"}, self.auth())
        self.assertEqual(payload["shortcut"]["datacenterId"], "bus-1")

        code, _, _ = request(self.url + "/api/settings/datacenters/bus-1", "DELETE", None,
                             self.auth())
        self.assertEqual(code, 200)
        code, _, _ = request(self.url + "/api/settings/datacenters/bus-1", "DELETE", None,
                             self.auth())
        self.assertEqual(code, 404)
        request(self.url + "/api/settings/datacenters/reset", "POST", {}, self.auth())

    def test_backup_create_list_download_delete(self):
        code, payload, _ = request(self.url + "/api/settings/backups", "POST", {}, self.auth())
        self.assertEqual(code, 201)
        name = payload["backup"]["name"]

        code, payload, headers = request(self.url + "/api/settings/backups/" + name,
                                         headers=self.auth())
        self.assertEqual(code, 200)
        self.assertIn("attachment", headers.get("Content-Disposition", ""))
        self.assertIn("shortcuts", payload["data"])

        code, _, _ = request(self.url + "/api/settings/backups/" + name, "DELETE", None, self.auth())
        self.assertEqual(code, 200)

    def test_backup_name_traversal_rejected(self):
        code, _, _ = request(self.url + "/api/settings/backups/..%2F..%2Fusers.json",
                             headers=self.auth())
        self.assertIn(code, (400, 404))

    def test_user_management_flow(self):
        code, payload, _ = request(self.url + "/api/settings/users", "POST",
                                   {"username": "viewer1", "role": "viewer",
                                    "password": "viewer-password-1"}, self.auth())
        self.assertEqual(code, 201)
        self.assertEqual(len(payload["users"]), 2)

        # viewer 로 로그인하면 바로가기는 되지만 관리자 영역은 막힌다.
        viewer_token = self._login("viewer-password-1", "viewer1")
        code, _, _ = request(self.url + "/api/settings/users", "POST",
                             {"username": "x", "role": "viewer", "password": "another-pass-1"},
                             {"X-Settings-Token": viewer_token})
        self.assertEqual(code, 403)
        code, _, _ = request(self.url + "/api/shortcuts", "POST",
                             {"name": "viewer 링크", "url": "v.internal.dc"},
                             {"X-Settings-Token": viewer_token})
        self.assertEqual(code, 201)

        code, _, _ = request(self.url + "/api/settings/users/viewer1", "DELETE", None, self.auth())
        self.assertEqual(code, 200)

    def test_cannot_delete_self(self):
        code, _, _ = request(self.url + "/api/settings/users/admin", "DELETE", None, self.auth())
        self.assertEqual(code, 400)

    def test_password_change_invalidates_session(self):
        request(self.url + "/api/settings/users", "POST",
                {"username": "temp1", "role": "viewer", "password": "temp-password-1"}, self.auth())
        token = self._login("temp-password-1", "temp1")
        self.assertEqual(request(self.url + "/api/settings", headers={"X-Settings-Token": token})[0], 200)
        request(self.url + "/api/settings/users/temp1/password", "POST",
                {"password": "temp-password-2"}, self.auth())
        self.assertEqual(request(self.url + "/api/settings", headers={"X-Settings-Token": token})[0], 401)
        request(self.url + "/api/settings/users/temp1", "DELETE", None, self.auth())


class OrderingTest(ServerCase):
    """표시 순서 지정 — 대시보드·센터 현황은 저장된 배열 순서를 그대로 쓴다."""

    def test_shortcut_move_swaps_neighbours(self):
        code, payload, _ = request(self.url + "/api/shortcuts", headers=self.auth())
        first, second = payload["shortcuts"][0]["id"], payload["shortcuts"][1]["id"]
        code, payload, _ = request(self.url + "/api/shortcuts/" + second + "/move", "POST",
                                   {"direction": "up"}, self.auth())
        self.assertEqual(code, 200)
        self.assertTrue(payload["moved"])
        self.assertEqual([payload["shortcuts"][0]["id"], payload["shortcuts"][1]["id"]],
                         [second, first])
        # 되돌려 놓는다(다른 테스트의 기대 순서를 흔들지 않게).
        request(self.url + "/api/shortcuts/" + second + "/move", "POST",
                {"direction": "down"}, self.auth())

    def test_move_at_edge_is_not_an_error(self):
        code, payload, _ = request(self.url + "/api/shortcuts", headers=self.auth())
        top = payload["shortcuts"][0]["id"]
        code, payload, _ = request(self.url + "/api/shortcuts/" + top + "/move", "POST",
                                   {"direction": "up"}, self.auth())
        self.assertEqual(code, 200)
        self.assertFalse(payload["moved"])

    def test_move_requires_session(self):
        code, payload, _ = request(self.url + "/api/shortcuts", headers=self.auth())
        top = payload["shortcuts"][0]["id"]
        self.assertEqual(request(self.url + "/api/shortcuts/" + top + "/move", "POST",
                                 {"direction": "down"})[0], 401)

    def test_datacenter_move_changes_visible_window(self):
        # 표시 개수 1 이면 '맨 앞 1개' 만 공개된다 — 순서를 바꾸면 보이는 센터가 바뀐다.
        request(self.url + "/api/settings/display", "PUT", {"datacenterLimit": 1}, self.auth())
        try:
            _, payload, _ = request(self.url + "/api/settings/datacenters", headers=self.auth())
            second = payload["datacenters"][1]["id"]
            request(self.url + "/api/settings/datacenters/" + second + "/move", "POST",
                    {"direction": "up"}, self.auth())
            _, public, _ = request(self.url + "/api/datacenters")
            self.assertEqual(public["datacenters"][0]["id"], second)
            request(self.url + "/api/settings/datacenters/" + second + "/move", "POST",
                    {"direction": "down"}, self.auth())
        finally:
            request(self.url + "/api/settings/display", "PUT", {"datacenterLimit": 0}, self.auth())

    def test_bad_direction_is_rejected(self):
        code, payload, _ = request(self.url + "/api/shortcuts", headers=self.auth())
        top = payload["shortcuts"][0]["id"]
        self.assertEqual(request(self.url + "/api/shortcuts/" + top + "/move", "POST",
                                 {"direction": "sideways"}, self.auth())[0], 400)


class NotifyAndAuditTest(ServerCase):
    def test_notify_section_round_trips(self):
        code, payload, _ = request(self.url + "/api/settings/notify", "PUT", {
            "enabled": True, "webhookUrl": "https://hooks.internal/x",
            "failThreshold": 3, "minIntervalMinutes": 20,
        }, self.auth())
        self.assertEqual(code, 200)
        self.assertEqual(payload["value"]["failThreshold"], 3)
        self.assertEqual(payload["value"]["webhookUrl"], "https://hooks.internal/x")

    def test_non_http_webhook_is_dropped(self):
        # 저장 URL 을 서버가 그대로 요청하므로 스킴을 좁혀 둔다.
        _, payload, _ = request(self.url + "/api/settings/notify", "PUT",
                                {"webhookUrl": "javascript:alert(1)"}, self.auth())
        self.assertEqual(payload["value"]["webhookUrl"], "")

    def test_notify_test_without_url_is_rejected(self):
        request(self.url + "/api/settings/notify", "PUT", {"webhookUrl": ""}, self.auth())
        self.assertEqual(request(self.url + "/api/settings/notify/test", "POST",
                                 {}, self.auth())[0], 400)

    def test_audit_records_login_and_settings_change(self):
        request(self.url + "/api/settings/display", "PUT", {"datacenterLimit": 0}, self.auth())
        code, payload, _ = request(self.url + "/api/settings/audit", headers=self.auth())
        self.assertEqual(code, 200)
        actions = [entry["action"] for entry in payload["entries"]]
        self.assertIn("settings.update", actions)
        self.assertIn("login", actions)

    def test_audit_never_stores_secrets(self):
        request(self.url + "/api/settings/users", "POST",
                {"username": "audituser", "role": "viewer", "password": "audit-password-1"},
                self.auth())
        _, payload, _ = request(self.url + "/api/settings/audit", headers=self.auth())
        raw = json.dumps(payload, ensure_ascii=False)
        self.assertNotIn("audit-password-1", raw)
        request(self.url + "/api/settings/users/audituser", "DELETE", None, self.auth())

    def test_audit_requires_admin(self):
        request(self.url + "/api/settings/users", "POST",
                {"username": "auditviewer", "role": "viewer", "password": "viewer-password-1"},
                self.auth())
        token = self._login("viewer-password-1", "auditviewer")
        self.assertEqual(request(self.url + "/api/settings/audit",
                                 headers={"X-Settings-Token": token})[0], 403)
        request(self.url + "/api/settings/users/auditviewer", "DELETE", None, self.auth())

    def test_audit_is_anonymous_denied(self):
        self.assertEqual(request(self.url + "/api/settings/audit")[0], 401)


class LoginTest(ServerCase):
    """v2.216 — 로그인이 사용자명 + 비밀번호를 받는다."""

    def test_password_alone_is_rejected(self):
        code, _, _ = request(self.url + "/api/settings/session", "POST",
                             {"password": self.password})
        self.assertEqual(code, 401, "비밀번호만으로 로그인되면 비밀번호가 곧 계정 식별자가 된다.")

    def test_wrong_username_is_rejected(self):
        code, _, _ = request(self.url + "/api/settings/session", "POST",
                             {"username": "nosuchuser", "password": self.password})
        self.assertEqual(code, 401)

    def test_error_message_does_not_reveal_which_field_was_wrong(self):
        _, bad_user, _ = request(self.url + "/api/settings/session", "POST",
                                 {"username": "nosuchuser", "password": self.password})
        _, bad_pass, _ = request(self.url + "/api/settings/session", "POST",
                                 {"username": "admin", "password": "definitely-wrong-1"})
        self.assertEqual(bad_user["error"], bad_pass["error"],
                         "구분해서 알려 주면 어떤 사용자명이 존재하는지 드러난다.")


class CategoryApiTest(ServerCase):
    def test_meta_serves_editable_categories(self):
        _, payload, _ = request(self.url + "/api/meta")
        ids = [cat["id"] for cat in payload["categories"]]
        self.assertIn("custom", ids)
        self.assertIn("color", payload["categories"][0])

    def test_create_update_and_move(self):
        code, payload, _ = request(self.url + "/api/settings/categories", "POST",
                                   {"label": "가상화 & 클라우드", "id": "virt", "color": "cyan"},
                                   self.auth())
        self.assertEqual(code, 201)
        self.assertEqual(payload["category"]["color"], "cyan")

        _, payload, _ = request(self.url + "/api/settings/categories/virt", "PUT",
                                {"label": "가상화", "color": "rose"}, self.auth())
        self.assertEqual(payload["category"]["label"], "가상화")

        _, payload, _ = request(self.url + "/api/settings/categories/virt/move", "POST",
                                {"direction": "up"}, self.auth())
        self.assertTrue(payload["moved"])
        request(self.url + "/api/settings/categories/virt", "DELETE", None, self.auth())

    def test_delete_moves_shortcuts_to_default(self):
        request(self.url + "/api/settings/categories", "POST",
                {"label": "임시분류", "id": "temp"}, self.auth())
        _, created, _ = request(self.url + "/api/shortcuts", "POST",
                                {"name": "임시 링크", "url": "temp.internal.dc",
                                 "category": "temp"}, self.auth())
        self.assertEqual(created["shortcut"]["category"], "temp")

        _, payload, _ = request(self.url + "/api/settings/categories/temp", "DELETE",
                                None, self.auth())
        self.assertEqual(payload["movedShortcuts"], 1)
        moved = next(sc for sc in payload["shortcuts"] if sc["id"] == created["shortcut"]["id"])
        self.assertEqual(moved["category"], "custom",
                         "분류만 사라지고 바로가기는 남아야 한다.")
        request(self.url + "/api/shortcuts/" + moved["id"], "DELETE", None, self.auth())

    def test_default_category_cannot_be_deleted(self):
        code, _, _ = request(self.url + "/api/settings/categories/custom", "DELETE",
                             None, self.auth())
        self.assertEqual(code, 400)

    def test_unknown_category_on_shortcut_falls_back(self):
        _, payload, _ = request(self.url + "/api/shortcuts", "POST",
                                {"name": "분류 없는 링크", "url": "nocat.internal.dc",
                                 "category": "존재하지않음"}, self.auth())
        self.assertEqual(payload["shortcut"]["category"], "custom")
        request(self.url + "/api/shortcuts/" + payload["shortcut"]["id"], "DELETE",
                None, self.auth())

    def test_category_write_requires_admin(self):
        self.assertEqual(request(self.url + "/api/settings/categories", "POST",
                                 {"label": "x"})[0], 401)


class CsvApiTest(ServerCase):
    def test_export_is_csv_attachment(self):
        code, payload, headers = request(self.url + "/api/export/csv", headers=self.auth())
        self.assertEqual(code, 200)
        self.assertIn("text/csv", headers["Content-Type"])
        self.assertIn(".csv", headers["Content-Disposition"])
        self.assertIn("name,url,category", payload["raw"])

    def test_export_requires_session(self):
        self.assertEqual(request(self.url + "/api/export/csv")[0], 401)

    def test_import_appends_and_skips_duplicates(self):
        csv_text = ("name,url,category\n"
                    "CSV 링크 A,https://csv-a.internal.dc/,monitoring\n"
                    "CSV 링크 B,https://csv-b.internal.dc/,custom\n")
        _, before, _ = request(self.url + "/api/shortcuts")
        code, payload, _ = request(self.url + "/api/import/csv", "POST",
                                   {"csv": csv_text}, self.auth())
        self.assertEqual(code, 200)
        self.assertEqual(payload["added"], 2)
        self.assertEqual(len(payload["shortcuts"]), len(before["shortcuts"]) + 2)

        # 같은 파일을 다시 올려도 목록이 두 배가 되면 안 된다.
        _, again, _ = request(self.url + "/api/import/csv", "POST",
                              {"csv": csv_text}, self.auth())
        self.assertEqual(again["added"], 0)
        self.assertEqual(again["skipped"], 2)

        for shortcut in again["shortcuts"]:
            if shortcut["url"].startswith("https://csv-"):
                request(self.url + "/api/shortcuts/" + shortcut["id"], "DELETE", None, self.auth())

    def test_import_rejects_rows_without_name_or_url(self):
        code, _, _ = request(self.url + "/api/import/csv", "POST",
                             {"csv": "name,url\n,\n"}, self.auth())
        self.assertEqual(code, 400)

    def test_json_import_append_mode_skips_duplicates(self):
        """JSON 가져오기 mode=append(v2.219) — 덧붙이고 같은 URL 은 건너뛴다."""
        entries = [{"name": "JSON 링크 A", "url": "https://json-a.internal.dc/", "category": "custom"}]
        _, before, _ = request(self.url + "/api/shortcuts")
        code, payload, _ = request(self.url + "/api/import", "POST",
                                   {"shortcuts": entries, "mode": "append"}, self.auth())
        self.assertEqual(code, 200)
        self.assertEqual(payload["added"], 1)
        self.assertEqual(len(payload["shortcuts"]), len(before["shortcuts"]) + 1)
        # 같은 파일을 다시 append 해도 목록이 늘지 않는다.
        _, again, _ = request(self.url + "/api/import", "POST",
                              {"shortcuts": entries, "mode": "append"}, self.auth())
        self.assertEqual(again["added"], 0)
        self.assertEqual(again["skipped"], 1)
        for shortcut in again["shortcuts"]:
            if shortcut["url"].startswith("https://json-a"):
                request(self.url + "/api/shortcuts/" + shortcut["id"], "DELETE", None, self.auth())

    def test_json_import_with_category_override_creates_missing(self):
        """가져오기 일괄 카테고리(v2.219) — 전 항목 지정 + 없는 분류는 admin 이 즉석 생성."""
        entries = [{"name": "카테고리 링크", "url": "https://json-cat.internal.dc/", "category": "custom"}]
        code, payload, _ = request(self.url + "/api/import", "POST",
                                   {"shortcuts": entries, "mode": "append", "category": "SBP"},
                                   self.auth())
        self.assertEqual(code, 200)
        imported = [s for s in payload["shortcuts"] if s["url"].startswith("https://json-cat")]
        self.assertEqual(len(imported), 1)
        self.assertEqual(imported[0]["category"], "sbp")  # 라벨 SBP → 슬러그 id
        request(self.url + "/api/shortcuts/" + imported[0]["id"], "DELETE", None, self.auth())

    def test_json_import_default_is_replace(self):
        """mode 없는 옛 요청은 기존 동작(통째 교체) 유지 — 하위호환."""
        entries = [{"name": "교체 링크", "url": "https://json-replace.internal.dc/", "category": "custom"}]
        code, payload, _ = request(self.url + "/api/import", "POST",
                                   {"shortcuts": entries}, self.auth())
        self.assertEqual(code, 200)
        self.assertEqual(len(payload["shortcuts"]), 1)
        self.assertEqual(payload["shortcuts"][0]["url"], "https://json-replace.internal.dc/")

    def test_import_requires_session(self):
        self.assertEqual(request(self.url + "/api/import/csv", "POST",
                                 {"csv": "name,url\nA,https://a.internal/\n"})[0], 401)


class HealthMethodTest(ServerCase):
    def test_default_method_is_port(self):
        _, payload, _ = request(self.url + "/api/settings", headers=self.auth())
        self.assertEqual(payload["settings"]["health"]["method"], "port")

    def test_method_can_be_switched_and_is_whitelisted(self):
        _, payload, _ = request(self.url + "/api/settings/health", "PUT",
                                {"autoEnabled": True, "intervalMinutes": 5, "method": "http"},
                                self.auth())
        self.assertEqual(payload["value"]["method"], "http")
        _, payload, _ = request(self.url + "/api/settings/health", "PUT",
                                {"method": "telnet"}, self.auth())
        self.assertEqual(payload["value"]["method"], "port", "허용 목록 밖은 기본값으로")


class KeepAliveTest(ServerCase):
    """본문을 쓰지 않는 핸들러 뒤의 요청이 깨지지 않아야 한다(과거 501 desync)."""

    def test_pipeline_of_bodyless_handlers(self):
        import http.client
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=8)
        headers = {"Content-Type": "application/json", "X-Settings-Token": self.token}

        def call(method, path, body=None):
            conn.request(method, path, json.dumps(body) if body is not None else None, headers)
            response = conn.getresponse()
            response.read()
            return response.status

        self.assertEqual(call("POST", "/api/settings/backups", {}), 201)
        self.assertEqual(call("PUT", "/api/settings/backup",
                              {"enabled": True, "intervalMinutes": 1440, "keep": 14}), 200)
        self.assertEqual(call("POST", "/api/shortcuts/reset", {}), 200)
        self.assertEqual(call("GET", "/api/meta"), 200)
        conn.close()


class StaticTest(ServerCase):
    def test_index_is_served_with_security_headers(self):
        code, _, headers = request(self.url + "/")
        self.assertEqual(code, 200)
        self.assertEqual(headers.get("X-Frame-Options"), "DENY")
        self.assertEqual(headers.get("X-Content-Type-Options"), "nosniff")
        self.assertIn("default-src 'self'", headers.get("Content-Security-Policy", ""))

    def test_static_assets_served(self):
        for path in ("/app.js", "/styles.css", "/favicon.svg"):
            self.assertEqual(request(self.url + path)[0], 200, path)

    def test_path_traversal_does_not_escape_static_dir(self):
        code, _, headers = request(self.url + "/../hub/config.py")
        self.assertEqual(code, 200)
        self.assertTrue(headers.get("Content-Type", "").startswith("text/html"),
                        "정적 디렉터리 밖 파일이 서빙되면 안 된다(index.html 로 폴백해야 함).")

    def test_unknown_api_is_404(self):
        self.assertEqual(request(self.url + "/api/nope")[0], 404)


class HubTokenTest(unittest.TestCase):
    """HUB_TOKEN 이 설정되면 조회까지 포함해 모든 /api 가 토큰을 요구한다."""

    @classmethod
    def setUpClass(cls):
        cls.original = config.token
        config.token = "hub-secret-1"
        cls.tmp = tempfile.TemporaryDirectory()
        cls.ctx = AppContext(Path(cls.tmp.name), start_workers=False)
        cls.server = server_mod.create_server("127.0.0.1", 0, cls.ctx)
        cls.url = "http://127.0.0.1:{}".format(cls.server.server_address[1])
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        config.token = cls.original
        cls.server.shutdown()
        cls.server.server_close()
        cls.ctx.close()
        cls.tmp.cleanup()

    def test_requires_token_with_distinct_code(self):
        code, payload, _ = request(self.url + "/api/shortcuts")
        self.assertEqual(code, 401)
        # 설정 로그인 실패와 구분되어야 화면이 엉뚱한 모달을 띄우지 않는다.
        self.assertEqual(payload["code"], "hub_token_required")

    def test_accepts_header_and_cookie(self):
        self.assertEqual(request(self.url + "/api/shortcuts",
                                 headers={"X-Hub-Token": "hub-secret-1"})[0], 200)
        self.assertEqual(request(self.url + "/api/shortcuts",
                                 headers={"Cookie": "hub_token=hub-secret-1"})[0], 200)

    def test_page_itself_is_public(self):
        self.assertEqual(request(self.url + "/")[0], 200)


if __name__ == "__main__":
    unittest.main()
