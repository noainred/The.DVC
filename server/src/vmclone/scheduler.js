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
import { ensureVmCloneDemo, isVmCloneDemoJob } from '../mock/demo/vmclone.js';
import { isMockMode } from '../mock/demo/flags.js'; // v2.717: 데모(mock) 잡 시드(비어 있을 때만)

let _timer = null;
let _ticking = false;
let _lastTick = 0;
// v2.719(감사 R1-07): live 모드에서 건너뛴 데모 잡(만기 도달분) — 조용히 빼지 않고 상태·콘솔에 밝힌다.
let _demoSkipped = { lastCount: 0, total: 0, at: null, reason: '' };
let _demoWarned = false;

/** 만기 잡을 실행할 것 / 건너뛸 데모 잡으로 나눈다(순수 — mock 판정은 인자로). */
export function dueJobsOf(jobs, now, { mock = isMockMode() } = {}) {
  const run = [], skipped = [];
  for (const j of jobs || []) {
    if (!isDue(j, now)) continue;
    if (!mock && isVmCloneDemoJob(j)) skipped.push(j); else run.push(j);
  }
  return { run, skipped };
}

function tick() {
  if (_ticking) return; // 재진입 가드
  _ticking = true;
  ensureVmCloneDemo().catch((e) => console.warn(`[vmclone] 데모 잡 등록 실패: ${e?.message || e}`));
  try {
    const now = Date.now();
    _lastTick = now;
    const { run, skipped } = dueJobsOf(listJobs(), now);
    for (const j of run) enqueueRun(j.id, 'schedule');
    if (skipped.length) {
      if (!_demoWarned) { _demoWarned = true; console.warn(`[vmclone] 데이터 소스가 live 라 데모 복제 잡 ${skipped.length}개를 실행하지 않습니다 — 필요 없으면 VM 복제 화면에서 삭제하세요.`); }
      _demoSkipped = { lastCount: skipped.length, total: _demoSkipped.total + skipped.length, at: now, reason: 'live 모드 — 데모 잡은 실행하지 않습니다' };
    }
  } finally { _ticking = false; }
}

export function startVmCloneScheduler() {
  if (_timer) return;
  _timer = setInterval(tick, 60_000);
  setTimeout(() => ensureVmCloneDemo().catch(() => null), 30_000).unref?.(); // 데모: 첫 틱(60초)을 기다리지 않게
  _timer.unref?.(); // 테스트/종료 시 프로세스를 붙잡지 않게
}

export function schedulerStatus() { return { lastTick: _lastTick, demoSkipped: { ..._demoSkipped }, ...runnerStatus() }; }
