"""v2.767 2회차 점검(R2-B5) 회귀 — 중지 링크 점검 제외 · 라우트 밖 id 재발급 · 세션 서명 비-ASCII."""

import json
import socket
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from hub import health as health_mod  # noqa: E402
from hub.auth import SessionStore  # noqa: E402
from hub.store import ID_RE, ShortcutStore  # noqa: E402

from test_api import ServerCase, request  # noqa: E402


class StoppedShortcutHealthTest(ServerCase):
    """R2-B5-3: 중지된 바로가기는 [지금 점검](전체)·ids 경로에서도 점검하지 않는다."""

    def setUp(self):
        self.seen = []
        self._orig = health_mod.check_many

        def fake_check_many(items, **_kw):
            self.seen.extend(item["url"] for item in items)
            return [{"id": item["id"], "url": item["url"], "status": "unreachable", "statusCode": 0,
                     "latencyMs": 1, "message": "x"} for item in items]

        health_mod.check_many = fake_check_many
        self.on = self.ctx.shortcuts.add({"name": "on", "url": "https://10.0.0.1/", "category": "custom"})
        self.off = self.ctx.shortcuts.add({"name": "off", "url": "https://10.0.0.2/", "category": "custom",
                                           "enabled": False})

    def tearDown(self):
        health_mod.check_many = self._orig
        self.ctx.shortcuts.delete(self.on["id"])
        self.ctx.shortcuts.delete(self.off["id"])

    def test_full_recheck_skips_stopped(self):
        code, payload, _ = request(self.url + "/api/health/check", "POST", {}, self.auth())
        self.assertEqual(code, 200)
        self.assertIn("https://10.0.0.1/", self.seen)
        self.assertNotIn("https://10.0.0.2/", self.seen, "중지한 링크에 접속했다")
        self.assertNotIn(self.off["id"], {row["id"] for row in payload["results"]})
        self.assertNotIn(self.off["id"], self.ctx.history.latest(), "중지한 링크가 이력에 쌓였다")

    def test_ids_recheck_skips_stopped(self):
        code, payload, _ = request(self.url + "/api/health/check", "POST",
                                   {"ids": [self.off["id"], self.on["id"]]}, self.auth())
        self.assertEqual(code, 200)
        self.assertEqual(self.seen, ["https://10.0.0.1/"])
        # 중지 링크만 고르면 점검 대상이 없다(빈 결과 — 접속하지 않는다).
        self.seen.clear()
        code, payload, _ = request(self.url + "/api/health/check", "POST",
                                   {"ids": [self.off["id"]]}, self.auth())
        self.assertEqual(code, 200)
        self.assertEqual(payload["results"], [])
        self.assertEqual(self.seen, [])


class ShortcutIdReissueTest(unittest.TestCase):
    """R2-B5-4: 라우트 패턴([A-Za-z0-9_-]{1,64}) 밖의 id 만 새로 발급한다."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "shortcuts.json"

    def tearDown(self):
        self.tmp.cleanup()

    def test_import_reissues_only_bad_ids(self):
        store = ShortcutStore(self.path)
        items = store.replace_all([
            {"id": "grafana.prod", "name": "Grafana", "url": "https://grafana.example/"},
            {"id": "x" * 300, "name": "Long", "url": "https://long.example/"},
            {"id": "한글", "name": "Kor", "url": "https://kor.example/"},
            {"id": "ok_id-1", "name": "Ok", "url": "https://ok.example/"},
            {"id": "x" * 64, "name": "Max", "url": "https://max.example/"},
        ])
        ids = [item["id"] for item in items]
        self.assertTrue(all(ID_RE.fullmatch(i) for i in ids), ids)
        self.assertEqual(ids[3], "ok_id-1")          # 맞는 id 는 그대로(이력이 id 로 이어진다)
        self.assertEqual(ids[4], "x" * 64)
        self.assertTrue(ids[0].startswith("sc-") and ids[1].startswith("sc-") and ids[2].startswith("sc-"))
        self.assertEqual(len(set(ids)), 5)
        # 재발급한 id 로 수정·삭제가 된다(예전에는 라우트가 404).
        self.assertTrue(store.delete(ids[0]))

    def test_file_load_reissues_and_persists(self):
        self.path.write_text(json.dumps([
            {"id": "bad id", "name": "A", "url": "https://a.example/"},
            {"id": "good", "name": "B", "url": "https://b.example/"},
        ]), encoding="utf-8")
        first = ShortcutStore(self.path).all()
        self.assertTrue(ID_RE.fullmatch(first[0]["id"]))
        self.assertEqual(first[1]["id"], "good")
        # 새 id 를 곧바로 저장한다 — 재기동마다 다른 id 가 붙으면 점검 이력이 끊긴다.
        again = ShortcutStore(self.path).all()
        self.assertEqual([i["id"] for i in again], [i["id"] for i in first])
        on_disk = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(on_disk[0]["id"], first[0]["id"])

    def test_valid_file_is_not_rewritten(self):
        self.path.write_text(json.dumps([{"id": "good", "name": "B", "url": "https://b.example/"}]),
                             encoding="utf-8")
        before = self.path.stat().st_mtime_ns
        raw_before = self.path.read_text(encoding="utf-8")
        ShortcutStore(self.path).all()
        self.assertEqual(self.path.read_text(encoding="utf-8"), raw_before)
        self.assertEqual(self.path.stat().st_mtime_ns, before)


class SessionSignatureTest(unittest.TestCase):
    """R2-B5-6: 서명부에 비-ASCII 가 있어도 예외 없이 None."""

    def test_non_ascii_signature_is_none(self):
        sessions = SessionStore(60, 3, 60)
        token = sessions.create({"username": "admin", "role": "admin"})["token"]
        encoded = token.rpartition(".")[0]
        for bad in ("abc.\xe9vil", encoded + ".\xe9vil", encoded + ".\udcff", "\xe9\xe9.sig", encoded + ".é"):
            self.assertIsNone(sessions.resolve(bad), repr(bad))
        self.assertEqual(sessions.resolve(token)["username"], "admin")


class SessionSignatureServerTest(ServerCase):
    def test_non_ascii_token_header_gets_a_response(self):
        host, port = self.server.server_address[:2]
        with socket.create_connection((host, port), timeout=5) as sock:
            sock.sendall(b"GET /api/meta HTTP/1.1\r\nHost: x\r\nX-Settings-Token: abc.\xe9vil\r\n"
                         b"Connection: close\r\n\r\n")
            data = b""
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                data += chunk
        self.assertTrue(data.startswith(b"HTTP/1."), "응답 없이 연결이 끊겼다")
        self.assertIn(b" 200 ", data.split(b"\r\n", 1)[0])


if __name__ == "__main__":
    unittest.main()
