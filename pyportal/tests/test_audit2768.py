"""v2.768 3회차 점검(R3-C3) 회귀 — 점검·웹훅 요청 전체 시한 · 웹훅 HTTPException · _dispatch 최종 500 ·
이력 최신값/통계 질의 · 새 계정 tokenVersion · CSV 형식 오류."""

import http.client
import json
import socket
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from hub import csvio  # noqa: E402
from hub import health as health_mod  # noqa: E402
from hub import notify as notify_mod  # noqa: E402
from hub.auth import SessionStore, UserStore  # noqa: E402
from hub.history import HealthHistory  # noqa: E402
from hub.notify import Notifier  # noqa: E402
from hub.ssrf import ValidationError  # noqa: E402

from test_api import ServerCase, request  # noqa: E402
from test_notify import FakeSettings, row  # noqa: E402


def _pass_guard(url, allow_private=True):
    """SSRF 가드는 루프백을 막는다 — 시험용으로 '검증 통과(127.0.0.1)' 만 돌려준다(접속 경로는 실제 코드)."""
    return ["127.0.0.1"], None, None


class _DripServer:
    """요청을 받으면 `payload` 를 `step` 초마다 1바이트씩, 총 `seconds` 초 동안 흘리는 서버.

    소켓 연산 단위 시한(timeout)보다 짧은 간격이라 recv 하나하나는 시한에 걸리지 않는다.
    """

    def __init__(self, payload, seconds=10.0, step=0.25, read_first=True):
        self.payload = payload
        self.seconds = seconds
        self.step = step
        self.read_first = read_first
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(5)
        self.port = self.sock.getsockname()[1]
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        try:
            conn, _ = self.sock.accept()
        except OSError:
            return
        with conn:
            if self.read_first:
                try:
                    conn.recv(65536)
                except OSError:
                    return
            started = time.monotonic()
            i = 0
            while time.monotonic() - started < self.seconds:
                try:
                    conn.sendall(self.payload[i % len(self.payload):i % len(self.payload) + 1])
                except OSError:
                    return          # 클라이언트가 끊었다(워치독) — 끝
                i += 1
                time.sleep(self.step)

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


class RequestDeadlineTest(unittest.TestCase):
    """R3-C3-1: http 모드 점검·웹훅의 시한은 '소켓 연산 단위' 가 아니라 요청 전체다."""

    TIMEOUT = 1.0
    DRIP = 10.0                 # 고치기 전 코드는 이 시간 내내 붙잡혔다
    BOUND = TIMEOUT * 4         # 넉넉한 상한(시한의 4배) — 절대 ms 단언 금지

    def setUp(self):
        self._orig_health_guard = health_mod.resolve_and_check
        self._orig_notify_guard = notify_mod.resolve_and_check
        self._orig_notify_timeout = notify_mod.TIMEOUT
        health_mod.resolve_and_check = _pass_guard
        notify_mod.resolve_and_check = _pass_guard
        self.servers = []

    def tearDown(self):
        health_mod.resolve_and_check = self._orig_health_guard
        notify_mod.resolve_and_check = self._orig_notify_guard
        notify_mod.TIMEOUT = self._orig_notify_timeout
        for srv in self.servers:
            srv.close()

    def _drip(self, payload, **kw):
        srv = _DripServer(payload, seconds=self.DRIP, **kw)
        self.servers.append(srv)
        return srv

    def test_status_line_drip_is_cut_at_deadline(self):
        srv = self._drip(b"HTTP/1.1 200 OK" + b"X" * 2000)
        started = time.monotonic()
        result = health_mod.check_one(f"http://drip.example:{srv.port}/", method="http",
                                      timeout=self.TIMEOUT)
        took = time.monotonic() - started
        self.assertLess(took, self.BOUND, f"상태줄 드립에 {took:.1f}초 붙잡혔다(시한 {self.TIMEOUT}초)")
        self.assertEqual(result["status"], health_mod.STATUS_UNREACHABLE)
        self.assertIn("시간 초과", result["message"])

    def test_header_drip_is_cut_at_deadline(self):
        srv = self._drip(b"HTTP/1.1 200 OK\r\nX-Slow: " + b"a" * 4000)
        started = time.monotonic()
        result = health_mod.check_url(f"http://drip.example:{srv.port}/", timeout=self.TIMEOUT)
        self.assertLess(time.monotonic() - started, self.BOUND)
        self.assertEqual(result["status"], health_mod.STATUS_UNREACHABLE)

    def test_tls_handshake_drip_is_cut_at_deadline(self):
        # ClientHello 를 받은 뒤 TLS 레코드처럼 보이는 바이트를 흘린다 — 핸드셰이크가 끝나지 않는다.
        # (CPython ssl 은 핸드셰이크 1회 연산에 시한을 통째로 걸어 수정 전에도 통과한다 — 워치독이 dup 소켓을
        #  잡는 구조가 TLS 경로를 깨지 않는지 보는 비회귀 시험이다. 수정 전 실패는 위 두 HTTP 드립 시험이 잡는다.)
        srv = self._drip(b"\x16\x03\x03\x40\x00" + b"\x02" * 4000)
        started = time.monotonic()
        result = health_mod.check_url(f"https://drip.example:{srv.port}/", timeout=self.TIMEOUT,
                                      tls_verify=False)
        self.assertLess(time.monotonic() - started, self.BOUND)
        self.assertEqual(result["status"], health_mod.STATUS_UNREACHABLE)

    def test_fast_server_still_healthy(self):
        # 워치독이 정상 응답을 망가뜨리지 않는다(연결 직후 등록·끝나면 해제).
        body = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
        lsock = socket.socket()
        lsock.bind(("127.0.0.1", 0))
        lsock.listen(1)
        port = lsock.getsockname()[1]

        def serve():
            conn, _ = lsock.accept()
            with conn:
                conn.recv(65536)
                conn.sendall(body)
            lsock.close()

        threading.Thread(target=serve, daemon=True).start()
        result = health_mod.check_url(f"http://fast.example:{port}/", timeout=self.TIMEOUT)
        self.assertEqual(result["status"], health_mod.STATUS_HEALTHY, result)
        self.assertEqual(result["statusCode"], 200)
        time.sleep(self.TIMEOUT * 1.2)          # 시한이 지난 뒤 워치독이 뒤늦게 무엇을 건드려도 예외가 없어야 한다

    def test_webhook_drip_is_cut_at_deadline(self):
        notify_mod.TIMEOUT = self.TIMEOUT
        srv = self._drip(b"HTTP/1.1 200 OK" + b"X" * 2000)
        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            Notifier._post_webhook(f"http://hook.example:{srv.port}/x", {"text": "t"})
        self.assertLess(time.monotonic() - started, self.BOUND)


