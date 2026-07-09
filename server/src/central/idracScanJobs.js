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

// 스캔에 실제로 사용된 자격증명의 '지문' — 평문은 절대 남기지 않는다. 계정명 + 비밀번호 길이 +
// 비복원 해시(djb2)만 표시해, "다른 법인은 되는데 이 법인만 인증 실패"일 때 법인 간 설정을
// 눈으로 비교(계정/길이/지문이 같은지)할 수 있게 한다. 앞뒤 공백은 [공백] 표기로 드러낸다.
function credFingerprint(username, password) {
  const u = String(username ?? '');
  const p = String(password ?? '');
  let h = 5381; for (let i = 0; i < p.length; i++) h = (((h << 5) + h) ^ p.charCodeAt(i)) >>> 0;
  const edge = /^\s|\s$/.test(p) ? ' · ⚠앞뒤공백' : '';
  return `계정 '${u}'${/^\s|\s$/.test(u) ? '(⚠공백)' : ''} · 비번 ${p.length}자·#${h.toString(16).slice(0, 4)}${edge}`;
}

const jobs = new Map();    // reqId -> { reqId, agent, ips, username, password, state, createdAt, takenAt, result, doneAt, progress, events }
const byAgent = new Map(); // agentLower -> Set<reqId> (대기 중)
const agentPolls = new Map(); // agentLower -> 마지막 잡 인출 폴링 시각(ms) — '에이전트가 살아있나' 진단용

const TTL = 10 * 60_000;   // 완료/오류 잡 보존 10분
const MAX_PENDING = 50;    // 에이전트당 동시 대기 잡 상한(남용 방지)
const MAX_EVENTS = 300;    // 잡당 이벤트 로그 상한
// claim→ack 2단계 확인응답: 인출(claim) 후 첫 진행/결과 보고(ack)가 ACK_TIMEOUT 내에 없으면,
// 엣지가 인출 직후 재시작/단절된 것으로 보고 잡을 다시 대기로 되돌려 재인출 가능하게 한다(유실 방지).
const ACK_TIMEOUT_MS = Number(process.env.IDRAC_SCAN_ACK_TIMEOUT_MS) || 90_000;
const MAX_CLAIMS = 3;      // 재인출 한도(초과 시 오류 종결)

/** 잡 이벤트 로그 한 줄 추가(로그창용 타임라인). level: info|warn|error */
function addEvent(j, msg, level = 'info') {
  if (!j.events) j.events = [];
  j.events.push({ ts: Date.now(), level, msg: String(msg).slice(0, 300) });
  if (j.events.length > MAX_EVENTS) j.events.splice(0, j.events.length - MAX_EVENTS);
}

/**
 * claim→ack 재수확: 인출(running)됐지만 아직 첫 보고(ack)가 없고 claim 기한을 넘긴 잡을 처리한다.
 * - 재인출 한도(MAX_CLAIMS) 미만: 다시 대기(pending)로 되돌려 재인출 가능하게 한다.
 * - 한도 이상: 오류로 종결(엣지 재시작/네트워크 문제로 판단).
 * push(중앙 동기) 잡은 대상이 아니다. now는 테스트를 위해 주입 가능.
 */
export function reapClaims(now = Date.now()) {
  let requeued = 0, failed = 0;
  for (const [reqId, j] of jobs) {
    if (j.state !== 'running' || j.acked || j.dispatch === 'push') continue;
    if (!j.claimDeadline || now <= j.claimDeadline) continue;
    if ((j.claims || 0) >= MAX_CLAIMS) {
      j.state = 'error'; j.doneAt = now;
      j.result = { scanned: 0, foundCount: 0, found: [], registered: 0, error: `인출 후 확인 응답(진행/결과)이 ${MAX_CLAIMS}회 연속 없어 종료 — 엣지 재시작/네트워크를 확인하세요.` };
      addEvent(j, `인출 후 확인 응답 없음이 ${MAX_CLAIMS}회 반복 — 잡을 오류로 종료(엣지 재시작/네트워크 확인).`, 'error');
      failed++;
      continue;
    }
    // 다시 대기로 되돌려 재인출.
    j.state = 'pending'; j.takenAt = null; j.acked = false; j.claimDeadline = null;
    const key = String(j.agent || '').trim().toLowerCase();
    const pend = byAgent.get(key) || new Set();
    pend.add(reqId); byAgent.set(key, pend);
    addEvent(j, `인출 후 ${Math.round(ACK_TIMEOUT_MS / 1000)}초간 진행/결과 보고가 없어 다시 대기로 되돌렸습니다(엣지 재시작 가능성) — 재인출 대기(시도 ${j.claims || 0}/${MAX_CLAIMS}).`, 'warn');
    requeued++;
  }
  return { requeued, failed };
}

