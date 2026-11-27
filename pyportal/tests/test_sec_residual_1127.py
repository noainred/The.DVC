"""보안 잔여 11-27 L12 — 허브 인바운드 수신 전체 시한 + 연결 자리 선획득.

- 소켓 시한(핸들러 timeout 20초)은 recv 1회 단위라 요청 줄·헤더·본문을 1바이트씩 흘리는 연결이 끊기지 않았다(재현).
- 연결 세마포어를 스레드 안에서(스레드 생성 뒤) 5초 기다려, 거절될 연결에도 스레드가 먼저 생겼다.
- 형제: EOF 로 끝난 헤더 · 짧게 끝난 본문 · 잘못된 Content-Length 를 그대로 라우팅했다.
- 반증(설계 2차): keep-alive 로 자리를 무기한 쥐기 · 가득 찼을 때 즉시 거절의 '빈자리 복권' · 선언 길이로 늘어나는 본문 시한.

실제 127.0.0.1 소켓을 쓴다. 시한은 config 를 patch(create=True)하거나 서버 속성으로 줄인다 —
수정 전 판본에서도 TypeError 가 아니라 단언으로 실패하게.
"""

import contextlib
import io
import json
import os
import socket
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from hub import config as config_mod  # noqa: E402
from hub import server as server_mod  # noqa: E402
from hub.config import config  # noqa: E402
from test_api import ServerCase  # noqa: E402

_GET = b"GET /api/meta HTTP/1.1\r\nHost: x\r\n\r\n"
_GET_CLOSE = b"GET /api/meta HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"


@contextlib.contextmanager
def _capture():
    buf = io.StringIO()
    with mock.patch("sys.stdout", new=buf):
        yield buf


def _open(port, timeout=5.0):
    sock = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    return sock


def _read_response(sock):
    """응답 하나(상태줄, 헤더 문자열, 본문 bytes). 연결이 응답 없이 닫히면 ('', '', b'')."""
    data = b""
    while b"\r\n\r\n" not in data:
        try:
            chunk = sock.recv(65536)
        except (ConnectionError, socket.timeout):
            chunk = b""
        if not chunk:
            return "", "", data
        data += chunk
    head, body = data.split(b"\r\n\r\n", 1)
    lines = head.decode("latin-1").split("\r\n")
    length = 0
    for line in lines[1:]:
        if line.lower().startswith("content-length:"):
            length = int(line.split(":", 1)[1])
    while len(body) < length:
        chunk = sock.recv(65536)
        if not chunk:
            break
        body += chunk
    return lines[0], "\r\n".join(lines[1:]), body[:length]


def _read_all(sock, limit=10.0):
    data = b""
    end = time.monotonic() + limit
    while time.monotonic() < end:
        try:
            chunk = sock.recv(65536)
        except socket.timeout:
            continue
        except ConnectionError:
            break
        if not chunk:
            break
        data += chunk
    return data


def _closed_within(sock, limit):
    """limit 초 안에 서버가 닫는지(받은 바이트, 닫힌 시각 또는 None)."""
    sock.settimeout(0.05)
    t0 = time.monotonic()
    got = b""
    while time.monotonic() - t0 < limit:
        try:
            chunk = sock.recv(4096)
        except socket.timeout:
            continue
        except ConnectionError:
            return got, time.monotonic() - t0
        if not chunk:
            return got, time.monotonic() - t0
        got += chunk
    return got, None


def _wait(pred, limit=5.0):
    end = time.monotonic() + limit
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.02)
    return pred()


