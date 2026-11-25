"""전체 점검 131회차 — 124회차(117회차 반증) 수정을 다시 깨뜨려 본 회귀.

C1 잠금 검사는 인증(PBKDF2) 앞에 있고 실패는 인증 뒤에 기록된다 — 그 사이에 들어온 **동시 요청**은 전부 검사를 지났다(재현: 임계 8 · 한 출발지의 동시 오답 40건 →
   33~38건이 평가됨). 잠금 한 번에 임계의 몇 배를 대입할 수 있었고, 임계가 낮으면(3 → 전역 임계 30) 한 출발지의 한 번으로 전역 잠금이 걸려 모든 출발지가 잠겼다.
   124회차 R1 은 '늦게 끝난 성공이 잠금을 푸는 것' 만 막았다(같은 틈의 다른 쪽). → 잠금 검사와 함께 진행 중인 시도를 예약한다(SessionStore.begin_attempt/end_attempt).
C2 잠금 끝 · 실패 창이 벽시계(time.time) 기준이라, 시계가 뒤로 가면(NTP 보정 · RTC 가 로컬 시각이던 장비의 첫 동기화) 잠금 300초가 그 차만큼 늘어났다
   (9시간 뒤로 = 9시간 5분 · 전역 잠금이면 모든 출발지) · 그동안의 실패도 창에서 빠지지 않았다. → 잠금 끝은 '지금 + 잠금 시간' 을 넘지 못한다(다시 잡는다 — 풀지는 않는다).
"""

import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from hub.auth import SessionStore  # noqa: E402
from test_api import ServerCase, request  # noqa: E402


class AttemptReservationTest(unittest.TestCase):
    """C1(저장소): (창 안 실패 수 + 진행 중인 시도 수)가 임계에 닿으면 더 받지 않는다."""

    def test_admits_at_most_the_limit_and_frees_on_end(self):
        s = SessionStore(600, 3, 300)
        self.assertEqual([s.begin_attempt("10.3.1.1") for _ in range(5)], [0, 0, 0, -1, -1])
        self.assertEqual(s.begin_attempt("10.3.1.2"), 0, "다른 출발지는 무관하다")
        self.assertEqual(s.lock_remaining("10.3.1.1"), 0, "진행 중인 시도는 잠금이 아니다(실패로 세지 않는다)")
        s.end_attempt("10.3.1.1")
        self.assertEqual([s.begin_attempt("10.3.1.1") for _ in range(2)], [0, -1], "끝난 만큼만 다시 받는다")

    def test_recorded_failures_use_up_the_room(self):
        s = SessionStore(600, 3, 300)
        c = "10.3.1.3"
        s.note_failure(c, "admin")
        s.note_failure(c, "admin")
        self.assertEqual([s.begin_attempt(c) for _ in range(2)], [0, -1], "실패 2회 뒤에는 한 건만 받는다")
        s.note_failure(c, "admin")   # 그 한 건도 오답 — 3회째로 잠긴다
        s.end_attempt(c)
        self.assertGreater(s.begin_attempt(c), 290, "잠금 동안은 남은 초를 돌려준다")
        self.assertEqual(s._pending, {})   # noqa: SLF001 — 거절된 시도는 예약되지 않는다

    def test_success_frees_the_room_for_that_account(self):
        s = SessionStore(600, 3, 300)
        c = "10.3.1.4"
        s.note_failure(c, "kim")
        s.note_failure(c, "kim")
        self.assertEqual(s.begin_attempt(c), 0)
        s.note_success(c, "kim")   # 자기 오타 2회는 성공으로 지워진다(117회차 F2)
        s.end_attempt(c)
        self.assertEqual([s.begin_attempt(c) for _ in range(4)], [0, 0, 0, -1])

    def test_failures_outside_the_window_do_not_count(self):
        s = SessionStore(600, 3, 300)
        c = "10.3.1.5"
        s.note_failure(c, "admin")
        s.note_failure(c, "admin")
        s._fails[c][2] = time.time() - s._fail_window() - 5   # noqa: SLF001 — 창이 지난 실패(31회차 F6)
        self.assertEqual([s.begin_attempt(c) for _ in range(4)], [0, 0, 0, -1])

    def test_pending_entries_are_dropped_at_zero(self):
        s = SessionStore(600, 3, 300)
        for i in range(40):
            self.assertEqual(s.begin_attempt(f"10.3.9.{i}"), 0)
            s.end_attempt(f"10.3.9.{i}")
        s.end_attempt("10.3.9.200")   # 짝 없는 end — 음수로 내려가 자리를 늘리지 않는다
        self.assertEqual(s._pending, {})   # noqa: SLF001
        self.assertEqual([s.begin_attempt("10.3.9.200") for _ in range(4)], [0, 0, 0, -1])


