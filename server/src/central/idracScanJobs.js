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

import { expandIpList } from '../idrac/iprange.js';

const jobs = new Map();    // reqId -> { reqId, agent, ips, username, password, state, createdAt, takenAt, result, doneAt, progress }
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

/** UI가 위임 스캔 요청 → reqId 반환. noRegister=true면 에이전트가 스캔만 하고 등록은 보류(UI 확인 후 등록). */
export function enqueueIdracScan(agent, { ips, username, password, vcenterId = '', datacenterId = '', noRegister = false }) {
  gc();
  const key = String(agent || '').trim().toLowerCase();
  if (!key) return null;
  const pend = byAgent.get(key) || new Set();
  // 중복 적재 방지: 같은 에이전트+법인(datacenterId)의 '대기 중' 스캔 잡이 이미 있으면 새로 만들지 않고
  // 그 reqId를 그대로 반환한다. (버그: 스캔 버튼 중복 클릭·주기 스캐너 겹침으로 같은 대역 잡이 쌓임)
  const dcNorm = String(datacenterId || '').trim();
  for (const rid of pend) {
    const jj = jobs.get(rid);
    if (jj && (jj.action || 'scan') === 'scan' && jj.state === 'pending'
      && String(jj.datacenterId || '').trim() === dcNorm) {
      return rid;
    }
  }
  if (pend.size >= MAX_PENDING) return null;
  const reqId = newReqId();
  // 총 IP 수를 미리 계산해 UI가 진행률 분모를 바로 표시할 수 있게 한다(스캔 max=2048 반영).
  let total = 0;
  try { total = Math.min(expandIpList(ips).ips.length, 2048); } catch { total = 0; }
  jobs.set(reqId, { reqId, agent, action: 'scan', ips, username, password, vcenterId, datacenterId, noRegister: !!noRegister, state: 'pending', createdAt: Date.now(), progress: { scanned: 0, total, at: Date.now() } });
  pend.add(reqId); byAgent.set(key, pend);
  return reqId;
}

/** UI가 위임 '등록' 요청(스캔에서 확인한 found 목록을 에이전트 현지에 등록) → reqId 반환. */
export function enqueueIdracRegister(agent, { found, username, password, vcenterId = '', mode = 'merge' }) {
  gc();
  const key = String(agent || '').trim().toLowerCase();
  if (!key) return null;
  if (!Array.isArray(found) || !found.length) return null;
  const pend = byAgent.get(key) || new Set();
  if (pend.size >= MAX_PENDING) return null;
  const reqId = newReqId();
  jobs.set(reqId, { reqId, agent, action: 'register', found, username, password, vcenterId, mode, state: 'pending', createdAt: Date.now(), progress: { scanned: 0, total: found.length, at: Date.now() } });
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
    out.push({ reqId, action: j.action || 'scan', ips: j.ips, username: j.username, password: j.password, vcenterId: j.vcenterId || '', noRegister: !!j.noRegister, found: j.found || undefined, mode: j.mode || 'merge' });
  }
  byAgent.delete(key);
  return out;
}

/** 에이전트가 스캔 진행률 보고(중간) — { scanned, total, found }. */
export function setIdracScanProgress(reqId, { scanned, total, found } = {}) {
  const j = jobs.get(reqId);
  if (!j) return false;
  j.progress = {
    scanned: Number(scanned) || 0,
    total: Number(total) || j.progress?.total || 0,
    found: found != null ? Number(found) || 0 : (j.progress?.found || 0),
    at: Date.now(),
  };
  if (j.state === 'running' || j.state === 'pending') j.state = 'running';
  return true;
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
  return { state: j.state, agent: j.agent, takenAt: j.takenAt || null, progress: j.progress || null, ...(j.result || {}) };
}

/**
 * 진행 중·최근 위임 스캔/등록 잡 목록(민감정보 제외). '스캔 현황' 패널이 어디서든 진행을 확인하게 한다.
 * 최신순 정렬. 비밀번호/IP 원문은 노출하지 않고 요약만.
 */
export function listIdracScanJobs() {
  gc();
  const out = [];
  for (const j of jobs.values()) {
    out.push({
      reqId: j.reqId,
      agent: j.agent,
      action: j.action || 'scan',
      datacenterId: j.datacenterId || '', // '대상' 칸에 표시할 스캔 대상 법인(DataCenter)
      vcenterId: j.vcenterId || '',
      state: j.state,
      progress: j.progress ? { scanned: j.progress.scanned || 0, total: j.progress.total || 0, found: j.progress.found || 0, at: j.progress.at || null } : null,
      result: j.result ? { foundCount: j.result.foundCount || 0, registered: j.result.registered || 0, scanned: j.result.scanned || 0, error: j.result.error || null, durationMs: j.result.durationMs || null } : null,
      createdAt: j.createdAt || null,
      takenAt: j.takenAt || null,
      doneAt: j.doneAt || null,
    });
  }
  out.sort((a, z) => (z.createdAt || 0) - (a.createdAt || 0));
  return out;
}
