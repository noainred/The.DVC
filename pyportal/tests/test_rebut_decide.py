"""결정 권장안 G1b 반증(적대적 재검토) — 고친 것을 깨뜨리려던 시도 중 '깨지지 않음' 으로 확인한 경로를 고정한다.

R1 fail-closed 가 고리가 되지 않는다: 업그레이드 직후(옛 .corrupt.* 만 남음) · 빈 파일 · 읽기 오류 뒤 회복 — 한 번만 끊고, 재기동마다 다시 끊지 않는다
   (그리고 그 사이 로그아웃한 토큰은 되살아나지 않는다).
R2 복원(저장소 잠금 5개)과 일반 저장 · 센터 · 분류 삭제 + 재배정 · 설정 · 계정 · 백업 생성이 동시에 돌아도 교착하지 않는다(스레드로 실제 경합).
R3 수동 · 자동 점검이 마구 겹쳐도 겹쳐 돌지 않고, 끝나면 가드가 풀리며 예약이 남지 않는다(예외가 섞여도).
결정(사용자 '권장안대로') 이어서 구현한 것:
D1 보관 수량이 꽉 찬 상태에서 가장 오래된 백업을 복원해도 복원 직전 백업의 정리가 그 백업을 지우지 않는다(재현된 데이터 손실).
D2 폐기 목록 읽기 오류가 **같은 파일 상태로 계속되면** 재기동마다 전원을 다시 끊지 않는다(표지 파일) — 파일이 바뀌었거나 표지가 없거나
   그 사이 계정 단위 폐기가 실패했으면 예전처럼 다시 끊는다 · 다시 읽히면 표지를 지운다.
D3 admin 을 늘리는 관리 동작(admin 생성 · 다른 admin 재설정 · admin 으로 올리기)은 요청자 본인의 현재 비밀번호(같은 실패 카운터) — viewer 대상 · 중지 · 삭제는 그대로.
"""

import random
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

sys.path.insert(0, str(Path(__file__).resolve().parent))

from hub.app import AppContext  # noqa: E402
from hub.auth import SessionStore, UserStore  # noqa: E402
from hub.scheduler import GuardedJob  # noqa: E402
from test_api import ServerCase, request  # noqa: E402

REVOKED = "session-revoked.json"


class _Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _users(self):
        users = UserStore(self.base / "users.json")
        users.add("admin", "admin", "admin-pass-123")
        users.add("bob", "viewer", "bob-pass-1234")
        return users

    def _store(self, users):
        return SessionStore(3600, 8, 300, secret_path=self.base / "session-secret", users=users,
                            revoked_path=self.base / REVOKED)

    def _login(self, store, users, name="admin", pw="admin-pass-123"):
        return store.create(users.authenticate(name, pw))["token"]


