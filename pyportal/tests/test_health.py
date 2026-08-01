"""링크 점검 로직 테스트 — 차단·분류·동시 실행."""

import socket
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hub import health  # noqa: E402


def _outbound_ip():
    """루프백이 아닌 자기 주소(있으면). SSRF 가드가 루프백을 막으므로 정상 경로 테스트에 필요."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("10.255.255.255", 1))
        return sock.getsockname()[0]
    except OSError:
        return None
    finally:
        sock.close()


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        code = 200
        if self.path.startswith("/404"):
            code = 404
        elif self.path.startswith("/500"):
            code = 500
        elif self.path.startswith("/302"):
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:1/internal")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        body = b"ok"
        self.send_response(code)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # 테스트 출력 조용히
        pass


class BlockTest(unittest.TestCase):
    def test_loopback_is_blocked_before_request(self):
        result = health.check_url("http://127.0.0.1:9/")
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["statusCode"], 0)

    def test_metadata_address_is_blocked(self):
        result = health.check_url("http://169.254.169.254/latest/meta-data/")
        self.assertEqual(result["status"], "blocked")

    def test_bad_scheme_is_blocked(self):
        result = health.check_url("javascript:alert(1)")
        self.assertEqual(result["status"], "blocked")

    def test_check_many_keeps_order_and_ids(self):
        targets = [{"id": "a", "url": "http://127.0.0.1:9/"},
                   {"id": "b", "url": "http://169.254.169.254/"}]
        results = health.check_many(targets, timeout=1.0, concurrency=2)
        self.assertEqual([row["id"] for row in results], ["a", "b"])

    def test_empty_target_list(self):
        self.assertEqual(health.check_many([]), [])


LOCAL_IP = _outbound_ip()


@unittest.skipUnless(LOCAL_IP and not LOCAL_IP.startswith("127."),
                     "루프백이 아닌 로컬 주소가 없어 실제 요청 경로를 검증할 수 없습니다.")
class LiveTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer((LOCAL_IP, 0), _Handler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def url(self, path=""):
        return "http://{}:{}{}".format(LOCAL_IP, self.port, path)

    def test_200_is_healthy(self):
        result = health.check_url(self.url("/"), timeout=3.0)
        self.assertEqual(result["status"], "healthy")
        self.assertEqual(result["statusCode"], 200)
        self.assertIsInstance(result["latencyMs"], int)

    def test_404_and_500_are_warning(self):
        self.assertEqual(health.check_url(self.url("/404"), timeout=3.0)["status"], "warning")
        self.assertEqual(health.check_url(self.url("/500"), timeout=3.0)["status"], "warning")

    def test_redirect_is_not_followed(self):
        # 3xx 를 따라가면 SSRF 가드를 통과한 요청이 루프백으로 되돌려질 수 있다.
        result = health.check_url(self.url("/302"), timeout=3.0)
        self.assertEqual(result["statusCode"], 302)
        self.assertEqual(result["status"], "healthy")

    def test_check_many_runs_concurrently(self):
        targets = [{"id": str(i), "url": self.url("/")} for i in range(6)]
        results = health.check_many(targets, timeout=3.0, concurrency=4)
        self.assertEqual(len(results), 6)
        self.assertTrue(all(row["status"] == "healthy" for row in results))


if __name__ == "__main__":
    unittest.main()
