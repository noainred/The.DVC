/**
 * 중앙 수신(ingest) 트래픽 통계 — 어떤 에이전트가 어떤 데이터를 얼마나 보내는지 추적한다.
 * 사이트 위임 인벤토리 push 등 에이전트→중앙 POST의 '와이어 바이트(Content-Length, 압축 포함)'와
 * 페이로드 요약(vCenter·호스트·VM 수)을 에이전트·엔드포인트별로 집계한다. iftop에서 특정 에이전트
 * 트래픽이 비정상적으로 높을 때 '무엇을 보내는지'를 화면에서 바로 확인하기 위함. 인메모리(재시작 시 초기화).
 */

const byAgent = new Map(); // agent -> { agent, firstAt, lastAt, pushes, wireBytes, byEndpoint: Map, last }
const MAX_AGENTS = 500;

function ewma(prev, sample, alpha = 0.3) { return prev == null ? sample : prev * (1 - alpha) + sample * alpha; }

/**
 * 한 건의 수신 기록.
 * @param agent     에이전트 이름(없으면 '(unknown)')
 * @param endpoint  중앙 경로(예: /inventory)
 * @param wireBytes 와이어 바이트(Content-Length; gzip이면 압축 크기)
 * @param summary   페이로드 요약(선택) { vcenterId, hosts, vms, datastores, networks, alarms, gzip }
 */
export function recordIngest(agent, endpoint, { wireBytes = 0, summary = null } = {}) {
  const key = String(agent || '(unknown)');
  const now = Date.now();
  let a = byAgent.get(key);
  if (!a) {
    if (byAgent.size >= MAX_AGENTS) { // 백스톱: 오래된 항목 정리
      let oldest = null; for (const [k, v] of byAgent) if (!oldest || v.lastAt < oldest[1].lastAt) oldest = [k, v];
      if (oldest) byAgent.delete(oldest[0]);
    }
    a = { agent: key, firstAt: now, lastAt: now, pushes: 0, wireBytes: 0, intervalMsEwma: null, byEndpoint: new Map(), last: null };
    byAgent.set(key, a);
  }
  if (a.lastAt && now > a.lastAt) a.intervalMsEwma = ewma(a.intervalMsEwma, now - a.lastAt);
  a.lastAt = now; a.pushes++; a.wireBytes += wireBytes;
  let e = a.byEndpoint.get(endpoint);
  if (!e) { e = { endpoint, count: 0, wireBytes: 0, lastAt: 0 }; a.byEndpoint.set(endpoint, e); }
  e.count++; e.wireBytes += wireBytes; e.lastAt = now;
  if (summary) a.last = { at: now, endpoint, wireBytes, ...summary };
}

/** 에이전트별 수신 통계(와이어 바이트 내림차순). UI/진단용. */
export function getIngestStats() {
  const now = Date.now();
  const rows = [];
  for (const a of byAgent.values()) {
    const spanSec = Math.max(1, (a.lastAt - a.firstAt) / 1000);
    rows.push({
      agent: a.agent,
      pushes: a.pushes,
      wireBytes: a.wireBytes,
      avgBytes: Math.round(a.wireBytes / a.pushes),
      bytesPerSec: Math.round(a.wireBytes / spanSec),  // 추적기간 평균 수신율
      intervalSec: a.intervalMsEwma != null ? Math.round(a.intervalMsEwma / 1000) : null, // push 평균 간격
      firstAt: a.firstAt, lastAt: a.lastAt, ageSec: Math.round((now - a.lastAt) / 1000),
      byEndpoint: [...a.byEndpoint.values()].sort((x, z) => z.wireBytes - x.wireBytes),
      last: a.last,
    });
  }
  rows.sort((x, z) => z.wireBytes - x.wireBytes);
  const totalBytes = rows.reduce((s, r) => s + r.wireBytes, 0);
  return { rows, totalBytes, agents: rows.length, since: rows.length ? Math.min(...rows.map((r) => r.firstAt)) : null };
}

/** 통계 초기화(진단 리셋용). */
export function resetIngestStats() { byAgent.clear(); }
