/**
 * IP 스캔 폴러 — 설정된 대역을 주기적으로 TCP 커넥트 스캔해 결과를 저장한다.
 * 분산 환경에서는 각 사이트 인스턴스(에이전트)에서 enable하고 그 사이트 대역을 등록.
 * 한 번에 한 스캔만 실행(중복 방지), 실패는 격리, 이벤트 루프 비차단.
 */

import { runScan, SCAN_DEADLINE_CODE } from './scanRunner.js';
import { loadScanSettings, mergeScanResults, pruneScanResults, recordAgentReport, recordAgentIncomplete, sweepReleases, listScanAgents, releaseHoldStatus, getAgentReports, LOCAL } from './scanStore.js';
import { enabledVcRanges } from './rangeStore.js';
import { recordScanLog } from './scanLog.js';
import { scheduleVcRangeMigration } from './vcRangeMigrate.js';
import { scanStarted, scanFinished, registerScanResumer, journalFor, isResumePending } from '../util/scanJournal.js'; // v2.737: 재시작으로 중단된 스캔 기록·재개 // v2.691: vCenter 별 대역 → 수집 에이전트로 1회 이전 // v2.636: 실행 로그(시작·종료·실패·건너뜀·중복 실행)
import { numOrNull } from '../util/numOrNull.js';

// 로컬 폴러가 실제로 스캔할 대역 = __local__ 설정 대역 ∪ enabled인 모든 vCenter 대역(유니크).
// v2.691: vCenter 별 대역은 수집 에이전트로 옮겨지고(vcRangeMigrate) 옮기지 못한 것만 남는다 — 남은 것은 예전처럼 중앙이 스캔한다.
function effectiveRanges(s) {
  return [...new Set([...(s.ranges || []), ...enabledVcRanges()])];
}

// 일정 시간 응답이 없으면 'IP 해제'로 간주(이력에 down 기록). 스캔 주기의 3배 또는 최소 3시간.
function releaseIdleMs() { return Math.max(loadScanSettings().intervalMs * 3, 3 * 3_600_000); }

let timer = null;
let releaseTimer = null;
let running = false;
let lastRun = null;
let progress = null; // 실행 중 진행률: { total, done, alive, startedAt }

