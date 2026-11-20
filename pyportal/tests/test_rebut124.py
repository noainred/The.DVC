"""전체 점검 124회차 — 117회차(서비스 허브 3차) 수정 반증 회귀.

R1 걸려 있는 출발지 잠금이 '늦게 끝난 성공' 한 번으로 풀렸다 — 잠금 검사는 인증(PBKDF2) 앞에 있어, 오답들과 함께 보낸 자기 계정 로그인이
   잠금 뒤에 끝나면 note_success 가 잠금 항목을 통째로 지웠다(117회차 F2 가 막으려던 '자기 계정 하나로 잠금 없이 대입' 의 동시 요청판)
R2 어느 계정이든 로그인에 성공하면 전역 실패 창이 통째로 비워져, 출발지를 바꿔 가며 틀리는 사이에 유효 계정 하나가 주기적으로 로그인하면
   전역 잠금이 걸리지 않았다(117회차가 '남긴 것' 으로 적은 줄 — F2 의 전역판)
D1 출발지(IP)당 동시 연결 상한(117회차 결정 D1 → 구현): 한 출발지가 헤더를 흘리는 연결로 전체 연결 상한을 다 쥐지 못한다
"""

import socket
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from hub import server as server_mod  # noqa: E402
from hub.auth import SessionStore  # noqa: E402
from test_api import ServerCase, request  # noqa: E402


class LockSurvivesLateSuccessTest(unittest.TestCase):
    """R1: 걸려 있는 잠금은 성공으로 풀리지 않는다."""

    def test_success_after_lock_keeps_the_lock(self):
        s = SessionStore(600, 3, 300)
        for _ in range(3):
            s.note_failure("10.1.1.1", "admin")
        self.assertGreater(s.lock_remaining("10.1.1.1"), 0)
        s.note_success("10.1.1.1", "viewer1")   # 잠금 전에 검사를 통과한 요청이 잠금 뒤에 끝났다
        self.assertGreater(s.lock_remaining("10.1.1.1"), 290, "늦게 끝난 성공이 잠금을 풀었다")
        s.note_success("10.1.1.1")              # 계정을 모르는 예전 호출도 잠금은 남긴다
        self.assertGreater(s.lock_remaining("10.1.1.1"), 290)

    def test_expired_lock_entry_is_still_dropped(self):
        s = SessionStore(600, 3, 300)
        for _ in range(3):
            s.note_failure("10.1.1.2", "admin")
        s._fails["10.1.1.2"][1] = time.time() - 1   # noqa: SLF001 — 잠금이 끝난 뒤
        s.note_success("10.1.1.2", "viewer1")
        self.assertNotIn("10.1.1.2", s._fails)      # noqa: SLF001 — 끝난 잠금 항목은 남기지 않는다(메모리)

    def test_own_typos_are_still_cleared(self):
        s = SessionStore(600, 3, 300)
        for _ in range(4):
            s.note_failure("10.1.1.3", "kim")
            s.note_failure("10.1.1.3", "kim")
            s.note_success("10.1.1.3", "kim")
        self.assertEqual(s.lock_remaining("10.1.1.3"), 0)
        self.assertNotIn("10.1.1.3", s._fails)      # noqa: SLF001


class GlobalCounterPerAccountTest(unittest.TestCase):
    """R2: 전역 창도 그 계정의 실패만 뺀다."""

    def test_periodic_valid_login_does_not_reset_the_global_window(self):
        s = SessionStore(600, 8, 300)
        threshold = 8 * SessionStore.GLOBAL_FACTOR
        locked_at = None
        for i in range(threshold * 3):
            s.note_failure(f"10.2.{i // 250}.{i % 250}", "admin")   # 출발지마다 1회 — 출발지별 잠금에는 닿지 않는다
            if i % 20 == 19:
                s.note_success("10.9.9.9", "viewer1")               # 공격자의 자기 계정
            if s.lock_remaining("10.250.0.1"):
                locked_at = i + 1
                break
        self.assertEqual(locked_at, threshold, "다른 계정의 성공이 전역 창을 비웠다")

    def test_success_removes_only_that_accounts_failures(self):
        s = SessionStore(600, 8, 300)
        for i in range(3):
            s.note_failure(f"10.3.0.{i}", " Kim ")
        for i in range(2):
            s.note_failure(f"10.3.1.{i}", "admin")
        s.note_success("10.3.9.9", "kim")
        self.assertEqual([item[1] for item in s._global_fails], ["admin", "admin"])   # noqa: SLF001
        s.note_success("10.3.9.9")   # 계정을 모르는 예전 호출 — 전부(예전 동작)
        self.assertEqual(len(s._global_fails), 0)   # noqa: SLF001

    def test_window_still_expires(self):
        s = SessionStore(600, 8, 300)
        real = time.time()
        with mock.patch("hub.auth.time.time", return_value=real - 5000):
            for i in range(30):
                s.note_failure(f"10.4.0.{i}", "admin")
        s.note_failure("10.4.1.1", "admin")
        self.assertEqual(len(s._global_fails), 1, "창 밖 실패가 남았다")   # noqa: SLF001


