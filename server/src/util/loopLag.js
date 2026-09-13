/**
 * 이벤트 루프 지연(lag) 모니터 — 대용량 동기 작업(수집 SOAP 파싱·집계·bulk write)이 메인
 * 루프를 얼마나 오래 막는지 계측한다. docs/ARCH-HEAVY-JOB-ISOLATION.md §10-0 '계측 먼저'의
 * 구현 — 실제 병목(수집 재구성 vs 이상탐지 vs 쓰기)을 숫자로 확정하기 위한 선행 단계.
 *
 * 설계 원칙(중요):
 *  - **완전 additive**: 실패/미지원이면 조용히 no-op. 서버 부팅·동작에 어떤 영향도 주지 않는다.
 *  - **평소엔 조용**: 임계(기본 500ms) 초과 구간만 로깅 → 실제 스톨만 눈에 띈다.
 *  - `perf_hooks.monitorEventLoopDelay`(히스토그램) 기반, 추가 의존성 없음.
 *  - 기본 활성. `LOOP_LAG_MONITOR=0` 으로 비활성. 임계·주기는 env 로 조정.
 */
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
// v2.498: 창 요약을 성능 측정기에 넘겨 24시간 추이·hang 이벤트(로그 파일)로 남긴다. 여기 로직은 그대로.
import { recordLoopWindow } from '../perf/monitor.js';

let started = false;

/** 부팅 시 1회 호출. 재호출·비활성 플래그·오류에 안전(no-op). */
export function startLoopLagMonitor() {
  if (started) return;
  if (process.env.LOOP_LAG_MONITOR === '0') return;
  started = true;
  try {
    const warnMs = Math.max(50, Number(process.env.LOOP_LAG_WARN_MS) || 500);        // 이 이상 멈추면 로깅
    const everyMs = Math.max(5_000, Number(process.env.LOOP_LAG_INTERVAL_MS) || 30_000);
    const h = monitorEventLoopDelay({ resolution: 20 });
    h.enable();
    // 이벤트 루프 이용률(ELU) 델타의 기준점 — 루프가 '막혔는지' 와 '바쁜지' 는 다르다.
    let prevElu = typeof performance.eventLoopUtilization === 'function' ? performance.eventLoopUtilization() : null;
    const timer = setInterval(() => {
      try {
        const maxMs = h.max / 1e6;               // ns → ms
        const p99Ms = h.percentile(99) / 1e6;
        const meanMs = h.mean / 1e6;
        if (Number.isFinite(maxMs) && maxMs >= warnMs) {
          console.warn(
            `[loop-lag] 최근 ${Math.round(everyMs / 1000)}s 이벤트루프 지연 `
            + `max=${maxMs.toFixed(0)}ms p99=${p99Ms.toFixed(0)}ms mean=${meanMs.toFixed(1)}ms `
            + '— 이 구간 동기 작업(수집 파싱/집계/bulk write)이 메인 루프를 막았을 수 있음',
          );
        }
        // v2.498: 창 요약을 영속 계측으로(임계 초과면 hang 이벤트 + 파일 기록). 실패는 무시.
        try {
          const elu = typeof performance.eventLoopUtilization === 'function'
            ? performance.eventLoopUtilization(prevElu) : null;
          if (elu) prevElu = performance.eventLoopUtilization();
          recordLoopWindow({
            maxMs, p99Ms, meanMs, windowMs: everyMs,
            eluPct: elu && Number.isFinite(elu.utilization) ? Math.round(elu.utilization * 1000) / 10 : null,
          });
        } catch { /* 계측 실패는 서비스에 영향 없음 */ }
        h.reset();
      } catch { /* 계측 실패는 무시 — 서비스 영향 없음 */ }
    }, everyMs);
    if (timer && typeof timer.unref === 'function') timer.unref();   // 프로세스 종료를 막지 않게
  } catch (e) {
    // perf_hooks 미지원/오류 — 계측만 비활성, 서버는 정상.
    try { console.warn(`[loop-lag] 모니터 비활성(${e && e.message})`); } catch { /* */ }
  }
}
