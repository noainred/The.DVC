"""보안 잔여 11-27 L12 — 허브 인바운드 수신 전체 시한 + 연결 자리 선획득.

- 소켓 시한(핸들러 timeout 20초)은 recv 1회 단위라 요청 줄·헤더·본문을 1바이트씩 흘리는 연결이 끊기지 않았다(재현).
- 연결 세마포어를 스레드 안에서(스레드 생성 뒤) 5초 기다려, 거절될 연결에도 스레드가 먼저 생겼다.
- 형제: EOF 로 끝난 헤더 · 짧게 끝난 본문 · 잘못된 Content-Length 를 그대로 라우팅했다.
- 반증(설계 2차): keep-alive 로 자리를 무기한 쥐기 · 가득 찼을 때 즉시 거절의 '빈자리 복권' · 선언 길이로 늘어나는 본문 시한.
- 반증 1회차(fix1): 자리 넘기기가 공격 중 정상 keep-alive 만 끊음(M1) · 느린 읽기(응답 쓰기)에 전체 시한 없음 · 대기 줄 앞 막힘(S1) ·
  미인증 큰 본문을 최저 속도로 흘려 자리 보유(S2) · Content-Length 의 유니코드 공백(N1) · shutdown 뒤 재가동(N2).
- 반증 2회차(fix2): 단계 갈아타기로 되찾기를 피함(R2-1 — PhaseCyclingTest · ReclaimScoreTest · UnitTest.test_conn_phase_slow_score) ·
  로그인 세션 제외가 계정 수와 무관(S) · 반환 대기 창 절대값(nit).

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
_GET_EXPECT = b"GET /api/meta HTTP/1.1\r\nHost: x\r\nExpect: 100-continue\r\n\r\n"   # 반증 3회차 R3-1
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


def _read_final(sock):
    """1xx(100 Continue)를 건너뛰고 최종 응답 상태줄을 돌려준다(본문은 Content-Length 만큼). 응답 없이 닫히면 ''.
    반증 3회차 R3-1 — `_read_response` 는 첫 응답만 읽어 100 뒤의 최종 응답을 버퍼에 남긴다."""
    buf = b""
    while True:
        while b"\r\n\r\n" not in buf:
            try:
                chunk = sock.recv(65536)
            except (ConnectionError, socket.timeout, OSError):
                return ""
            if not chunk:
                return ""
            buf += chunk
        head, buf = buf.split(b"\r\n\r\n", 1)
        lines = head.decode("latin-1").split("\r\n")
        if lines[0].startswith("HTTP/1.1 1"):
            continue
        length = 0
        for line in lines[1:]:
            if line.lower().startswith("content-length:"):
                length = int(line.split(":", 1)[1])
        while len(buf) < length:
            try:
                chunk = sock.recv(65536)
            except (ConnectionError, socket.timeout, OSError):
                return ""
            if not chunk:
                return ""
            buf += chunk
        return lines[0]


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


def _leave(conn, phase, now):
    """단계 닫기 — 수정 전 판본(leave(phase) 만 받음)에서도 TypeError 가 아니라 단언으로 실패하게."""
    try:
        conn.leave(phase, now)
    except TypeError:
        conn.leave(phase)


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
                admit_wait=None, handler=None, cls=None, reclaim_after=None, preauth=65536):
        patches = [mock.patch.object(config, "header_timeout", header, create=True),
                   mock.patch.object(config, "body_min_rate", rate, create=True),
                   mock.patch.object(config, "body_timeout_max", cap, create=True),
                   mock.patch.object(config, "preauth_max_body", preauth, create=True)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        srv = (cls or server_mod.HubServer)(("127.0.0.1", 0), handler or server_mod.HubHandler, self.ctx,
                                            max_connections=max_connections, max_per_client=per_client)
        if admit_wait is not None:
            srv.admit_wait = admit_wait
        if reclaim_after is not None:
            srv.reclaim_after = reclaim_after
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
    def _post(self, port, length, extra_headers=b"", auth=False):
        if auth:   # fix1 S2: 64KiB 넘는 본문은 로그인 세션이 있어야 읽는다(미인증은 읽기 전에 401)
            extra_headers = b"X-Settings-Token: " + self.token.encode() + b"\r\n" + extra_headers
        sock = _open(port)
        self.addCleanup(sock.close)
        sock.sendall(b"POST /api/shortcuts HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n"
                     + extra_headers + b"Content-Length: " + str(length).encode() + b"\r\n\r\n")
        return sock

    def test_declared_length_does_not_buy_time(self):
        """T2 + 반증 M-3: 1MiB 를 선언하고 1바이트씩 — 받은 바이트만큼만 늘어나 base(0.5초) 근처에서 408."""
        with _capture():
            srv, port = self._server(header=0.5, rate=16384, cap=300.0)
            sock = self._post(port, 1048576, auth=True)
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
            sock = self._post(port, 100000, auth=True)
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
            sock = self._post(port, 500000, auth=True)
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
            big = self._post(port, 900000, auth=True)
            big.sendall(b" " * 900000)
            status, _, body = _read_response(big)
            self.assertIn(" 400 ", status, "로그인 세션의 빠른 대용량 본문이 처리기까지 가지 않았다")

    def test_expect_100_continue_does_not_start_the_write_clock(self):
        """fix1: 'Expect: 100-continue' 의 100 응답이 연 쓰기 단계는 본문을 받기 전에 닫는다 — base(0.5초)보다 오래 걸린 정상 속도의
        본문(약 1초)도 최종 응답을 받는다(열어 두면 본문 수신 시간이 쓰기 시한에 들어가 응답 없이 끊긴다)."""
        with _capture():
            srv, port = self._server(header=0.5, rate=1024, cap=30.0)
            sock = self._post(port, 2000, b"Expect: 100-continue\r\n", auth=True)
            sock.settimeout(3)
            first = sock.recv(100)
            self.assertTrue(first.startswith(b"HTTP/1.1 100 "), first)
            for _ in range(10):
                sock.sendall(b" " * 200)   # 2000B/s > 1024B/s
                time.sleep(0.1)
            status = _read_response(sock)[0]
            self.assertIn(" 400 ", status, "100-continue 뒤 정상 속도 본문의 응답이 쓰기 시한에 잘렸다")
            self.assertEqual(self._drops(srv, "write"), 0)

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
        """반증 M-1: 유휴 keep-alive 연결은 자리를 무기한 쥐지 못한다 — 가득 차면 reclaim_after 넘게 쉰 연결 중 가장 오래 쉰 것을 내보낸다."""
        with _capture():
            srv, port = self._server(header=2.0, max_connections=2, admit_wait=3.0, reclaim_after=0.3)
            idle = []
            for _ in range(2):
                sock = _open(port)
                self.addCleanup(sock.close)
                sock.sendall(_GET)
                self.assertIn(" 200 ", _read_response(sock)[0])
                idle.append(sock)
                time.sleep(0.05)
            time.sleep(0.4)
            t0 = time.monotonic()
            third = _open(port)
            self.addCleanup(third.close)
            third.sendall(_GET_CLOSE)
            self.assertIn(" 200 ", _read_response(third)[0], "유휴 keep-alive 가 자리를 쥐어 새 연결이 못 들어왔다")
            self.assertLess(time.monotonic() - t0, 1.5)
            got, closed = _closed_within(idle[0], 2.0)
            self.assertIsNotNone(closed, "가장 오래 유휴한 연결이 내보내지지 않았다")
            self.assertGreaterEqual(self._drops(srv, "evicted"), 1)
            idle[1].sendall(_GET)
            self.assertIn(" 200 ", _read_response(idle[1])[0], "두 번째 유휴 연결까지 내보냈다(대기자 하나에 하나만)")

    def test_active_keepalive_is_not_evicted_for_a_newcomer(self):
        """fix1: 자리가 reclaim_after(1초)보다 자주 쓰는 keep-alive 하나뿐이면 새 연결은 대기 마감에 끊기고 기존 연결은 그대로다
        (방금 요청을 마친 연결을 내보내면 쓰는 사람을 밀어내고 새로 온 연결 — 공격 연결일 수 있다 — 을 들인다)."""
        with _capture():
            srv, port = self._server(header=5.0, max_connections=1, admit_wait=0.6, reclaim_after=1.0)
            user = _open(port)
            self.addCleanup(user.close)
            user.sendall(_GET)
            self.assertIn(" 200 ", _read_response(user)[0])
            newcomer = _open(port)
            self.addCleanup(newcomer.close)
            newcomer.sendall(_GET_CLOSE)
            for _ in range(5):
                time.sleep(0.2)
                user.sendall(_GET)
                self.assertIn(" 200 ", _read_response(user)[0], "쓰고 있는 keep-alive 를 새 연결에 내보냈다")
            self.assertEqual(_read_all(newcomer, 1.0), b"")
            self.assertEqual(self._drops(srv, "full"), 1)
            self.assertEqual(self._drops(srv, "evicted"), 0)

    def test_idle_is_evicted_when_no_slow_phase_matures_before_the_deadline(self):
        """fix1: 느린 단계 후보(헤더 0.1초째 · 1.5초 뒤 후보)가 대기 마감(1초) 전에 생기지 않으면 오래 쉰 유휴를 내보낸다 —
        느린 후보를 마감 너머까지 기다려 새 연결을 'full' 로 끊지 않는다."""
        with _capture():
            srv, port = self._server(header=8.0, max_connections=2, admit_wait=1.0, reclaim_after=1.5)
            idle = _open(port)
            self.addCleanup(idle.close)
            idle.sendall(_GET)
            self.assertIn(" 200 ", _read_response(idle)[0])
            time.sleep(1.6)   # 유휴 1.6초 > reclaim_after
            self._hold_partial(port, 1)   # 헤더 단계 막 시작
            self.assertTrue(_wait(lambda: self._active(srv) == 2))
            third = _open(port)
            self.addCleanup(third.close)
            third.sendall(_GET_CLOSE)
            self.assertIn(" 200 ", _read_response(third)[0], "대기 마감 너머의 느린 후보를 기다리느라 새 연결을 끊었다")
            self.assertEqual(self._drops(srv, "evicted"), 1)
            self.assertEqual(self._drops(srv, "full"), 0)

    def test_recently_finished_keepalive_keeps_its_seat_and_the_slow_phase_is_reclaimed(self):
        """fix1 M1: 기다리는 연결이 있어도 방금 요청을 마친 keep-alive 는 자리를 넘기지 않는다 — 헤더를 오래 흘리는 연결을 되찾는다.

        1회차는 요청을 마친 연결이 넘겨(conn_idle) 공격 중 정상 사용자만 요청마다 끊겼다(반증 실측: 매 요청 재연결 · 느린 읽기 0/2).
        """
        with _capture():
            srv, port = self._server(header=5.0, max_connections=2, admit_wait=4.0, reclaim_after=1.0)
            held = self._hold_partial(port, 2)
            self.assertTrue(_wait(lambda: self._active(srv) == 2))
            t_start = time.monotonic()
            third = _open(port)
            self.addCleanup(third.close)
            third.sendall(_GET_CLOSE)
            time.sleep(0.2)
            held[0].sendall(b"1\r\n\r\n")   # 헤더를 마친다(keep-alive) — 이제 정상 사용자다
            self.assertIn(" 200 ", _read_response(held[0])[0])
            for _ in range(4):   # 0.2초마다 같은 연결로 — reclaim_after(1초)보다 자주 쓰는 연결
                time.sleep(0.2)
                held[0].sendall(_GET)
                self.assertIn(" 200 ", _read_response(held[0])[0], "방금 요청을 마친 keep-alive 가 기다리는 연결에 자리를 넘겼다")
            self.assertIn(" 200 ", _read_response(third)[0], "헤더를 흘리는 연결을 되찾지 않았다")
            self.assertLess(time.monotonic() - t_start, 3.0)
            _, closed = _closed_within(held[1], 2.0)
            self.assertIsNotNone(closed, "헤더 단계에 오래 머문 연결이 끊기지 않았다")
            self.assertEqual(self._drops(srv, "shed"), 1)
            self.assertEqual(self._drops(srv, "eof"), 0, "되찾긴 연결을 'EOF 로 끝난 헤더' 로 이중 집계했다")
            held[0].sendall(_GET)
            self.assertIn(" 200 ", _read_response(held[0])[0])

    def test_request_in_processing_is_not_reclaimed(self):
        """fix1: 헤더를 다 받은 뒤 서버가 처리 중인 요청(본문 없음)은 되찾기 대상이 아니다 — 헤더 단계를 열어 두면 처리 시간이
        '헤더 단계' 로 보여 처리 중인 연결을 끊었다. 처리가 끝나 유휴가 된 뒤 reclaim_after 가 지나면 기다리던 연결이 받는다."""
        real_all = self.ctx.shortcuts.all

        def slow_all():
            time.sleep(1.0)
            return real_all()

        with _capture():
            srv, port = self._server(header=5.0, max_connections=1, admit_wait=2.5, reclaim_after=0.2)
            with mock.patch.object(self.ctx.shortcuts, "all", side_effect=slow_all):
                busy = _open(port)
                self.addCleanup(busy.close)
                busy.sendall(b"GET /api/shortcuts HTTP/1.1\r\nHost: x\r\n\r\n")
                time.sleep(0.1)
                waiter = _open(port)
                self.addCleanup(waiter.close)
                waiter.sendall(_GET_CLOSE)
                self.assertIn(" 200 ", _read_response(busy)[0], "처리 중인 요청을 되찾았다")
            self.assertIn(" 200 ", _read_response(waiter)[0], "처리를 마치고 쉰 연결을 되찾지 않았다")
            self.assertEqual(self._drops(srv, "shed"), 0)
            self.assertEqual(self._drops(srv, "evicted"), 1)

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

    def test_reclaim_policy(self):
        """fix1: 되찾기 대상 — 헤더 · 본문 · 쓰기에 reclaim_after 넘게 머문 연결이 먼저(오래된 순) · 그다음 오래 쉰 유휴.
        처리 중(단계 없음) · 린저 · 로그인 세션의 본문 · 쓰기는 되찾지 않는다 · 되찾긴 연결은 다음 요청을 처리하지 않는다 ·
        느린 단계 후보가 대기 마감 전에 생기면 유휴를 내보내지 않고 그것을 기다린다."""
        srv = server_mod.HubServer(("127.0.0.1", 0), server_mod.HubHandler, self.ctx,
                                   max_connections=9, max_per_client=0, reclaim_after=1.0)
        self.addCleanup(srv.server_close)

        class FakeSock:
            def __init__(self):
                self.shut = []

            def shutdown(self, how):
                self.shut.append(how)

        socks = {name: FakeSock() for name in ("working", "fresh_idle", "mid_idle", "old_idle", "header", "old_header",
                                               "trusted_body", "trusted_header", "linger")}
        for i, sock in enumerate(socks.values()):
            self.assertIsNone(srv._admit(sock, "10.0.0.%d" % i)[0])   # noqa: SLF001
        now = time.monotonic()
        seat = {name: srv._admitted[sock] for name, sock in socks.items()}   # noqa: SLF001
        for st in seat.values():
            _leave(st.conn, "header", now)   # fix2: 새 자리는 입장부터 헤더 단계다 — 여기서는 첫 요청을 이미 받은 자리들로 본다
        self.assertTrue(srv.conn_idle(socks["fresh_idle"]))
        self.assertTrue(srv.conn_idle(socks["old_idle"]))
        self.assertTrue(srv.conn_idle(socks["mid_idle"]))
        seat["old_idle"].since = now - 5
        seat["mid_idle"].since = now - 3
        seat["fresh_idle"].since = now - 0.5
        seat["header"].conn.enter("header", now - 2)
        seat["old_header"].conn.enter("header", now - 3)
        seat["trusted_body"].conn.enter("body", now - 9)
        seat["trusted_body"].conn.trusted = True
        seat["trusted_header"].conn.enter("header", now - 1.5)
        seat["trusted_header"].conn.trusted = True   # 헤더 단계는 로그인 여부를 아직 모른다 — 대상
        seat["linger"].conn.enter("linger", now - 9)
        seat["working"].since = now - 9          # 처리 중(단계 없음) — 대상 아님
        order = []
        with srv._cond:   # noqa: SLF001
            for _ in range(6):
                kind, next_at = srv._reclaim_one_locked(now)   # noqa: SLF001
                if kind is None:
                    break
                victim = [name for name, st in seat.items() if st.state == "evicted" and name not in order]
                order.append(victim[0])
                self.assertEqual(kind, "evicted" if victim[0].endswith("idle") else "shed")
        self.assertEqual(order, ["old_header", "header", "trusted_header", "old_idle", "mid_idle"])
        self.assertAlmostEqual(next_at, now + 0.5, delta=0.01)   # 다음 후보: fresh_idle 이 1초를 채우는 때
        for name in ("working", "fresh_idle", "trusted_body", "linger"):
            self.assertEqual(socks[name].shut, [], name + " 을(를) 되찾았다")
            self.assertFalse(seat[name].conn.shed)
        for name in order:
            self.assertEqual(socks[name].shut, [socket.SHUT_RDWR])
            self.assertTrue(seat[name].conn.shed)
        self.assertFalse(srv.conn_busy(socks["old_idle"]), "내보낸 연결이 다음 요청을 처리했다")
        self.assertFalse(srv.conn_idle(socks["old_header"]), "되찾은 연결이 유휴로 남았다")
        self.assertTrue(srv.conn_busy(socks["working"]))
        with srv._cond:   # noqa: SLF001
            self.assertTrue(srv._reclaim_pending_locked(now + 0.5))   # noqa: SLF001
            self.assertFalse(srv._reclaim_pending_locked(now + 1.5), "돌아오지 않는 자리가 되찾기를 영원히 막는다")   # noqa: SLF001
        # 유휴(5초 쉼) 하나 + 헤더 단계 0.6초째(0.4초 뒤 후보) — 마감이 그 뒤면 기다리고, 그 전이면 유휴를 내보낸다
        srv2 = server_mod.HubServer(("127.0.0.1", 0), server_mod.HubHandler, self.ctx,
                                    max_connections=2, max_per_client=0, reclaim_after=1.0)
        self.addCleanup(srv2.server_close)
        user, slow = FakeSock(), FakeSock()
        srv2._admit(user, "10.0.0.1")   # noqa: SLF001
        srv2._admit(slow, "10.0.0.2")   # noqa: SLF001
        self.assertTrue(srv2.conn_idle(user))
        now = time.monotonic()
        _leave(srv2._admitted[user].conn, "header", now)   # noqa: SLF001
        srv2._admitted[user].since = now - 5   # noqa: SLF001
        srv2._admitted[slow].conn.enter("header", now - 0.6)   # noqa: SLF001
        with srv2._cond:   # noqa: SLF001
            kind, next_at = srv2._reclaim_one_locked(now, now + 2.0)   # noqa: SLF001
            self.assertIsNone(kind, "곧 느린 단계 후보가 생기는데 쉬고 있던 정상 연결을 내보냈다")
            self.assertAlmostEqual(next_at, now + 0.4, delta=0.01)
            self.assertEqual(user.shut, [])
            kind, _ = srv2._reclaim_one_locked(now + 0.5, now + 2.0)   # noqa: SLF001
            self.assertEqual(kind, "shed")
            self.assertEqual((user.shut, slow.shut), ([], [socket.SHUT_RDWR]))
        srv3 = server_mod.HubServer(("127.0.0.1", 0), server_mod.HubHandler, self.ctx,
                                    max_connections=2, max_per_client=0, reclaim_after=1.0)
        self.addCleanup(srv3.server_close)
        user, slow = FakeSock(), FakeSock()
        srv3._admit(user, "10.0.0.1")   # noqa: SLF001
        srv3._admit(slow, "10.0.0.2")   # noqa: SLF001
        self.assertTrue(srv3.conn_idle(user))
        now = time.monotonic()
        _leave(srv3._admitted[user].conn, "header", now)   # noqa: SLF001
        srv3._admitted[user].since = now - 5   # noqa: SLF001
        srv3._admitted[slow].conn.enter("header", now - 0.1)   # noqa: SLF001 — 0.1초째(대체 후보 기준 1/4 미만 — 아직 '느리다' 고 볼 수 없다)
        with srv3._cond:   # noqa: SLF001
            kind, _ = srv3._reclaim_one_locked(now, now + 0.2)   # noqa: SLF001
        self.assertEqual(kind, "evicted", "대기 마감 전에 느린 후보가 없는데 유휴를 내보내지 않았다")
        self.assertEqual((user.shut, slow.shut), ([socket.SHUT_RDWR], []))
        # fix2(반증 2회차 R2-1): 마감 직전 대체 후보는 '조금이라도 느린' 연결이 먼저 — 헤더 0.6초째(기준 1초 미만)가 5초 쉰 정상
        #   keep-alive 보다 앞선다(1회차 판본은 쉬던 정상 연결을 끊었다 — 갈아타기 공격 중 기존 사용자가 수정 전보다 먼저 끊긴 원인).
        srv4 = server_mod.HubServer(("127.0.0.1", 0), server_mod.HubHandler, self.ctx,
                                    max_connections=2, max_per_client=0, reclaim_after=1.0)
        self.addCleanup(srv4.server_close)
        user, slow = FakeSock(), FakeSock()
        srv4._admit(user, "10.0.0.1")   # noqa: SLF001
        srv4._admit(slow, "10.0.0.2")   # noqa: SLF001
        self.assertTrue(srv4.conn_idle(user))
        now = time.monotonic()
        _leave(srv4._admitted[user].conn, "header", now)   # noqa: SLF001
        srv4._admitted[user].since = now - 5   # noqa: SLF001
        srv4._admitted[slow].conn.enter("header", now - 0.6)   # noqa: SLF001
        with srv4._cond:   # noqa: SLF001
            kind, _ = srv4._reclaim_one_locked(now, now + 0.2)   # noqa: SLF001
        self.assertEqual(kind, "shed", "마감 직전에 헤더를 0.6초째 끄는 연결 대신 쉬던 정상 연결을 내보냈다")
        self.assertEqual((user.shut, slow.shut), ([], [socket.SHUT_RDWR]))

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


_FONT = b"GET /fonts/PretendardVariable.woff2 HTTP/1.1\r\nHost: x\r\n\r\n"


def _slow_reader(port, stop, rcvbuf=1024):
    """큰 정적 파일(폰트 2MB)을 요청하고 읽지 않는다. 서버가 끊으면 다시 붙는다(반증 refute_g5._slow_reader 와 같은 꼴)."""
    while time.monotonic() < stop:
        try:
            s = socket.socket()
            s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, rcvbuf)
            s.settimeout(2)
            s.connect(("127.0.0.1", port))
            s.sendall(_FONT)
            s.settimeout(0.2)
            while time.monotonic() < stop:
                try:
                    if s.recv(1, socket.MSG_PEEK) == b"":
                        break
                    time.sleep(0.2)
                except socket.timeout:
                    pass
                except OSError:
                    break
                try:
                    s.send(b"x")
                except OSError:
                    break
            s.close()
        except OSError:
            time.sleep(0.05)


def _dripper(port, stop):
    """헤더를 0.05초마다 1바이트씩 — 끊기면 다시 붙는다."""
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
            time.sleep(0.02)


def _min_rate_poster(port, stop, length, per_tick, path=b"/api/health/check", extra=b""):
    """미인증 본문을 최저 속도를 겨우 넘겨(0.1초마다 per_tick 바이트) 보낸다 — 끊기면 다시 붙는다."""
    while time.monotonic() < stop:
        try:
            a = socket.create_connection(("127.0.0.1", port), timeout=2)
            a.sendall(b"POST " + path + b" HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n" + extra
                      + b"Content-Length: " + str(length).encode() + b"\r\n\r\n")
            sent = 0
            while time.monotonic() < stop and sent < length:
                a.sendall(b" " * per_tick)
                sent += per_tick
                time.sleep(0.1)
            a.close()
        except OSError:
            time.sleep(0.05)


class UnderAttackTest(InboundCase):
    """fix1 M1 · S1 · S2: 공격 중에도 기존 keep-alive 가 그대로 쓰이고, 새 사용자도 들어온다.

    축소 비율: 헤더 시한 1초 · 대기 상한 1초 · 되찾기 0.5초(운영 10 · 10 · 5 의 1/10). 자리 4.
    수정 전(a821fd9e)은 기존 연결이 세마포어 칸을 쥐고 있어 '기존 keep-alive' 시험은 통과한다(회귀 지킴이) —
    1회차(8708d24f)는 요청을 마친 연결이 자리를 넘겨 실패했다(반증 실측: 매 요청 재연결 · 느린 읽기 0/2).
    """

    def _keepalive_user(self, port):
        sock = _open(port)
        self.addCleanup(sock.close)
        sock.sendall(_GET)
        self.assertIn(" 200 ", _read_response(sock)[0])
        return sock

    def _use(self, sock, seconds, gap):
        results = []
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            t0 = time.monotonic()
            try:
                sock.settimeout(3)
                sock.sendall(_GET)
                ok = " 200 " in _read_response(sock)[0]
            except OSError:
                ok = False
            results.append((ok, round(time.monotonic() - t0, 2)))
            if not ok:
                break
            time.sleep(gap)
        return results

    def _attack(self, target, count, seconds, *args):
        stop = time.monotonic() + seconds
        threads = [threading.Thread(target=target, args=(self._port, stop) + args, daemon=True) for _ in range(count)]
        for t in threads:
            t.start()
        self.addCleanup(lambda: [t.join(5) for t in threads])
        return stop

    def _new_users(self, stop, margin=1.0, read=3.0):
        ok = tries = 0
        waits = []
        while time.monotonic() < stop - margin:
            tries += 1
            t0 = time.monotonic()
            try:
                c = socket.create_connection(("127.0.0.1", self._port), timeout=3)
                c.settimeout(0.5)
                c.sendall(_GET_CLOSE)
                if _read_all(c, read).startswith(b"HTTP/1.1 200 "):
                    ok += 1
                    waits.append(round(time.monotonic() - t0, 2))
                c.close()
            except OSError:
                pass
            time.sleep(0.2)
        return ok, tries, waits

    def test_existing_keepalive_keeps_working_under_drip_attack(self):
        with _capture():
            srv, self._port = self._server(header=1.0, max_connections=4, admit_wait=1.0)
            user = self._keepalive_user(self._port)
            self._attack(_dripper, 8, 4.5)
            results = self._use(user, 3.8, 0.6)   # 반증 경계: 요청 사이 0.6초 쉼 > 되찾기 0.5초 — 그래도 느린 공격 연결이 먼저 끊긴다
        self.assertGreaterEqual(len(results), 4)
        self.assertTrue(all(ok for ok, _ in results), "공격 중 기존 keep-alive 가 끊겼다: {}".format(results))
        self.assertLess(max(d for _, d in results), 0.5, results)

    def test_existing_keepalive_keeps_working_under_slow_read_attack(self):
        with _capture():
            srv, self._port = self._server(header=1.0, max_connections=4, admit_wait=1.0)
            user = self._keepalive_user(self._port)
            self._attack(_slow_reader, 16, 4.5)
            results = self._use(user, 3.8, 0.6)   # 반증 경계: 요청 사이 0.6초 쉼 > 되찾기 0.5초 — 그래도 느린 공격 연결이 먼저 끊긴다
        self.assertGreaterEqual(len(results), 4)
        self.assertTrue(all(ok for ok, _ in results), "느린 읽기 공격 중 기존 keep-alive 가 끊겼다: {}".format(results))
        self.assertLess(max(d for _, d in results), 0.5, results)

    def test_new_users_get_in_during_slow_read_attack(self):
        """반증 S1: 느린 읽기 16연결(자리 4) — 응답 쓰기 시한 + 되찾기로 보유가 짧아져 대기 줄이 막히지 않는다."""
        with _capture():
            srv, self._port = self._server(header=1.0, max_connections=4, admit_wait=1.0)
            stop = self._attack(_slow_reader, 16, 8.0)
            time.sleep(0.8)
            ok, tries, waits = self._new_users(stop)
            drops = dict(srv.inbound_drops) if hasattr(srv, "inbound_drops") else {}
        # 공격 연결 16개가 자리 4개 앞에 줄을 선다 — 새 사용자는 FIFO 로 약 1.5~2초 기다린다(되찾기 0.5초마다 4자리 · 실측)
        self.assertGreaterEqual(tries, 3)
        self.assertGreaterEqual(ok / tries, 0.8, "느린 읽기 중 새 사용자 {}/{} · {} · {}".format(ok, tries, waits, drops))
        self.assertGreater(drops.get("write", 0) + drops.get("shed", 0), 0)

    def test_new_users_get_in_while_min_rate_bodies_hold_seats(self):
        """반증 S2: 최저 속도를 겨우 넘는 미인증 본문 8연결(자리 4 · 본문은 미인증 상한 안) — 되찾기로 새 사용자가 들어온다."""
        with _capture():
            srv, self._port = self._server(header=1.0, rate=1024, cap=60.0, max_connections=4, admit_wait=1.0)
            stop = self._attack(_min_rate_poster, 8, 6.0, 60000, 150)   # 1500B/s > 1024B/s · 6만 바이트 < 미인증 상한
            time.sleep(0.8)
            ok, tries, waits = self._new_users(stop)
            drops = dict(srv.inbound_drops) if hasattr(srv, "inbound_drops") else {}
        self.assertGreaterEqual(tries, 4)
        self.assertGreaterEqual(ok / tries, 0.8, "최저 속도 본문 중 새 사용자 {}/{} · {} · {}".format(ok, tries, waits, drops))


class WriteDeadlineTest(InboundCase):
    def test_non_reading_client_is_cut_at_the_write_deadline(self):
        """fix1 M1(a): 응답을 읽지 않는 연결 — 쓰기 단계 시한(base 0.5초 + 상대가 받은 바이트/최저 속도)에서 끊긴다.

        수정 전에는 sendall 1회에 소켓 시한 20초라 쓰기마다 20초를 쥐었다. 보낸 바이트(커널 송신 버퍼)로 세면 루프백에서 20초였다(실측).
        """
        with _capture() as out:
            srv, port = self._server(header=0.5)
            s = socket.socket()
            s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024)
            self.addCleanup(s.close)
            s.connect(("127.0.0.1", port))
            s.sendall(_FONT)
            self.assertTrue(_wait(lambda: self._active(srv) == 1, 2.0))
            t0 = time.monotonic()
            self.assertTrue(_wait(lambda: self._active(srv) == 0, 6.0), "읽지 않는 연결이 6초 동안 자리를 쥐었다")
            self.assertLess(time.monotonic() - t0, 4.0)
            self.assertEqual(self._drops(srv, "write"), 1)
            time.sleep(0.1)
        self.assertNotIn("Traceback", out.getvalue())
        self.assertNotIn("BrokenPipe", out.getvalue())
        self.assertIn("응답 쓰기 시한 초과 1건", out.getvalue())

    def test_reading_clients_get_the_whole_file(self):
        """정상 읽기는 그대로 — 2MB 폰트를 빠르게 · 최저 속도의 몇 배로(약 100KB/s · base 0.5초보다 훨씬 오래) 끝까지 받는다."""
        with _capture():
            srv, port = self._server(header=0.5, rate=16384)
            size = (server_mod.STATIC_DIR / "fonts" / "PretendardVariable.woff2").stat().st_size
            fast = _open(port)
            self.addCleanup(fast.close)
            fast.sendall(_FONT)
            status, _, body = _read_response(fast)
            self.assertIn(" 200 ", status)
            self.assertEqual(len(body), size)
            slow = socket.socket()
            slow.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 16384)
            self.addCleanup(slow.close)
            slow.connect(("127.0.0.1", port))
            slow.settimeout(5)
            slow.sendall(b"GET /app.js HTTP/1.1\r\nHost: x\r\n\r\n")
            data = b""
            t0 = time.monotonic()
            want = None
            while want is None or len(data) < want:
                chunk = slow.recv(4096)
                if not chunk:
                    break
                data += chunk
                if want is None and b"\r\n\r\n" in data:
                    head = data.split(b"\r\n\r\n", 1)[0].decode("latin-1")
                    length = [int(x.split(":", 1)[1]) for x in head.split("\r\n") if x.lower().startswith("content-length:")][0]
                    want = len(head) + 4 + length
                time.sleep(0.04)   # 4KB/0.04초 ≈ 100KB/s
            self.assertEqual(len(data), want, "최저 속도보다 빠르게 읽는 연결이 끊겼다")
            self.assertGreater(time.monotonic() - t0, 0.6, "읽기 속도 제한이 걸리지 않았다(시험 무효)")
            slow.sendall(_GET)   # 같은 연결의 다음 요청도 그대로(앞 응답의 쓰기 단계가 남지 않는다)
            self.assertIn(" 200 ", _read_response(slow)[0])
            self.assertEqual(self._drops(srv, "write"), 0)


class ReclaimTest(InboundCase):
    def test_trusted_upload_is_not_reclaimed_but_anonymous_one_is(self):
        """fix1: 가득 찼을 때 미인증 본문(최저 속도 이상)은 되찾기 대상 · 로그인 세션의 업로드는 대상이 아니다."""
        with _capture():
            srv, port = self._server(header=2.0, rate=1024, cap=30.0, max_connections=1, admit_wait=1.0,
                                     reclaim_after=0.3)
            payload = b" " * 3000

            def upload(extra):
                s = _open(port)
                self.addCleanup(s.close)
                s.sendall(b"POST /api/shortcuts HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n" + extra
                          + b"Content-Length: 3000\r\n\r\n")
                return s

            # ① 로그인 세션 — 3000B 를 약 2000B/s 로(1.5초) · 기다리는 연결이 있어도 끝까지 받고 답한다
            trusted = upload(b"X-Settings-Token: " + self.token.encode() + b"\r\n")
            time.sleep(0.1)
            waiter = _open(port)
            self.addCleanup(waiter.close)
            waiter.sendall(_GET_CLOSE)
            for i in range(0, 3000, 200):
                trusted.sendall(payload[i:i + 200])
                time.sleep(0.1)
            status = _read_response(trusted)[0]
            self.assertIn(" 400 ", status, "로그인 세션의 업로드를 되찾았다")   # 공백 본문 = JSON 오류(처리기까지 갔다)
            self.assertEqual(self._drops(srv, "shed"), 0)
            self.assertEqual(_read_all(waiter, 1.0), b"")   # 대기 상한(1초) 안에 자리가 나지 않았다
            # ② 미인증 — 같은 속도의 업로드는 되찾긴다
            trusted.close()
            self.assertTrue(_wait(lambda: self._active(srv) == 0))
            anon = upload(b"")
            time.sleep(0.1)
            waiter2 = _open(port)
            self.addCleanup(waiter2.close)
            waiter2.sendall(_GET_CLOSE)
            t0 = time.monotonic()
            for i in range(0, 1400, 200):
                try:
                    anon.sendall(payload[i:i + 200])
                except OSError:
                    break
                time.sleep(0.1)
            self.assertIn(" 200 ", _read_response(waiter2)[0], "미인증 느린 본문을 되찾지 않았다")
            self.assertLess(time.monotonic() - t0, 1.5)
            self.assertEqual(_read_all(anon, 1.0), b"", "되찾긴 연결에 응답했다")
            self.assertEqual(self._drops(srv, "shed"), 1)
            self.assertEqual(self._drops(srv, "body"), 0, "되찾기를 본문 시한 초과로 이중 집계했다")


class PreauthBodyTest(InboundCase):
    def _ask(self, port, head, limit=1.5):
        sock = _open(port)
        self.addCleanup(sock.close)
        sock.sendall(head)
        t0 = time.monotonic()
        sock.settimeout(limit)
        try:
            status, headers, body = _read_response(sock)
        except socket.timeout:
            status, headers, body = "", "", b""
        return status, headers, body, time.monotonic() - t0

    def test_large_anonymous_body_is_refused_before_reading(self):
        """반증 S2: 로그인 세션 없는 64KiB 초과 본문은 읽기 전에 401 + 닫기(본문 시한 3초를 기다리지 않는다)."""
        with _capture():
            srv, port = self._server(header=3.0, preauth=65536)
            head = (b"POST /api/nothing HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n"
                    b"Content-Length: 1000000\r\n\r\n")
            status, headers, body, took = self._ask(port, head)
            self.assertIn(" 401 ", status, "미인증 큰 본문을 읽기 시작했다")
            self.assertLess(took, 1.0)
            self.assertIn("Connection: close", headers)
            self.assertEqual(json.loads(body.decode())["code"], "settings_login_required")
            self.assertEqual(self._drops(srv, "body"), 0)
            status, _, _, _ = self._ask(port, head.replace(b"/api/nothing", b"/upload"))
            self.assertIn(" 404 ", status)
            with mock.patch.object(config, "token", "hub-secret"):
                status, _, body, _ = self._ask(port, head)
                self.assertIn(" 401 ", status)
                self.assertEqual(json.loads(body.decode())["code"], "hub_token_required")
            # 미인증 상한 안의 본문은 그대로 읽고 라우팅한다(로그인 실패 401 — 처리기까지 갔다)
            login = json.dumps({"username": "nobody", "password": "x" * 100}).encode()
            sock = _open(port)
            self.addCleanup(sock.close)
            sock.sendall(b"POST /api/settings/session HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n"
                         b"Content-Length: " + str(len(login)).encode() + b"\r\n\r\n" + login)
            status, _, body = _read_response(sock)
            self.assertIn(" 401 ", status)
            self.assertIn("사용자명 또는 비밀번호", json.loads(body.decode())["error"])
            # 로그인 세션이면 큰 본문도 읽는다
            sock = _open(port)
            self.addCleanup(sock.close)
            sock.sendall(b"POST /api/shortcuts HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nX-Settings-Token: "
                         + self.token.encode() + b"\r\nContent-Length: 200000\r\n\r\n" + b" " * 200000)
            status, _, _ = _read_response(sock)
            self.assertIn(" 400 ", status)

    def test_content_length_rejects_non_ows_whitespace(self):
        """반증 N1: Content-Length 앞뒤 공백은 SP · HTAB 만 — '2\\xa0' · '\\x0b' · '\\x0c' · '\\x1c' 는 400(1회차는 404 = 라우팅됨)."""
        with _capture():
            srv, port = self._server(header=3.0)
            for value in (b"2\xa0", b"\x0b2", b"2\x0c", b"2\x1c"):
                with self.subTest(value=value):
                    sock = _open(port)
                    self.addCleanup(sock.close)
                    sock.sendall(b"POST /api/nothing HTTP/1.1\r\nHost: x\r\nContent-Length: " + value + b"\r\n\r\n{}")
                    data = _read_all(sock, 3.0)
                    self.assertTrue(data.startswith(b"HTTP/1.1 400 "), data[:60])
            sock = _open(port)
            self.addCleanup(sock.close)
            sock.sendall(b"POST /api/nothing HTTP/1.1\r\nHost: x\r\nContent-Length: \t2 \r\nConnection: close\r\n\r\n{}")
            self.assertTrue(_read_all(sock, 3.0).startswith(b"HTTP/1.1 404 "), "OWS(SP · HTAB)는 받아야 한다")


class QuietCloseTest(InboundCase):
    def test_client_reset_mid_header_leaves_no_traceback(self):
        """fix1: 요청 도중 RST 로 끊는 연결 — stdlib 'Exception occurred during processing' traceback 을 남기지 않는다
        (미인증 연결이 RST 만으로 로그를 채우지 못하게)."""
        err = io.StringIO()
        with _capture() as out, mock.patch("sys.stderr", new=err):
            srv, port = self._server(header=3.0)
            for _ in range(3):
                s = _open(port)
                s.sendall(b"GET /api/meta HTTP/1.1\r\nHost: x\r\nX-A: ")
                self.assertTrue(_wait(lambda: self._active(srv) == 1))
                time.sleep(0.1)
                s.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, b"\x01\x00\x00\x00\x00\x00\x00\x00")
                s.close()   # SO_LINGER 0 → RST
                self.assertTrue(_wait(lambda: self._active(srv) == 0))
            time.sleep(0.2)
        self.assertNotIn("Traceback", err.getvalue() + out.getvalue())
        self.assertNotIn("Exception occurred", err.getvalue() + out.getvalue())

    def test_deadline_inside_a_route_closes_quietly(self):
        """fix1: 라우트 응답을 쓰는 중의 쓰기 시한 · 자리 되찾기(InboundDeadline)는 _dispatch 의 최종 except 가 500 을 덧쓰거나
        'ERROR unhandled' traceback 을 남기지 않고 핸들러가 조용히 닫는다."""
        from hub.inbound import InboundDeadline
        err = io.StringIO()
        with _capture() as out, mock.patch("sys.stderr", new=err):
            srv, port = self._server(header=3.0)
            with mock.patch.object(self.ctx.shortcuts, "all", side_effect=InboundDeadline("write")):
                s = _open(port)
                self.addCleanup(s.close)
                s.sendall(b"GET /api/shortcuts HTTP/1.1\r\nHost: x\r\n\r\n")
                self.assertEqual(_read_all(s, 2.0), b"")
            self.assertTrue(_wait(lambda: self._drops(srv, "write") == 1))
        self.assertNotIn("ERROR unhandled", out.getvalue())
        self.assertNotIn("Traceback", err.getvalue() + out.getvalue())


class RestartTest(InboundCase):
    def test_serve_forever_again_after_shutdown_still_waits_for_a_seat(self):
        """반증 N2: shutdown 뒤 같은 객체로 다시 serve_forever — 가득 찼을 때 대기 없이 전부 'full' 로 끊지 않는다."""
        with _capture():
            srv, port = self._server(header=5.0, max_connections=1, admit_wait=3.0)
            srv.shutdown()
            thread = threading.Thread(target=srv.serve_forever, daemon=True)
            thread.start()
            held = self._hold_partial(port, 1)
            self.assertTrue(_wait(lambda: self._active(srv) == 1))
            waiting = _open(port)
            self.addCleanup(waiting.close)
            waiting.sendall(_GET_CLOSE)
            time.sleep(0.4)
            held[0].close()
            self.assertIn(" 200 ", _read_response(waiting)[0], "재가동한 서버가 자리를 기다리지 않고 끊었다")
            self.assertEqual(self._drops(srv, "full"), 0)


def _cycler(port, stop, mode, phase=0.4, idle=0.4):
    """반증 2회차 R2-1: 단계마다 되찾기 기준(0.5초) 직전에 다음 단계로 갈아탄다 — 유휴 → 헤더 드립 → 본문 드립 → 응답 → 유휴 …
    (반증 refute_cycle.py 와 같은 꼴). mode 'hdr' 는 쉬지 않고 헤더만 흘린다. mode 'expect'(반증 3회차 R3-1)는 유휴 → 헤더 드립 끝에
    'Expect: 100-continue' — stdlib 가 100 을 쓰며 단계를 덮어써 헤더 드립이 누계에서 빠지던 우회."""
    while time.monotonic() < stop:
        try:
            s = _open(port, timeout=5)
            s.settimeout(5)
            first = True
            while time.monotonic() < stop:
                if mode in ("full", "expect"):
                    if not first:
                        time.sleep(idle)
                    first = False
                    req = (b"POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\n\r\n" if mode == "full" else _GET_EXPECT)
                else:
                    req = _GET
                step = phase / len(req) * 0.9
                for i in range(len(req)):
                    s.sendall(req[i:i + 1])
                    time.sleep(step)
                if mode == "full":
                    for _ in range(4):
                        time.sleep(phase / 4 * 0.9)
                        s.sendall(b"a")
                if not (_read_final(s) if mode == "expect" else _read_response(s)[0]):
                    break
            s.close()
        except OSError:
            time.sleep(0.05)


class PhaseCyclingTest(InboundCase):
    """반증 2회차 R2-1: 되찾기 후보를 '지금 단계의 시작' 으로만 보면 단계를 갈아타는 연결이 자리를 무기한 쥐었다.

    축소 비율은 UnderAttackTest 와 같다(헤더 1초 · 대기 1초 · 되찾기 0.5초 · 자리 4). 수정 전(35d8da36) 실측: 새 사용자 0/5 ·
    기존 keep-alive(0.6초 간격) 3번째 요청에서 끊김(a821fd9e 는 8/8 유지 — 이 시험의 keep-alive 쪽은 그 판본에서도 통과한다).
    """

    _keepalive_user = UnderAttackTest._keepalive_user
    _use = UnderAttackTest._use
    _new_users = UnderAttackTest._new_users

    def _attack(self, count, seconds, mode):
        stop = time.monotonic() + seconds
        threads = [threading.Thread(target=_cycler, args=(self._port, stop, mode), daemon=True) for _ in range(count)]
        for t in threads:
            t.start()
        self.addCleanup(lambda: [t.join(6) for t in threads])
        return stop

    def test_new_users_get_in_during_phase_cycling(self):
        for mode in ("full", "hdr"):
            with self.subTest(mode=mode), _capture():
                srv, self._port = self._server(header=1.0, max_connections=4, admit_wait=1.0)
                stop = self._attack(4, 7.0, mode)
                time.sleep(1.0)
                ok, tries, waits = self._new_users(stop)
                drops = dict(getattr(srv, "inbound_drops", {}))
                self.assertGreaterEqual(tries, 3)
                self.assertGreaterEqual(ok / tries, 0.8, "단계 갈아타기({}) 중 새 사용자 {}/{} · {} · {}".format(
                    mode, ok, tries, waits, drops))
                self.assertGreater(drops.get("shed", 0), 0)

    def test_existing_keepalive_keeps_working_during_phase_cycling(self):
        for mode in ("full", "hdr", "expect"):
            with self.subTest(mode=mode), _capture():
                srv, self._port = self._server(header=1.0, max_connections=4, admit_wait=1.0)
                user = self._keepalive_user(self._port)
                self._attack(6, 5.5, mode)
                results = self._use(user, 4.5, 0.6)   # 요청 사이 0.6초 쉼 > 되찾기 0.5초 — 그래도 갈아타는 공격 연결이 먼저 끊긴다
                drops = dict(getattr(srv, "inbound_drops", {}))
                self.assertGreaterEqual(len(results), 5)
                self.assertTrue(all(ok for ok, _ in results), "갈아타기({}) 중 기존 keep-alive 가 끊겼다: {} · {}".format(
                    mode, results, drops))
                self.assertEqual(drops.get("evicted", 0), 0, drops)


class ReclaimScoreTest(InboundCase):
    """fix2: 되찾기 판정 단위 시험(가짜 소켓) — 연결 단위 느린 누계 · 마감 직전 대체 후보 · 공격 중 유예 · 계정당 보호 개수 · 반환 대기 창."""

    class FakeSock:
        def __init__(self):
            self.shut = []

        def shutdown(self, how):
            self.shut.append(how)

    def _srv(self, n, reclaim_after=1.0):
        srv = server_mod.HubServer(("127.0.0.1", 0), server_mod.HubHandler, self.ctx,
                                   max_connections=n, max_per_client=0, reclaim_after=reclaim_after)
        self.addCleanup(srv.server_close)
        socks = [self.FakeSock() for _ in range(n)]
        now = time.monotonic()
        for i, sock in enumerate(socks):
            self.assertIsNone(srv._admit(sock, "10.0.0.%d" % i)[0])   # noqa: SLF001
            _leave(srv._admitted[sock].conn, "header", now)   # noqa: SLF001 — 첫 요청은 받았다
        return srv, socks, now

    @staticmethod
    def _seat(srv, sock):
        return srv._admitted[sock]   # noqa: SLF001

    def _add_slow(self, conn, seconds, now):
        add = getattr(conn, "add_slow", None)
        self.assertIsNotNone(add, "연결 단위 느린 단계 누계가 없다(ConnPhase.add_slow)")
        add(seconds, now)

    def test_cycling_connection_is_reclaimed_although_its_phase_just_started(self):
        """누계 0.98초 + 헤더 0.05초째인 연결은 후보다(1회차는 '지금 단계 0.05초' 만 보아 끝내 후보가 되지 않았다) ·
        쉬는 중이어도 누계가 기준을 넘으면 후보(종류 shed) · 점수가 큰 쪽 먼저 · 5초 쉰 정상 keep-alive 와 막 시작한 헤더는 남는다."""
        srv, (user, cyc, cyc_idle, fresh), now = self._srv(4)
        self.assertTrue(srv.conn_idle(user))
        self._seat(srv, user).since = now - 5
        self._add_slow(self._seat(srv, cyc).conn, 0.98, now)
        self._seat(srv, cyc).conn.enter("header", now - 0.05)
        self.assertTrue(srv.conn_idle(cyc_idle))
        self._seat(srv, cyc_idle).since = now - 0.3
        self._add_slow(self._seat(srv, cyc_idle).conn, 1.2, now - 0.3)
        self._seat(srv, fresh).conn.enter("header", now - 0.05)   # 막 시작한 헤더 — 점수 0.05
        order = []
        with srv._cond:   # noqa: SLF001
            for _ in range(3):
                kind, _ = srv._reclaim_one_locked(now, now + srv.admit_wait)   # noqa: SLF001 — 대기 막 시작
                if kind is None:
                    break
                victim = [name for name, sock in (("cyc", cyc), ("cyc_idle", cyc_idle), ("user", user), ("fresh", fresh))
                          if sock.shut and name not in [v for _, v in order]]
                order.append((kind, victim[0]))
        self.assertEqual(order, [("shed", "cyc_idle"), ("shed", "cyc")])
        self.assertEqual((user.shut, fresh.shut), ([], []))

    def test_fallback_waits_under_attack_but_not_otherwise(self):
        """공격 중(최근 느린 연결을 끊었다)이면 대기자가 reclaim_after 를 기다리기 전에는 쉬는 정상 연결을 내보내지 않는다
        (대기 줄에서 요청을 미리 흘린 공격 연결은 입장 직후 빨라 보인다). 공격이 없으면(가득 찬 정상 keep-alive) 바로 정리한다."""
        srv, (user, other), now = self._srv(2)
        for sock in (user, other):
            self.assertTrue(srv.conn_idle(sock))
        self._seat(srv, user).since = now - 5
        self._seat(srv, other).since = now - 0.2
        with srv._cond:   # noqa: SLF001
            kind, _ = srv._reclaim_one_locked(now, now + srv.admit_wait)   # noqa: SLF001
        self.assertEqual(kind, "evicted", "공격이 없는데 가득 찬 유휴 keep-alive 를 바로 정리하지 않았다")
        self.assertEqual((user.shut, other.shut), ([socket.SHUT_RDWR], []))
        srv2, (user, other), now = self._srv(2)
        for sock in (user, other):
            self.assertTrue(srv2.conn_idle(sock))
        self._seat(srv2, user).since = now - 5
        self._seat(srv2, other).since = now - 0.2
        self.assertTrue(hasattr(srv2, "_attack_seen_at"), "공격 신호(최근 느린 연결 정리)를 기록하지 않는다")
        srv2._attack_seen_at = now - 1   # noqa: SLF001
        deadline = now + srv2.admit_wait
        with srv2._cond:   # noqa: SLF001
            kind, next_at = srv2._reclaim_one_locked(now, deadline)   # noqa: SLF001
            self.assertIsNone(kind, "공격 중 대기를 시작하자마자 쉬던 정상 연결을 내보냈다")
            self.assertAlmostEqual(next_at, now + 0.8, delta=0.01)   # 다시 볼 때: other 가 1초를 쉬는 때(유예 끝 1초보다 먼저)
            kind, _ = srv2._reclaim_one_locked(now + 0.8, deadline)   # noqa: SLF001
            self.assertIsNone(kind, "유예(reclaim_after) 안에 쉬던 정상 연결을 내보냈다")
            kind, _ = srv2._reclaim_one_locked(now + srv2.reclaim_after, deadline)   # noqa: SLF001
        self.assertEqual(kind, "evicted")
        self.assertEqual((user.shut, other.shut), ([socket.SHUT_RDWR], []))
        with _capture():
            srv2.note_inbound_drop("header")
        self.assertGreater(srv2._attack_seen_at, now)   # noqa: SLF001 — 단계 시한 초과도 공격 신호

    def test_overwritten_phase_still_counts(self):
        """반증 3회차 R3-1: 닫히지 않은 쌓이는 단계를 다른 단계(또는 같은 단계)로 덮어써도 그 진행분은 누계에 남는다.
        'Expect: 100-continue' 는 헤더를 다 읽은 뒤 100 을 쓰며 'write' 를 열어 헤더 단계를 덮었다 → 뒤의 leave('header') 는 무시 → 누계 0."""
        from hub.inbound import ConnPhase
        c = ConnPhase(half_life=0)
        t = 200.0
        c.enter("header", t)
        c.enter("write", t + 0.6)                  # 덮어쓰기 — 헤더 0.6초가 남아야 한다
        self.assertAlmostEqual(c.slow_score(t + 0.6, current=False), 0.6, delta=1e-6, msg="덮어쓴 헤더 단계가 누계에서 빠졌다")
        c.leave("header", t + 0.65)                # 이미 덮인 단계 — 아무것도 안 한다(이중으로 세지 않음)
        self.assertAlmostEqual(c.slow_score(t + 0.65), 0.6 + 0.05, delta=1e-6)
        c.leave("write", t + 0.7)
        self.assertAlmostEqual(c.slow_score(t + 0.7), 0.7, delta=1e-6)
        c.enter("body", t + 1.0)
        c.enter("body", t + 1.3)                   # 같은 단계를 닫지 않고 다시 열어도 앞 구간을 잃지 않는다
        c.leave("body", t + 1.4)
        self.assertAlmostEqual(c.slow_score(t + 1.4), 1.1, delta=1e-6)
        c.enter("linger", t + 2.0)
        c.enter("header", t + 5.0)                 # 린저(쌓지 않는 단계)를 덮어쓰면 더하지 않는다
        self.assertAlmostEqual(c.slow_score(t + 5.0), 1.1, delta=1e-6, msg="린저를 쌓았다")
        c.leave("header", t + 5.0)
        c.trusted = True
        c.enter("body", t + 6.0)
        c.enter("write", t + 9.0)                  # 로그인 세션의 본문은 덮어써도 쌓지 않는다
        self.assertAlmostEqual(c.slow_score(t + 9.0), 1.1, delta=1e-6, msg="로그인 세션 본문을 쌓았다")

    def test_expect_100_header_drip_counts_on_a_real_socket(self):
        """반증 3회차 R3-1(실소켓): 같은 헤더를 0.6초 흘린 뒤 연결 누계 — Expect 가 있어도 없을 때와 같게 쌓인다(수정 전 0.0)."""
        with _capture():
            srv, port = self._server(header=2.0, max_connections=4)
            scores = {}
            for expect in (False, True):
                s = _open(port)
                self.addCleanup(s.close)
                req = _GET_EXPECT if expect else _GET
                for i in range(len(req)):
                    s.sendall(req[i:i + 1])
                    time.sleep(0.6 / len(req))
                self.assertTrue(_read_final(s).startswith("HTTP/1.1 200"), expect)
                time.sleep(0.1)
                with srv._cond:
                    seats = list(srv._admitted.values())
                self.assertEqual(len(seats), 1, seats)
                scores[expect] = seats[0].conn.slow_score(time.monotonic(), current=False)
                s.close()
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    with srv._cond:
                        if not srv._admitted:
                            break
                    time.sleep(0.02)
            self.assertGreater(scores[False], 0.4, scores)
            self.assertGreater(scores[True], 0.4, "Expect: 100-continue 로 헤더 드립이 누계에서 빠졌다: {}".format(scores))

    def test_trusted_exemption_is_capped_per_account(self):
        """반증 2회차 S: 로그인 세션의 본문 · 쓰기 제외는 계정당 2개까지(오래 진행한 것 보호) — viewer 하나로 64칸을 못 쥔다.
        넘는 것은 진행분이 큰 순으로 되찾는다."""
        from hub.inbound import ConnPhase
        self.assertIn("user", getattr(ConnPhase, "__slots__", ()), "로그인 세션의 계정을 적지 않는다 — 계정당 보호 개수를 셀 수 없다")
        srv, socks, now = self._srv(6)
        plan = [("viewer", "body", 9), ("viewer", "write", 8), ("viewer", "body", 7), ("viewer", "body", 6),
                ("admin", "body", 9), ("admin", "write", 1)]
        for sock, (user, phase, ago) in zip(socks, plan):
            conn = self._seat(srv, sock).conn
            conn.trusted = True
            conn.user = user
            conn.enter(phase, now - ago)
        shed = []
        with srv._cond:   # noqa: SLF001
            for _ in range(4):
                kind, _ = srv._reclaim_one_locked(now, now + 1.0)   # noqa: SLF001
                if kind is None:
                    break
                shed.extend(i for i, s in enumerate(socks) if s.shut and i not in shed)
        self.assertEqual(shed, [2, 3], "계정당 보호 개수를 넘는 로그인 세션 업로드를 되찾지 않았거나 순서가 틀렸다")

    def test_reclaim_pending_window_follows_reclaim_after(self):
        """반증 2회차 nit: 되찾기 반환 대기 창은 min(1초, reclaim_after) — 축소 비율(0.4초)에서도 비율이 맞는다(운영 5초 → 1초 그대로)."""
        for reclaim_after, inside, outside in ((0.4, 0.3, 0.45), (5.0, 0.9, 1.1)):
            srv, (a, _b), now = self._srv(2, reclaim_after=reclaim_after)
            seat = self._seat(srv, a)
            seat.state = "evicted"
            seat.reclaimed_at = now
            with srv._cond:   # noqa: SLF001
                self.assertTrue(srv._reclaim_pending_locked(now + inside), reclaim_after)   # noqa: SLF001
                self.assertFalse(srv._reclaim_pending_locked(now + outside), reclaim_after)   # noqa: SLF001

    def test_new_seat_waits_for_the_header_from_admission(self):
        """새 자리는 입장 시각부터 헤더 단계다 — 스레드 시작 지연 동안 '처리 중' 으로 보여 되찾기 예측에서 빠지지 않게."""
        srv = server_mod.HubServer(("127.0.0.1", 0), server_mod.HubHandler, self.ctx, max_connections=2, max_per_client=0)
        self.addCleanup(srv.server_close)
        sock = self.FakeSock()
        srv._admit(sock, "10.0.0.1")   # noqa: SLF001
        seat = self._seat(srv, sock)
        self.assertEqual((seat.conn.phase, seat.conn.started), ("header", seat.since))

    def test_header_deadline_counts_from_admission_despite_thread_lag(self):
        """스레드가 0.6초 늦게 시작해도 아무것도 안 보내는 새 연결은 입장부터 헤더 시한(1초)에 끊긴다(1회차: 약 1.6초)."""
        class Lagging(server_mod.HubHandler):
            def setup(self):
                time.sleep(0.6)
                super().setup()

        with _capture():
            srv, port = self._server(header=1.0, handler=Lagging)
            sock = _open(port)
            self.addCleanup(sock.close)
            got, closed = _closed_within(sock, 3.0)
        self.assertEqual(got, b"")
        self.assertIsNotNone(closed)
        self.assertLess(closed, 1.35, "헤더 시한을 스레드 시작부터 셌다(입장 시각이 아니라)")


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

    def test_phase_writer(self):
        """fix1 M1(a): 쓰기 단계 — 첫 write 에 auto 로 열림 · 조각 단위 · 끝나면 소켓 시한은 유휴 값 · 최저 속도 미만이면 시한 ·
        되찾긴 연결(shed)의 쓰기 오류는 InboundDeadline('shed') · 그 밖의 OSError 는 그대로 · 단계 추적(ConnPhase)."""
        from hub.inbound import ConnPhase, InboundDeadline, PhaseWriter, write_chunk_size

        class FakeSock:
            def __init__(self, per_byte=0.0, fail=None):
                self.timeout = 7.0
                self.timeouts = []
                self.chunks = []
                self.per_byte = per_byte
                self.fail = fail

            def settimeout(self, value):
                self.timeout = value
                self.timeouts.append(value)

            def fileno(self):
                return -1   # 송신 큐를 못 읽는 소켓 — 보낸 바이트로 센다

            def sendall(self, data):
                if self.fail:
                    raise self.fail
                need = len(data) * self.per_byte
                if need > self.timeout:
                    time.sleep(self.timeout)
                    raise socket.timeout("timed out")
                time.sleep(need)
                self.chunks.append(len(data))

        self.assertEqual(write_chunk_size(10.0, 16384), 40960)
        self.assertEqual(write_chunk_size(0.5, 1024), 512)
        self.assertEqual(write_chunk_size(100.0, 10 ** 8), 65536)
        self.assertEqual(write_chunk_size(2.0, 0), 65536)
        fast = FakeSock()
        tracker = ConnPhase()
        tx = PhaseWriter(fast, 7.0, tracker=tracker, auto=(1.0, 16384, 30.0))
        self.assertEqual(tx.write(b"a" * 20000), 20000)
        self.assertEqual(tracker.phase, "write")
        self.assertTrue(all(n <= write_chunk_size(1.0, 16384) for n in fast.chunks))
        self.assertEqual(sum(fast.chunks), 20000)
        self.assertEqual(fast.timeout, 7.0, "쓰기 단계 잔여 시한이 소켓에 남았다")
        tx.end()
        self.assertIsNone(tracker.phase)
        # 최저 속도(16384B/s)의 1/4 로 받는 상대 — base 0.3초 + 받은 바이트/최저 속도 안에서 끊긴다
        slow = FakeSock(per_byte=1 / 4096)
        tx = PhaseWriter(slow, 7.0, auto=(0.3, 16384, 30.0))
        t0 = time.monotonic()
        with self.assertRaises(InboundDeadline) as caught:
            tx.write(b"b" * 200000)
        self.assertEqual(caught.exception.phase, "write")
        self.assertLess(time.monotonic() - t0, 1.5)
        self.assertEqual(slow.timeout, 7.0)
        # 최저 속도의 4배 — base(0.3초)보다 오래 걸려도 끝까지 보낸다(허용 시간이 받은 바이트만큼 는다)
        ok = FakeSock(per_byte=1 / 65536)
        tx = PhaseWriter(ok, 7.0, auto=(0.3, 16384, 30.0))
        t0 = time.monotonic()
        tx.write(b"c" * 40000)
        self.assertGreater(time.monotonic() - t0, 0.5)
        self.assertEqual(sum(ok.chunks), 40000)
        # 되찾긴 연결 — 보내기 전에 표시됐으면 보내지 않고, 보내는 도중 되찾겨 깨진 파이프가 나도 'shed' 로 접는다
        shed = ConnPhase()
        shed.shed = True
        before = FakeSock()
        tx = PhaseWriter(before, 7.0, tracker=shed, auto=(1.0, 16384, 30.0))
        with self.assertRaises(InboundDeadline) as caught:
            tx.write(b"d")
        self.assertEqual(caught.exception.phase, "shed")
        self.assertEqual(before.chunks, [])
        during = ConnPhase()

        class ShedDuringSend(FakeSock):
            def sendall(self, data):
                during.shed = True   # 서버가 되찾으며 shutdown → 보내던 sendall 이 깨진 파이프
                raise BrokenPipeError(32, "Broken pipe")

        tx = PhaseWriter(ShedDuringSend(), 7.0, tracker=during, auto=(1.0, 16384, 30.0))
        with self.assertRaises(InboundDeadline) as caught:
            tx.write(b"d")
        self.assertEqual(caught.exception.phase, "shed")
        tx = PhaseWriter(FakeSock(fail=BrokenPipeError(32, "Broken pipe")), 7.0, tracker=ConnPhase(), auto=(1.0, 16384, 30.0))
        with self.assertRaises(BrokenPipeError):
            tx.write(b"e")
        # auto 없음 = 예전 동작(단계 없이 그대로 보낸다)
        plain = FakeSock()
        self.assertEqual(PhaseWriter(plain, 7.0).write(b"f" * 100000), 100000)
        self.assertEqual(plain.chunks, [100000])
        self.assertEqual(plain.timeouts, [])

    @unittest.skipUnless(sys.platform.startswith("linux"), "리눅스 송신 큐(TIOCOUTQ)")
    def test_write_allowance_counts_acknowledged_bytes_only(self):
        """fix1: 허용 시간은 상대가 받은 바이트로만 는다 — 읽지 않는 상대에게 커널 버퍼에 넣은 바이트를 쳐주지 않는다."""
        from hub.inbound import PhaseWriter, unacked_bytes
        srv = socket.create_server(("127.0.0.1", 0))
        self.addCleanup(srv.close)
        cli = socket.socket()
        cli.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024)
        self.addCleanup(cli.close)
        cli.connect(srv.getsockname())
        conn, _ = srv.accept()
        self.addCleanup(conn.close)
        conn.settimeout(5.0)
        self.assertEqual(unacked_bytes(conn), 0)
        tx = PhaseWriter(conn, 5.0, auto=(0.4, 16384, 300.0))
        t0 = time.monotonic()
        with self.assertRaises(Exception) as caught:
            tx.write(b"g" * 4_000_000)
        self.assertEqual(getattr(caught.exception, "phase", None), "write", caught.exception)
        self.assertLess(time.monotonic() - t0, 2.0, "버퍼에 넣은 바이트로 허용 시간이 늘었다")
        self.assertGreater(tx.sent, 16384 * 2, "커널 버퍼가 시험 조건보다 작다(시험 무효)")
        self.assertLess(tx.delivered(), tx.sent)

    def test_conn_phase_slow_score(self):
        """fix2(반증 2회차 R2-1): 연결 단위 느린 누계 — 헤더 · 본문 · 쓰기를 단계가 바뀌어도 이어 쌓고, 반감기로 줄인다.
        로그인 세션의 본문 · 쓰기 · 린저 · 유휴는 쌓지 않는다(헤더는 로그인 여부를 아직 모르니 쌓는다). 리더 · 라이터가 단계를 닫으면 더한다."""
        from hub.inbound import ConnPhase, PhaseReader
        self.assertTrue(hasattr(ConnPhase, "slow_score"), "연결 단위 느린 누계가 없다 — 단계를 갈아타면 매번 0 부터")
        c = ConnPhase(half_life=0)   # 먼저 줄이지 않고 쌓이는지만
        t = 100.0
        for phase, start, end in (("header", 0.0, 0.4), ("body", 0.4, 0.8), ("write", 0.8, 0.9)):
            c.enter(phase, t + start)
            self.assertAlmostEqual(c.slow_score(t + end), start + (end - start), delta=1e-6, msg=phase)
            c.leave(phase, t + end)
        self.assertAlmostEqual(c.slow_score(t + 0.9), 0.9, delta=1e-6, msg="단계가 바뀌어도 이어 쌓는다")
        c.half_life = 4.0
        self.assertAlmostEqual(c.slow_score(t + 4.9), 0.45, delta=1e-6, msg="반감기 4초")
        c.enter("linger", t + 5)
        c.leave("linger", t + 9)
        self.assertAlmostEqual(c.slow_score(t + 8.9), 0.225, delta=0.01, msg="린저는 쌓지 않는다")
        c.enter("header", t + 9)
        self.assertAlmostEqual(c.slow_score(t + 9.5, current=False), c.slow_score(t + 9.5) - 0.5, delta=1e-9)
        c.leave("header", t + 9.5)
        c.trusted = True
        before = c.slow_score(t + 10)
        for phase in ("body", "write"):
            c.enter(phase, t + 10)
            self.assertAlmostEqual(c.slow_score(t + 13), before * 2 ** (-3 / 4.0), delta=0.01, msg=phase)
            c.leave(phase, t + 13)
        self.assertAlmostEqual(c.slow_score(t + 13), before * 2 ** (-3 / 4.0), delta=0.01, msg="로그인 세션의 본문 · 쓰기를 쌓았다")
        c.enter("header", t + 13)
        c.leave("header", t + 14)
        self.assertAlmostEqual(c.slow_score(t + 14), before * 2 ** (-4 / 4.0) + 1.0, delta=0.02, msg="헤더는 로그인 세션도 쌓는다")
        c.leave("header", t + 20)   # 단계가 다르면(이미 닫힘) 아무것도 안 한다
        self.assertAlmostEqual(c.slow_score(t + 14), before * 2 ** (-4 / 4.0) + 1.0, delta=0.02)
        # 리더가 단계를 닫으면 tracker 에 더한다(리더 시계)
        clock = [50.0]
        a, b = socket.socketpair()
        self.addCleanup(a.close)
        self.addCleanup(b.close)
        tracker = ConnPhase(half_life=0)
        rx = PhaseReader(a, 5.0, clock=lambda: clock[0], tracker=tracker)
        rx.begin("header", 10.0)
        clock[0] = 52.5
        rx.end()
        self.assertAlmostEqual(tracker.slow_score(52.5), 2.5)
        rx.begin("header", 10.0, started=40.0)   # 새 연결의 첫 헤더 — 입장 시각부터
        self.assertEqual(tracker.started, 40.0)
        self.assertAlmostEqual(rx.remaining(), 40.0 + 10.0 - 52.5)

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
        keys = ("HUB_HEADER_TIMEOUT", "HUB_BODY_MIN_RATE", "HUB_BODY_TIMEOUT_MAX", "HUB_PREAUTH_MAX_BODY")
        clean = {k: v for k, v in os.environ.items() if k not in keys}
        with mock.patch.dict(os.environ, clean, clear=True):
            c = config_mod.Config()
            self.assertEqual((c.header_timeout, c.body_min_rate, c.body_timeout_max), (10.0, 16384, 300.0))
            self.assertEqual(c.preauth_max_body, 65536)
        with mock.patch.dict(os.environ, {"HUB_HEADER_TIMEOUT": "0", "HUB_BODY_MIN_RATE": "1", "HUB_BODY_TIMEOUT_MAX": "99999"}):
            c = config_mod.Config()
            self.assertEqual((c.header_timeout, c.body_min_rate, c.body_timeout_max), (1.0, 1024, 3600.0))
        with mock.patch.dict(os.environ, {"HUB_HEADER_TIMEOUT": "abc"}):
            self.assertEqual(config_mod.Config().header_timeout, 10.0)
        with mock.patch.dict(os.environ, {"HUB_PREAUTH_MAX_BODY": "1"}):
            self.assertEqual(config_mod.Config().preauth_max_body, 4096)
        srv = server_mod.HubServer(("127.0.0.1", 0), server_mod.HubHandler, None, max_per_client=0, header_timeout=10.0)
        self.addCleanup(srv.server_close)
        self.assertEqual((srv.admit_wait, srv.reclaim_after), (10.0, 5.0), "되찾기는 대기 상한의 절반(막 쥔 자리만 있어도 대기 중에 하나는 되찾는다)")

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