class LateSuccessHttpTest(ServerCase):
    """R1(HTTP): 오답과 함께 보낸 자기 계정 로그인이 잠금 뒤에 끝나도 잠금이 남는다."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.ctx.users.add("viewer1", "viewer", "viewer-password-1")

    def setUp(self):
        self.ctx.sessions._fails.clear()          # noqa: SLF001
        self.ctx.sessions._fail_names.clear()     # noqa: SLF001
        self.ctx.sessions._global_fails.clear()   # noqa: SLF001

    def test_concurrent_own_login_cannot_lift_the_lock(self):
        gate = threading.Event()
        entered = threading.Event()
        real = self.ctx.users.authenticate

        def slow(username, password):
            user = real(username, password)
            if username == "viewer1":
                entered.set()
                gate.wait(10)   # 잠금 검사는 이미 지났다 — 오답들이 잠금을 건 뒤에 끝난다
            return user

        codes = {}
        with mock.patch.object(self.ctx.sessions, "_max_fails", 3), mock.patch.object(self.ctx.users, "authenticate", slow):
            t = threading.Thread(target=lambda: codes.__setitem__("own", request(
                self.url + "/api/settings/session", "POST", {"username": "viewer1", "password": "viewer-password-1"})[0]))
            t.start()
            self.assertTrue(entered.wait(10))
            wrong = [request(self.url + "/api/settings/session", "POST", {"username": "admin", "password": f"wrong-{i}"})[0] for i in range(3)]
            # 131회차: 진행 중인 자기 계정 로그인도 한 자리를 쥔다(잠금 검사와 실패 기록 사이의 동시 요청은 임계까지만 받는다) —
            #   세 번째 오답은 평가되지 않고(429 · 실패로 세지 않는다), 자기 계정 성공 뒤의 오답이 3회째가 되어 잠근다. 성공은 admin 오답 2회를 지우지 못했다.
            self.assertEqual(wrong, [401, 401, 429])
            gate.set()
            t.join(10)
            self.assertEqual(codes.get("own"), 200)
            code, payload, _ = request(self.url + "/api/settings/session", "POST", {"username": "admin", "password": "wrong-3"})
            self.assertEqual(code, 401, payload)
            code, payload, _ = request(self.url + "/api/settings/session", "POST", {"username": "admin", "password": "wrong-4"})
            self.assertEqual(code, 429, payload)


def _open(port, source=None):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(5)
    if source:
        sock.bind((source, 0))
    sock.connect(("127.0.0.1", port))
    return sock


def _get_meta(port, source=None):
    """GET /api/meta 한 번 — 상태줄(없으면 '' — 서버가 응답 없이 끊음)."""
    sock = _open(port, source)
    try:
        sock.sendall(b"GET /api/meta HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
        data = b""
        try:
            while True:   # 끝까지 읽는다(Connection: close) — 중간에 닫으면 서버 쪽에 BrokenPipe 흔적이 남는다
                chunk = sock.recv(4096)
                if not chunk:
                    break
                data += chunk
        except (ConnectionError, socket.timeout):
            pass
        return data.split(b"\r\n", 1)[0].decode("latin-1")
    finally:
        sock.close()


class PerClientConnectionCapTest(ServerCase):
    """D1: 출발지당 동시 연결 상한 — 한 출발지가 헤더를 흘리는 연결로 자리를 다 쥐지 못한다."""

    def _server(self, per_client):
        srv = server_mod.HubServer(("127.0.0.1", 0), server_mod.HubHandler, self.ctx, max_per_client=per_client)
        thread = threading.Thread(target=srv.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        return srv, srv.server_address[1]

    def _hold(self, port, count):
        held = []
        for _ in range(count):
            sock = _open(port)
            sock.sendall(b"GET /api/meta HTTP/1.1\r\nHost: x\r\nX-Drip: ")   # 헤더를 끝내지 않는다
            held.append(sock)
            self.addCleanup(sock.close)
        return held

    def _wait_count(self, srv, client, want):
        deadline = time.time() + 5
        while time.time() < deadline:
            if srv._per_client.get(client, 0) == want:   # noqa: SLF001
                return True
            time.sleep(0.02)
        return False

    def test_one_source_cannot_take_every_slot(self):
        srv, port = self._server(3)
        held = self._hold(port, 3)
        self.assertTrue(self._wait_count(srv, "127.0.0.1", 3))
        self.assertEqual(_get_meta(port), "", "상한을 넘은 같은 출발지의 연결이 응답을 받았다")
        try:
            other = _get_meta(port, source="127.0.0.2")
        except OSError:
            other = None   # 127.0.0.2 로 나갈 수 없는 환경 — 다른 출발지 확인은 건너뛴다
        if other is not None:
            self.assertIn(" 200 ", other, "다른 출발지는 계속 붙어야 한다")
        held[0].close()
        self.assertTrue(self._wait_count(srv, "127.0.0.1", 2), "닫힌 연결의 자리가 돌아오지 않았다")
        self.assertIn(" 200 ", _get_meta(port))
        for sock in held[1:]:
            sock.close()
        self.assertTrue(self._wait_count(srv, "127.0.0.1", 0))
        self.assertEqual(srv._per_client, {}, "끝난 출발지의 집계가 남았다")   # noqa: SLF001

    def test_zero_turns_the_cap_off(self):
        srv, port = self._server(0)
        self._hold(port, 5)
        self.assertIn(" 200 ", _get_meta(port))
        self.assertEqual(srv._per_client, {})   # noqa: SLF001

    def test_default_comes_from_config(self):
        from hub.config import config
        self.assertEqual(config.max_conn_per_client, 48)
        self.assertEqual(self.server._per_client_max, 48)   # noqa: SLF001
        self.assertLess(self.server._per_client_max, 64, "출발지 상한이 전체 상한과 같으면 한 출발지가 다 쥔다")   # noqa: SLF001


if __name__ == "__main__":
    unittest.main()