// v2.639: 바깥 호출부 0건(라우트는 startScan 을 쓴다) — 모듈 내부 함수(export 를 뗐다).
async function runScanOnce({ manual = false, resumeOf = null } = {}) {
  const trigger = resumeOf ? 'resume' : manual ? 'manual' : 'periodic';
  if (running) {
    if (manual) recordScanLog({ event: 'busy', trigger, message: '이미 스캔 중이라 새로 시작하지 않았습니다.' });
    return { ok: false, reason: '이미 스캔 중입니다.' };
  }
  const s = loadScanSettings();
  const ranges = effectiveRanges(s);
  // 주기 스캔은 __local__ enabled이거나, enabled인 vCenter 대역이 하나라도 있으면 돈다.
  if (!manual && !s.enabled && !enabledVcRanges().length) {
    lastRun = { at: Date.now(), skipped: '비활성' };
    recordScanLog({ event: 'skip', trigger, message: '주기 스캔이 꺼져 있습니다(이 포탈 설정 비활성 · 켜진 vCenter 대역 없음).' });
    return { ok: false, reason: '비활성' };
  }
  if (!ranges.length) {
    lastRun = { at: Date.now(), skipped: '대역 없음' };
    recordScanLog({ event: 'skip', trigger, message: '스캔할 대역이 없습니다.' });
    return { ok: false, reason: '스캔 대역이 없습니다.' };
  }
  running = true;
  const started = Date.now();
  progress = { total: 0, done: 0, alive: 0, startedAt: started };
  // v2.737: 실행 중 스캔 기록 — 업그레이드·재시작으로 끊기면 다음 기동이 '중단됨' 으로 기록하고 다시 시작한다(재개 상한 2회).
  scanStarted('ipscan', 'local', { label: `IP 스캔(대역 ${ranges.length}개)`, trigger, resumeOf, meta: { manual: !!manual, ranges: ranges.length } });
  if (resumeOf) recordScanLog({ event: 'resume', trigger, message: `재시작으로 중단된 스캔을 다시 시작합니다(${new Date(resumeOf.since || started).toISOString()} 시작분 · 재개 ${(resumeOf.resumes || 0) + 1}회째).` });
  recordScanLog({ event: 'start', trigger, at: started, ranges: ranges.length, rangesSample: ranges.slice(0, 5),
    message: `대역 ${ranges.length}개 · 포트 ${(s.ports || []).length}개 · 동시 ${s.concurrency} · 시한 ${s.timeoutMs}ms${s.ping ? ' · ICMP 병행' : ''}` });
  try {
    // 스캔은 별도 프로세스에서(v2.363) — TCP/ping/역DNS 부하·FD 를 포탈에서 격리.
    const { scanned, alive } = await runScan(
      { ranges, ports: s.ports, concurrency: s.concurrency, timeoutMs: s.timeoutMs, reverseDns: s.reverseDns, ping: s.ping },
      { onProgress: (done, total, aliveCount) => { progress = { total, done, alive: aliveCount, startedAt: started }; } },
    );
    mergeScanResults(alive, Date.now(), LOCAL);
    recordAgentReport(LOCAL, { scanned, alive: alive.length, durationMs: Date.now() - started });
    // 중앙 직접 스캔이 끝난 직후의 해제 마킹은 '중앙(LOCAL)이 소유한 IP'에만 적용한다.
    // (원격 사이트 에이전트가 보고한 IP를 중앙 스캔 결과로 오탐 down하지 않게 — 전역 staleness는 releaseTimer가 담당)
    sweepReleases(releaseIdleMs(), { agent: LOCAL });
    pruneScanResults(s.retentionDays);
    lastRun = { at: Date.now(), durationMs: Date.now() - started, scanned, alive: alive.length, manual };
    recordScanLog({ event: 'finish', trigger, ranges: ranges.length, scanned, alive: alive.length, durationMs: lastRun.durationMs });
    return { ok: true, ...lastRun };
  } catch (e) {
    // v2.733(점검 3회차 C1-02 — v2.732 B4-02 가 만든 회귀): 시한 초과·실패한 스캔은 결과를 남기지 않아 해제 판정이 살아 있는 IP 를
    //   down 으로 바꿨다. ① 워커가 시한 전에 찾은 생존 IP(부분 결과)로 **마지막 확인 시각만** 갱신하고 ② 이 포탈의 '스캔 미완료' 를
    //   기록한다 — 해제 판정(sweepReleases)은 완료된 스캔이 해제 기준 시간 안에 올 때까지 보류한다. 같은 스캔을 메인에서 다시 돌리지 않는다.
    const durationMs = Date.now() - started;
    const code = e?.code === SCAN_DEADLINE_CODE ? SCAN_DEADLINE_CODE : 'error';
    const partial = Array.isArray(e?.partialAlive) ? e.partialAlive : [];
    let partialAlive = 0;
    if (partial.length) {
      try { partialAlive = mergeScanResults(partial, Date.now(), LOCAL, { seenOnly: true }).merged; }
      catch (me) { console.warn(`[ipscan] 부분 결과 병합 실패: ${me?.message || me}`); }
    }
    const done = Number.isFinite(e?.progress?.done) ? e.progress.done : null;
    const total = Number.isFinite(e?.progress?.total) ? e.progress.total : null;
    recordAgentIncomplete(LOCAL, { code, reason: e?.message || String(e), durationMs, partial: partialAlive, done, total });
    lastRun = { at: Date.now(), error: e.message, manual, incomplete: true, code, durationMs, partialAlive, ...(done != null ? { done, total } : {}) };
    recordScanLog({ event: 'fail', trigger, ranges: ranges.length, durationMs, scanned: done, alive: partialAlive,
      message: `${e?.message || String(e)} — 스캔 미완료로 기록${done != null && total != null ? `(${done}/${total} 스캔)` : ''} · 시한 전에 찾은 생존 IP ${partialAlive}개는 마지막 확인 시각만 갱신 · 해제(down) 판정은 완료된 스캔이 올 때까지 보류` });
    return { ok: false, reason: e.message };
  } finally { running = false; progress = null; scanFinished('ipscan', 'local'); }
}

/**
 * v2.737: 재시작으로 중단된 스캔의 재개(util/scanJournal). 기동 30초 뒤의 주기 스캔이 이미 다시 돌았으면(그 시작이 대기 항목을 덮는다) 여기
 * 오지 않는다. 주기가 꺼져 있어 수동 스캔만 끊긴 경우가 여기다.
 */
export async function resumeIpScan(entry) {
  if (running) return { outcome: 'covered', note: '이미 다시 스캔 중입니다' };
  if (lastRun && !lastRun.skipped && (lastRun.at || 0) >= (entry.detectedAt || 0)) return { outcome: 'covered', note: '재시작 뒤 스캔이 이미 끝났습니다' };
  const s = loadScanSettings();
  if (!effectiveRanges(s).length) return { outcome: 'gone', note: '스캔할 대역이 없습니다' };
  if (!entry.meta?.manual && !s.enabled && !enabledVcRanges().length) return { outcome: 'skipped', note: '주기 스캔이 꺼져 있습니다' };
  runScanOnce({ manual: !!entry.meta?.manual, resumeOf: entry }).catch((e) => console.error('[ipscan] 자동 재개 실패:', e.message));
  return { outcome: 'started', note: '중단된 IP 스캔을 처음부터 다시 시작했습니다(대역 전체)' };
}
registerScanResumer('ipscan', resumeIpScan);

