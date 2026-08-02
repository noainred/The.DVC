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
    """겹쳐 실행되지 않는 작업 래퍼. 수동 실행과 자동 실행이 같은 가드를 공유한다."""

    def __init__(self, fn):
        self._fn = fn
        self._lock = threading.Lock()
        self.last_started = 0.0
        self.last_finished = 0.0
        self.running = False

    def __call__(self, *args, **kwargs):
        if not self._lock.acquire(blocking=False):
            return None                     # 이전 실행이 진행 중 — 이번 호출은 건너뛴다
        self.running = True
        self.last_started = time.time()
        try:
            return self._fn(*args, **kwargs)
        finally:
            self.running = False
            self.last_finished = time.time()
            self._lock.release()