class ConcurrentGuessCapTest(ServerCase):
    """C1(HTTP): 한 출발지의 동시 오답은 임계까지만 평가되고, 그 한 번으로 다른 출발지가 잠기지 않는다."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.ctx.users.add("viewer131", "viewer", "viewer-password-131")

    def setUp(self):
        self._clear()

    def tearDown(self):
        self._clear()

    def _clear(self):
        s = self.ctx.sessions
        s._fails.clear()          # noqa: SLF001
        s._fail_names.clear()     # noqa: SLF001
        s._global_fails.clear()   # noqa: SLF001
        s._global_until = 0.0     # noqa: SLF001

    def _login_url(self):
        return self.url + "/api/settings/session"

    def test_concurrent_wrong_logins_are_not_evaluated_past_the_limit(self):
        total = 40
        gate = threading.Event()
        guard = threading.Lock()
        entered = []
        codes = []
        real = self.ctx.users.authenticate

        def slow(username, password):
            with guard:
                entered.append(username)
            gate.wait(15)   # 잠금 검사는 이미 지났다 — 실패 기록은 아직이다
            return real(username, password)

        def one(i):
            try:
                code = request(self._login_url(), "POST", {"username": "admin", "password": f"wrong-{i}"})[0]
            except Exception as exc:  # noqa: BLE001 — 연결 오류도 결과로 센다
                code = type(exc).__name__
            with guard:
                codes.append(code)

        with mock.patch.object(self.ctx.sessions, "_max_fails", 3), mock.patch.object(self.ctx.users, "authenticate", slow):
            threads = [threading.Thread(target=one, args=(i,)) for i in range(total)]
            for t in threads:
                t.start()
            deadline = time.time() + 12
            while time.time() < deadline:   # 40건 모두 '인증에 들어갔거나 응답을 받았거나'
                with guard:
                    if len(entered) + len(codes) >= total:
                        break
                time.sleep(0.02)
            with guard:
                in_flight = len(entered)
            gate.set()
            for t in threads:
                t.join(15)
            self.assertLessEqual(in_flight, 3, f"임계 3인데 동시 오답 {in_flight}건이 인증까지 갔다(잠금 검사와 실패 기록 사이의 틈)")
            self.assertEqual(sorted(str(c) for c in codes), ["401"] * 3 + ["429"] * (total - 3))
            self.assertEqual(len(self.ctx.sessions._global_fails), 3, "평가되지 않은 요청은 실패로 세지 않는다")   # noqa: SLF001
            self.assertEqual(self.ctx.sessions._pending, {}, "예약이 남았다")   # noqa: SLF001
            self.assertGreater(self.ctx.sessions.lock_remaining("127.0.0.1"), 0, "임계에 닿은 출발지는 잠긴다")
            self.assertEqual(self.ctx.sessions.lock_remaining("10.200.0.9"), 0,
                             "한 출발지의 동시 오답 한 번으로 전역 잠금이 걸렸다(전역 임계 30 · 다른 출발지까지 잠김)")

    def test_reservation_is_returned_on_every_exit(self):
        s = self.ctx.sessions
        # 본문 오류(JSON 아님) → 400 — 예약이 남으면 그 출발지는 임계만큼 쌓인 뒤 영영 429 다
        import urllib.error
        import urllib.request
        for _ in range(12):
            req = urllib.request.Request(self._login_url(), data=b"{not json", method="POST",
                                         headers={"Content-Type": "application/json"})
            try:
                urllib.request.urlopen(req, timeout=8).close()
                code = 200
            except urllib.error.HTTPError as exc:
                code = exc.code
                exc.close()
            self.assertEqual(code, 400)
        self.assertEqual(s._pending, {})   # noqa: SLF001
        # 인증 함수가 던져도(500) 돌려준다
        import contextlib
        import io
        with mock.patch.object(self.ctx.users, "authenticate", side_effect=RuntimeError("probe")), \
                contextlib.redirect_stderr(io.StringIO()):   # 서버가 500 의 traceback 을 stderr 에 찍는다 — 시험 출력에 싣지 않는다
            for _ in range(12):
                code = request(self._login_url(), "POST", {"username": "admin", "password": "x"})[0]
                self.assertEqual(code, 500)
        self.assertEqual(s._pending, {})   # noqa: SLF001
        # 성공 · 실패 · 현재 비밀번호 확인(없음 400 · 오답 403)
        self.assertEqual(request(self._login_url(), "POST", {"username": "admin", "password": "nope"})[0], 401)
        code, payload, _ = request(self._login_url(), "POST", {"username": "viewer131", "password": "viewer-password-131"})
        self.assertEqual(code, 200, payload)
        tok = {"X-Settings-Token": payload["token"]}
        url = self.url + "/api/settings/users/viewer131/password"
        self.assertEqual(request(url, "POST", {"password": "new-pass-131-a"}, tok)[0], 400)
        self.assertEqual(request(url, "POST", {"password": "new-pass-131-a", "currentPassword": "wrong"}, tok)[0], 403)
        self.assertEqual(s._pending, {})   # noqa: SLF001
        self.assertEqual(request(self._login_url(), "POST", {"username": "viewer131", "password": "viewer-password-131"})[0], 200,
                         "예약이 새지 않았으면 정상 로그인이 그대로 된다")


class ClockStepBackTest(unittest.TestCase):
    """C2: 벽시계가 뒤로 가도 잠금은 잠금 시간보다 길어지지 않는다(풀리지도 않는다)."""

    HOURS9 = 9 * 3600

    def test_source_lock_is_capped_at_the_lockout(self):
        base = time.time()
        with mock.patch("hub.auth.time.time") as clock:
            clock.return_value = base
            s = SessionStore(600, 3, 300)
            for _ in range(3):
                s.note_failure("10.4.1.1", "admin")
            self.assertGreater(s.lock_remaining("10.4.1.1"), 290)
            clock.return_value = base - self.HOURS9          # 시계가 9시간 뒤로
            remaining = s.lock_remaining("10.4.1.1")
            self.assertLessEqual(remaining, 300, f"잠금 300초가 {remaining}초가 됐다")
            self.assertGreater(remaining, 290, "시계가 뒤로 갔다고 잠금이 풀리지는 않는다")
            clock.return_value = base - self.HOURS9 + 301
            self.assertEqual(s.lock_remaining("10.4.1.1"), 0)

    def test_global_lock_is_capped_at_the_lockout(self):
        base = time.time()
        with mock.patch("hub.auth.time.time") as clock:
            clock.return_value = base
            s = SessionStore(600, 3, 300)
            for i in range(3 * SessionStore.GLOBAL_FACTOR):
                s.note_failure(f"10.4.2.{i}", "admin")      # 출발지를 바꿔 가며 — 전역 잠금
            self.assertGreater(s.lock_remaining("10.4.9.9"), 290)
            clock.return_value = base - self.HOURS9
            remaining = s.lock_remaining("10.4.9.9")
            self.assertLessEqual(remaining, 300, f"전역 잠금 300초가 {remaining}초가 됐다(모든 출발지)")
            clock.return_value = base - self.HOURS9 + 301
            self.assertEqual(s.lock_remaining("10.4.9.9"), 0)

    def test_failures_from_before_the_step_leave_the_window(self):
        base = time.time()
        with mock.patch("hub.auth.time.time") as clock:
            clock.return_value = base
            s = SessionStore(600, 3, 300)
            s.note_failure("10.4.3.1", "admin")
            s.note_failure("10.4.3.1", "admin")              # 임계 3 에 한 번 남았다
            clock.return_value = base - self.HOURS9
            self.assertEqual(s.lock_remaining("10.4.3.1"), 0)
            clock.return_value = base - self.HOURS9 + s._fail_window() + 5   # noqa: SLF001 — 새 시계로 창이 지났다
            self.assertEqual(s.lock_remaining("10.4.3.1"), 0)
            s.note_failure("10.4.3.1", "admin")
            self.assertEqual(s.lock_remaining("10.4.3.1"), 0, "9시간 전(옛 시계)의 실패 2회가 창에 남아 오타 한 번에 잠겼다")
            self.assertEqual(len(s._global_fails), 1, "전역 창에도 옛 시계의 실패가 남았다")   # noqa: SLF001


if __name__ == "__main__":
    unittest.main()