/** 비동기로 스캔 시작(요청은 즉시 반환, 창을 닫아도 백그라운드에서 계속 실행). */
export function startScan({ manual = true } = {}) {
  if (running) {
    recordScanLog({ event: 'busy', trigger: manual ? 'manual' : 'periodic', message: '이미 스캔 중이라 새로 시작하지 않았습니다.' });
    return { ok: false, reason: '이미 스캔 중입니다.', running: true };
  }
  const s = loadScanSettings();
  if (!effectiveRanges(s).length) {
    recordScanLog({ event: 'skip', trigger: manual ? 'manual' : 'periodic', message: '스캔할 대역이 없습니다.' });
    return { ok: false, reason: '스캔 대역이 없습니다.' };
  }
  runScanOnce({ manual }).catch((e) => console.error('[ipscan] 백그라운드 스캔 실패:', e.message));
  return { ok: true, started: true };
}

export function scanStatus() {
  const s = loadScanSettings();
  const vcN = enabledVcRanges().length;
  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : null;
  // 폴러는 __local__ enabled이거나 enabled인 vCenter 대역이 있으면 실제로 돈다 → enabled를 그 기준으로 노출.
  // v2.733: releaseHold — 해제 판정 보류 현황(완료된 스캔이 기준 안에 없는 에이전트의 IP 를 down 으로 바꾸지 않은 것).
  const j = journalFor('ipscan'); // v2.737: 재시작으로 중단된 스캔(재개 대기)·최근 재개 결과
  return { enabled: s.enabled || vcN > 0, localEnabled: s.enabled, ranges: effectiveRanges(s).length, localRanges: (s.ranges || []).length, vcRanges: vcN, intervalMs: s.intervalMs, running, lastRun, progress: progress ? { ...progress, pct } : null, releaseHold: releaseHoldStatus(),
    ...(firstScanPlan ? { firstScan: { ...firstScanPlan } } : {}), // v2.741: 기동 뒤 첫 스캔 예정(마지막 완료 스캔이 주기 안이면 미룬다)
    journal: { interrupted: j.interrupted, recent: j.recent.slice(0, 5), resumeLimit: j.resumeLimit } };
}

/*
 * v2.741(감사 TIMING-06): 기동 뒤 첫 주기 스캔은 **마지막 완료 스캔 + 주기** 에 맞춘다. 예전에는 기동 30초 뒤 언제나 대역 전체를 다시
 *   스캔했다 — 업그레이드·재시작마다(주기를 길게 둔 현장일수록) 주기와 무관한 전체 스캔이 한 번 더 나갔다(형제 iDRAC 스캔은 이미
 *   lastScanCycleAt 로 '재시작이 스캔을 앞당기지 않게' 고쳤다 — 비대칭). 기준은 scanStore 에 영속된 이 포탈(LOCAL)의 마지막 **완료** 시각
 *   (reports[LOCAL].at — 미완료 기록은 이 값을 바꾸지 않는다)이다.
 *   · 재시작으로 끊긴 스캔이 재개를 기다리면(v2.737 scanJournal) 예전처럼 30초 뒤 시작한다 — 그 시작이 대기 항목을 덮는다(재개 유지).
 *   · 완료 기록이 없으면(처음 · 계속 실패) 30초 뒤. 주기를 넘길 수는 없다(시계가 뒤로 간 경우도 최대 한 주기).
 */
export const FIRST_SCAN_MIN_DELAY_MS = 30_000;
/** 기동 뒤 첫 주기 스캔까지의 지연(순수 — 테스트 고정). */
export function firstScanDelayMs({ intervalMs, lastDoneAt = null, pendingResume = false, now = Date.now() } = {}) {
  const iv = numOrNull(intervalMs);
  const last = numOrNull(lastDoneAt);
  if (pendingResume || iv == null || iv <= 0 || last == null || last <= 0) return FIRST_SCAN_MIN_DELAY_MS;
  return Math.max(FIRST_SCAN_MIN_DELAY_MS, Math.min(iv, last + iv - now));
}
let firstTimer = null;
let firstScanPlan = null; // { at, delayMs, reason } — 상태 화면이 '왜 지금 스캔하지 않는가' 를 말하게