class _BannerServer:
    """HTTP 가 아닌 상태줄(SSH 배너)을 돌려주는 대상 — 웹훅 포트 오기입."""

    def __init__(self):
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(20)
        self.port = self.sock.getsockname()[1]
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            with conn:
                try:
                    conn.recv(65536)
                    conn.sendall(b"SSH-2.0-OpenSSH_9.0\r\n")
                except OSError:
                    pass

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


class WebhookHttpExceptionTest(unittest.TestCase):
    """R3-C3-3: BadStatusLine(HTTPException — OSError 아님)도 '전송 실패' 로 접는다."""

    def setUp(self):
        self._orig = notify_mod.resolve_and_check
        notify_mod.resolve_and_check = _pass_guard
        self.banner = _BannerServer()

    def tearDown(self):
        notify_mod.resolve_and_check = self._orig
        self.banner.close()

    def test_test_send_returns_not_ok(self):
        result = Notifier(settings=None).test(f"http://hook.example:{self.banner.port}/x")
        self.assertEqual(result, {"ok": False})

    def test_one_bad_send_does_not_drop_the_rest(self):
        calls = []

        def sender(url, payload):
            calls.append(payload["name"])
            if len(calls) == 1:
                raise http.client.BadStatusLine("SSH-2.0-OpenSSH_9.0")

        settings = FakeSettings(enabled=True, webhookUrl="https://hooks.internal/x",
                                failThreshold=1, minIntervalMinutes=0)
        notifier = Notifier(settings, sender=sender)
        notifier.notify_transitions([row("a"), row("b")])                       # 기준점
        sent = notifier.notify_transitions([row("a", "unreachable"), row("b", "unreachable")])
        self.assertEqual(len(calls), 2, "첫 전송 실패가 같은 주기의 나머지 알림을 끊었다")
        self.assertEqual(len(sent), 1)


