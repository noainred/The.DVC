/**
 * vmclone/scheduler.js — 복제 잡 스케줄러(v2.299).
 *
 * 60초 틱으로 due 잡(store.isDue — 매일 HH:MM / N시간 간격)을 실행 큐에 넣는다.
 * CLAUDE.md 폴러 규칙 준수:
 *  - 재진입 가드: 이전 틱이 안 끝났으면 이번 틱 건너뜀(잡 실행 자체는 runner 의 전역 큐가
 *    직렬화하므로, 이 가드는 due 판정 루프의 중첩만 막는다).
 *  - 수동 실행(runNow API)도 runner.enqueueRun 하나를 공유 — 스케줄과 수동이 같은 직렬 큐.
 */

import { listJobs, isDue } from './store.js';
import { enqueueRun, runnerStatus } from './runner.js';

let _timer = null;
let _ticking = false;
let _lastTick = 0;

function tick() {
  if (_ticking) return; // 재진입 가드
  _ticking = true;
  try {
    const now = Date.now();
    _lastTick = now;
    for (const j of listJobs()) {
      if (isDue(j, now)) enqueueRun(j.id, 'schedule');
    }
  } finally { _ticking = false; }
}

export function startVmCloneScheduler() {
  if (_timer) return;
  _timer = setInterval(tick, 60_000);
  _timer.unref?.(); // 테스트/종료 시 프로세스를 붙잡지 않게
}

export function schedulerStatus() { return { lastTick: _lastTick, ...runnerStatus() }; }
