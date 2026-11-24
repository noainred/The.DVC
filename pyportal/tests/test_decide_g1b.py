"""결정(56~75 남긴 것) G1b — 서비스 허브 회귀.

D1 session-revoked.json 손상 · 읽기 오류 → fail-closed(원본 보존 · 그 시점 이전 발급 토큰 전부 거부 · 빈 목록으로 시작 ·
   콘솔 · 감사 · 화면 상태에 사유) — 로그아웃한 토큰이 되살아나는 경로가 없어야 한다(저장 실패 · 읽기 오류 동안의 로그아웃 포함).
D2 같은 초(같은 밀리초)에 만든 백업 이름 겹침 → 밀리초 + 순번(-2, -3 …), 절대 덮어쓰지 않는다(복원 직전 자동 백업 포함) ·
   예전 이름 형식도 목록 · 받기 · 복원 · 정리에서 읽는다.
D3(31회차 E3) 본인 비밀번호 변경은 현재 비밀번호 확인 — 실패 카운터 · 잠금은 로그인과 같은 함수, admin 의 다른 계정 재설정은 그대로.
D4(31회차 E1) 수동 점검 중 온 자동 점검은 끝난 뒤 한 번 이어서(중복 실행 없음) · (E2) 복원은 저장소 쓰기와 같은 잠금.
"""

import json
import shutil
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from hub import backup as backup_mod  # noqa: E402
from hub import server as server_mod  # noqa: E402
from hub.app import AppContext  # noqa: E402
from hub.auth import SessionStore, UserStore  # noqa: E402
from hub.backup import NAME_RE  # noqa: E402
from hub.scheduler import GuardedJob  # noqa: E402
from test_api import ServerCase, request  # noqa: E402

REVOKED = "session-revoked.json"


def _hour_floor() -> float:
    """기준 시각 — 실제 시각에서 정시 경계로 떨어뜨려 고정(+0.25초: 밀리초 칸이 250)."""
    return (int(time.time()) // 3600) * 3600 + 0.25


def _wait(pred, timeout=3.0):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.01)
    return pred()


def _materialize(ctx):
    """첫 기동 컨텍스트는 users.json 만 파일로 있다 — 백업 · 복원 시험을 위해 다섯 파일을 모두 만든다."""
    ctx.shortcuts.reset()
    ctx.datacenters.reset()
    ctx.categories.reset()
    ctx.settings.update_section("display", {})


class _Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()


# ---------------------------------------------------------------- D1

