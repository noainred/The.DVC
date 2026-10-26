"""v2.769 4회차 점검(R4-D1-1) 회귀 — 요청 전체 시한은 소켓 시한과 따로다.

v2.768 은 요청 전체 시한(RequestDeadline)을 소켓 연산 시한과 같은 값으로 잡아, 단계마다는 소켓 시한 안이지만
합이 그보다 긴 정상 서버(RTT 800ms 대상의 TCP + TLS 핸드셰이크 + 요청 왕복)를 '응답 시간 초과' 로 떨어뜨렸다
(재현 tls2.py: 소켓 4초 · 단계 2.0/2.5/1.5초 → 새 코드 4.0초 unreachable / 옛 코드 6.03초 healthy 200).
여기서는 소켓 시한 1초로 줄여 같은 모양을 만든다(간격마다 < 1초, 합 > 1초 · < 전체 시한 3초).
"""

from __future__ import annotations

import os
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

from hub import health as health_mod  # noqa: E402
from hub import notify as notify_mod  # noqa: E402
from hub import pinned as pinned_mod  # noqa: E402
from hub.notify import Notifier  # noqa: E402

import test_audit2768  # noqa: E402  — 드립 시험의 상한(BOUND = 시한 × 4)과 배수를 대조한다


def _pass_guard(url, allow_private=True):
    return ["127.0.0.1"], None, None


SOCK = 1.0                 # 소켓 연산 시한
GAP = (0.6, 0.6, 0.5)      # 클라이언트가 기다리는 간격 하나하나 < SOCK, 합 1.7 > SOCK (전체 시한 3초 안)


class _StagedServer:
    """간격마다 소켓 시한보다 짧게 쉬지만 합은 소켓 시한보다 긴 **정상** 서버(tls2.py 의 축소판).

    TLS: 핸드셰이크 지연(GAP0) → 요청 처리(GAP1) → 상태줄 뒤 헤더(GAP2) → 본문.
    평문: 요청 처리(GAP0) → 상태줄 뒤 헤더(GAP1) → 헤더 뒤 본문(GAP2). (평문은 핸드셰이크가 없어 GAP0 을 요청 대기에 쓴다 —
    연결 직후 쉬면 클라이언트의 응답 대기 한 번에 두 간격이 겹친다.)
    """

    def __init__(self, ctx=None):
        self.ctx = ctx
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(5)
        self.port = self.sock.getsockname()[1]
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        try:
            raw, _ = self.sock.accept()
        except OSError:
            return
        conn = raw
        status = b"HTTP/1.1 200 OK\r\n"
        rest = b"Content-Length: 5\r\nConnection: close\r\n\r\n"
        try:
            if self.ctx is not None:
                time.sleep(GAP[0])                    # 고RTT 핸드셰이크 지연 모사
                conn = self.ctx.wrap_socket(raw, server_side=True)
                conn.recv(65536)
                time.sleep(GAP[1])                    # 서버 처리 + 왕복
                conn.sendall(status)
                time.sleep(GAP[2])
                conn.sendall(rest + b"hello")
            else:
                conn.recv(65536)
                time.sleep(GAP[0])
                conn.sendall(status)
                time.sleep(GAP[1])
                conn.sendall(rest)
                time.sleep(GAP[2])
                conn.sendall(b"hello")
        except OSError:
            pass
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


class TotalDeadlineSecondsTest(unittest.TestCase):
    def setUp(self):
        self._env = os.environ.pop(health_mod.TOTAL_TIMEOUT_ENV, None)

    def tearDown(self):
        os.environ.pop(health_mod.TOTAL_TIMEOUT_ENV, None)
        if self._env is not None:
            os.environ[health_mod.TOTAL_TIMEOUT_ENV] = self._env

    def test_default_is_three_times_socket_timeout(self):
        self.assertEqual(pinned_mod.total_deadline_seconds(4.0, health_mod.TOTAL_TIMEOUT_ENV), 12.0)
        self.assertEqual(pinned_mod.total_deadline_seconds(30.0), 90.0)          # 상한 90초
        self.assertEqual(pinned_mod.total_deadline_seconds(notify_mod.TIMEOUT), notify_mod.TIMEOUT * 3)

    def test_factor_stays_under_drip_bound(self):
        # 드립 시험(test_audit2768)은 시한의 4배 안에 끝나기를 요구한다 — 배수가 4 이상이면 그 시험이 깨진다.
        bound_factor = test_audit2768.RequestDeadlineTest.BOUND / test_audit2768.RequestDeadlineTest.TIMEOUT
        self.assertLess(pinned_mod.TOTAL_DEADLINE_FACTOR, bound_factor)
        self.assertGreater(pinned_mod.TOTAL_DEADLINE_FACTOR, 1.0)

    def test_env_overrides_and_bad_values_fall_back(self):
        env = health_mod.TOTAL_TIMEOUT_ENV
        os.environ[env] = "20"
        self.assertEqual(pinned_mod.total_deadline_seconds(4.0, env), 20.0)
        os.environ[env] = "1"            # 소켓 시한 아래로는 내리지 않는다
        self.assertEqual(pinned_mod.total_deadline_seconds(4.0, env), 4.0)
        os.environ[env] = "99999"        # 상한
        self.assertEqual(pinned_mod.total_deadline_seconds(4.0, env), pinned_mod.TOTAL_DEADLINE_ENV_CAP)
        for bad in ("abc", "nan", "inf", "-5", "0", ""):
            os.environ[env] = bad        # 잘못된 값은 무시(시한을 없애지 않는다)
            self.assertEqual(pinned_mod.total_deadline_seconds(4.0, env), 12.0, bad)