class DispatchFallbackTest(ServerCase):
    """R3-C3-3·C3-6: 라우트 핸들러의 예상 밖 예외는 무응답 끊김이 아니라 원문 없는 500 JSON."""

    def test_unexpected_exception_is_500_without_detail(self):
        history = self.ctx.history

        def boom():
            raise RuntimeError("SECRET-/var/lib/hub/internal-path")

        history.latest = boom
        try:
            code, payload, _ = request(self.url + "/api/health/latest")
        finally:
            del history.latest
        self.assertEqual(code, 500)
        self.assertIsInstance(payload, dict)
        self.assertFalse(payload.get("success"))
        self.assertNotIn("SECRET", json.dumps(payload, ensure_ascii=False))
        # 서버는 계속 응답한다.
        code, _, _ = request(self.url + "/api/meta")
        self.assertEqual(code, 200)

    def test_notify_test_with_banner_target_gets_a_response(self):
        orig = notify_mod.resolve_and_check
        notify_mod.resolve_and_check = _pass_guard
        banner = _BannerServer()
        try:
            code, payload, _ = request(self.url + "/api/settings/notify/test", "POST",
                                       {"webhookUrl": f"http://hook.example:{banner.port}/x"},
                                       self.auth())
        finally:
            notify_mod.resolve_and_check = orig
            banner.close()
        self.assertIn(code, (400, 502), payload)
        self.assertFalse(payload.get("success"))

    def test_csv_with_unclosed_quote_is_400(self):
        rows = ["name,url,description"] + [f"svc{i},https://svc{i}.corp/,설명 {i}" for i in range(4000)]
        rows[3] = 'svc2,https://svc2.corp/,"19인치 모니터'        # 닫는 따옴표가 빠진 행
        code, payload, _ = request(self.url + "/api/import/csv", "POST",
                                   {"csv": "\n".join(rows), "mode": "append"}, self.auth())
        self.assertEqual(code, 400, payload)
        self.assertIn("따옴표", payload.get("error", ""))


class CsvQuoteTest(unittest.TestCase):
    """R3-C3-6: csv.Error(ValueError 아님)는 사유를 붙인 ValidationError 로."""

    def test_field_limit_is_validation_error(self):
        text = "name,url,description\nsvc,https://svc.corp/,\"" + "가" * 140000
        with self.assertRaises(ValidationError) as ctx:
            csvio.parse_csv(text)
        self.assertIn("따옴표", str(ctx.exception))

    def test_normal_csv_still_parses(self):
        entries = csvio.parse_csv('name,url,description\nA,https://a.corp/,"쉼표, 포함"\n')
        self.assertEqual(entries[0]["description"], "쉼표, 포함")


