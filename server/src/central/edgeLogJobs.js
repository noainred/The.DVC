/**
 * central/edgeLogJobs.js — 중앙이 **못 닿는** 엣지에 로그를 요청하는 폴백 큐(v2.549).
 *
 * 사용자 선택: "중앙이 당긴다(pull) + 폴백". pull 이 `unreachable`·`timeout` 으로 실패하면
 * 여기에 요청을 쌓고 **엣지가 인출**한다(엣지는 항상 자기가 먼저 나간다 — 중앙→엣지 inbound 가
 * 막힌 법인에서도 동작하는 유일한 길).
 *
 *   중앙 UI → POST /api/tools/edge-log/fetch (pull 실패 시)  → enqueueEdgeLogJob
 *   엣지   ← GET  /api/central/edge-log-jobs?agent=…          → takeEdgeLogJob   (claim)
 *   엣지   → POST /api/central/edge-log-result                → ackEdgeLogJob    (ack)
 *
 * ── claim→ack 2단계(CLAUDE.md: "새 위임 잡 큐를 추가할 때 같은 claim→ack 패턴을 따를 것") ──
 * 인출 즉시 지우면 엣지가 인출 직후 재시작했을 때 **요청이 영영 사라진다**(사용자는 버튼을 눌렀는데
 * 아무 일도 안 일어난 것으로 보인다). 인출분을 in-flight 로 옮겨 기한 안에 결과가 없으면 되돌린다.
 *
 * ⚠ **인메모리다.** 중앙을 재시작하면 대기 요청이 사라진다 — 사람이 버튼을 다시 누르면 되는
 *   저비용 작업이라 파일 영속을 두지 않았다(RMA 의 outbox 와 다른 판단: 저쪽은 '명령' 이라 유실이 위험하다).
 * ⚠ **엣지당 대기 1건**이다. 연타가 큐를 부풀리지 않게 같은 엣지의 새 요청은 **기존 것을 덮어쓴다**
 *   (최신 요청이 사용자가 지금 원하는 것이다).
 */
const ACK_TIMEOUT_MS = Math.max(10_000, Number(process.env.EDGELOG_ACK_TIMEOUT_MS) || 60_000);
const MAX_TRIES = 2;
const REQ_TTL_MS = Math.max(60_000, Number(process.env.EDGELOG_REQ_TTL_MS) || 10 * 60_000);
const MAX_AGENTS = 200;

const t = (v) => String(v ?? '').trim();
let pending = new Map();   // agentLower -> { agent, at, opt, tries }
let inflight = new Map();  // agentLower -> { agent, at, opt, tries, deadline }

/** 기한 넘긴 인출분 회수 — 재시도 남으면 대기로 되돌리고, 한도를 넘으면 버린다(사유를 남긴다). */
export function reapEdgeLogClaims(now = Date.now()) {
  let requeued = 0, dropped = 0;
  for (const [k, j] of [...inflight]) {
    if (j.deadline > now) continue;
    inflight.delete(k);
    if (j.tries < MAX_TRIES) { pending.set(k, { ...j, deadline: undefined }); requeued += 1; }
    else dropped += 1;
  }
  // 너무 오래 대기한 요청도 버린다 — 엣지가 죽어 있으면 영원히 남는다.
  for (const [k, j] of [...pending]) if (now - j.at > REQ_TTL_MS) { pending.delete(k); dropped += 1; }
  return { requeued, dropped };
}

/** 요청 등록(엣지당 1건 — 새 요청이 기존을 덮는다). */
export function enqueueEdgeLogJob(agent, opt = {}) {
  const key = t(agent).toLowerCase();
  if (!key) return null;
  reapEdgeLogClaims();
  if (!pending.has(key) && !inflight.has(key) && pending.size + inflight.size >= MAX_AGENTS) return null;
  const job = {
    agent: t(agent), at: Date.now(), tries: 0,
    opt: { since: Number(opt.since) || 0, level: t(opt.level), limit: Number(opt.limit) || 0, withStatus: opt.withStatus !== false },
  };
  pending.set(key, job);
  return job;
}

/** 엣지가 인출(claim). 없으면 null. */
export function takeEdgeLogJob(agent, now = Date.now()) {
  const key = t(agent).toLowerCase();
  if (!key) return null;
  reapEdgeLogClaims(now);
  const j = pending.get(key);
  if (!j) return null;
  pending.delete(key);
  const claimed = { ...j, tries: j.tries + 1, deadline: now + ACK_TIMEOUT_MS };
  inflight.set(key, claimed);
  return { agent: claimed.agent, at: claimed.at, ...claimed.opt };
}

/** 엣지가 결과 회신(ack) — in-flight 에서 지운다. 요청한 적 없는 회신인지도 알려 준다. */
export function ackEdgeLogJob(agent) {
  const key = t(agent).toLowerCase();
  const had = inflight.delete(key);
  return { acked: had };
}

/** 그 엣지의 대기 상태 — 화면이 '요청해 두었고 아직 안 왔다' 를 말한다. */
export function edgeLogJobState(agent, now = Date.now()) {
  const key = t(agent).toLowerCase();
  reapEdgeLogClaims(now);
  if (inflight.has(key)) { const j = inflight.get(key); return { state: 'claimed', at: j.at, tries: j.tries, deadline: j.deadline }; }
  if (pending.has(key)) { const j = pending.get(key); return { state: 'pending', at: j.at, tries: j.tries }; }
  return { state: 'none' };
}

/** 전체 대기 현황(화면 배너용). */
export function edgeLogJobsInfo(now = Date.now()) {
  reapEdgeLogClaims(now);
  return { pending: pending.size, claimed: inflight.size, ackTimeoutMs: ACK_TIMEOUT_MS, ttlMs: REQ_TTL_MS, maxTries: MAX_TRIES };
}

export function _resetForTest() { pending = new Map(); inflight = new Map(); }