export function rescheduleScanPoller() {
  if (timer) clearInterval(timer);
  const { intervalMs } = loadScanSettings();
  timer = setInterval(() => runScanOnce().catch(() => {}), intervalMs);
  timer.unref?.();
  return intervalMs;
}

export function startIpScanPoller() {
  const s = loadScanSettings();
  // v2.737: 이전 프로세스가 끝내지 못한 스캔을 로그에 남긴다(조용히 사라지지 않게) — 재개는 기동 30초 뒤 주기 스캔 또는 scanJournal 이 한다.
  try {
    for (const x of journalFor('ipscan').interrupted) {
      recordScanLog({ event: 'interrupted', trigger: x.trigger || '', at: x.detectedAt,
        message: `업그레이드·재시작으로 끝나지 못한 스캔이 있습니다(${new Date(x.since || x.detectedAt).toISOString()} 시작) — ${s.enabled || enabledVcRanges().length ? '곧 다시 스캔합니다' : '수동 스캔이었으므로 자동 재개가 다시 시작합니다'}.` });
    }
  } catch (e) { console.warn(`[ipscan] 중단 기록 실패: ${e.message}`); }
  // 첫 스캔은 '마지막 완료 + 주기'(최소 부팅 30초 뒤 — 다른 수집과 겹치지 않게), 이후 주기 반복(v2.741 TIMING-06 — 위 firstScanDelayMs).
  //   주기 setInterval 은 첫 스캔 때 건다 — 기동 시각에 걸면 첫 스캔을 미룬 만큼 두 스캔이 바짝 붙는다.
  const lastDoneAt = numOrNull(getAgentReports()?.[LOCAL]?.at);
  const pendingResume = isResumePending('ipscan', 'local');
  const delayMs = firstScanDelayMs({ intervalMs: s.intervalMs, lastDoneAt, pendingResume });
  firstScanPlan = { at: Date.now() + delayMs, delayMs, reason: pendingResume ? 'resume-pending' : delayMs > FIRST_SCAN_MIN_DELAY_MS ? 'recent-scan' : 'boot', lastDoneAt };
  // v2.591 L9: 기동 스태거 전 reschedule 이 먼저 왔으면 그 interval 을 지운다(IP 스캔 주기가 두 벌이 되지 않게).
  if (timer) { clearInterval(timer); timer = null; }
  if (releaseTimer) clearInterval(releaseTimer);
  if (firstTimer) clearTimeout(firstTimer);
  firstTimer = setTimeout(() => {
    firstTimer = null; firstScanPlan = null;
    runScanOnce().catch((e) => console.error('[ipscan] 실패:', e.message));
    if (timer) clearInterval(timer);
    timer = setInterval(() => runScanOnce().catch(() => {}), loadScanSettings().intervalMs);
    timer.unref?.();
  }, delayMs);
  firstTimer.unref?.();
  if (firstScanPlan.reason === 'recent-scan') console.log(`[ipscan] 마지막 완료 스캔(${new Date(lastDoneAt).toISOString()})이 주기 안이라 첫 스캔을 ${Math.round(delayMs / 60_000)}분 뒤로 미룹니다(재시작이 스캔을 앞당기지 않게)`);
  // 분산 에이전트가 중앙으로 보고하는 경우 로컬 스캔이 꺼져 있어도 '해제' 전이는 기록해야 하므로
  // 별도 주기(10분)로 미응답 IP를 마킹한다(중앙/로컬 공통).
  releaseTimer = setInterval(() => {
    try {
      // 에이전트별 스캔 주기(최대 7일 설정 가능) 기준으로 각자 임계(주기×3, 최소 3h)를 적용한다 —
      // 로컬 주기 기준 일괄 판정이면 주기가 긴 원격 사이트 IP가 스캔 사이마다 가짜 down/up 플립된다.
      const idleMsByAgent = new Map(listScanAgents().map((a) => [a.name, Math.max((a.intervalMs || 0) * 3, 3 * 3_600_000)]));
      sweepReleases(releaseIdleMs(), { idleMsByAgent });
    } catch { /* */ }
  }, 10 * 60_000);
  releaseTimer.unref?.();
  // v2.691: 'vCenter 별 스캔 대역' 을 수집 에이전트의 스캔 대역으로 1회 옮긴다(이미 했으면 아무것도 하지 않는다).
  try { scheduleVcRangeMigration(); } catch (e) { console.warn(`[ipscan] 대역 이전 예약 실패: ${e.message}`); }
  console.log(`[ipscan] poller started (enabled=${s.enabled}, ranges=${s.ranges.length}, every ${Math.round(s.intervalMs / 1000)}s)`);
}