class RevokedFailClosedTest(_Base):
    def _users(self):
        users = UserStore(self.base / "users.json")
        if not users.get("admin"):
            users.add("admin", "admin", "admin-pass-123")
        return users

    def _store(self, users=None):
        return SessionStore(3600, 8, 300, secret_path=self.base / "session-secret", users=users,
                            revoked_path=self.base / REVOKED)

    def _login(self, store, users):
        return store.create(users.authenticate("admin", "admin-pass-123"))["token"]

    def test_corrupt_file_fails_closed_and_preserves_original(self):
        users = self._users()
        s1 = self._store(users)
        logged_out = self._login(s1, users)
        alive = self._login(s1, users)
        s1.destroy(logged_out)
        (self.base / REVOKED).write_text("{broken", encoding="utf-8")
        s2 = self._store(users)
        self.assertIsNone(s2.resolve(logged_out), "로그아웃한 토큰이 되살아나면 안 된다")
        self.assertIsNone(s2.resolve(alive), "그 시점 이전 발급 토큰은 모두 거부(전원 다시 로그인)")
        copies = list(self.base.glob(REVOKED + ".corrupt.*"))
        self.assertEqual(len(copies), 1, "손상 원본은 .corrupt.* 로 보존")
        self.assertEqual(copies[0].read_text(encoding="utf-8"), "{broken")
        err = s2.revoked_load_error()
        self.assertEqual(err["state"], "corrupt")
        self.assertEqual(err["file"], REVOKED)
        self.assertEqual(err["accountsReset"], 1)
        self.assertEqual(s2._revoked, {}, "빈 폐기 목록으로 시작")
        fresh = self._login(s2, users)
        self.assertIsNotNone(s2.resolve(fresh), "fail-closed 뒤 새 로그인은 된다")
        s3 = self._store(users)   # 재기동
        self.assertIsNone(s3.resolve(logged_out))
        self.assertIsNone(s3.resolve(alive))
        self.assertIsNotNone(s3.resolve(fresh), "fail-closed 는 한 번 — 재기동마다 다시 끊지 않는다")
        self.assertIsNone(s3.revoked_load_error())

    def test_corrupt_without_user_store_cutoff_survives_restart(self):
        """계정 저장소가 없어도(tokenVersion 인상 불가) 새 파일의 _cutoff 표지로 재기동 뒤에도 거부한다."""
        s1 = self._store()
        tok = s1.create({"username": "a", "role": "admin", "tokenVersion": 1})["token"]
        s1.destroy(tok)
        (self.base / REVOKED).write_text("[]", encoding="utf-8")   # 형식 오류(dict 아님)
        s2 = self._store()
        self.assertIsNone(s2.resolve(tok))
        self.assertIn(SessionStore.CUTOFF_KEY, json.loads((self.base / REVOKED).read_text(encoding="utf-8")))
        s3 = self._store()
        self.assertIsNone(s3.resolve(tok), "재기동 뒤에도")
        new = s3.create({"username": "a", "role": "admin", "tokenVersion": 1})["token"]
        self.assertIsNotNone(s3.resolve(new))

    def test_unreadable_file_is_left_as_is_and_logouts_fold(self):
        users = self._users()
        s1 = self._store(users)
        before = self._login(s1, users)
        gone = self._login(s1, users)
        s1.destroy(gone)
        path = self.base / REVOKED
        original = path.read_bytes()
        real = Path.read_text

        def deny(self_path, *a, **k):
            if self_path.name == REVOKED:
                raise PermissionError(13, "Permission denied")
            return real(self_path, *a, **k)

        with mock.patch.object(Path, "read_text", deny):
            s2 = self._store(users)
            self.assertEqual(s2.revoked_load_error()["state"], "unreadable")
            self.assertIsNone(s2.resolve(gone))
            self.assertIsNone(s2.resolve(before))
            during = self._login(s2, users)
            self.assertIsNotNone(s2.resolve(during))
            s2.destroy(during)
            self.assertIsNone(s2.resolve(during))
        self.assertEqual(path.read_bytes(), original, "읽기 오류면 원본을 옮기지도 덮어쓰지도 않는다")
        self.assertEqual(list(self.base.glob(REVOKED + ".corrupt.*")), [])
        s3 = self._store(users)   # 권한을 고친 뒤 재기동 — 옛 내용이 그대로 읽힌다
        self.assertIsNone(s3.revoked_load_error())
        for tok in (gone, before, during):
            self.assertIsNone(s3.resolve(tok), "읽기 오류 동안 · 그 이전 로그아웃 토큰이 재기동 뒤 되살아나면 안 된다")

    def test_malformed_entry_counts_as_corrupt(self):
        s1 = self._store()
        tok = s1.create({"username": "a", "role": "admin", "tokenVersion": 1})["token"]
        s1.destroy(tok)
        path = self.base / REVOKED
        data = json.loads(path.read_text(encoding="utf-8"))
        data["short-key"] = "garbage"
        path.write_text(json.dumps(data), encoding="utf-8")
        s2 = self._store()
        self.assertEqual(s2.revoked_load_error()["state"], "corrupt")
        self.assertEqual(len(list(self.base.glob(REVOKED + ".corrupt.*"))), 1)
        self.assertIsNone(s2.resolve(tok))

    def test_missing_file_is_a_normal_start(self):
        s = self._store()
        self.assertIsNone(s.revoked_load_error())
        tok = s.create({"username": "a", "role": "admin", "tokenVersion": 1})["token"]
        self.assertIsNotNone(s.resolve(tok))
        self.assertFalse((self.base / REVOKED).exists())

    def test_save_failure_folds_logout_to_account(self):
        users = self._users()
        s1 = self._store(users)
        tok = self._login(s1, users)
        from hub import auth as auth_mod
        real = auth_mod.write_json

        def fail_revoked(path, data):
            if Path(path).name == REVOKED:
                raise OSError(28, "No space left on device")
            return real(path, data)

        with mock.patch.object(auth_mod, "write_json", fail_revoked):
            s1.destroy(tok)
        s2 = self._store(users)
        self.assertIsNone(s2.resolve(tok), "폐기 목록 저장이 실패한 로그아웃도 재기동 뒤 되살아나지 않는다")

    def test_context_audits_and_settings_state_shows_reason(self):
        ctx = AppContext(self.base, start_workers=False)
        ctx.close()
        (self.base / REVOKED).write_text("{broken", encoding="utf-8")
        ctx = AppContext(self.base, start_workers=False)
        try:
            actions = [(e.get("action"), e.get("result")) for e in ctx.audit.tail(20)]
            self.assertIn(("session.failclosed", "fail"), actions)
            password = None
            for line in (self.base / "initial-settings-password.txt").read_text(encoding="utf-8").splitlines():
                if line.startswith("password:"):
                    password = line.split(":", 1)[1].strip()
            server = server_mod.create_server("127.0.0.1", 0, ctx)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                url = "http://127.0.0.1:{}".format(server.server_address[1])
                code, payload, _ = request(url + "/api/settings/session", "POST",
                                           {"username": "admin", "password": password})
                self.assertEqual(code, 200, payload)
                code, payload, _ = request(url + "/api/settings", headers={"X-Settings-Token": payload["token"]})
                self.assertEqual(code, 200)
                self.assertEqual(payload["sessionRevokedError"]["state"], "corrupt")
                self.assertNotIn(str(self.base), json.dumps(payload["sessionRevokedError"]), "경로는 싣지 않는다")
            finally:
                server.shutdown()
                server.server_close()
        finally:
            ctx.close()


