/**
 * vmclone/scheduler.js — 복제 잡 스케줄러(v2.299).
 *
 * 60초 틱으로 due 잡(store.isDue — 매일 HH:MM / N시간 간격)을 실행 큐에 넣는다.
 * CLAUDE.md 폴러 규칙 준수:
 *  - 재진입 가드: 이전 틱이 안 끝났으면 이번 틱 건너뜀(잡 실행 자체는 runner 의 전역 큐가
 *    직렬화하므로, 이 가드는 due 판정 루프의 중첩만 막는다).
 *  - 수동 실행(runNow API)도 runner.enqueueRun 하나를 공유 — 스케줄과 수동이 같은 직렬 큐.
 */

import { listJobs, isDue, recoveryDue, markInterruptedRuns } from './store.js';
import { enqueueRun, runnerStatus } from './runner.js';
import { ensureVmCloneDemo, isVmCloneDemoJob } from '../mock/demo/vmclone.js';
import { isMockMode } from '../mock/demo/flags.js'; // v2.717: 데모(mock) 잡 시드(비어 있을 때만)
import { loadVcenterConfig } from '../config.js';
import { directCollectSkipReason } from '../vcenter/collectTarget.js';

let _timer = null;
let _ticking = false;
let _lastTick = 0;
// v2.719(감사 R1-07): live 모드에서 건너뛴 데모 잡(만기 도달분) — 조용히 빼지 않고 상태·콘솔에 밝힌다.
let _demoSkipped = { lastCount: 0, total: 0, at: null, reason: '' };
let _demoWarned = false;

/**
 * 만기 잡을 실행할 것 / 건너뛸 데모 잡으로 나눈다(순수 — mock 판정은 인자로).
 * v2.741(감사 TIMING-01): 재시작으로 중단된 실행이 남은 잡(store.recoveryDue)도 실행한다 — 실행기가 새 스냅샷을 만들기 전에 남은 스냅샷을
 *   지우고 다시 실행한다. 그런 잡은 `resume` 에 id 를 담는다(정규 스케줄 만기가 함께면 정규 실행이다 — 재실행 상한을 적용하지 않는다).
 */
export function dueJobsOf(jobs, now, { mock = isMockMode(), siteVcIds = null } = {}) {
  const run = [], skipped = [], resume = [], delegated = [];
  for (const j of jobs || []) {
    const due = isDue(j, now);
    const rec = !due && recoveryDue(j, now);
    if (!due && !rec) continue;
    // v2.793: 이 노드가 엣지에 위임한(site) vCenter 의 잡은 담당 엣지가 자기 스케줄러로 돌린다 — 여기서 넣으면 같은 VM 을 두 노드가
    //   스냅샷한다(재시작 정리 기록이 남은 잡도 같다 — 그 정리는 로그인할 수 있는 노드의 몫이다).
    if (siteVcIds && siteVcIds.has(String(j.vcenterId))) { delegated.push(j); continue; }
    if (!mock && isVmCloneDemoJob(j)) { skipped.push(j); continue; }
    run.push(j);
    if (rec) resume.push(j.id);
  }
  return { run, skipped, resume, delegated };
}

/** 이 노드의 vCenter 설정에서 엣지 위임(site) id 집합. 설정을 못 읽으면 null(거르지 않는다 — 실행기가 로그인 전에 다시 본다). */
export function siteVcenterIds() {
  try {
    const out = new Set();
    for (const v of loadVcenterConfig().vcenters || []) if (directCollectSkipReason(v) === 'site') out.add(String(v.id));
    return out;
  } catch { return null; }
}

function tick() {
  if (_ticking) return; // 재진입 가드
  _ticking = true;
  ensureVmCloneDemo().catch((e) => console.warn(`[vmclone] 데모 잡 등록 실패: ${e?.message || e}`));
  try {
    const now = Date.now();
    _lastTick = now;
    // 데모(mock)에는 실제 엣지가 없다 — 데모 법인 잡도 이 노드가 시뮬레이션한다(실행기의 mock 경로는 vCenter 에 접속하지 않는다).
    const { run, skipped, resume } = dueJobsOf(listJobs(), now, { siteVcIds: isMockMode() ? null : siteVcenterIds() });
    for (const j of run) enqueueRun(j.id, resume.includes(j.id) ? 'resume' : 'schedule');
    if (skipped.length) {
      if (!_demoWarned) { _demoWarned = true; console.warn(`[vmclone] 데이터 소스가 live 라 데모 복제 잡 ${skipped.length}개를 실행하지 않습니다 — 필요 없으면 VM 복제 화면에서 삭제하세요.`); }
      _demoSkipped = { lastCount: skipped.length, total: _demoSkipped.total + skipped.length, at: now, reason: 'live 모드 — 데모 잡은 실행하지 않습니다' };
    }
  } finally { _ticking = false; }
}

export function startVmCloneScheduler() {
  if (_timer) return;
  // v2.741(감사 TIMING-01): 이전 프로세스(업그레이드·재시작 전)가 끝내지 못한 실행을 lastRun 에 남긴다 — 첫 틱(60초)이 남은 스냅샷을 정리하고 다시 실행한다.
  try {
    const n = markInterruptedRuns();
    if (n) console.warn(`[vmclone] 재시작으로 중단된 복제 실행 ${n}개 — 켜져 있는 잡은 다음 확인(약 1분 뒤)에 남은 스냅샷을 정리하고 다시 실행합니다(꺼진 잡은 다시 켜면 그다음 확인에서 정리 — 꺼진 채로는 수동 실행도 하지 않습니다)`);   // v2.767(점검 R2-B3-9): runner 는 꺼진 잡을 수동 실행해도 바로 끝낸다 — 문구를 동작에 맞춤
  } catch (e) { console.warn(`[vmclone] 중단된 실행 확인 실패: ${e?.message || e}`); }
  _timer = setInterval(tick, 60_000);
  setTimeout(() => ensureVmCloneDemo().catch(() => null), 30_000).unref?.(); // 데모: 첫 틱(60초)을 기다리지 않게
  _timer.unref?.(); // 테스트/종료 시 프로세스를 붙잡지 않게
}

export function schedulerStatus() { return { lastTick: _lastTick, demoSkipped: { ..._demoSkipped }, ...runnerStatus() }; }