class FailClosedNoLoopTest(_Base):
    def test_upgrade_with_only_corrupt_copy_fails_closed_once(self):
        """옛 판본이 손상 파일을 옮기고 그 뒤 로그아웃이 없어 보존본만 남은 설치 — 업그레이드 첫 기동에 한 번만 끊는다."""
        users = self._users()
        s0 = self._store(users)
        old = self._login(s0, users)
        (self.base / (REVOKED + ".corrupt.1700000000")).write_text("{x", encoding="utf-8")
        s1 = self._store(users)
        self.assertEqual(s1.revoked_load_error()["state"], "corrupt")
        self.assertIsNone(s1.resolve(old), "보존본만 남았어도 손상 — 그 이전 토큰은 거부")
        fresh = self._login(s1, users)
        for _ in range(3):   # 재기동 반복
            s = self._store(users)
            self.assertIsNone(s.revoked_load_error(), "재기동마다 다시 fail-closed 하면 전원이 계속 끊긴다")
            self.assertIsNotNone(s.resolve(fresh))
            self.assertIsNone(s.resolve(old))

    def test_empty_file_fails_closed_once(self):
        users = self._users()
        (self.base / REVOKED).write_text("", encoding="utf-8")
        s1 = self._store(users)
        self.assertEqual(s1.revoked_load_error()["state"], "corrupt")
        fresh = self._login(s1, users)
        s2 = self._store(users)
        self.assertIsNone(s2.revoked_load_error())
        self.assertIsNotNone(s2.resolve(fresh))

    def test_unreadable_then_recovered_does_not_cut_again_and_keeps_logouts(self):
        users = self._users()
        s0 = self._store(users)
        gone = self._login(s0, users, "bob", "bob-pass-1234")
        s0.destroy(gone)
        real = Path.read_text

        def deny(self_path, *a, **k):
            if self_path.name == REVOKED:
                raise PermissionError(13, "Permission denied")
            return real(self_path, *a, **k)

        with mock.patch.object(Path, "read_text", deny):
            s1 = self._store(users)
            self.assertEqual(s1.revoked_load_error()["state"], "unreadable")
            during_admin = self._login(s1, users)
            during_bob = self._login(s1, users, "bob", "bob-pass-1234")
            s1.destroy(during_bob)   # 폐기 목록에 못 쓴다 — 계정 단위 폐기로 접힌다
        for _ in range(2):   # 권한을 고친 뒤 재기동 반복
            s = self._store(users)
            self.assertIsNone(s.revoked_load_error(), "회복 뒤 재기동이 다시 끊으면 안 된다")
            self.assertIsNotNone(s.resolve(during_admin), "읽기 오류 동안 발급된 정상 세션은 회복 뒤에도 산다")
            self.assertIsNone(s.resolve(during_bob), "읽기 오류 동안 로그아웃한 토큰이 되살아나면 안 된다")
            self.assertIsNone(s.resolve(gone), "그 이전 로그아웃 토큰도")


class RestoreNoDeadlockTest(_Base):
    def test_concurrent_restore_and_store_writes_finish(self):
        ctx = AppContext(self.base, start_workers=False)
        try:
            ctx.shortcuts.reset()
            ctx.datacenters.reset()
            ctx.categories.reset()
            ctx.settings.update_section("display", {})
            ctx.users.add("adm2", "admin", "admin-pass-123")
            ctx.settings.update_section("backup", {"keep": 200})   # 정리가 복원 대상 백업을 지우지 않게(이 시험은 교착만 본다)
            name = ctx.backups.create(reason="manual")["name"]
            stop = time.time() + 1.5
            errors = []

            def loop(fn):
                def run():
                    while time.time() < stop:
                        try:
                            fn()
                        except Exception as exc:  # noqa: BLE001 — 형식 거절은 정상(교착만 본다)
                            errors.append(type(exc).__name__)
                return run

            def restore():
                ctx.backups.restore(name)
                ctx.reload_stores()

            def add():
                ctx.shortcuts.add({"name": "r%d" % random.randint(0, 10 ** 9), "url": "r.internal.dc"})

            def dc():
                ids = [x["id"] for x in ctx.datacenters.all()]
                if len(ids) > 1:
                    ctx.datacenters.delete(ids[-1])
                    ctx.shortcuts.reassign_missing_datacenters(ctx.datacenters.ids())

            def cat():
                ids = [c["id"] for c in ctx.categories.all() if c["id"] != "custom"]
                if ids:
                    ctx.categories.delete(ids[-1])
                    ctx.shortcuts.reassign_category(ids[-1], "custom")

            fns = (restore, add, dc, cat,
                   lambda: ctx.settings.update_section("health", {"intervalMinutes": random.randint(1, 9)}),
                   lambda: ctx.backups.create(reason="auto"),
                   lambda: ctx.users.update("adm2", role="admin"),
                   lambda: (ctx.backups.status(), ctx.backups.list()),
                   restore)
            threads = [threading.Thread(target=loop(fn), daemon=True) for fn in fns]
            for t in threads:
                t.start()
            deadline = time.time() + 20   # 합계 시한 — 교착이면 스레드마다 기다리지 않고 곧 실패한다
            for t in threads:
                t.join(max(0.0, deadline - time.time()))
            self.assertEqual([t for t in threads if t.is_alive()], [], "복원 잠금 순서가 다른 경로와 교착했다")
        finally:
            ctx.close()


