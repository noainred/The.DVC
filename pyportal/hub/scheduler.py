"""주기 작업 실행기 — 자동 링크 점검 · 자동 설정 백업.

재진입 가드가 핵심이다. 점검 주기(5분)보다 점검 자체가 오래 걸리면(느린 사이트 30개 ×
타임아웃) 다음 틱이 겹쳐 실행되고, 그 상태가 누적되면 CPU·소켓이 계속 불어난다.
그래서 **이전 실행이 끝나기 전이면 이번 틱을 건너뛴다**. 수동 실행(API)도 같은 락을
공유해 동시에 두 번 돌지 않는다.
"""

from __future__ import annotations

import threading
import time
import traceback


class PeriodicRunner(threading.Thread):
    """tick_seconds 마다 job() 을 호출한다. job 은 스스로 '지금 할 때인가'를 판단한다."""

    daemon = True

    def __init__(self, name: str, job, tick_seconds: float = 20.0, initial_delay: float = 3.0):
        super().__init__(name=name, daemon=True)
        self._job = job
        self._tick = max(1.0, float(tick_seconds))
        self._initial_delay = max(0.0, float(initial_delay))
        self._stop = threading.Event()

    def run(self):
        if self._stop.wait(self._initial_delay):
            return
        while not self._stop.is_set():
            try:
                self._job()
            except Exception:  # noqa: BLE001 — 한 번의 실패로 스케줄러가 죽으면 안 된다
                print(f"[{self.name}] 주기 작업 실패:\n{traceback.format_exc()}", flush=True)
            self._stop.wait(self._tick)

    def stop(self):
        self._stop.set()


class GuardedJob:
    """겹쳐 실행되지 않는 작업 래퍼. 수동 실행과 자동 실행이 같은 가드를 공유한다.

    결정(56~75 남긴 것 · 31회차 E1): 예전에는 수동 실행이 가드를 쥔 동안 온 자동 틱이 그냥 None 으로 끝나 자동 점검이 한 주기(기본 5분)를
    통째로 건너뛰었다(로그인한 사용자가 urls 점검을 이어 보내면 자동 점검 · 이력이 계속 비었다). 이제 자동 실행(`run_auto`)은 가드를 쥔 쪽이
    **수동 실행**이면 '끝난 뒤 한 번' 으로 예약하고, 수동 실행이 끝나는 순간 가드를 놓지 않은 채 그 자동 실행에 넘긴다(그 사이 다른 실행이
    끼지 않는다 — 중복 실행 없음). 예약은 몇 번 와도 한 번이다. 가드를 쥔 쪽이 자동 실행이면(점검이 주기보다 오래 걸림) 예전처럼 건너뛴다 —
    밀린 주기를 곧바로 이어 돌면 쉬지 않고 점검만 하게 된다.
    """

    def __init__(self, fn):
        self._fn = fn
        self._lock = threading.Lock()
        self._state = threading.Lock()   # _holder · _deferred 와 가드 획득 · 해제를 한 번에 본다(예약을 놓치지 않게)
        self._holder = None              # 'manual' | 'auto' — 지금 가드를 쥔 실행의 종류
        self._deferred = None            # (args, kwargs) — 수동 실행이 끝난 뒤 이어서 돌 자동 실행
        self.last_started = 0.0
        self.last_finished = 0.0
        self.running = False

    def __call__(self, *args, **kwargs):
        """수동 실행 — 진행 중이면 건너뛴다(None)."""
        with self._state:
            if not self._lock.acquire(blocking=False):
                return None                     # 이전 실행이 진행 중 — 이번 호출은 건너뛴다
            self._holder = "manual"
        return self._run(args, kwargs)

    def run_auto(self, *args, **kwargs):
        """자동(주기) 실행 — 지금 돌리거나, 수동 실행이 진행 중이면 그것이 끝난 뒤 한 번 이어서 돌게 예약한다(None)."""
        with self._state:
            if not self._lock.acquire(blocking=False):
                if self._holder == "manual":
                    self._deferred = (args, kwargs)
                return None
            self._holder = "auto"
        return self._run(args, kwargs)

    def _run(self, args, kwargs):
        self.running = True
        self.last_started = time.time()
        try:
            return self._fn(*args, **kwargs)
        finally:
            self.last_finished = time.time()
            self._finish()

    def _finish(self):
        with self._state:
            pending, self._deferred = self._deferred, None
            if pending is None:
                self.running = False
                self._holder = None
                self._lock.release()
                return
            self._holder = "auto"
        # 가드는 쥔 채로 넘긴다 — 수동 실행의 응답을 자동 점검 시간만큼 늦추지 않게 별도 스레드에서 돈다.
        try:
            threading.Thread(target=self._run_deferred, args=pending, name="guarded-deferred", daemon=True).start()
        except RuntimeError:   # 스레드를 못 만들면(자원 고갈) 예약을 버리고 가드를 푼다 — 다음 주기에 다시 돈다
            with self._state:
                self.running = False
                self._holder = None
                self._lock.release()
            print("[scheduler] 이어서 돌 자동 실행을 시작하지 못했습니다 — 다음 주기에 다시 시도합니다.", flush=True)

    def _run_deferred(self, args, kwargs):
        try:
            self._run(args, kwargs)
        except Exception:  # noqa: BLE001 — 주기 작업과 같은 처리(한 번의 실패가 스레드 밖으로 새지 않게)
            print(f"[scheduler] 이어서 돈 자동 실행 실패:\n{traceback.format_exc()}", flush=True)
