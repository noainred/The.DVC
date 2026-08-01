"""HTTP API E2E — 실제 서버를 띄워 REST 계약과 정적 서빙을 검증한다."""

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
from hub.config import config  # noqa: E402
from hub.store import ShortcutStore  # noqa: E402


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
        with urllib.request.urlopen(req, timeout=5) as response:
            raw = response.read()
            return response.getcode(), _maybe_json(raw), dict(response.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, _maybe_json(exc.read()), dict(exc.headers)


class ApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        store = ShortcutStore(Path(cls.tmp.name) / "shortcuts.json")
        cls.server = server_mod.create_server("127.0.0.1", 0, store)
        cls.base = "http://127.0.0.1:{}".format(cls.server.server_address[1])
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    # ---------- 조회 ----------

    def test_meta_exposes_catalog(self):
        code, payload, _ = request(self.base + "/api/meta")
        self.assertEqual(code, 200)
        self.assertTrue(payload["success"])
        self.assertGreaterEqual(len(payload["categories"]), 5)
        self.assertEqual(payload["datacenterCount"], 28)

    def test_datacenters_returns_28_sites_with_summary(self):
        code, payload, _ = request(self.base + "/api/datacenters")
        self.assertEqual(code, 200)
        self.assertEqual(len(payload["datacenters"]), 28)
        self.assertEqual(payload["summary"]["total"], 28)
        self.assertEqual(sum(payload["summary"]["byRegion"].values()), 28)

    def test_shortcuts_seeded(self):
        code, payload, _ = request(self.base + "/api/shortcuts")
        self.assertEqual(code, 200)
        self.assertGreater(len(payload["shortcuts"]), 0)

    # ---------- 생성/수정/삭제 ----------

    def test_create_update_delete_flow(self):
        code, payload, _ = request(self.base + "/api/shortcuts", "POST",
                                   {"name": "테스트 링크", "url": "test.internal.dc/path"})
        self.assertEqual(code, 201)
        created = payload["shortcut"]
        self.assertEqual(created["url"], "https://test.internal.dc/path")
        self.assertEqual(payload["shortcuts"][0]["id"], created["id"])

        code, payload, _ = request(self.base + "/api/shortcuts/" + created["id"], "PUT",
                                   {"isFavorite": True})
        self.assertEqual(code, 200)
        self.assertTrue(payload["shortcut"]["isFavorite"])

        code, payload, _ = request(self.base + "/api/shortcuts/" + created["id"], "DELETE")
        self.assertEqual(code, 200)
        self.assertFalse(any(item["id"] == created["id"] for item in payload["shortcuts"]))

    def test_create_requires_name_and_url(self):
        code, payload, _ = request(self.base + "/api/shortcuts", "POST", {"name": "이름만"})
        self.assertEqual(code, 400)
        self.assertFalse(payload["success"])

    def test_create_rejects_javascript_url(self):
        code, _, _ = request(self.base + "/api/shortcuts", "POST",
                             {"name": "나쁜", "url": "javascript:alert(1)"})
        self.assertEqual(code, 400)

    def test_update_missing_id_is_404(self):
        code, _, _ = request(self.base + "/api/shortcuts/sc-nonexistent", "PUT", {"name": "x"})
        self.assertEqual(code, 404)

    def test_reset_restores_defaults(self):
        request(self.base + "/api/shortcuts", "POST", {"name": "임시", "url": "https://t.internal.dc"})
        code, payload, _ = request(self.base + "/api/shortcuts/reset", "POST", {})
        self.assertEqual(code, 200)
        self.assertFalse(any(item["name"] == "임시" for item in payload["shortcuts"]))

    def test_import_replaces_all(self):
        code, payload, _ = request(self.base + "/api/import", "POST", {
            "shortcuts": [{"name": "가져온 링크", "url": "imported.internal.dc"}]
        })
        self.assertEqual(code, 200)
        self.assertEqual(len(payload["shortcuts"]), 1)
        request(self.base + "/api/shortcuts/reset", "POST", {})

    # ---------- 점검 ----------

    def test_health_check_blocks_loopback_targets(self):
        code, payload, _ = request(self.base + "/api/health/check", "POST",
                                   {"urls": ["http://127.0.0.1:9/"]})
        self.assertEqual(code, 200)
        self.assertEqual(payload["results"][0]["status"], "blocked")

    # ---------- 정적/보안 ----------

    def test_index_is_served_with_security_headers(self):
        code, _, headers = request(self.base + "/")
        self.assertEqual(code, 200)
        self.assertEqual(headers.get("X-Frame-Options"), "DENY")
        self.assertEqual(headers.get("X-Content-Type-Options"), "nosniff")
        self.assertIn("default-src 'self'", headers.get("Content-Security-Policy", ""))

    def test_static_assets_served(self):
        for path in ("/app.js", "/styles.css", "/favicon.svg"):
            code, _, headers = request(self.base + path)
            self.assertEqual(code, 200, path)

    def test_path_traversal_does_not_escape_static_dir(self):
        # 탈출에 성공하면 서버 소스나 저장 파일이 그대로 노출된다.
        code, _, headers = request(self.base + "/../hub/config.py")
        self.assertEqual(code, 200)
        self.assertTrue(headers.get("Content-Type", "").startswith("text/html"),
                        "정적 디렉터리 밖 파일이 서빙되면 안 된다(index.html 로 폴백해야 함).")

    def test_unknown_api_is_404(self):
        code, _, _ = request(self.base + "/api/nope")
        self.assertEqual(code, 404)


class TokenAuthTest(unittest.TestCase):
    """HUB_TOKEN 이 설정된 경우 /api 전체가 토큰을 요구해야 한다."""

    @classmethod
    def setUpClass(cls):
        cls.original = config.token
        config.token = "secret-token-123"
        cls.tmp = tempfile.TemporaryDirectory()
        store = ShortcutStore(Path(cls.tmp.name) / "shortcuts.json")
        cls.server = server_mod.create_server("127.0.0.1", 0, store)
        cls.base = "http://127.0.0.1:{}".format(cls.server.server_address[1])
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        config.token = cls.original
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def test_api_requires_token(self):
        code, _, _ = request(self.base + "/api/shortcuts")
        self.assertEqual(code, 401)

    def test_wrong_token_rejected(self):
        code, _, _ = request(self.base + "/api/shortcuts", headers={"X-Hub-Token": "nope"})
        self.assertEqual(code, 401)

    def test_correct_token_accepted(self):
        code, payload, _ = request(self.base + "/api/shortcuts",
                                   headers={"X-Hub-Token": "secret-token-123"})
        self.assertEqual(code, 200)
        self.assertTrue(payload["success"])

    def test_cookie_token_accepted(self):
        code, _, _ = request(self.base + "/api/shortcuts",
                             headers={"Cookie": "hub_token=secret-token-123"})
        self.assertEqual(code, 200)

    def test_write_routes_also_guarded(self):
        for method, path in (("POST", "/api/shortcuts"), ("PUT", "/api/shortcuts/sc-1"),
                             ("DELETE", "/api/shortcuts/sc-1"), ("POST", "/api/health/check")):
            code, _, _ = request(self.base + path, method, {} if method != "DELETE" else None)
            self.assertEqual(code, 401, "{} {}".format(method, path))

    def test_page_itself_is_public(self):
        # 페이지는 열려야 토큰 입력 화면을 띄울 수 있다.
        code, _, _ = request(self.base + "/")
        self.assertEqual(code, 200)


if __name__ == "__main__":
    unittest.main()