# ---------------------------------------------------------------- D2

class BackupNameTest(_Base):
    def setUp(self):
        super().setUp()
        self.ctx = AppContext(self.base, start_workers=False)
        _materialize(self.ctx)
        self.dir = self.base / "backups"

    def tearDown(self):
        self.ctx.close()
        super().tearDown()

    def test_same_millisecond_backups_do_not_overwrite(self):
        fixed = _hour_floor()
        with mock.patch.object(backup_mod.time, "time", lambda: fixed):
            a = self.ctx.backups.create(reason="manual")
            self.ctx.shortcuts.add({"name": "g1b-later", "url": "later.internal.dc"})
            b = self.ctx.backups.create(reason="manual")
            c = self.ctx.backups.create(reason="auto")
        self.assertRegex(a["name"], r"-250-manual\.json$", "밀리초 3자리")
        self.assertTrue(b["name"].endswith("-250-manual-2.json"), b["name"])
        self.assertTrue(c["name"].endswith("-250-auto.json"), c["name"])
        self.assertNotIn("g1b-later", json.dumps(self.ctx.backups.read(a["name"]), ensure_ascii=False),
                         "먼저 만든 백업이 나중 백업에 덮이면 안 된다")
        self.assertIn("g1b-later", json.dumps(self.ctx.backups.read(b["name"]), ensure_ascii=False))
        listed = {e["name"]: e["reason"] for e in self.ctx.backups.list()}
        self.assertEqual(listed.get(a["name"]), "manual")
        self.assertEqual(listed.get(b["name"]), "manual")
        self.assertEqual(listed.get(c["name"]), "auto")
        self.assertEqual(list(self.dir.glob("*.part.*")), [], "임시 파일을 남기지 않는다")

    def test_restore_pre_backup_never_overwrites_manual_backup(self):
        fixed = _hour_floor()
        with mock.patch.object(backup_mod.time, "time", lambda: fixed):
            name = self.ctx.backups.create(reason="manual")["name"]
            raw = (self.dir / name).read_bytes()
            self.ctx.shortcuts.add({"name": "g1b-after", "url": "after.internal.dc"})
            self.ctx.backups.restore(name)
        self.assertEqual((self.dir / name).read_bytes(), raw, "복원 직전 자동 백업이 방금 만든 수동 백업을 덮으면 안 된다")
        names = sorted(p.name for p in self.dir.glob("backup-*.json"))
        self.assertEqual(len(names), 2, names)
        pre = [n for n in names if n != name][0]
        self.assertIn("g1b-after", json.dumps(self.ctx.backups.read(pre), ensure_ascii=False), "직전 상태가 따로 남는다")

    def test_old_and_new_names_list_sort_read_restore_prune(self):
        src = self.dir / self.ctx.backups.create(reason="manual")["name"]
        for p in list(self.dir.glob("backup-*.json")):
            if p != src:
                p.unlink()
        names = [
            "backup-20200101-000000.json",                 # 예전 — 사유 없음
            "backup-20200101-000000-manual.json",          # 예전
            "backup-20200101-000000-500-manual.json",
            "backup-20200101-000000-500-manual-2.json",
            "backup-20200101-000000-500-manual-10.json",
            "backup-20200101-000000-900-auto.json",
            "backup-20200101-000001-auto.json",            # 예전 — 다음 초
            "backup-20200101-000002-100-auto-3.json",
        ]
        for n in names:
            self.assertRegex(n, NAME_RE)
            shutil.copy(src, self.dir / n)
        src.unlink()
        listed = [e["name"] for e in self.ctx.backups.list()]
        self.assertEqual(listed[:6], [
            "backup-20200101-000002-100-auto-3.json",
            "backup-20200101-000001-auto.json",
            "backup-20200101-000000-900-auto.json",
            "backup-20200101-000000-500-manual-10.json",
            "backup-20200101-000000-500-manual-2.json",
            "backup-20200101-000000-500-manual.json",
        ], "같은 초 · 같은 밀리초 안에서도 만든 순서대로(최신 먼저) — 예전 이름은 같은 초의 새 이름보다 오래된 것")
        self.assertEqual(set(listed[6:]), {"backup-20200101-000000.json", "backup-20200101-000000-manual.json"})
        reasons = {e["name"]: e["reason"] for e in self.ctx.backups.list()}
        self.assertEqual(reasons["backup-20200101-000002-100-auto-3.json"], "auto")
        self.assertEqual(reasons["backup-20200101-000000-500-manual-10.json"], "manual")
        for n in ("backup-20200101-000000-manual.json", "backup-20200101-000000-500-manual-2.json"):
            self.assertIsInstance(self.ctx.backups.read(n), dict)
            self.assertIn("shortcuts", self.ctx.backups.restore(n)["restored"])
        # 복원 2회가 직전 백업 2개(지금 시각 — 가장 최신)를 더했다: 10개 → 7개 보관
        self.ctx.settings.update_section("backup", {"keep": 7})
        kept, removed = self.ctx.backups._prune_locked()   # noqa: SLF001
        left = [e["name"] for e in self.ctx.backups.list()]
        self.assertEqual((kept, removed), (7, 3))
        self.assertEqual(left[2:], [
            "backup-20200101-000002-100-auto-3.json",
            "backup-20200101-000001-auto.json",
            "backup-20200101-000000-900-auto.json",
            "backup-20200101-000000-500-manual-10.json",
            "backup-20200101-000000-500-manual-2.json",
        ], "정리는 가장 오래된 것부터(예전 이름 · 순번 없는(1번) 이름이 먼저 지워진다)")


