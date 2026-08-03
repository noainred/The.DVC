/**
 * VM 사용률 누적 통계(인메모리) — 라이트사이징 리포트용.
 * metrics sampler 틱마다 전원 켜진 VM의 순간 CPU/메모리 사용률을 누적(평균·피크)한다.
 * 시계열 DB에 VM별 행을 쌓으면 5,850 VM × 매분 = 하루 수백만 행이라 감당이 안 되므로,
 * VM당 고정 크기 누적기(합/최대/횟수)만 유지한다(O(VM수) 메모리, 행 0개).
 * 서버 재시작 시 초기화된다 — 리포트는 관측 시작 시각(sinceTs)을 함께 표기한다.
 */

const acc = new Map(); // vmId -> { n, cpuSum, memSum, cpuMax, memMax, sinceTs, lastTs }
let _pruneTick = 0;

/** metrics sampler에서 호출 — 스냅샷의 순간값을 누적. 동기·O(VM수)라 이벤트 루프 부담 없음. */
export function updateVmStats(snap, ts = Date.now()) {
  for (const v of snap.vms || []) {
    if (v.powerState !== 'POWERED_ON' || v.template) continue;
    const cpu = v.cpuUsagePct; const mem = v.memUsagePct;
    if (cpu == null && mem == null) continue;
    let e = acc.get(v.id);
    if (!e) { e = { n: 0, cpuSum: 0, memSum: 0, cpuMax: 0, memMax: 0, sinceTs: ts, lastTs: ts }; acc.set(v.id, e); }
    e.n++;
    if (cpu != null) { e.cpuSum += cpu; if (cpu > e.cpuMax) e.cpuMax = cpu; }
    if (mem != null) { e.memSum += mem; if (mem > e.memMax) e.memMax = mem; }
    e.lastTs = ts;
  }
  // 사라진 VM(삭제/이관) 엔트리 정리 — 매 틱 전체 순회 대신 ~60틱마다 1회.
  if (++_pruneTick % 60 === 0) {
    const cutoff = ts - 7 * 86_400_000;
    for (const [id, e] of acc) if (e.lastTs < cutoff) acc.delete(id);
  }
}

/** VM 1대의 누적 통계 → { samples, cpuAvg, memAvg, cpuMax, memMax, sinceTs } | null */
export function vmStatsFor(vmId) {
  const e = acc.get(vmId);
  if (!e || !e.n) return null;
  return {
    samples: e.n,
    cpuAvg: Math.round((e.cpuSum / e.n) * 10) / 10,
    memAvg: Math.round((e.memSum / e.n) * 10) / 10,
    cpuMax: e.cpuMax,
    memMax: e.memMax,
    sinceTs: e.sinceTs,
  };
}

export function vmStatsMeta() {
  let oldest = null;
  for (const e of acc.values()) if (oldest == null || e.sinceTs < oldest) oldest = e.sinceTs;
  return { tracked: acc.size, sinceTs: oldest };
}

/** 테스트용 초기화. */
export function _resetVmStats() { acc.clear(); _pruneTick = 0; }
