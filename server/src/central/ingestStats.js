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
export function resetIngestStats() { byAgent.clear(); plainState.clear(); }

// ── 무압축 대형 push 경고 승격(v2.344, 성능 점검 #12) ─────────────────────────────
// 구버전 엣지(gzip push 미지원)나 AGENT_PUSH_GZIP=false 엣지는 인벤토리를 push당 5~10배
// 크기로 보낸다(WAN·중앙 파싱 5~10배). 종전엔 진단 표의 '무압축' 표기뿐이라 관리자가 그
// 화면을 열어야만 알 수 있었다 → 알림 채널(Slack/Teams/웹훅)로 승격한다.
// 판정은 상태전이 방식: 임계 크기 이상 무압축 push 가 '연속 N회(기본 3)'면 경고 1회(일시
// gzip 폴백 오탐 방지), 이후 gzip push 관측 시 해소 1회. 소형 push(빈 엣지 등)는 무압축이어도
// 실해가 없어 무시한다. 상태는 인메모리(재시작 시 초기화 — 무압축이 지속되면 재경고돼 무해).
const PLAIN_WARN_BYTES = Number(process.env.INGEST_PLAIN_WARN_BYTES) || 512 * 1024; // 판정 최소 크기(와이어)
const PLAIN_WARN_STREAK = Math.max(1, Number(process.env.INGEST_PLAIN_WARN_STREAK) || 3);
const plainState = new Map(); // agent -> { streak, warned, lastBytes }

export function ingestPlainThresholds() { return { bytes: PLAIN_WARN_BYTES, streak: PLAIN_WARN_STREAK }; }

/**
 * 인벤토리 push 1건의 압축 상태를 추적하고, 알릴 전이가 생기면 이벤트를 반환한다(없으면 null).
 * 경고는 에이전트당 1회(warned 래치) — 재발화 억제는 notify 의 전역 억제 창과 별개로 여기서 보장.
 * @returns {null | {type:'warned'|'resolved', agent, wireBytes, streak}}
 */
export function noteInventoryCompression(agent, { gzip, wireBytes = 0 } = {}) {
  const key = String(agent || '(unknown)');
  let s = plainState.get(key);
  if (!s) {
    if (plainState.size >= MAX_AGENTS) plainState.clear(); // 백스톱(위조 agent 이름 폭주 대비)
    s = { streak: 0, warned: false, lastBytes: 0 };
    plainState.set(key, s);
  }
  if (gzip) {
    const wasWarned = s.warned;
    s.streak = 0; s.warned = false; s.lastBytes = wireBytes;
    return wasWarned ? { type: 'resolved', agent: key, wireBytes, streak: 0 } : null;
  }
  if (wireBytes < PLAIN_WARN_BYTES) return null; // 소형 무압축은 무해 — streak 유지(대형 지속에만 경고)
  s.streak++; s.lastBytes = wireBytes;
  if (!s.warned && s.streak >= PLAIN_WARN_STREAK) {
    s.warned = true;
    return { type: 'warned', agent: key, wireBytes, streak: s.streak };
  }
  return null;
}