class GuardedJobStressTest(unittest.TestCase):
    def test_manual_and_auto_storm_never_overlaps_and_releases(self):
        state = {"active": 0, "peak": 0}
        guard = threading.Lock()

        def fn(kind):
            with guard:
                state["active"] += 1
                state["peak"] = max(state["peak"], state["active"])
            time.sleep(random.random() * 0.002)
            with guard:
                state["active"] -= 1
            if random.random() < 0.05:
                raise RuntimeError("boom")
            return kind

        job = GuardedJob(fn)
        stop = time.time() + 1.0

        def manual():
            while time.time() < stop:
                try:
                    job("manual")
                except RuntimeError:
                    pass

        def auto():
            while time.time() < stop:
                try:
                    job.run_auto("auto")
                except RuntimeError:
                    pass
                time.sleep(0.0005)

        threads = [threading.Thread(target=manual) for _ in range(3)] + [threading.Thread(target=auto) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(10)
        end = time.time() + 3
        while job.running and time.time() < end:
            time.sleep(0.01)
        self.assertEqual(state["peak"], 1, "겹쳐 돌았다")
        self.assertFalse(job.running)
        self.assertIsNone(job._deferred)   # noqa: SLF001
        self.assertTrue(job._lock.acquire(blocking=False), "가드가 풀리지 않았다")   # noqa: SLF001
        job._lock.release()   # noqa: SLF001


# ---------------------------------------------------------------- D1

class RestoreOldestKeepsItTest(_Base):
    def test_restoring_oldest_backup_at_keep_limit_does_not_delete_it(self):
        ctx = AppContext(self.base, start_workers=False)
        try:
            ctx.shortcuts.reset()
            ctx.datacenters.reset()
            ctx.categories.reset()
            ctx.settings.update_section("backup", {"keep": 3})
            names = []
            for _ in range(3):
                names.append(ctx.backups.create(reason="manual")["name"])
                time.sleep(0.002)
            oldest = names[0]
            ctx.backups.restore(oldest)
            listed = [e["name"] for e in ctx.backups.list()]
            self.assertIn(oldest, listed, "복원 직전 백업의 정리가 지금 복원하는 백업을 지웠다(데이터 손실)")
            self.assertEqual(len(listed), 4, "이번에는 보관 수량을 한 개 넘긴다")
            self.assertIsInstance(ctx.backups.read(oldest), dict, "다시 받기 · 복원할 수 있어야 한다")
            ctx.backups.restore(oldest)   # 두 번째 복원도 된다(예전: 404)
            ctx.backups.create(reason="manual")   # 다음 정리에서 보관 수량을 맞춘다
            self.assertEqual(len(ctx.backups.list()), 3)
        finally:
            ctx.close()


# ---------------------------------------------------------------- D2

class FailClosedMarkerTest(_Base):
    def _deny(self):
        real = Path.read_text

        def deny(self_path, *a, **k):
            if self_path.name == REVOKED:
                raise PermissionError(13, "Permission denied")
            return real(self_path, *a, **k)

        return mock.patch.object(Path, "read_text", deny)

    def _versions(self, users):
        return {u["username"]: users.get(u["username"])["tokenVersion"] for u in users.public_list()}

    def test_same_unreadable_file_does_not_cut_again_on_restart(self):
        users = self._users()
        s0 = self._store(users)
        before = self._login(s0, users)
        s0.destroy(self._login(s0, users, "bob", "bob-pass-1234"))   # 파일이 있게
        marker = self.base / "session-revoked.failclosed.json"
        with self._deny():
            s1 = self._store(users)
            self.assertEqual(s1.revoked_load_error()["state"], "unreadable")
            self.assertTrue(marker.exists(), "첫 fail-closed 는 표지를 남긴다")
            self.assertEqual(marker.stat().st_mode & 0o777, 0o600)
            during = self._login(s1, users)
            v1 = self._versions(users)
            for _ in range(3):   # 같은 파일 상태로 재기동 반복
                s = self._store(users)
                err = s.revoked_load_error()
                self.assertTrue(err and err.get("resumed"), err)
                self.assertEqual(self._versions(users), v1, "재기동마다 전 계정 tokenVersion 을 다시 올렸다(전원 끊김)")
                self.assertIsNotNone(s.resolve(during), "첫 끊음 뒤 로그인한 세션이 재기동으로 끊겼다")
                self.assertIsNone(s.resolve(before), "첫 끊음 이전 토큰은 계속 거부")
                fresh = self._login(s, users)
                self.assertIsNotNone(s.resolve(fresh))
        s2 = self._store(users)   # 권한을 고쳤다 — 정상 읽기, 표지 정리
        self.assertIsNone(s2.revoked_load_error())
        self.assertFalse(marker.exists(), "다시 읽혔으면 표지를 지운다")

    def test_changed_file_or_missing_marker_cuts_again(self):
        users = self._users()
        s0 = self._store(users)
        s0.destroy(self._login(s0, users, "bob", "bob-pass-1234"))
        marker = self.base / "session-revoked.failclosed.json"
        with self._deny():
            self._store(users)
            v1 = self._versions(users)
            path = self.base / REVOKED
            path.write_bytes(path.read_bytes() + b" ")   # 파일이 바뀌었다(크기 · mtime)
            s = self._store(users)
            self.assertFalse(s.revoked_load_error().get("resumed"))
            v2 = self._versions(users)
            self.assertTrue(all(v2[k] == v1[k] + 1 for k in v1), "파일이 바뀌었으면 예전처럼 다시 끊는다")
            marker.unlink()
            s = self._store(users)
            self.assertFalse(s.revoked_load_error().get("resumed"))
            self.assertTrue(all(self._versions(users)[k] == v2[k] + 1 for k in v2), "표지가 없으면 다시 끊는다")

    def test_failed_account_fold_drops_marker_so_next_start_cuts_again(self):
        """읽기 오류 중 로그아웃을 계정 단위로도 남기지 못했으면(users.json 저장 실패) 그 토큰은 어디에도 없다 — 이어 가기를 막는다."""
        users = self._users()
        s0 = self._store(users)
        s0.destroy(self._login(s0, users, "bob", "bob-pass-1234"))
        marker = self.base / "session-revoked.failclosed.json"
        with self._deny():
            s1 = self._store(users)
            tok = self._login(s1, users)
            with mock.patch.object(UserStore, "bump_token_version", side_effect=OSError(28, "No space left on device")):
                s1.destroy(tok)
            self.assertFalse(marker.exists(), "계정 단위 폐기도 실패했는데 표지가 남았다")
            s2 = self._store(users)
            self.assertFalse(s2.revoked_load_error().get("resumed"))
            self.assertIsNone(s2.resolve(tok), "어디에도 남지 않은 로그아웃 토큰이 재기동 뒤 되살아났다")

    def test_marker_not_written_when_account_bump_failed(self):
        users = self._users()
        s0 = self._store(users)
        s0.destroy(self._login(s0, users, "bob", "bob-pass-1234"))
        with self._deny(), mock.patch.object(UserStore, "bump_all_token_versions", side_effect=OSError(28, "No space")):
            self._store(users)
        self.assertFalse((self.base / "session-revoked.failclosed.json").exists(),
                         "계정 인상이 실패한 첫 끊음(메모리 컷오프뿐)은 이어 갈 근거가 없다")


# ---------------------------------------------------------------- D3

class AdminGrantNeedsRequesterPasswordTest(ServerCase):
    def tearDown(self):
        self.ctx.sessions._fails.clear()          # noqa: SLF001
        self.ctx.sessions._global_fails.clear()   # noqa: SLF001
        self.ctx.sessions._global_until = 0.0     # noqa: SLF001

    def _post(self, path, body, method="POST"):
        return request(self.url + path, method, body, self.auth())

    def test_create_admin_requires_requester_password(self):
        code, payload, _ = self._post("/api/settings/users", {"username": "d3a", "role": "admin", "password": "d3a-pass-111"})
        self.assertEqual((code, payload.get("code")), (400, "current_password_required"))
        self.assertIsNone(self.ctx.users.get("d3a"), "확인 없이 admin 이 늘었다")
        code, payload, _ = self._post("/api/settings/users", {"username": "d3a", "role": "admin", "password": "d3a-pass-111",
                                                              "currentPassword": "wrong-pass-0"})
        self.assertEqual((code, payload.get("code")), (403, "current_password_invalid"))
        self.assertIn(("user.create", "fail"), [(e.get("action"), e.get("result")) for e in self.ctx.audit.tail(20)])
        code, _, _ = self._post("/api/settings/users", {"username": "d3a", "role": "admin", "password": "d3a-pass-111",
                                                        "currentPassword": self.password})
        self.assertEqual(code, 201)
        code, _, _ = self._post("/api/settings/users", {"username": "d3v", "role": "viewer", "password": "d3v-pass-111"})
        self.assertEqual(code, 201, "viewer 생성은 그대로")

    def test_reset_other_admin_requires_requester_password_viewer_unchanged(self):
        self._post("/api/settings/users", {"username": "d3b", "role": "admin", "password": "d3b-pass-111", "currentPassword": self.password})
        self._post("/api/settings/users", {"username": "d3w", "role": "viewer", "password": "d3w-pass-111"})
        code, payload, _ = self._post("/api/settings/users/d3b/password", {"password": "d3b-new-2222"})
        self.assertEqual((code, payload.get("code")), (400, "current_password_required"))
        self.assertIsNotNone(self.ctx.users.authenticate("d3b", "d3b-pass-111"))
        code, _, _ = self._post("/api/settings/users/d3b/password", {"password": "d3b-new-2222", "currentPassword": self.password})
        self.assertEqual(code, 200)
        code, _, _ = self._post("/api/settings/users/d3w/password", {"password": "d3w-new-2222"})
        self.assertEqual(code, 200, "viewer 재설정은 그대로")

    def test_promote_to_admin_requires_requester_password_demote_disable_unchanged(self):
        self._post("/api/settings/users", {"username": "d3p", "role": "viewer", "password": "d3p-pass-111"})
        code, payload, _ = self._post("/api/settings/users/d3p", {"role": "admin"}, "PUT")
        self.assertEqual((code, payload.get("code")), (400, "current_password_required"))
        self.assertEqual(self.ctx.users.get("d3p")["role"], "viewer")
        code, _, _ = self._post("/api/settings/users/d3p", {"role": "admin", "currentPassword": self.password}, "PUT")
        self.assertEqual(code, 200)
        self.assertEqual(self.ctx.users.get("d3p")["role"], "admin")
        self.assertEqual(self._post("/api/settings/users/d3p", {"role": "viewer"}, "PUT")[0], 200, "낮추기는 그대로")
        self.assertEqual(self._post("/api/settings/users/d3p", {"enabled": False}, "PUT")[0], 200, "중지는 그대로")
        self.assertEqual(self._post("/api/settings/users/d3p", None, "DELETE")[0], 200, "삭제는 그대로")

    def test_requester_check_shares_login_lockout(self):
        with mock.patch.object(self.ctx.sessions, "_max_fails", 2):
            for _ in range(2):
                code, _, _ = self._post("/api/settings/users", {"username": "d3l", "role": "admin", "password": "d3l-pass-111",
                                                                "currentPassword": "nope-nope"})
                self.assertEqual(code, 403)
            code, _, _ = self._post("/api/settings/users", {"username": "d3l", "role": "admin", "password": "d3l-pass-111",
                                                            "currentPassword": self.password})
            self.assertEqual(code, 429, "로그인과 같은 출발지 잠금")
        self.assertIsNone(self.ctx.users.get("d3l"))


if __name__ == "__main__":
    unittest.main()