# ---------------------------------------------------------------- D3

class SelfPasswordChangeTest(ServerCase):
    def _add(self, name, password, role="viewer"):
        body = {"username": name, "role": role, "password": password}
        if role == "admin":
            body["currentPassword"] = self.password   # 반증(결정 G1b ②): admin 생성은 요청자 본인 확인
        code, payload, _ = request(self.url + "/api/settings/users", "POST", body, self.auth())
        self.assertEqual(code, 201, payload)

    def tearDown(self):
        self.ctx.sessions._fails.clear()          # noqa: SLF001 — 같은 출발지(127.0.0.1)의 다른 시험에 잠금이 번지지 않게
        self.ctx.sessions._global_fails.clear()   # noqa: SLF001
        self.ctx.sessions._global_until = 0.0     # noqa: SLF001

    def test_self_change_requires_current_password(self):
        self._add("self1", "self-pass-111")
        tok = self._login("self-pass-111", "self1")
        url = self.url + "/api/settings/users/self1/password"
        code, payload, _ = request(url, "POST", {"password": "new-pass-2222"}, self.auth(tok))
        self.assertEqual(code, 400, payload)
        self.assertEqual(payload.get("code"), "current_password_required")
        code, payload, _ = request(url, "POST", {"password": "new-pass-2222", "currentPassword": "wrong-pass"},
                                   self.auth(tok))
        self.assertEqual(code, 403, payload)
        self.assertEqual(payload.get("code"), "current_password_invalid")
        self.assertEqual(request(self.url + "/api/settings", headers=self.auth(tok))[0], 200, "틀려도 세션은 그대로")
        self.assertIsNotNone(self.ctx.users.authenticate("self1", "self-pass-111"), "비밀번호는 바뀌지 않았다")
        actions = [(e.get("action"), e.get("result")) for e in self.ctx.audit.tail(20)]
        self.assertIn(("user.password", "fail"), actions)
        code, payload, _ = request(url, "POST", {"password": "new-pass-2222", "currentPassword": "self-pass-111"},
                                   self.auth(tok))
        self.assertEqual(code, 200, payload)
        self.assertEqual(request(self.url + "/api/settings", headers=self.auth(tok))[0], 401)
        self.assertIsNotNone(self.ctx.users.authenticate("self1", "new-pass-2222"))

    def test_admin_reset_of_other_account_needs_no_current_password(self):
        """변하지 않은 경로 — admin 이 다른 계정을 재설정할 때는 현재 비밀번호를 묻지 않는다(별도 admin 세션으로 — 다른 시험과 독립)."""
        self._add("admin2", "admin2-pass-22", role="admin")
        self._add("self2", "self-pass-222")
        tok = self._login("admin2-pass-22", "admin2")
        code, payload, _ = request(self.url + "/api/settings/users/self2/password", "POST",
                                   {"password": "reset-pass-333"}, self.auth(tok))
        self.assertEqual(code, 200, payload)
        self.assertIsNotNone(self.ctx.users.authenticate("self2", "reset-pass-333"))

    def test_admin_own_change_also_requires_current_password(self):
        self._add("admin3", "admin3-pass-33", role="admin")
        tok = self._login("admin3-pass-33", "admin3")
        code, payload, _ = request(self.url + "/api/settings/users/admin3/password", "POST",
                                   {"password": "admin-new-pass-1"}, self.auth(tok))
        self.assertEqual(code, 400, payload)
        self.assertIsNotNone(self.ctx.users.authenticate("admin3", "admin3-pass-33"), "admin 본인 비밀번호도 그대로")

    def test_wrong_current_password_uses_login_lockout(self):
        self._add("self3", "self-pass-333")
        tok = self._login("self-pass-333", "self3")
        url = self.url + "/api/settings/users/self3/password"
        with mock.patch.object(self.ctx.sessions, "_max_fails", 3):
            for _ in range(3):
                code, _, _ = request(url, "POST", {"password": "new-pass-4444", "currentPassword": "nope-nope"},
                                     self.auth(tok))
                self.assertEqual(code, 403)
            code, payload, _ = request(url, "POST", {"password": "new-pass-4444", "currentPassword": "self-pass-333"},
                                       self.auth(tok))
            self.assertEqual(code, 429, "맞는 비밀번호도 잠금 동안은 거절(로그인과 같은 잠금)")
            code, _, _ = request(self.url + "/api/settings/session", "POST",
                                 {"username": "self3", "password": "self-pass-333"})
            self.assertEqual(code, 429, "로그인 라우트와 같은 출발지 카운터")


