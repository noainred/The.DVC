/**
 * bmstor/jobs.js — 베어메탈 스토리지 '에이전트 폴링' 위임 잡 큐(v2.341).
 *
 * 중앙이 직접 닿지 못하는(NAT 뒤) 엣지를 위해, iDRAC 스캔·캡처·Ping 과 동일한
 * claim→ack 2단계 확인응답 패턴(central/captureJobs.js 원형, CLAUDE.md 지침)을 따른다:
 *   poller 가 enqueue → 엣지가 GET /api/central/bmstor-jobs 로 인출(claim, 기한 부여)
 *   → 현지 SSH df 수집 → POST /api/central/bmstor-result(ack).
 *   기한 내 ack 없으면 reap 이 pending 으로 되돌리고(재시도 1회), 한도 소진 시
 *   onExpire 콜백으로 해당 서버들에 실패 사유를 남긴다(무한 '수집 대기' 방지).
 */

const jobs = new Map();           // reqId -> { reqId, agent, servers, state, createdAt, takenAt, claims, claimDeadline, doneAt }
const pendingByAgent = new Map(); // agentLower -> Set<reqId>

const DONE_TTL = 5 * 60_000;
const UNDONE_TTL = 30 * 60_000;   // 주기(기본 10분)보다 길게 — 다음 주기 전 정리로 유령 잡 방지
const MAX_PENDING = 2;            // 에이전트당 대기 상한 — 엣지가 오래 죽어도 최신 주기 잡만 남긴다
const MAX_CLAIMS = 2;
const ACK_BASE_MS = Number(process.env.BMSTOR_ACK_GRACE_MS) || 60_000;
const ACK_PER_SERVER_MS = 20_000; // 서버당 SSH 접속+df 여유
const ACK_MAX_MS = 10 * 60_000;

let seq = 0;
const newReqId = () => `bms_${Date.now().toString(36)}_${(seq++).toString(36)}`;
const agentKey = (a) => String(a || '').trim().toLowerCase();

let onExpire = null; // (agent, serverIds, reason) — poller 가 등록(만료 서버에 오류 표시)
export function setBmstorExpireHandler(fn) { onExpire = typeof fn === 'function' ? fn : null; }

function dropPending(agent, reqId) {
  const set = pendingByAgent.get(agentKey(agent));
  if (set) { set.delete(reqId); if (!set.size) pendingByAgent.delete(agentKey(agent)); }
}

/** 만료 claim 재수확 — 재시도 남으면 pending 복귀, 소진이면 onExpire 로 실패 확정. */
export function reapBmstorClaims(now = Date.now()) {
  let requeued = 0, failed = 0;
  for (const [reqId, j] of jobs) {
    if (j.state !== 'running' || !j.claimDeadline || now <= j.claimDeadline) continue;
    if ((j.claims || 0) >= MAX_CLAIMS) {
      j.state = 'done'; j.doneAt = now; failed++;
      try { onExpire?.(j.agent, j.servers.map((s) => s.id), `에이전트 '${j.agent}'가 수집 잡 인출 후 ${MAX_CLAIMS}회 연속 결과를 회신하지 않았습니다 — 엣지 상태를 확인하세요.`); } catch { /* 콜백 실패가 큐를 막지 않게 */ }
      continue;
    }
    j.state = 'pending'; j.takenAt = null; j.claimDeadline = null;
    const set = pendingByAgent.get(agentKey(j.agent)) || new Set();
    set.add(reqId); pendingByAgent.set(agentKey(j.agent), set);
    requeued++;
  }
  return { requeued, failed };
}

function prune(now = Date.now()) {
  reapBmstorClaims(now);
  for (const [reqId, j] of jobs) {
    const done = j.state === 'done';
    const last = done ? (j.doneAt || 0) : Math.max(j.createdAt || 0, j.takenAt || 0);
    if (now - last > (done ? DONE_TTL : UNDONE_TTL)) { jobs.delete(reqId); dropPending(j.agent, reqId); }
  }
}

/** poller 가 주기마다 호출 — 그 에이전트 소속 서버들(SSH 자격증명 포함)을 하나의 잡으로. */
export function enqueueBmstorJob(agent, servers) {
  prune();
  const key = agentKey(agent);
  const set = pendingByAgent.get(key) || new Set();
  if (set.size >= MAX_PENDING) { // 가장 오래된 대기 잡 폐기 — 최신 주기 우선
    let oldestId = null, oldestAt = Infinity;
    for (const rid of set) { const at = jobs.get(rid)?.createdAt ?? 0; if (at < oldestAt) { oldestAt = at; oldestId = rid; } }
    if (oldestId) { jobs.delete(oldestId); set.delete(oldestId); }
  }
  const reqId = newReqId();
  jobs.set(reqId, { reqId, agent: String(agent || ''), servers, state: 'pending', createdAt: Date.now(), takenAt: null, claims: 0, claimDeadline: null, doneAt: null });
  set.add(reqId); pendingByAgent.set(key, set);
  return reqId;
}

/** 엣지 인출(claim) — pending 만, 기한 = 60s + 서버당 20s(상한 10분). */
export function takeBmstorJobs(agent, now = Date.now()) {
  reapBmstorClaims(now);
  const set = pendingByAgent.get(agentKey(agent));
  if (!set || !set.size) return [];
  const out = [];
  for (const reqId of set) {
    const j = jobs.get(reqId);
    if (!j || j.state !== 'pending') continue;
    j.state = 'running'; j.takenAt = now; j.claims = (j.claims || 0) + 1;
    j.claimDeadline = now + Math.min(ACK_MAX_MS, ACK_BASE_MS + j.servers.length * ACK_PER_SERVER_MS);
    out.push({ reqId, servers: j.servers });
  }
  pendingByAgent.delete(agentKey(agent));
  return out;
}

/** reqId 소유 에이전트(결과 위조 주입 방지용 소유권 판정). */
export function bmstorAgentOfReq(reqId) { return jobs.get(String(reqId || ''))?.agent || ''; }

/** ack — 잡 종결. 반환: 그 잡의 서버 id 목록(늦은/모르는 reqId 는 null — 호출부가 무시). */
export function ackBmstorJob(reqId) {
  const j = jobs.get(String(reqId || ''));
  if (!j || j.state === 'done') return null;
  j.state = 'done'; j.doneAt = Date.now(); j.claimDeadline = null;
  dropPending(j.agent, reqId);
  prune();
  return { agent: j.agent, serverIds: j.servers.map((s) => s.id) };
}
