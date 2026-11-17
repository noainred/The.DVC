"""결정 권장안 G1b 반증(적대적 재검토) — 고친 것을 깨뜨리려던 시도 중 '깨지지 않음' 으로 확인한 경로를 고정한다.

R1 fail-closed 가 고리가 되지 않는다: 업그레이드 직후(옛 .corrupt.* 만 남음) · 빈 파일 · 읽기 오류 뒤 회복 — 한 번만 끊고, 재기동마다 다시 끊지 않는다
   (그리고 그 사이 로그아웃한 토큰은 되살아나지 않는다).
R2 복원(저장소 잠금 5개)과 일반 저장 · 센터 · 분류 삭제 + 재배정 · 설정 · 계정 · 백업 생성이 동시에 돌아도 교착하지 않는다(스레드로 실제 경합).
R3 수동 · 자동 점검이 마구 겹쳐도 겹쳐 돌지 않고, 끝나면 가드가 풀리며 예약이 남지 않는다(예외가 섞여도).
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

from hub.app import AppContext  # noqa: E402
from hub.auth import SessionStore, UserStore  # noqa: E402
from hub.scheduler import GuardedJob  # noqa: E402

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


if __name__ == "__main__":
    unittest.main()