class StagedServerHealthyTest(unittest.TestCase):
    """간격마다 < 소켓 시한, 합 > 소켓 시한인 정상 서버는 healthy 다(전체 시한 = 소켓 × 3)."""

    def setUp(self):
        self._g1 = health_mod.resolve_and_check
        self._g2 = notify_mod.resolve_and_check
        self._t = notify_mod.TIMEOUT
        self._env = os.environ.pop(health_mod.TOTAL_TIMEOUT_ENV, None)
        health_mod.resolve_and_check = _pass_guard
        notify_mod.resolve_and_check = _pass_guard
        self.servers = []

    def tearDown(self):
        health_mod.resolve_and_check = self._g1
        notify_mod.resolve_and_check = self._g2
        notify_mod.TIMEOUT = self._t
        if self._env is not None:
            os.environ[health_mod.TOTAL_TIMEOUT_ENV] = self._env
        for s in self.servers:
            s.close()

    def _srv(self, ctx=None):
        s = _StagedServer(ctx)
        self.servers.append(s)
        return s

    def test_plain_http_staged_server_is_healthy(self):
        srv = self._srv()
        started = time.monotonic()
        r = health_mod.check_url(f"http://staged.example:{srv.port}/", timeout=SOCK)
        took = time.monotonic() - started
        self.assertEqual(r["status"], health_mod.STATUS_HEALTHY, r)
        self.assertEqual(r["statusCode"], 200)
        self.assertGreater(took, SOCK, "시나리오가 성립하지 않는다 — 합이 소켓 시한보다 길어야 한다")

    def test_tls_staged_server_is_healthy(self):
        # tls2.py 시나리오 — v2.768 코드는 소켓 시한(1초)에 unreachable 이었다.
        openssl = shutil.which("openssl")
        if not openssl:
            self.skipTest("openssl 없음 — 시험용 인증서를 만들 수 없다")
        d = tempfile.mkdtemp()
        try:
            cert, key = os.path.join(d, "c.pem"), os.path.join(d, "k.pem")
            subprocess.run([openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
                            "-days", "1", "-subj", "/CN=staged.example"], check=True, capture_output=True, timeout=60)
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(cert, key)
            srv = self._srv(ctx)
            # urllib 은 환경의 HTTPS 프록시를 탄다 — 시험 서버로 바로 가게 이 시험 동안만 뺀다(tls2.py 도 프록시 env 를 지웠다).
            saved = {k: os.environ.pop(k) for k in list(os.environ) if k.lower() in ("https_proxy", "http_proxy", "all_proxy")}
            try:
                started = time.monotonic()
                r = health_mod.check_url(f"https://staged.example:{srv.port}/", timeout=SOCK, tls_verify=False)
                took = time.monotonic() - started
            finally:
                os.environ.update(saved)
        finally:
            shutil.rmtree(d, ignore_errors=True)
        self.assertEqual(r["status"], health_mod.STATUS_HEALTHY, r)
        self.assertEqual(r["statusCode"], 200)
        self.assertGreater(took, SOCK)

    def test_env_total_shorter_than_stages_times_out_with_both_values(self):
        # env 로 전체 시한을 소켓 시한(1초)까지 줄이면 같은 서버가 시한 초과다 — 메시지가 두 시한을 구분한다.
        os.environ[health_mod.TOTAL_TIMEOUT_ENV] = "1"
        srv = self._srv()
        r = health_mod.check_url(f"http://staged.example:{srv.port}/", timeout=SOCK)
        self.assertEqual(r["status"], health_mod.STATUS_UNREACHABLE, r)
        self.assertIn("요청 전체 1초", r["message"])
        self.assertIn("소켓 1초", r["message"])

    def test_webhook_staged_server_succeeds(self):
        notify_mod.TIMEOUT = SOCK
        srv = self._srv()
        Notifier._post_webhook(f"http://hook.example:{srv.port}/x", {"text": "t"})   # 예외 없음 = 성공


if __name__ == "__main__":
    unittest.main()
