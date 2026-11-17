"""애플리케이션 컨텍스트 — 저장소·서비스·스케줄러를 한 번에 조립한다.

서버 핸들러는 여기 붙은 객체만 보고 동작하므로, 테스트에서는 임시 디렉터리로 컨텍스트를
따로 만들어 끼울 수 있다(전역 상태에 의존하지 않는다).
"""

from __future__ import annotations

import time
from contextlib import ExitStack

from . import health as health_mod
from .audit import AuditLog
from .auth import SessionStore, UserStore
from .backup import BackupService
from .catstore import CategoryStore
from .notify import Notifier
from .config import config
from .dcstore import DatacenterStore
from .history import HealthHistory
from .scheduler import GuardedJob, PeriodicRunner
from .settings import SettingsStore
from .store import ShortcutStore


class AppContext:
    def __init__(self, data_dir=None, *, start_workers: bool = True):
        base = data_dir or config.data_dir
        self.data_dir = base

        self.settings = SettingsStore(base / "settings.json")
        self.datacenters = DatacenterStore(base / "datacenters.json")
        self.categories = CategoryStore(base / "categories.json")
        self.shortcuts = ShortcutStore(base / "shortcuts.json",
                                       datacenter_ids=self.datacenters.ids,
                                       resolve_category=self.categories.resolve)
        self.users = UserStore(base / "users.json", base / "initial-settings-password.txt")
        self.sessions = SessionStore(config.session_ttl_min * 60, config.login_max_fails,
                                     config.login_lockout_sec,
                                     secret_path=base / "session-secret", users=self.users,
                                     revoked_path=base / "session-revoked.json")   # 31회차 F5
        self.audit = AuditLog(base / "audit.log")
        self.notifier = Notifier(self.settings, self.audit)
        self.history = HealthHistory(base / "health-history.db", config.history_retention_days)
        self.backups = BackupService(base / "backups", {
            "shortcuts": base / "shortcuts.json",
            "datacenters": base / "datacenters.json",
            "categories": base / "categories.json",
            "users": base / "users.json",
            "settings": base / "settings.json",
        }, self.settings, load_errors=lambda: {
            # 47회차 #5: 데이터 파일을 못 읽는 동안 백업 정리를 멈춘다(정상 목록이 든 마지막 백업을 지키려고)
            "datacenters.json": self.datacenters.load_error(),
            "categories.json": self.categories.load_error(),
            "shortcuts.json": self.shortcuts.load_error(),
        }, store_locks=self.store_locks, on_restored=self.reload_stores)
        # 결정(56~75 남긴 것) session-revoked.json 손상 · 읽기 오류로 fail-closed 했으면 감사 로그에도 남긴다(콘솔 로그는 SessionStore 가 남김).
        revoked_error = self.sessions.revoked_load_error()
        if revoked_error:
            self.audit.write("session.failclosed", actor="-", client="-", result="fail", detail={
                "file": revoked_error.get("file"), "state": revoked_error.get("state"),
                "accountsReset": revoked_error.get("accountsReset"), "resumed": bool(revoked_error.get("resumed"))})

        # 계정이 없으면 초기 비밀번호를 만들어 파일로 남긴다(경로만 로그에 찍는다).
        self.bootstrap_password_created = bool(self.users.bootstrap())

        # 자동 점검과 수동 점검이 같은 가드를 공유한다 — 동시에 두 번 돌지 않는다.
        self.run_health_check = GuardedJob(self._run_health_check)
        self._last_auto_check = 0.0
        # 미인증 '지금 점검'의 최소 간격(초). 로그인 없이 무한히 재점검을 돌려
        # 대상 서버에 부하를 주거나 서버 자원을 소모하지 못하게 한다(6차 감사).
        self.public_check_interval = 30
        self._last_public_check = 0.0
        self._workers = []
        if start_workers:
            self.start_workers()

    def store_locks(self):
        """백업 대상 저장소 잠금 — **이 순서로만** 잡는다(결정 · 31회차 E2).

        바로가기 저장소는 자기 잠금 안에서 센터 · 분류 잠금을 잡으므로(_clean_datacenter_id · resolve_category) 바로가기가 먼저다.
        복원(backup.restore)과 캐시 비우기(reload_stores)가 같은 순서로 잡아 서로 · 일반 저장과 교착하지 않는다.
        """
        return [self.shortcuts._lock, self.datacenters._lock, self.categories._lock,   # noqa: SLF001
                self.users._lock, self.settings._lock]                                 # noqa: SLF001

    def reload_stores(self):
        """디스크가 외부에서 바뀐 뒤(백업 복원) 메모리 캐시를 버리고 다시 읽는다.

        이 호출을 빼면 복원 직후 화면에는 옛 목록이 그대로 보이고, 다음 저장이 복원된
        내용을 덮어써 복원이 사실상 무효가 된다.
        결정(31회차 E2): 저장소 잠금을 쥔 채 비운다 — 잠금 밖에서 비우면 진행 중인 저장(예: 바로가기 add 의 insert 와 write 사이)이
        빈 목록을 파일에 쓸 수 있었다. 복원은 이 함수를 같은 잠금 안에서 부른다(RLock — 다시 잡아도 된다).
        """
        with ExitStack() as stack:
            for lock in self.store_locks():
                stack.enter_context(lock)
            self.shortcuts._loaded = False       # noqa: SLF001 — 같은 패키지 내부 재적재
            self.shortcuts._items = []           # noqa: SLF001
            self.datacenters._items = None       # noqa: SLF001
            self.categories._items = None        # noqa: SLF001
            self.users._users = None             # noqa: SLF001
            self.settings._data = None           # noqa: SLF001

    def public_check_cooldown(self) -> int:
        """미인증 점검 요청의 남은 대기 시간(초). 0이면 지금 실행해도 된다."""
        remaining = int(self.public_check_interval - (time.time() - self._last_public_check))
        if remaining > 0:
            return remaining
        self._last_public_check = time.time()
        return 0

    # ---------- 링크 점검 ----------

    def _run_health_check(self, targets=None, *, persist: bool = True):
        items = targets if targets is not None else [
            {"id": item["id"], "url": item["url"]} for item in self.shortcuts.all()
            if item.get("enabled", True)  # 중지된 바로가기(v2.227)는 점검하지 않는다(대상 부하·이력 오염 방지)
        ]
        if not items:
            return []
        results = health_mod.check_many(
            items,
            timeout=config.health_timeout,
            concurrency=config.health_concurrency,
            tls_verify=config.health_tls_verify,
            allow_private=config.health_allow_private,
            # 판정 기준은 설정에서 바꿀 수 있다(기본 port) — 매번 다시 읽어 재기동 없이 반영.
            method=self.settings.section("health").get("method", health_mod.METHOD_PORT),
        )
        if persist:
            # id 가 있는 항목만 이력으로 남긴다(임시 URL 점검은 차트에 섞이면 안 된다).
            keep = [row for row in results if row.get("id")]
            if keep:
                self.history.record(keep)
                # 상태가 '바뀐' 링크만 알린다 — 매 주기 알림은 곧 무시된다.
                names = {item["id"]: item["name"] for item in self.shortcuts.all()}
                self.notifier.notify_transitions(keep, names)
        return results

    def _auto_health_tick(self):
        cfg = self.settings.section("health")
        if not cfg.get("autoEnabled"):
            return
        interval = max(1, int(cfg.get("intervalMinutes", 5))) * 60
        if (time.time() - self._last_auto_check) < interval:
            return
        self._last_auto_check = time.time()
        # 결정(56~75 남긴 것 · 31회차 E1): 수동 점검이 진행 중이면 이번 틱을 버리지 않고, 그것이 끝난 뒤 한 번 이어서 돈다(GuardedJob.run_auto).
        self.run_health_check.run_auto()

    # ---------- 워커 ----------

    def start_workers(self):
        self._workers = [
            PeriodicRunner("health-auto", self._auto_health_tick, tick_seconds=20,
                           initial_delay=5),
            PeriodicRunner("backup-auto", self.backups.run_if_due, tick_seconds=60,
                           initial_delay=30),
        ]
        for worker in self._workers:
            worker.start()

    def stop_workers(self):
        for worker in self._workers:
            worker.stop()
        self._workers = []

    def close(self):
        self.stop_workers()
        try:
            self.history.close()
        except Exception:  # noqa: BLE001
            pass
