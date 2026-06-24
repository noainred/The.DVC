/**
 * 에이전트 위임 iDRAC 스캔 — 온디맨드 작업큐(인메모리).
 *
 * 중앙 포탈은 원격 사이트의 iDRAC(사설/내부망)에 직접 못 닿으므로, 그 사이트의 현장
 * 에이전트가 스캔을 대행한다. UI가 "에이전트 X로 스캔"을 요청하면 reqId로 잡을 적재하고,
 * 에이전트가 자기 이름으로 잡을 인출→로컬 스캔→현지 자동등록→발견 목록을 회신한다.
 * UI는 reqId로 결과를 폴링한다.
 *
 *   UI    → POST /api/admin/idrac/scan(agent, ips, ...)        → enqueueIdracScan → reqId
 *   Agent ← GET  /api/central/idrac-scan-jobs?agent=NAME       → takeIdracScanJobs
 *   Agent → POST /api/central/idrac-scan-result(reqId, found)  → setIdracScanResult
 *   UI    ← GET  /api/admin/idrac/scan-result?reqId=...        → getIdracScanResult
 */

const jobs = new Map();    // reqId -> { reqId, agent, ips, username, password, state, createdAt, takenAt, result, doneAt }
const byAgent = new Map(); // agentLower -> Set<reqId> (대기 중)

const TTL = 10 * 60_000;   // 완료/오류 잡 보존 10분
const MAX_PENDING = 50;    // 에이전트당 동시 대기 잡 상한(남용 방지)

function gc() {
  const now = Date.now();
  for (const [reqId, j] of jobs) {
    const done = j.state === 'done' || j.state === 'error';
    if (done && now - (j.doneAt || 0) > TTL) jobs.delete(reqId);
    else if (!done && now - j.createdAt > TTL) jobs.delete(reqId); // 영영 안 가져간 잡도 정리
  }
}

let seq = 0;
function newReqId() {
  seq = (seq + 1) % 1e6;
  return `idscan_${Date.now().toString(36)}_${seq.toString(36)}`;
}

/** UI가 위임 스캔 요청 → reqId 반환. */
export function enqueueIdracScan(agent, { ips, username, password, vcenterId = '' }) {
  gc();
  const key = String(agent || '').trim().toLowerCase();
  if (!key) return null;
  const pend = byAgent.get(key) || new Set();
  if (pend.size >= MAX_PENDING) return null;
  const reqId = newReqId();
  jobs.set(reqId, { reqId, agent, ips, username, password, vcenterId, state: 'pending', createdAt: Date.now() });
  pend.add(reqId); byAgent.set(key, pend);
  return reqId;
}

/** 에이전트가 자기 이름의 대기 잡을 인출(인출 즉시 running으로 전환, 비밀번호 포함). */
export function takeIdracScanJobs(agentName) {
  const key = String(agentName || '').trim().toLowerCase();
  if (!key) return [];
  const pend = byAgent.get(key);
  if (!pend || !pend.size) return [];
  const out = [];
  for (const reqId of pend) {
    const j = jobs.get(reqId);
    if (!j) continue;
    j.state = 'running'; j.takenAt = Date.now();
    out.push({ reqId, ips: j.ips, username: j.username, password: j.password, vcenterId: j.vcenterId || '' });
  }
  byAgent.delete(key);
  return out;
}

/** 에이전트가 스캔 결과 보고. */
export function setIdracScanResult(reqId, data = {}) {
  const j = jobs.get(reqId);
  if (!j) return false;
  j.state = data.error ? 'error' : 'done';
  j.doneAt = Date.now();
  // 비밀번호 등 민감정보는 저장하지 않는다(result는 발견 목록·요약만).
  j.result = {
    scanned: data.scanned || 0,
    foundCount: data.foundCount ?? (Array.isArray(data.found) ? data.found.length : 0),
    found: Array.isArray(data.found) ? data.found.slice(0, 5000) : [],
    unreachable: data.unreachable || 0,
    notIdrac: data.notIdrac || 0,
    authFailed: data.authFailed || 0,
    registered: data.registered || 0,
    truncated: !!data.truncated,
    durationMs: data.durationMs || null,
    error: data.error || null,
  };
  return true;
}

/** UI가 결과 폴링 — { state: pending|running|done|error|unknown, agent, ...result }. */
export function getIdracScanResult(reqId) {
  gc();
  const j = jobs.get(reqId);
  if (!j) return { state: 'unknown' };
  return { state: j.state, agent: j.agent, takenAt: j.takenAt || null, ...(j.result || {}) };
}
