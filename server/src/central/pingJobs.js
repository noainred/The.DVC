/**
 * 에이전트 위임 Ping 작업큐(인메모리). 중앙 포탈은 현장 VM IP(특히 사설/내부망)에 직접
 * 못 가므로, 그 vCenter를 담당하는 현장 에이전트가 ping을 대행한다.
 *
 *   UI → POST /api/tools/ip-ping(vcenterId, ips)         → enqueuePing
 *   Agent ← GET  /api/central/ping-jobs?vcenters=...      → takePingJobs (대기 IP 인출)
 *   Agent → POST /api/central/ping-result(vcenterId, ...) → setPingResults
 *   UI ← GET  /api/tools/ip-ping?vcenterId&ips=...        → getPingResults (녹/적 표시)
 *
 * vCenterId 기준으로 키잉한다(UI는 vcenterId를, 에이전트는 자기 vcenters.json의 id를 앎).
 */

const pending = new Map();  // vcenterId -> Map<ip, atMs>   (요청됐으나 아직 ping 안 한 IP)
const results = new Map();  // vcenterId -> Map<ip, { alive, rttMs, at }>

const RESULT_TTL = 5 * 60_000; // 결과 보존 5분
const UP_STICKY_MS = 2 * 60_000; // 최근 'up'은 이 시간 동안 down 보고로 덮어쓰지 않음(멀티홈/멀티에이전트 깜빡임 방지)
const MAX_IPS = 64;            // 한 vCenter당 동시 대기 IP 상한(남용 방지)

/** UI가 ping을 요청 — 대기열에 추가(중복 IP는 갱신). */
export function enqueuePing(vcenterId, ips = []) {
  if (!vcenterId) return 0;
  const m = pending.get(vcenterId) || new Map();
  const now = Date.now();
  for (const ip of ips) {
    const v = String(ip || '').trim();
    if (v && m.size < MAX_IPS) m.set(v, now);
  }
  pending.set(vcenterId, m);
  return m.size;
}

/** 에이전트가 자기 담당 vCenter들의 대기 IP를 인출(인출 즉시 대기열에서 제거). */
export function takePingJobs(vcenterIds = []) {
  const out = {};
  for (const vc of vcenterIds) {
    const m = pending.get(vc);
    if (m && m.size) { out[vc] = [...m.keys()]; pending.delete(vc); }
  }
  return out;
}

/** 에이전트가 ping 결과 보고. results: [{ ip, alive, rttMs }]. */
export function setPingResults(vcenterId, rows = []) {
  if (!vcenterId) return;
  const m = results.get(vcenterId) || new Map();
  const now = Date.now();
  for (const r of rows) {
    if (!r || !r.ip) continue;
    const key = String(r.ip);
    const prev = m.get(key);
    // 도달성은 'OR' — 한 vantage point(중앙/다른 망 에이전트)라도 최근에 응답했으면 up 유지.
    // 다른 곳에서 못 닿아 down을 보고해도 신선한 up을 덮어쓰지 않는다(녹↔적 깜빡임 방지).
    if (!r.alive && prev && prev.alive && (now - prev.at) < UP_STICKY_MS) continue;
    m.set(key, { alive: !!r.alive, rttMs: r.rttMs ?? null, at: now });
  }
  // TTL 만료 정리
  for (const [ip, v] of m) if (now - v.at > RESULT_TTL) m.delete(ip);
  results.set(vcenterId, m);
}

/** UI가 결과 조회 — { ip: { alive, rttMs, at, ageMs } }. 미수행 IP는 결과 없음(pending 여부 포함). */
export function getPingResults(vcenterId, ips = []) {
  const m = results.get(vcenterId) || new Map();
  const pend = pending.get(vcenterId) || new Map();
  const now = Date.now();
  const out = {};
  for (const ip of ips) {
    const key = String(ip);
    const r = m.get(key);
    if (r && now - r.at <= RESULT_TTL) out[key] = { alive: r.alive, rttMs: r.rttMs, ageMs: now - r.at, state: r.alive ? 'up' : 'down' };
    else out[key] = { state: pend.has(key) ? 'pending' : 'unknown' };
  }
  return out;
}