# ---------------------------------------------------------------- D4 — E1

class DeferredAutoRunTest(unittest.TestCase):
    def _job(self, gate):
        calls, active, peak = [], [0], [0]
        guard = threading.Lock()

        def fn(kind):
            with guard:
                active[0] += 1
                peak[0] = max(peak[0], active[0])
            calls.append(kind)
            if kind.startswith("block"):
                gate.wait(5)
            with guard:
                active[0] -= 1
            return kind

        return GuardedJob(fn), calls, peak

    def test_auto_skipped_during_manual_runs_once_after(self):
        gate = threading.Event()
        job, calls, peak = self._job(gate)
        t = threading.Thread(target=job, args=("block-manual",))
        t.start()
        self.assertTrue(_wait(lambda: calls == ["block-manual"]))
        self.assertIsNone(job.run_auto("auto"), "진행 중 — 지금은 돌지 않는다")
        self.assertIsNone(job.run_auto("auto"), "여러 번 와도")
        self.assertIsNone(job("manual-2"), "수동 실행은 예전처럼 건너뛴다(예약하지 않는다)")
        gate.set()
        t.join(3)
        self.assertTrue(_wait(lambda: calls == ["block-manual", "auto"] and not job.running), calls)
        time.sleep(0.05)
        self.assertEqual(calls, ["block-manual", "auto"], "이어서 한 번만")
        self.assertEqual(peak[0], 1, "겹쳐 돌지 않는다")
        self.assertEqual(job("after"), "after", "끝나면 가드가 풀린다")

    def test_no_gap_between_manual_and_deferred_auto(self):
        """수동 실행이 끝나는 순간 가드를 놓지 않고 넘긴다 — 그 사이 끼어든 수동 실행은 건너뛴다."""
        gate = threading.Event()
        hold_auto = threading.Event()
        calls = []

        def fn(kind):
            calls.append(kind)
            if kind == "block-manual":
                gate.wait(5)
            if kind == "auto":
                hold_auto.wait(5)
            return kind

        job = GuardedJob(fn)
        t = threading.Thread(target=job, args=("block-manual",))
        t.start()
        self.assertTrue(_wait(lambda: calls == ["block-manual"]))
        job.run_auto("auto")
        gate.set()
        t.join(3)
        self.assertTrue(_wait(lambda: calls == ["block-manual", "auto"]))
        self.assertIsNone(job("manual-3"), "이어서 도는 자동 실행 중에는 새 수동 실행이 끼지 않는다")
        hold_auto.set()
        self.assertTrue(_wait(lambda: not job.running))

    def test_auto_during_auto_is_still_skipped(self):
        """자동 실행이 주기보다 오래 걸릴 때는 예전처럼 건너뛴다(쉬지 않고 점검만 하지 않게)."""
        gate = threading.Event()
        job, calls, _peak = self._job(gate)
        t = threading.Thread(target=job.run_auto, args=("block-auto",))
        t.start()
        self.assertTrue(_wait(lambda: calls == ["block-auto"]))
        self.assertIsNone(job.run_auto("auto-2"))
        gate.set()
        t.join(3)
        self.assertTrue(_wait(lambda: not job.running))
        time.sleep(0.05)
        self.assertEqual(calls, ["block-auto"])

    def test_app_tick_defers_behind_manual_check(self):
        tmp = tempfile.TemporaryDirectory()
        ctx = AppContext(Path(tmp.name), start_workers=False)
        try:
            ctx.settings.update_section("health", {"autoEnabled": True, "intervalMinutes": 5})
            gate = threading.Event()
            seen = []

            def fake(targets=None, *, persist=True):
                seen.append("auto" if targets is None else "manual")
                if targets is not None:
                    gate.wait(5)
                return []

            ctx.run_health_check = GuardedJob(fake)
            t = threading.Thread(target=ctx.run_health_check, args=([{"id": None, "url": "x.internal"}],))
            t.start()
            self.assertTrue(_wait(lambda: seen == ["manual"]))
            ctx._auto_health_tick()   # noqa: SLF001 — 수동 점검 중 온 자동 틱
            gate.set()
            t.join(3)
            self.assertTrue(_wait(lambda: seen == ["manual", "auto"] and not ctx.run_health_check.running), seen)
        finally:
            ctx.close()
            tmp.cleanup()