function gc() {
  reapClaims(); // 만료된 claim을 먼저 재수확(재인출 대기로 복귀 또는 오류 종결)
  const now = Date.now();
  for (const [reqId, j] of jobs) {
    const done = j.state === 'done' || j.state === 'error';
    // 미완료 잡은 '마지막 활동'(생성/인출/진행 보고) 기준으로 만료 — createdAt 기준이면 2048 IP처럼
    // 10분을 넘기는 정상 진행(running) 잡이 도중에 삭제돼 에이전트의 결과 회신이 유실된다.
    const lastActivity = done
      ? (j.doneAt || 0)
      : Math.max(j.createdAt || 0, j.takenAt || 0, j.progress?.at || 0);
    if (now - lastActivity > TTL) {
      jobs.delete(reqId);
      // byAgent 대기 셋도 함께 정리 — 남겨두면 유령 reqId가 MAX_PENDING을 영구 점유해
      // 오프라인 에이전트로의 신규 위임이 전부 거부된다.
      const key = String(j.agent || '').trim().toLowerCase();
      const pend = byAgent.get(key);
      if (pend) { pend.delete(reqId); if (!pend.size) byAgent.delete(key); }
    }
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
  // 중복 적재 방지: 같은 에이전트+법인(datacenterId)+대역(ips)의 '대기 중' 스캔 잡이 이미 있으면
  // 새로 만들지 않고 그 reqId를 그대로 반환한다(스캔 버튼 중복 클릭·주기 스캐너 겹침 방지).
  // ips를 키에 포함해야 한다 — 수동 스캔은 datacenterId를 넘기지 않아(dcNorm='') 서로 다른
  // 대역으로 보낸 두 스캔이 같은 잡으로 병합되어 두 번째 요청이 조용히 유실되던 버그 방지.
  const dcNorm = String(datacenterId || '').trim();
  const ipsNorm = String(ips || '').trim();
  for (const rid of pend) {
    const jj = jobs.get(rid);
    if (!jj) { pend.delete(rid); continue; } // gc로 사라진 잡의 잔여 reqId 정리
    if ((jj.action || 'scan') === 'scan' && jj.state === 'pending'
      && String(jj.datacenterId || '').trim() === dcNorm
      && String(jj.ips || '').trim() === ipsNorm) {
      // 대상(대역·법인)이 같아도 자격증명/등록플래그가 다르면 병합하면 안 된다 — 비밀번호를
      // 고쳐 재스캔했는데 옛 잡을 재사용해 틀린 비번으로 스캔되거나, noRegister 의도(등록 보류
      // ↔ 자동등록)가 뒤바뀐다. 다르면 기존 대기 잡을 새 값으로 갱신(가장 최근 의도 반영).
      if (String(jj.username || '') !== String(username || '') || String(jj.password || '') !== String(password || '')
        || !!jj.noRegister !== !!noRegister || String(jj.vcenterId || '') !== String(vcenterId || '')) {
        jj.username = username; jj.password = password; jj.noRegister = !!noRegister; jj.vcenterId = vcenterId;
        addEvent(jj, '동일 대상의 대기 중 스캔 잡을 새 자격증명/옵션으로 갱신했습니다.');
        return rid;
      }
      addEvent(jj, '동일 대상의 대기 중 스캔 잡이 있어 새 요청을 이 잡으로 병합했습니다(중복 방지).');
      return rid;
    }
  }
  if (pend.size >= MAX_PENDING) return null;
  const reqId = newReqId();
  // 총 IP 수를 미리 계산해 UI가 진행률 분모를 바로 표시할 수 있게 한다(스캔 max=2048 반영).
  let total = 0;
  try { total = Math.min(expandIpList(ips).ips.length, 2048); } catch { total = 0; }
  const j = { reqId, agent, action: 'scan', ips, username, password, vcenterId, datacenterId, noRegister: !!noRegister, state: 'pending', createdAt: Date.now(), progress: { scanned: 0, total, at: Date.now() } };
  addEvent(j, `스캔 잡 생성 — 에이전트 '${agent}'${datacenterId ? ` · 법인 ${datacenterId}` : ''} · 대상 IP ${total}개. 에이전트 인출 대기 중.`);
  // 사용된 자격증명 지문(평문 아님) — 법인 간 비교로 "이 법인만 인증 실패" 원인 파악용.
  addEvent(j, `사용 자격증명: ${credFingerprint(username, password)} (평문 미기록 — 정상 법인과 계정/길이/지문 비교하세요)`);
  jobs.set(reqId, j);
  pend.add(reqId); byAgent.set(key, pend);
  return reqId;
}

/**
 * 중앙→엣지 직접(PUSH) 스캔 잡 생성 — 엣지가 중앙으로 폴링하지 않아도, 중앙이 수집 서버(원격)
 * URL로 엣지에 직접 스캔을 시켜 결과를 받는다. 폴링 대기 없이 즉시 'running'으로 시작하며,
 * 실제 전송/결과 반영은 호출측(idracScanPush)이 setIdracScanResult로 처리한다.
 * 폴링 큐(byAgent)에는 넣지 않는다 — 에이전트 인출 대상이 아님.
 * @returns reqId 또는 null(대기 한도 초과)
 */
export function createPushScanJob(agent, { ips, username, password, vcenterId = '', datacenterId = '', noRegister = false, mode = 'merge', edgeUrl = '' }) {
  gc();
  // 인메모리 잡 총량 상한(폴링 큐와 별개) — 남용/누수 방지.
  if (jobs.size >= MAX_PENDING * 20) return null;
  const reqId = newReqId();
  let total = 0;
  try { total = Math.min(expandIpList(ips).ips.length, 2048); } catch { total = 0; }
  const now = Date.now();
  const j = {
    reqId, agent, action: 'scan', dispatch: 'push', edgeUrl,
    ips, username, password, vcenterId, datacenterId, noRegister: !!noRegister, mode: mode || 'merge',
    state: 'running', createdAt: now, takenAt: now, progress: { scanned: 0, total, at: now },
  };
  addEvent(j, `중앙→엣지 직접 전송(PUSH) 스캔 시작 — 에이전트 '${agent}'${datacenterId ? ` · 법인 ${datacenterId}` : ''} · 대상 IP ${total}개 · 엣지 ${edgeUrl || '(URL 미상)'}. 엣지 폴링 없이 중앙이 직접 실행합니다.`);
  addEvent(j, `사용 자격증명: ${credFingerprint(username, password)} (평문 미기록 — 정상 법인과 계정/길이/지문 비교하세요)`);
  jobs.set(reqId, j);
  return reqId;
}

/** UI가 위임 '등록' 요청(스캔에서 확인한 found 목록을 에이전트 현지에 등록) → reqId 반환. */
export function enqueueIdracRegister(agent, { found, username, password, vcenterId = '', datacenterId = '', mode = 'merge' }) {
  gc();
  const key = String(agent || '').trim().toLowerCase();
  if (!key) return null;
  if (!Array.isArray(found) || !found.length) return null;
  const pend = byAgent.get(key) || new Set();
  if (pend.size >= MAX_PENDING) return null;
  const reqId = newReqId();
  jobs.set(reqId, { reqId, agent, action: 'register', found, username, password, vcenterId, datacenterId, mode, state: 'pending', createdAt: Date.now(), progress: { scanned: 0, total: found.length, at: Date.now() } });
  pend.add(reqId); byAgent.set(key, pend);
  return reqId;
}

/** 에이전트가 자기 이름의 대기 잡을 인출(인출 즉시 running으로 전환, 비밀번호 포함). */
export function takeIdracScanJobs(agentName) {
  reapClaims(); // 만료된 claim을 먼저 재수확 → 되돌아온 잡을 이번 인출에 바로 포함
  const key = String(agentName || '').trim().toLowerCase();
  if (!key) return [];
  agentPolls.set(key, Date.now()); // 빈 폴링이어도 '에이전트 살아있음'으로 기록(로그창 진단용)
  const pend = byAgent.get(key);
  if (!pend || !pend.size) return [];
  const out = [];
  for (const reqId of pend) {
    const j = jobs.get(reqId);
    if (!j) continue;
    // claim: running으로 전환하되 첫 보고(ack) 전까지는 claim 기한을 둔다. 기한 내 보고 없으면 재수확.
    j.state = 'running'; j.takenAt = Date.now(); j.acked = false;
    j.claims = (j.claims || 0) + 1;
    j.claimDeadline = j.takenAt + ACK_TIMEOUT_MS;
    addEvent(j, `에이전트 '${j.agent}'가 잡을 인출 — 현지 스캔 시작(대기 ${Math.round((j.takenAt - j.createdAt) / 1000)}초, 시도 ${j.claims}/${MAX_CLAIMS}).`);
    out.push({ reqId, action: j.action || 'scan', ips: j.ips, username: j.username, password: j.password, vcenterId: j.vcenterId || '', datacenterId: j.datacenterId || '', noRegister: !!j.noRegister, found: j.found || undefined, mode: j.mode || 'merge' });
  }
  byAgent.delete(key);
  return out;
}

/** 에이전트의 마지막 잡 인출 폴링 시각(ms). 없으면 null — 로그창에서 '에이전트 미접속' 진단. */
export function agentLastScanPoll(agentName) {
  return agentPolls.get(String(agentName || '').trim().toLowerCase()) || null;
}

/** 최근 withinMs 이내에 잡 인출 폴링한 에이전트 이름(소문자) 목록 — AGENT_NAME 불일치 진단용. */
export function recentPollingAgents(withinMs = 30_000) {
  const now = Date.now();
  const out = [];
  for (const [name, ts] of agentPolls) if (now - ts <= withinMs) out.push(name);
  return out;
}

/**
 * '스캔 중지' — 아직 에이전트가 인출하지 않은 '대기' 잡을 모두 취소한다(큐에서 제거 + error 종결).
 * 이미 인출된(진행 중) 잡은 원격에서 멈출 수 없어 그대로 둔다. 반환: 취소된 잡 수.
 */
export function cancelPendingIdracScanJobs() {
  let n = 0;
  for (const [key, pend] of byAgent) {
    for (const reqId of [...pend]) {
      const j = jobs.get(reqId);
      if (!j || j.state !== 'pending') { pend.delete(reqId); continue; }
      j.state = 'error';
      j.doneAt = Date.now();
      j.result = { scanned: 0, foundCount: 0, found: [], registered: 0, error: '사용자가 스캔을 중지(취소)했습니다.' };
      addEvent(j, '사용자가 스캔을 중지 — 대기 중이던 잡을 취소했습니다.', 'warn');
      pend.delete(reqId);
      n++;
    }
    if (!pend.size) byAgent.delete(key);
  }
  return n;
}

/**
 * 개별 대기 잡 취소 — reqId 하나만 큐에서 제거하고 error로 종결한다. 잘못된 AGENT_NAME으로
 * 만들어져 영원히 '대기'하는 잡을 전체 중지 없이 정리할 때 사용. 이미 인출된(running) 잡이나
 * 이미 종료된 잡은 취소하지 않는다. 반환: { ok, reason? }.
 */
export function cancelIdracScanJob(reqId) {
  const rid = String(reqId || '');
  const j = jobs.get(rid);
  if (!j) return { ok: false, reason: '잡을 찾을 수 없습니다(이미 정리되었을 수 있음).' };
  if (j.state !== 'pending') return { ok: false, reason: `이 잡은 '${j.state}' 상태라 개별 취소할 수 없습니다(대기 상태만 취소 가능).` };
  j.state = 'error';
  j.doneAt = Date.now();
  j.result = { scanned: 0, foundCount: 0, found: [], registered: 0, error: '관리자가 이 대기 잡을 취소했습니다.' };
  addEvent(j, '관리자가 이 대기 잡을 개별 취소했습니다.', 'warn');
  const key = String(j.agent || '').trim().toLowerCase();
  const pend = byAgent.get(key);
  if (pend) { pend.delete(rid); if (!pend.size) byAgent.delete(key); }
  return { ok: true };
}

/** 에이전트가 스캔 진행률 보고(중간) — { scanned, total, found }. */
export function setIdracScanProgress(reqId, { scanned, total, found } = {}) {
  const j = jobs.get(reqId);
  if (!j) return false;
  j.acked = true; j.claimDeadline = null; // 첫 진행 보고 = ack(claim 확정) → 재수확 대상 아님
  const prevFound = j.progress?.found || 0;
  j.progress = {
    scanned: Number(scanned) || 0,
    total: Number(total) || j.progress?.total || 0,
    found: found != null ? Number(found) || 0 : (j.progress?.found || 0),
    at: Date.now(),
  };
  if (j.state === 'running' || j.state === 'pending') j.state = 'running';
  // 진행 이벤트는 스팸 방지 스로틀: 발견 수가 늘었거나, 마지막 진행 이벤트 후 10초 지났을 때만 기록.
  const now = Date.now();
  if (j.progress.found > prevFound || now - (j._lastProgEvt || 0) >= 10_000) {
    j._lastProgEvt = now;
    addEvent(j, `진행 ${j.progress.scanned}/${j.progress.total}${j.progress.found ? ` · iDRAC 발견 ${j.progress.found}대` : ''}`);
  }
  return true;
}

/** 에이전트가 스캔 결과 보고. */
export function setIdracScanResult(reqId, data = {}) {
  const j = jobs.get(reqId);
  if (!j) return false;
  j.acked = true; j.claimDeadline = null; // 결과 회신 = ack
  j.state = data.error ? 'error' : 'done';
  j.doneAt = Date.now();
  const af = data.authFailed || 0;
  if (data.error) addEvent(j, `오류로 종료 — ${data.error}`, 'error');
  else {
    addEvent(j, `완료 — 스캔 ${data.scanned || 0}개 · iDRAC ${data.foundCount ?? (Array.isArray(data.found) ? data.found.length : 0)}대 발견 · 현지 등록 ${data.registered || 0}대 · 무응답 ${data.unreachable || 0} · 비iDRAC ${data.notIdrac || 0} · 인증실패 ${af}${data.durationMs ? ` · 소요 ${Math.round(data.durationMs / 1000)}초` : ''}`);
    // 인증실패가 있으면 원인을 별도 경고 이벤트로 남긴다('계정 맞는데 401'의 실제 이유).
    if (af > 0 && data.authFailReason) addEvent(j, `인증실패 원인: ${data.authFailReason}`, 'warn');
    // '계정 맞는데 막힌' IP 목록을 이벤트에 남긴다(어느 iDRAC을 점검할지 — 처음 몇 개는 인라인, 전체는 result).
    if (af > 0 && Array.isArray(data.authFailedIps) && data.authFailedIps.length) {
      const ips = data.authFailedIps;
      const preview = ips.slice(0, 20).join(', ');
      addEvent(j, `인증 거부 IP(${ips.length}${data.authFailedIpsTruncated ? '+' : ''}): ${preview}${ips.length > 20 ? ` … 외 ${ips.length - 20}개(전체는 로그창 하단)` : ''}`, 'warn');
    }
  }
  // 비밀번호 등 민감정보는 저장하지 않는다(result는 발견 목록·요약만).
  j.result = {
    scanned: data.scanned || 0,
    foundCount: data.foundCount ?? (Array.isArray(data.found) ? data.found.length : 0),
    found: Array.isArray(data.found) ? data.found.slice(0, 5000) : [],
    unreachable: data.unreachable || 0,
    notIdrac: data.notIdrac || 0,
    authFailed: af,
    authFailReason: data.authFailReason || null,
    authFailedIps: Array.isArray(data.authFailedIps) ? data.authFailedIps.slice(0, 200) : [],
    authFailedIpsTruncated: !!data.authFailedIpsTruncated,
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
 * 잡 하나의 세부 로그(이벤트 타임라인 + 진단) — '스캔 현황' 로그창용. 비밀번호 미포함.
 * 진단(hints): 멈춘 것처럼 보일 때 어디를 봐야 하는지 서버가 판정해 함께 내려준다.
 */
export function getIdracScanJobLog(reqId, opts = {}) {
  gc();
  const j = jobs.get(reqId);
  if (!j) return { ok: false, reason: '잡을 찾을 수 없습니다(완료 후 10분이 지나 정리됐을 수 있음).' };
  const now = Date.now();
  const lastPoll = agentLastScanPoll(j.agent);
  // 이 에이전트가 '수집 서버(원격)'로 등록돼 있는지(id/이름, 소문자). 등록·정상인데 폴링만
  // 없으면 방향이 반대인 '스캔 폴링(엣지→중앙)' 미설정이 원인일 가능성이 크다.
  const collectorSet = opts.collectors instanceof Set ? opts.collectors : null;
  const agentKey = String(j.agent || '').trim().toLowerCase();
  const isRegisteredCollector = collectorSet ? collectorSet.has(agentKey) : false;
  const hints = [];
  if (j.state === 'pending') {
    if (!lastPoll) {
      hints.push({ level: 'error', msg: `에이전트 '${j.agent}'의 잡 인출 폴링 기록이 없습니다 — 엣지 포탈이 꺼져 있거나 AGENT_NAME 불일치, CENTRAL_URL/CENTRAL_TOKEN 미설정일 수 있습니다.` });
      // 다른 이름으로 폴링 중인 에이전트가 있으면 AGENT_NAME 불일치를 바로 짚어준다(가장 흔한 원인).
      const others = recentPollingAgents(30_000);
      if (isRegisteredCollector) {
        // 수집 서버로는 등록·정상인데 스캔 폴링만 없는 전형적 케이스 — 방향 차이를 명확히 설명.
        hints.push({ level: 'warn', msg: `'${j.agent}'는 수집 서버(원격)로 등록되어 있습니다(중앙이 엣지에서 수집 = 중앙→엣지 PULL). 하지만 위임 스캔은 반대로 엣지가 중앙으로 '폴링'해야 동작합니다(엣지→중앙). 수집이 정상이어도 스캔 폴링은 별개이므로, 엣지 포탈에 CENTRAL_URL(중앙 주소)과 CENTRAL_TOKEN이 설정·재시작됐는지 확인하세요. 엣지 로그에 '[idrac-scan-agent] started (central=…, name=${j.agent})'가 보여야 합니다.` });
      }
      if (others.length) hints.push({ level: 'warn', msg: `현재 폴링 중인 에이전트: ${others.join(', ')} — 이 잡은 '${j.agent}'용인데 그 이름으로는 폴링이 없습니다. 엣지의 AGENT_NAME이 '${j.agent}'와 일치하는지(대소문자 무관) 확인하세요.` });
      else hints.push({ level: 'warn', msg: '현재 중앙에 폴링하는 에이전트가 하나도 없습니다 — 엣지 프로세스 미기동, CENTRAL_URL 미설정, 또는 네트워크/토큰 문제일 수 있습니다.' });
    }
    else if (now - lastPoll > 30_000) hints.push({ level: 'warn', msg: `에이전트가 ${Math.round((now - lastPoll) / 1000)}초째 폴링하지 않습니다(정상 주기 5초) — 엣지 포탈 상태/네트워크를 확인하세요.` });
    else hints.push({ level: 'info', msg: '에이전트는 정상 폴링 중이며 곧 잡을 인출합니다.' });
  }
  if (j.state === 'running') {
    if (j.dispatch === 'push') {
      // PUSH는 중앙이 엣지에 동기 요청 → 결과 반영까지 진행 보고가 없다(정상). 장시간이면 대역이 큰 것.
      hints.push({ level: 'info', msg: `중앙→엣지 직접 전송(PUSH)으로 실행 중입니다 — 엣지가 대역을 스캔하고 결과를 회신할 때까지 대기합니다(대역이 크면 수십 초~수 분). 엣지 폴링 설정은 필요 없습니다.` });
    } else {
      const progAt = j.progress?.at || j.takenAt || j.createdAt;
      if (now - progAt > 60_000) hints.push({ level: 'warn', msg: `진행 보고가 ${Math.round((now - progAt) / 1000)}초째 없습니다 — 엣지에서 스캔이 멈췄거나(재시작 등) 결과 회신이 유실됐을 수 있습니다. 엣지 포탈 로그(journalctl)에서 [idrac-scan-agent]를 확인하세요.` });
      if (lastPoll && now - lastPoll > 60_000) hints.push({ level: 'warn', msg: `에이전트의 중앙 폴링도 ${Math.round((now - lastPoll) / 1000)}초째 끊겼습니다 — 엣지 프로세스 중단/네트워크 단절 가능성이 큽니다.` });
    }
  }
  return {
    ok: true,
    reqId: j.reqId,
    agent: j.agent,
    action: j.action || 'scan',
    datacenterId: j.datacenterId || '',
    vcenterId: j.vcenterId || '',
    ips: j.ips || '', // 스캔 대상 대역(관리자 로그창 — 어떤 대역이 멈췄는지 식별용)
    state: j.state,
    createdAt: j.createdAt || null,
    takenAt: j.takenAt || null,
    doneAt: j.doneAt || null,
    agentLastPoll: lastPoll,
    progress: j.progress ? { ...j.progress } : null,
    result: j.result ? { ...j.result, found: undefined, foundCount: j.result.foundCount || 0 } : null,
    hints,
    events: [...(j.events || [])],
  };
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

// 폴링 트래픽이 없어도(엣지가 인출만 하고 사라진 경우) 만료 claim이 재수확되도록 주기 실행.
const reapTimer = setInterval(() => { try { reapClaims(); } catch { /* */ } }, 30_000);
reapTimer.unref?.();
