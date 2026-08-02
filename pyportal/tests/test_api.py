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
    def _login(cls, password):
        code, payload, _ = request(cls.url + "/api/settings/session", "POST",
                                   {"password": password})
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
        code, payload, _ = request(self.url + "/api/health/check", "POST",
                                   {"urls": ["http://127.0.0.1:9/"]})
        self.assertEqual(code, 200)
        self.assertEqual(payload["results"][0]["status"], "blocked")


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
        viewer_token = self._login("viewer-password-1")
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
        token = self._login("temp-password-1")
        self.assertEqual(request(self.url + "/api/settings", headers={"X-Settings-Token": token})[0], 200)
        request(self.url + "/api/settings/users/temp1/password", "POST",
                {"password": "temp-password-2"}, self.auth())
        self.assertEqual(request(self.url + "/api/settings", headers={"X-Settings-Token": token})[0], 401)
        request(self.url + "/api/settings/users/temp1", "DELETE", None, self.auth())


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
