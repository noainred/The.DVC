/**
 * VM 사용률 누적 통계(인메모리) — 라이트사이징 리포트용.
 * metrics sampler 틱마다 전원 켜진 VM의 순간 CPU/메모리 사용률을 누적(평균·피크)한다.
 * 시계열 DB에 VM별 행을 쌓으면 5,850 VM × 매분 = 하루 수백만 행이라 감당이 안 되므로,
 * VM당 고정 크기 누적기(합/최대/횟수)만 유지한다(O(VM수) 메모리, 행 0개).
 * 서버 재시작 시 초기화된다 — 리포트는 관측 시작 시각(sinceTs)을 함께 표기한다.
 */

const acc = new Map(); // vmId -> { n, nCpu, nMem, cpuSum, memSum, cpuMax, memMax, sinceTs, lastTs }
let _pruneTick = 0;

/** metrics sampler에서 호출 — 스냅샷의 순간값을 누적. 동기·O(VM수)라 이벤트 루프 부담 없음. */
export function updateVmStats(snap, ts = Date.now()) {
  for (const v of snap.vms || []) {
    if (v.powerState !== 'POWERED_ON' || v.template) continue;
    const cpu = v.cpuUsagePct; const mem = v.memUsagePct;
    if (cpu == null && mem == null) continue;
    let e = acc.get(v.id);
    // v2.603(감사 LEFT2603-03 — 함수 호출로 재현): 예전에는 CPU·메모리 중 **하나만** 있어도 공용 n 을 올려, 못 읽은 쪽의
    // 결측이 평균의 분모에 들어갔다(CPU 80·null·80 → 평균 53.3, 정답 80). v2.550 규약 — null 은 분모에 넣지 않는다.
    // 지표마다 따로 센다. ⚠ 지금 수집기(soapClient pct())는 null 을 내지 않아 운영에서는 잠재 결함이다.
    if (!e) { e = { n: 0, nCpu: 0, nMem: 0, cpuSum: 0, memSum: 0, cpuMax: null, memMax: null, sinceTs: ts, lastTs: ts }; acc.set(v.id, e); }
    e.n++;
    if (cpu != null) { e.nCpu++; e.cpuSum += cpu; if (e.cpuMax == null || cpu > e.cpuMax) e.cpuMax = cpu; }
    if (mem != null) { e.nMem++; e.memSum += mem; if (e.memMax == null || mem > e.memMax) e.memMax = mem; }
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
  // 한 번도 읽지 못한 지표는 평균·최대가 null 이다(0 은 '부하 없음' 이라는 거짓). samples 는 관측 틱 수 그대로.
  const avg = (sum, k) => (k > 0 ? Math.round((sum / k) * 10) / 10 : null);
  return {
    samples: e.n,
    cpuAvg: avg(e.cpuSum, e.nCpu),
    memAvg: avg(e.memSum, e.nMem),
    cpuMax: e.nCpu > 0 ? e.cpuMax : null,
    memMax: e.nMem > 0 ? e.memMax : null,
    cpuSamples: e.nCpu,
    memSamples: e.nMem,
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