class InboundCase(ServerCase):
    """ServerCase 의 ctx · admin 토큰을 쓰고, 시험마다 시한을 줄인 서버를 따로 띄운다."""

    def _server(self, *, header=10.0, rate=16384, cap=300.0, max_connections=64, per_client=0,
                admit_wait=None, handler=None, cls=None):
        patches = [mock.patch.object(config, "header_timeout", header, create=True),
                   mock.patch.object(config, "body_min_rate", rate, create=True),
                   mock.patch.object(config, "body_timeout_max", cap, create=True)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        srv = (cls or server_mod.HubServer)(("127.0.0.1", 0), handler or server_mod.HubHandler, self.ctx,
                                            max_connections=max_connections, max_per_client=per_client)
        if admit_wait is not None:
            srv.admit_wait = admit_wait
        thread = threading.Thread(target=srv.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        return srv, srv.server_address[1]

    def _hold_partial(self, port, count):
        held = []
        for _ in range(count):
            sock = _open(port)
            sock.sendall(b"GET /api/meta HTTP/1.1\r\nHost: x\r\nX-Drip: ")   # 헤더를 끝내지 않는다
            held.append(sock)
            self.addCleanup(sock.close)
        return held

    @staticmethod
    def _active(srv):
        fn = getattr(srv, "active_connections", None)
        if fn is not None:
            return fn()
        return 64 - srv._slots._value   # noqa: SLF001 — 수정 전 판본(세마포어)

    @staticmethod
    def _drops(srv, kind):
        return getattr(srv, "inbound_drops", {}).get(kind, 0)


class HeaderDeadlineTest(InboundCase):
    def test_header_drip_is_cut_at_the_header_deadline(self):
        """T1: 0.1초마다 1바이트 — 헤더 시한 0.5초에 응답 없이 끊긴다(소켓 시한 20초와 무관)."""
        with _capture() as out:
            srv, port = self._server(header=0.5)
            sock = _open(port)
            self.addCleanup(sock.close)
            sock.sendall(b"GET /api/meta HTTP/1.1\r\nHost: x\r\nX-D: ")
            t0 = time.monotonic()
            closed = None
            got = b""
            sock.settimeout(0.05)
            while time.monotonic() - t0 < 5:
                try:
                    sock.sendall(b"a")
                except OSError:
                    closed = time.monotonic() - t0
                    break
                try:
                    chunk = sock.recv(100)
                    if not chunk:
                        closed = time.monotonic() - t0
                        break
                    got += chunk
                except socket.timeout:
                    pass
                except OSError:
                    closed = time.monotonic() - t0
                    break
                time.sleep(0.05)
            self.assertIsNotNone(closed, "헤더를 흘리는 연결이 5초 동안 끊기지 않았다")
            self.assertLess(closed, 3.0)
            self.assertEqual(got, b"", "헤더를 다 받지 못한 요청에 응답했다")
            self.assertTrue(_wait(lambda: self._active(srv) == 0), "끊긴 연결의 자리가 돌아오지 않았다")
            self.assertEqual(self._drops(srv, "header"), 1)
        self.assertIn("연결 보호", out.getvalue())
        self.assertIn("헤더 시한 초과 1건", out.getvalue())

    def test_keepalive_next_request_drip_is_cut_too(self):
        """keep-alive 다음 요청도 첫 바이트부터 헤더 시한 — 두 번째 요청의 헤더를 흘리면 끊긴다."""
        with _capture():
            srv, port = self._server(header=0.5)
            sock = _open(port)
            self.addCleanup(sock.close)
            sock.sendall(_GET)
            self.assertIn(" 200 ", _read_response(sock)[0])
            sock.sendall(b"GET /api/meta HTTP/1.1\r\nX-D: ")
            t0 = time.monotonic()
            closed = None
            sock.settimeout(0.05)
            while time.monotonic() - t0 < 5:
                try:
                    sock.sendall(b"a")
                    if sock.recv(100) == b"":
                        closed = time.monotonic() - t0
                        break
                except socket.timeout:
                    pass
                except OSError:
                    closed = time.monotonic() - t0
                    break
                time.sleep(0.05)
            self.assertIsNotNone(closed, "keep-alive 다음 요청의 헤더 드립이 끊기지 않았다")
            self.assertLess(closed, 3.0)
            self.assertTrue(_wait(lambda: self._drops(srv, "header") == 1))

    def test_silent_new_connection_is_cut_at_the_header_deadline(self):
        """반증 S-4: 새 연결은 입장 시각부터 헤더 시한 — 아무것도 안 보내는 연결이 유휴 20초 + 헤더 시한을 쥐지 못한다."""
        with _capture() as out:
            srv, port = self._server(header=0.5)
            sock = _open(port)
            self.addCleanup(sock.close)
            got, closed = _closed_within(sock, 4.0)
            self.assertIsNotNone(closed, "데이터 없는 새 연결이 4초 동안 끊기지 않았다(유휴 20초가 걸림)")
            self.assertLess(closed, 2.5)
            self.assertEqual(got, b"")
            self.assertTrue(_wait(lambda: self._drops(srv, "silent") == 1))
            self.assertTrue(_wait(lambda: self._active(srv) == 0))
        self.assertNotIn("ERROR", out.getvalue())
        self.assertNotIn("연결 보호", out.getvalue(), "사전 연결(무데이터)은 세기만 하고 로그를 남기지 않는다")

    def test_eof_terminated_header_is_not_processed(self):
        """T11: 빈 줄 대신 EOF 로 끝난 헤더 — 처리하지 않고(응답 0바이트) BrokenPipe 로그도 없다."""
        with _capture() as out:
            srv, port = self._server(header=3.0)
            sock = _open(port)
            self.addCleanup(sock.close)
            sock.sendall(b"GET /api/meta HTTP/1.1\r\nHost: x\r\nX-T: 1")
            sock.shutdown(socket.SHUT_WR)
            got = _read_all(sock, 3.0)
            self.assertEqual(got, b"", "EOF 로 잘린 헤더를 정상 요청으로 처리했다")
            self.assertTrue(_wait(lambda: self._active(srv) == 0))
            self.assertEqual(self._drops(srv, "eof"), 1)
            time.sleep(0.2)
        self.assertNotIn("BrokenPipe", out.getvalue())
        self.assertNotIn('"GET /api/meta', out.getvalue())


class KeepAliveTest(InboundCase):
    def test_idle_between_requests_is_not_charged_to_the_header_deadline(self):
        """T8: 유휴(헤더 시한보다 긴 0.6초) 뒤 keep-alive 요청 · 파이프라인 두 요청 모두 200."""
        srv, port = self._server(header=0.3)
        sock = _open(port)
        self.addCleanup(sock.close)
        sock.sendall(_GET)
        self.assertIn(" 200 ", _read_response(sock)[0])
        time.sleep(0.6)
        sock.sendall(_GET)
        self.assertIn(" 200 ", _read_response(sock)[0], "유휴 대기를 헤더 시한에 셌다")
        pipe = _open(port)
        self.addCleanup(pipe.close)
        pipe.sendall(_GET + _GET_CLOSE)
        data = _read_all(pipe, 3.0)
        self.assertEqual(data.count(b"HTTP/1.1 200 "), 2)

    def test_idle_close_is_quiet(self):
        """T9: 요청 뒤 유휴 시한으로 닫히는 연결은 오류 로그 · 연결 보호 집계가 없다."""
        class Quick(server_mod.HubHandler):
            timeout = 0.5
        with _capture() as out:
            srv, port = self._server(header=2.0, handler=Quick)
            sock = _open(port)
            self.addCleanup(sock.close)
            sock.sendall(_GET)
            self.assertIn(" 200 ", _read_response(sock)[0])
            _, closed = _closed_within(sock, 4.0)
            self.assertIsNotNone(closed, "유휴 연결이 닫히지 않았다")
            self.assertTrue(_wait(lambda: self._active(srv) == 0))
            self.assertEqual(sum(getattr(srv, "inbound_drops", {"x": 1}).values()), 0)
        self.assertNotIn("ERROR", out.getvalue())
        self.assertNotIn("연결 보호", out.getvalue())


class BodyDeadlineTest(InboundCase):
    def _post(self, port, length, extra_headers=b""):
        sock = _open(port)
        self.addCleanup(sock.close)
        sock.sendall(b"POST /api/shortcuts HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n"
                     + extra_headers + b"Content-Length: " + str(length).encode() + b"\r\n\r\n")
        return sock

    def test_declared_length_does_not_buy_time(self):
        """T2 + 반증 M-3: 1MiB 를 선언하고 1바이트씩 — 받은 바이트만큼만 늘어나 base(0.5초) 근처에서 408."""
        with _capture():
            srv, port = self._server(header=0.5, rate=16384, cap=300.0)
            sock = self._post(port, 1048576)
            t0 = time.monotonic()
            status = ""
            body = b""
            sock.settimeout(0.05)
            buf = b""
            while time.monotonic() - t0 < 5:
                try:
                    sock.sendall(b"x")
                except OSError:
                    break
                try:
                    chunk = sock.recv(65536)
                    if not chunk:
                        break
                    buf += chunk
                except socket.timeout:
                    pass
                except OSError:
                    break
                time.sleep(0.05)
            elapsed = time.monotonic() - t0
            if b"\r\n\r\n" in buf:
                head, body = buf.split(b"\r\n\r\n", 1)
                status = head.split(b"\r\n", 1)[0].decode()
            self.assertIn(" 408 ", status, "선언한 길이로 본문 시한이 늘어났다(드립이 끊기지 않음)")
            self.assertLess(elapsed, 3.0)
            self.assertEqual(json.loads(body.decode())["code"], "request_timeout")
            self.assertIn(b"Connection: close", buf)
            self.assertTrue(_wait(lambda: self._active(srv) == 0))
            self.assertEqual(self._drops(srv, "body"), 1)

    def test_body_deadline_has_a_cap(self):
        """M4: 최저 속도를 넘겨 보내더라도 본문 전체 시한 상한(1초)에서 408."""
        with _capture():
            srv, port = self._server(header=0.3, rate=1024, cap=1.0)
            sock = self._post(port, 100000)
            t0 = time.monotonic()
            sock.settimeout(0.05)
            buf = b""
            while time.monotonic() - t0 < 5:
                try:
                    sock.sendall(b"y" * 200)   # 초당 약 4000B — 최저 속도 1024B/s 의 4배
                except OSError:
                    break
                try:
                    chunk = sock.recv(65536)
                    if not chunk:
                        break
                    buf += chunk
                except socket.timeout:
                    pass
                except OSError:
                    break
                time.sleep(0.05)
            elapsed = time.monotonic() - t0
            self.assertIn(b" 408 ", buf.split(b"\r\n", 1)[0])
            self.assertLess(elapsed, 3.0)
            self.assertGreater(elapsed, 0.8)

    def test_timeout_reply_drains_late_body_before_closing(self):
        """408 뒤 짧은 린저: 시한 뒤에도 본문을 보내는 상대에게 바로 RST 를 주지 않는다(읽지 않은 채 닫으면 RST 로 응답이 버려질 수 있다)."""
        with _capture():
            srv, port = self._server(header=0.3)
            sock = self._post(port, 500000)
            sock.sendall(b"x" * 10)
            status, headers, _ = _read_response(sock)
            self.assertIn(" 408 ", status)
            errors = []
            for _ in range(4):
                time.sleep(0.1)
                try:
                    sock.sendall(b"z" * 1024)
                except OSError as exc:
                    errors.append(exc)
            self.assertEqual(errors, [], "응답 직후 연결을 읽지 않고 닫았다(늦게 온 본문에 RST)")

    def test_allowance_grows_with_received_bytes(self):
        """T3: base 0.3초보다 오래(0.8초) 걸려도 최저 속도 이상이면 처리기까지 간다 · 빠른 대용량 본문도 그대로."""
        with _capture():
            srv, port = self._server(header=0.3, rate=8000)
            sock = self._post(port, 16000)
            for _ in range(16):
                sock.sendall(b" " * 1000)
                time.sleep(0.05)
            status, _, body = _read_response(sock)
            self.assertIn(" 401 ", status, "정상 속도의 본문이 시한에 걸렸다")
            self.assertEqual(json.loads(body.decode())["code"], "settings_login_required")
            big = self._post(port, 900000)
            big.sendall(b" " * 900000)
            status, _, body = _read_response(big)
            self.assertIn(" 401 ", status)

    def test_short_body_is_not_routed(self):
        """T4: 끝까지 오지 않은 본문(SHUT_WR) — 앞부분이 유효한 JSON 이어도 저장하지 않고 400."""
        before = len(self.ctx.shortcuts.all())
        with _capture():
            srv, port = self._server(header=3.0)
            payload = json.dumps({"name": "short-body", "url": "short.internal"}).encode()
            sock = self._post(port, len(payload) + 100, b"X-Settings-Token: " + self.token.encode() + b"\r\n")
            sock.sendall(payload)
            sock.shutdown(socket.SHUT_WR)
            status, headers, body = _read_response(sock)
            self.assertIn(" 400 ", status)
            self.assertIn("끝까지 오지 않았습니다", json.loads(body.decode())["error"])
            self.assertIn("Connection: close", headers)
        self.assertEqual(len(self.ctx.shortcuts.all()), before, "잘린 본문이 저장됐다")

    def test_invalid_content_length_closes_before_routing(self):
        """T5: Content-Length '1_0'·'+5'·'-1'·'0x10'·서로 다른 중복 → 400 + 닫힘 · 같은 연결의 다음 요청은 처리하지 않는다."""
        with _capture():
            srv, port = self._server(header=3.0)
            for value in (b"1_0", b"+5", b"-1", b"0x10", b"5\r\nContent-Length: 6"):
                with self.subTest(value=value):
                    sock = _open(port)
                    self.addCleanup(sock.close)
                    sock.sendall(b"POST /api/health/check HTTP/1.1\r\nHost: x\r\nContent-Length: " + value
                                 + b"\r\n\r\n0123456789" + _GET)
                    data = _read_all(sock, 3.0)
                    self.assertTrue(data.startswith(b"HTTP/1.1 400 "), data[:80])
                    self.assertIn(b"Connection: close", data)
                    self.assertEqual(data.count(b"HTTP/1.1 "), 1, "잘못된 길이 뒤의 바이트를 다음 요청으로 처리했다")


class AdmissionTest(InboundCase):
    def test_full_server_waits_in_the_accept_loop_without_a_thread(self):
        """T6: 가득 차면 스레드를 만들지 않고 accept 루프에서 유한 대기 → 만료 시 응답 없이 끊음 · 자리는 돌아온다."""
        calls = []

        class Spy(server_mod.HubServer):
            def process_request_thread(self, request, client_address):
                calls.append(1)
                return super().process_request_thread(request, client_address)

        with _capture():
            srv, port = self._server(header=5.0, max_connections=2, admit_wait=0.5, cls=Spy)
            held = self._hold_partial(port, 2)
            self.assertTrue(_wait(lambda: len(calls) == 2 and self._active(srv) == 2))
            third = _open(port)
            self.addCleanup(third.close)
            third.sendall(_GET_CLOSE)
            got, closed = _closed_within(third, 3.0)
            self.assertIsNotNone(closed, "가득 찬 서버가 새 연결을 대기 상한 안에 정리하지 않았다")
            self.assertLess(closed, 2.0)
            self.assertEqual(got, b"")
            self.assertEqual(len(calls), 2, "거절될 연결에도 스레드가 만들어졌다")
            self.assertEqual(self._drops(srv, "full"), 1)
            held[0].close()
            self.assertTrue(_wait(lambda: self._active(srv) == 1), "닫힌 연결의 자리가 돌아오지 않았다")
            again = _open(port)
            self.addCleanup(again.close)
            again.sendall(_GET_CLOSE)
            self.assertIn(" 200 ", _read_response(again)[0])

    def test_waiting_connection_gets_the_next_slot(self):
        """반증 M-2: 대기 중 자리가 나면 기다리던 연결이 받는다(즉시 거절하지 않는다)."""
        with _capture():
            srv, port = self._server(header=5.0, max_connections=2, admit_wait=3.0)
            held = self._hold_partial(port, 2)
            self.assertTrue(_wait(lambda: self._active(srv) == 2))
            third = _open(port)
            self.addCleanup(third.close)
            third.sendall(_GET_CLOSE)
            time.sleep(0.3)
            held[0].close()
            t0 = time.monotonic()
            status = _read_response(third)[0]
            self.assertIn(" 200 ", status)
            self.assertLess(time.monotonic() - t0, 2.0)

    def test_idle_keepalive_is_evicted_when_full(self):
        """반증 M-1: 유휴 keep-alive 연결은 자리를 무기한 쥐지 못한다 — 가득 차면 가장 오래 유휴한 연결을 내보낸다."""
        with _capture():
            srv, port = self._server(header=2.0, max_connections=2, admit_wait=3.0)
            idle = []
            for _ in range(2):
                sock = _open(port)
                self.addCleanup(sock.close)
                sock.sendall(_GET)
                self.assertIn(" 200 ", _read_response(sock)[0])
                idle.append(sock)
                time.sleep(0.05)
            t0 = time.monotonic()
            third = _open(port)
            self.addCleanup(third.close)
            third.sendall(_GET_CLOSE)
            self.assertIn(" 200 ", _read_response(third)[0], "유휴 keep-alive 가 자리를 쥐어 새 연결이 못 들어왔다")
            self.assertLess(time.monotonic() - t0, 1.5)
            got, closed = _closed_within(idle[0], 2.0)
            self.assertIsNotNone(closed, "가장 오래 유휴한 연결이 내보내지지 않았다")
            self.assertGreaterEqual(self._drops(srv, "evicted"), 1)

    def test_finished_request_hands_its_slot_to_a_waiter(self):
        """반증 M-1: 자리를 기다리는 연결이 있으면 요청을 마친 연결은 유휴로 들어가지 않고 자리를 넘긴다."""
        with _capture():
            srv, port = self._server(header=5.0, max_connections=2, admit_wait=4.0)
            held = self._hold_partial(port, 2)
            self.assertTrue(_wait(lambda: self._active(srv) == 2))
            third = _open(port)
            self.addCleanup(third.close)
            third.sendall(_GET_CLOSE)
            time.sleep(0.3)
            held[0].sendall(b"1\r\n\r\n")   # 헤더를 마친다(keep-alive)
            self.assertIn(" 200 ", _read_response(held[0])[0])
            t0 = time.monotonic()
            self.assertIn(" 200 ", _read_response(third)[0], "요청을 마친 keep-alive 가 자리를 넘기지 않았다")
            self.assertLess(time.monotonic() - t0, 2.0)
            _, closed = _closed_within(held[0], 2.0)
            self.assertIsNotNone(closed)

    def test_reconnecting_attackers_do_not_starve_a_waiting_user(self):
        """반증 M-2(exp2): 시한마다 다시 붙는 연결 8개 · 자리 4 — 정상 요청 성공률 80% 이상."""
        with _capture():
            srv, port = self._server(header=0.5, max_connections=4, admit_wait=5.0)
            stop = time.monotonic() + 4.0

            def attacker():
                while time.monotonic() < stop:
                    try:
                        a = socket.create_connection(("127.0.0.1", port), timeout=1)
                        a.settimeout(0.05)
                        a.sendall(b"GET / HTTP/1.1\r\nX: ")
                        while time.monotonic() < stop:
                            try:
                                a.sendall(b"a")
                                if a.recv(10) == b"":
                                    break
                            except socket.timeout:
                                pass
                            except OSError:
                                break
                            time.sleep(0.05)
                        a.close()
                    except OSError:
                        pass

            threads = [threading.Thread(target=attacker, daemon=True) for _ in range(8)]
            for t in threads:
                t.start()
            time.sleep(0.5)
            ok = tries = 0
            while time.monotonic() < stop - 1.0:
                tries += 1
                try:
                    c = socket.create_connection(("127.0.0.1", port), timeout=3)
                    c.settimeout(3)
                    c.sendall(_GET_CLOSE)
                    if _read_all(c, 3.0).startswith(b"HTTP/1.1 200 "):   # 끝까지 읽는다(중간에 닫으면 서버에 RST 흔적)
                        ok += 1
                    c.close()
                except OSError:
                    pass
                time.sleep(0.2)
            for t in threads:
                t.join(3)
            self.assertGreaterEqual(tries, 3)
            self.assertGreaterEqual(ok / tries, 0.8, "정상 요청 성공 {}/{}".format(ok, tries))

    def test_shutdown_is_not_delayed_by_a_waiting_admission(self):
        """가득 찬 상태에서 자리를 기다리는 중에도 shutdown 이 대기 상한(5초)만큼 늦지 않는다."""
        with _capture():
            srv, port = self._server(header=8.0, max_connections=1, admit_wait=5.0)
            self._hold_partial(port, 1)
            self.assertTrue(_wait(lambda: self._active(srv) == 1))
            waiting = _open(port)
            self.addCleanup(waiting.close)
            waiting.sendall(_GET_CLOSE)
            time.sleep(0.3)
            t0 = time.monotonic()
            srv.shutdown()
            self.assertLess(time.monotonic() - t0, 2.0, "자리 대기가 서버 종료를 붙잡았다")

    def test_thread_start_failure_returns_the_slot(self):
        """T7: 스레드 시작 실패에도 자리 · 출발지 집계가 돌아온다."""
        with _capture(), mock.patch("sys.stderr", new=io.StringIO()):
            srv, port = self._server(header=3.0, max_connections=4, per_client=3)
            real_start = threading.Thread.start
            state = {"failed": 0}

            def flaky(thread_self):
                if not state["failed"] and getattr(thread_self, "_target", None) is not None \
                        and getattr(thread_self._target, "__name__", "") == "process_request_thread":
                    state["failed"] += 1
                    raise RuntimeError("can't start new thread")
                return real_start(thread_self)

            with mock.patch.object(threading.Thread, "start", flaky):
                sock = _open(port)
                self.addCleanup(sock.close)
                sock.sendall(_GET_CLOSE)
                self.assertEqual(_read_all(sock, 3.0), b"")
            self.assertEqual(state["failed"], 1)
            self.assertTrue(_wait(lambda: self._active(srv) == 0))
            self.assertEqual(srv._per_client, {})   # noqa: SLF001
            again = _open(port)
            self.addCleanup(again.close)
            again.sendall(_GET_CLOSE)
            self.assertIn(" 200 ", _read_response(again)[0])

    def test_release_is_idempotent(self):
        """M15: 반환이 두 번 불려도 다른 연결의 집계를 깎지 않는다."""
        srv = server_mod.HubServer(("127.0.0.1", 0), server_mod.HubHandler, self.ctx,
                                   max_connections=4, max_per_client=5)
        self.addCleanup(srv.server_close)
        a, b = object(), object()
        self.assertEqual(srv._admit(a, "10.0.0.1")[0], None)   # noqa: SLF001
        self.assertEqual(srv._admit(b, "10.0.0.1")[0], None)   # noqa: SLF001
        srv._release(a)   # noqa: SLF001
        srv._release(a)   # noqa: SLF001
        self.assertEqual(srv.active_connections(), 1)
        self.assertEqual(srv._per_client, {"10.0.0.1": 1})   # noqa: SLF001
        srv._release(b)   # noqa: SLF001
        self.assertEqual(srv._per_client, {})   # noqa: SLF001

    def test_evicted_idle_connection_is_not_served(self):
        """유휴 peek 가 첫 바이트를 받은 직후 내보내진 연결은 처리하지 않는다(conn_busy → False) · 내보내기는 유휴만 고른다."""
        srv = server_mod.HubServer(("127.0.0.1", 0), server_mod.HubHandler, self.ctx,
                                   max_connections=2, max_per_client=0)
        self.addCleanup(srv.server_close)

        class FakeSock:
            def __init__(self):
                self.shut = []

            def shutdown(self, how):
                self.shut.append(how)

        busy, idle = FakeSock(), FakeSock()
        srv._admit(busy, "10.0.0.1")   # noqa: SLF001
        srv._admit(idle, "10.0.0.2")   # noqa: SLF001
        self.assertTrue(srv.conn_idle(idle))
        with srv._cond:   # noqa: SLF001
            self.assertEqual(srv._evict_idle_locked(), 1)   # noqa: SLF001
            self.assertEqual(srv._evict_idle_locked(), 0, "처리 중(busy)인 연결을 내보냈다")   # noqa: SLF001
        self.assertEqual(idle.shut, [socket.SHUT_RDWR])
        self.assertEqual(busy.shut, [])
        self.assertFalse(srv.conn_busy(idle), "내보낸 연결이 다음 요청을 처리했다")
        self.assertTrue(srv.conn_busy(busy))

    @unittest.skipUnless(os.path.isdir("/proc/self/fd"), "리눅스 전용")
    def test_no_fd_leak(self):
        """T16: 연결 50개를 열고 닫은 뒤 FD 수가 그대로(리더 교체가 소켓 참조를 남기지 않는다)."""
        with _capture():
            srv, port = self._server(header=3.0)
            for _ in range(3):   # 워밍업(스레드·버퍼)
                s = _open(port)
                s.sendall(_GET_CLOSE)
                _read_all(s, 3.0)
                s.close()
            time.sleep(0.2)
            base = len(os.listdir("/proc/self/fd"))
            for _ in range(50):
                s = _open(port)
                s.sendall(_GET_CLOSE)
                _read_all(s, 3.0)
                s.close()
            self.assertTrue(_wait(lambda: srv.active_connections() == 0))
            time.sleep(0.2)
            self.assertLessEqual(len(os.listdir("/proc/self/fd")), base + 3)


class UnitTest(unittest.TestCase):
    def test_phase_reader(self):
        """T10: 단계 중 recv 뒤 소켓 시한은 유휴 값 · 드립은 시한에 InboundDeadline · 단계가 없으면 socket.timeout."""
        from hub.inbound import InboundDeadline, PhaseReader
        self.assertFalse(issubclass(InboundDeadline, OSError))
        self.assertFalse(issubclass(InboundDeadline, TimeoutError))
        a, b = socket.socketpair()
        self.addCleanup(a.close)
        self.addCleanup(b.close)
        a.settimeout(5.0)
        rx = PhaseReader(a, 5.0)
        reader = io.BufferedReader(rx)
        rx.begin("header", 2.0)
        b.sendall(b"line\r\n")
        self.assertEqual(reader.readline(), b"line\r\n")
        self.assertEqual(a.gettimeout(), 5.0, "단계 잔여 시한이 소켓에 남았다(응답 쓰기가 잘린다)")
        rx.begin("header", 0.4)
        stop = threading.Event()

        def drip():
            while not stop.is_set():
                try:
                    b.sendall(b"x")
                except OSError:
                    return
                time.sleep(0.05)

        t = threading.Thread(target=drip, daemon=True)
        t.start()
        t0 = time.monotonic()
        with self.assertRaises(InboundDeadline) as caught:
            reader.readline(65537)
        stop.set()
        t.join(2)
        self.assertEqual(caught.exception.phase, "header")
        self.assertLess(time.monotonic() - t0, 2.0)
        self.assertEqual(a.gettimeout(), 5.0)
        idle_a, idle_b = socket.socketpair()
        self.addCleanup(idle_a.close)
        self.addCleanup(idle_b.close)
        idle_a.settimeout(0.2)
        idle_rx = PhaseReader(idle_a, 0.2)
        idle_reader = io.BufferedReader(idle_rx)
        with self.assertRaises(socket.timeout):
            idle_reader.peek(1)
        idle_rx.begin("header", 1.0)
        idle_b.shutdown(socket.SHUT_WR)
        self.assertEqual(idle_reader.read(10), b"")
        self.assertTrue(idle_rx.eof_in_phase)

    def test_phase_allowance(self):
        """T12: 본문 허용 시간 = base + 받은 바이트/최저 속도, 상한."""
        from hub.inbound import phase_allowance
        self.assertEqual(phase_allowance(0, base=10.0, min_rate=16384, cap=300.0), 10.0)
        self.assertAlmostEqual(phase_allowance(1048576, base=10.0, min_rate=16384, cap=300.0), 74.0)
        self.assertEqual(phase_allowance(16 * 1048576, base=10.0, min_rate=16384, cap=300.0), 300.0)
        self.assertLess(phase_allowance(4, base=10.0, min_rate=16384, cap=300.0), 10.01)
        self.assertEqual(phase_allowance(10 ** 9, base=10.0), 10.0)

    def test_config(self):
        """T13: 기본값 10/16384/300 · 범위 밖·잘못된 값은 범위·기본값으로."""
        keys = ("HUB_HEADER_TIMEOUT", "HUB_BODY_MIN_RATE", "HUB_BODY_TIMEOUT_MAX")
        clean = {k: v for k, v in os.environ.items() if k not in keys}
        with mock.patch.dict(os.environ, clean, clear=True):
            c = config_mod.Config()
            self.assertEqual((c.header_timeout, c.body_min_rate, c.body_timeout_max), (10.0, 16384, 300.0))
        with mock.patch.dict(os.environ, {"HUB_HEADER_TIMEOUT": "0", "HUB_BODY_MIN_RATE": "1", "HUB_BODY_TIMEOUT_MAX": "99999"}):
            c = config_mod.Config()
            self.assertEqual((c.header_timeout, c.body_min_rate, c.body_timeout_max), (1.0, 1024, 3600.0))
        with mock.patch.dict(os.environ, {"HUB_HEADER_TIMEOUT": "abc"}):
            self.assertEqual(config_mod.Config().header_timeout, 10.0)

    def test_drop_log_is_rate_limited_and_flushes_its_tail(self):
        """T14 + 반증 N-1: 연결 보호 로그는 간격당 1줄 · 간격 안의 건은 타이머가 '지난 N초' 로 찍는다(다음 사건을 기다리지 않는다)."""
        srv = server_mod.HubServer(("127.0.0.1", 0), server_mod.HubHandler, None, max_per_client=0)
        self.addCleanup(srv.server_close)
        srv._drop_log_interval = 0.4   # noqa: SLF001
        with _capture() as out:
            srv.note_inbound_drop("header")
            srv.note_inbound_drop("header")
            srv.note_inbound_drop("silent")
            self.assertEqual(out.getvalue().count("연결 보호"), 1)
            self.assertTrue(_wait(lambda: out.getvalue().count("연결 보호") == 2, 3.0), out.getvalue())
        lines = [x for x in out.getvalue().splitlines() if "연결 보호" in x]
        self.assertIn("헤더 시한 초과 1건", lines[0])
        self.assertIn("지난", lines[1])
        self.assertIn("헤더 시한 초과 1건", lines[1])
        self.assertNotIn("ERROR", out.getvalue())
        self.assertEqual(srv.inbound_drops["header"], 2)
        self.assertEqual(srv.inbound_drops["silent"], 1)


if __name__ == "__main__":
    unittest.main()