# ---------------------------------------------------------------- D4 — E2

class RestoreLockTest(_Base):
    def setUp(self):
        super().setUp()
        self.ctx = AppContext(self.base, start_workers=False)
        _materialize(self.ctx)

    def tearDown(self):
        self.ctx.close()
        super().tearDown()

    def test_concurrent_save_during_restore_does_not_undo_restore(self):
        """재현: 복원이 shortcuts.json 을 쓴 직후 다른 요청이 옛 메모리 목록으로 저장하면 복원이 사라졌다(응답은 성공)."""
        name = self.ctx.backups.create(reason="manual")["name"]
        restored_names = {x["name"] for x in self.ctx.shortcuts.all()}
        self.ctx.shortcuts.add({"name": "g1b-after-backup", "url": "after-backup.internal.dc"})   # 옛 메모리 목록(복원 전)
        real_write = backup_mod.write_json
        finished = threading.Event()
        box = {}

        def racer():
            self.ctx.shortcuts.add({"name": "g1b-concurrent", "url": "concurrent.internal.dc"})
            finished.set()

        def hooked(path, data):
            real_write(path, data)
            if Path(path).name == "shortcuts.json" and "thread" not in box:
                box["thread"] = threading.Thread(target=racer)
                box["thread"].start()
                box["finished_inside"] = finished.wait(0.5)

        with mock.patch.object(backup_mod, "write_json", hooked):
            self.ctx.backups.restore(name)
        self.ctx.reload_stores()   # 라우트와 같은 순서
        box["thread"].join(5)
        names = {x["name"] for x in self.ctx.shortcuts.all()}
        self.assertNotIn("g1b-after-backup", names, "복원 내용이 옛 메모리 목록 저장에 덮이면 안 된다")
        self.assertTrue(restored_names <= names)
        self.assertIn("g1b-concurrent", names, "기다린 저장은 복원된 목록 위에 들어간다")
        self.assertFalse(box["finished_inside"], "복원이 잠금을 쥔 동안 다른 저장은 기다린다")

    def test_restore_holds_every_store_lock_in_fixed_order(self):
        ctx = self.ctx
        self.assertEqual([id(lock) for lock in ctx.store_locks()],
                         [id(ctx.shortcuts._lock), id(ctx.datacenters._lock), id(ctx.categories._lock),   # noqa: SLF001
                          id(ctx.users._lock), id(ctx.settings._lock)],                                    # noqa: SLF001
                         "바로가기(센터 · 분류 잠금을 안에서 잡는다)가 먼저 — 순서를 바꾸면 교착")
        name = ctx.backups.create(reason="manual")["name"]
        real_write = backup_mod.write_json
        probe = {}

        def hooked(path, data):
            real_write(path, data)
            if Path(path).name == "settings.json" and not probe:
                def check():
                    for key, lock in zip(("shortcuts", "datacenters", "categories", "users", "settings"),
                                         ctx.store_locks()):
                        got = lock.acquire(blocking=False)
                        if got:
                            lock.release()
                        probe[key] = got
                t = threading.Thread(target=check)
                t.start()
                t.join(3)

        with mock.patch.object(backup_mod, "write_json", hooked):
            ctx.backups.restore(name)
        self.assertEqual(probe, {k: False for k in ("shortcuts", "datacenters", "categories", "users", "settings")})


if __name__ == "__main__":
    unittest.main()