class HistoryQueryShapeTest(unittest.TestCase):
    """R3-C3-4: latest 는 GROUP BY + MAX(ts) 전체 스캔이 아니고, stats 는 집계 하나씩 단독 문장이다."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.history = HealthHistory(Path(self.tmp.name) / "h.db", retention_days=40)
        # 기준 시각: 실제 시각을 정시로 떨어뜨려 고정한다.
        self.t0 = (int(time.time()) // 3600) * 3600

    def tearDown(self):
        self.history.close()
        self.tmp.cleanup()

    def _trace(self, fn):
        statements = []
        self.history._db.set_trace_callback(statements.append)
        try:
            result = fn()
        finally:
            self.history._db.set_trace_callback(None)
        return result, statements

    def _plan(self, sql):
        return " | ".join(str(r[3]) for r in self.history._db.execute("EXPLAIN QUERY PLAN " + sql))

    def test_latest_values(self):
        h = self.history
        h.record([{"id": "a", "url": "u", "status": "healthy", "latencyMs": 5},
                  {"id": "b", "url": "u", "status": "unreachable"},
                  {"url": "no-id", "status": "healthy"}], ts=self.t0 - 600)
        h.record([{"id": "a", "url": "u", "status": "warning", "statusCode": 503}], ts=self.t0 - 300)
        # 같은 ts 에 두 번 적재되면 나중 적재분이 최신이다(예전 dict 덮어쓰기 결과와 같다).
        h.record([{"id": "b", "url": "u", "status": "unreachable", "message": "first"}], ts=self.t0 - 100)
        h.record([{"id": "b", "url": "u", "status": "healthy", "message": "second"}], ts=self.t0 - 100)
        latest = h.latest()
        self.assertEqual(set(latest), {"a", "b"})
        self.assertEqual((latest["a"]["status"], latest["a"]["statusCode"], latest["a"]["ts"]),
                         ("warning", 503, self.t0 - 300))
        self.assertEqual((latest["b"]["status"], latest["b"]["message"]), ("healthy", "second"))
        empty = HealthHistory(Path(self.tmp.name) / "empty.db")
        try:
            self.assertEqual(empty.latest(), {})
        finally:
            empty.close()

    def test_latest_does_not_scan_or_group(self):
        h = self.history
        h.record([{"id": f"sc-{i}", "url": "u", "status": "healthy"} for i in range(5)], ts=self.t0)
        _, statements = self._trace(h.latest)
        selects = [s for s in statements if "checks" in s and s.lstrip().upper().startswith(("WITH", "SELECT"))]
        self.assertTrue(selects)
        for sql in selects:
            self.assertNotIn("GROUP BY", sql.upper())
            plan = self._plan(sql)
            self.assertNotIn("SCAN c", plan, plan)
            self.assertNotIn("SCAN checks", plan, plan)
            self.assertNotIn("TEMP B-TREE", plan, plan)

    def test_stats_single_aggregate_statements_and_exact_rows(self):
        h = self.history
        h.record([{"id": "a", "url": "u", "status": "healthy"}] * 3, ts=self.t0 - 7200)
        h.record([{"id": "a", "url": "u", "status": "healthy"}] * 2, ts=self.t0)
        stats, statements = self._trace(h.stats)
        self.assertEqual((stats["rows"], stats["firstTs"], stats["lastTs"]), (5, self.t0 - 7200, self.t0))
        for sql in statements:
            upper = sql.upper()
            aggs = sum(upper.count(fn) for fn in ("COUNT(", "MIN(", "MAX("))
            self.assertLessEqual(aggs, 1, f"집계 2개 이상 한 문장: {sql}")
        for sql in statements:
            if "MIN(" in sql.upper() or "MAX(" in sql.upper():
                self.assertNotIn("SCAN", self._plan(sql))
        # 행 수는 캐시 — 두 번째 호출은 COUNT 를 다시 돌리지 않고, 적재·정리 후에도 정확하다.
        h.record([{"id": "b", "url": "u", "status": "healthy"}], ts=self.t0)
        stats, statements = self._trace(h.stats)
        self.assertEqual(stats["rows"], 6)
        self.assertFalse([s for s in statements if "COUNT(" in s.upper()])
        h._db.execute("UPDATE checks SET ts = ? WHERE ts = ?", (self.t0 - 100 * 86400, self.t0 - 7200))
        h._db.commit()
        self.assertEqual(h.prune(), 3)
        self.assertEqual(h.stats()["rows"], 3)
        self.assertEqual(h.stats()["rows"],
                         h._db.execute("SELECT COUNT(*) FROM checks").fetchone()[0])


class TokenVersionRecreateTest(unittest.TestCase):
    """R3-C3-5: 지운 계정과 같은 이름을 (재기동 뒤) 다시 만들어도 옛 토큰은 통과하지 못한다."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _boot(self):
        users = UserStore(self.dir / "users.json", self.dir / "init.txt")
        users.bootstrap()
        return users, SessionStore(8 * 3600, 5, 300, secret_path=self.dir / "session-secret", users=users)

    def test_recreated_account_rejects_old_token(self):
        users, sessions = self._boot()
        users.add("kim", "admin", "OldPassw0rd!")
        old = sessions.create(users.authenticate("kim", "OldPassw0rd!"))["token"]
        self.assertIsNotNone(sessions.resolve(old))
        users.delete("kim")
        sessions.destroy_user("kim")
        self.assertIsNone(sessions.resolve(old))
        users, sessions = self._boot()                 # 재기동 — 메모리 컷오프가 사라진다
        users.add("kim", "viewer", "BrandNewPw#2")
        self.assertIsNone(sessions.resolve(old), "삭제 전 토큰이 같은 이름의 새 계정으로 통과했다")
        new = sessions.create(users.authenticate("kim", "BrandNewPw#2"))["token"]
        self.assertEqual(sessions.resolve(new), {"username": "kim", "role": "viewer"})

    def test_new_accounts_do_not_start_at_one(self):
        users, _ = self._boot()
        users.add("lee", "viewer", "Passw0rd!x")
        versions = {u["username"]: u["tokenVersion"] for u in users._load()}
        self.assertGreaterEqual(versions["lee"], 1 << 20)
        self.assertGreaterEqual(versions["admin"], 1 << 20)       # bootstrap 도 같은 이름 재생성이다

    def test_existing_account_version_is_kept(self):
        users, sessions = self._boot()
        users.add("park", "viewer", "Passw0rd!y")
        data = json.loads((self.dir / "users.json").read_text(encoding="utf-8"))
        records = data["users"] if isinstance(data, dict) else data
        for rec in records:
            if rec["username"] == "park":
                rec["tokenVersion"] = 3                # 업그레이드 전 계정(작은 값)
        (self.dir / "users.json").write_text(json.dumps(data), encoding="utf-8")
        users, sessions = self._boot()
        user = users.authenticate("park", "Passw0rd!y")
        self.assertEqual(user["tokenVersion"], 3)
        token = sessions.create(user)["token"]
        self.assertEqual(sessions.resolve(token), {"username": "park", "role": "viewer"})


if __name__ == "__main__":
    unittest.main()
