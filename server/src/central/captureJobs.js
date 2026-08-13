/**
 * 에이전트 위임 tcpdump 캡처 작업큐(인메모리) — claim→ack 2단계 확인응답(v2.290 #6-B).
 *
 * 중앙이 직접 못 가는 사설망 서버는 그 망의 엣지 에이전트가 캡처를 대행한다.
 *   UI    → POST /api/admin/net/capture(via='agent')      → enqueueCapture → reqId
 *   Agent ← GET  /api/central/capture-jobs?agent=NAME     → takeCaptureJobs (4초 폴, agent/captureWorker.js)
 *   Agent → POST /api/central/capture-result(reqId, ...)  → setCaptureResult (= ack)
 *   UI    ← 폴링 getCaptureResult(reqId)                  → pending|done|unknown
 *
 * ── 왜 2단계(claim→ack)인가 ──
 * 종전(v2.289 이하)에는 takeCaptureJobs 가 인출 즉시 대기열에서 잡을 삭제했다(1단계 인출).
 * 엣지가 인출 직후 재시작/네트워크 단절되면 잡이 그대로 유실되고, UI 는 결과 TTL(5분)까지
 * 'pending' 을 표시하다 'unknown' 으로 끝났다 — 사용자는 실패 사유도 모른 채 기다린다.
 * idracScanJobs.js 의 검증된 패턴(claim 기한 + 재수확 reap + 재시도 상한)을 캡처 규모에 맞게
 * 이식했다: 인출(claim) 후 결과 회신(ack)이 기한 내 없으면 잡을 대기로 되돌려 재인출시키고,
 * 재시도 상한 초과 시 오류 결과로 종결해 UI 가 즉시 실패를 안다.
 *
 * ── 타임아웃 근거(실측·코드 기반, 추정 아님) ──
 * - 캡처 시간: spec.seconds 는 실행측(net/tcpdump.js:79)에서 1~120초로 클램프된다.
 * - 에이전트는 SSH 접속 → tcpdump(seconds 초) → 분석 → 결과 POST(timeoutMs 20s, retries 2).
 *   진행(progress) 보고는 없다 — 결과 회신 1회가 유일한 ack 다. 따라서 claim 기한은
 *   '캡처 시간 + SSH/분석/회신 여유' 로 잡아야 하며, 짧게 잡으면 정상 진행 중인 긴 캡처(120초)를
 *   진행 중인데도 재인출해 같은 서버에 tcpdump 를 중복 실행하게 된다(오탐 재수확 금지).
 * - 에이전트 폴 주기 4초(agent/captureWorker.js POLL_MS) → 재인출 지연은 수 초 내.
 *
 * ── 컴팩트(요약) 후 이어받기 메모 ──
 * 이 모듈은 v2.290 에서 1단계 인출 → 2단계 claim→ack 로 전면 개편됐다. 같은 개편이
 * pingJobs.js(IP 단위 in-flight)에도 적용됐고, idracScanJobs.js 는 그 원형(이미 구현돼 있었음).
 * 회귀 테스트: server/test/captureJobsClaim.test.js (now 주입으로 시간 제어).
 */

// ── 상태 저장소 ──
// jobs: reqId → 잡 전체 상태. state 전이: pending →(claim)→ running →(ack=결과)→ done
//                                            ↑______(reap: 기한 만료·재시도 남음)______|
const jobs = new Map();          // reqId -> { reqId, agent, spec, state, createdAt, takenAt, claims, claimDeadline, doneAt, result }
const pendingByAgent = new Map(); // agentLower -> Set<reqId> — 인출 대기 인덱스(에이전트 폴이 O(대기잡)로 찾게)

const DONE_TTL = 5 * 60_000;      // 완료 잡 보존 5분(종전 결과 TTL 과 동일 — UI 폴링이 결과를 가져갈 시간)
const UNDONE_TTL = 10 * 60_000;   // 미완료(대기/진행) 잡 보존 10분 — 에이전트가 영영 안 오면 정리(유령 잡 방지)
const MAX_PENDING = 20;           // 에이전트당 대기 상한(종전과 동일 — 남용 방지, 초과 시 가장 오래된 대기 잡 폐기)
const MAX_CLAIMS = 2;             // 재인출 한도 — 캡처는 멱등(다시 떠도 무해)이지만 SSH 부하가 있어 2회로 제한
// claim 기한 여유: SSH 접속 + tcpdump 기동 + 분석 + 결과 POST(재시도 포함) 몫. 캡처 자체
// 시간(spec.seconds, 1~120s 클램프)은 잡마다 다르므로 인출 시점에 spec 에서 더한다.
const ACK_GRACE_MS = Number(process.env.CAPTURE_ACK_GRACE_MS) || 60_000;

let seq = 0;
function newReqId() { return `cap_${Date.now().toString(36)}_${(seq++).toString(36)}`; }

const agentKey = (agent) => String(agent || '').trim().toLowerCase();

/** 대기 인덱스에서 reqId 제거(빈 셋이면 맵 엔트리도 정리 — 누수 방지). */
function dropPending(agent, reqId) {
  const key = agentKey(agent);
  const set = pendingByAgent.get(key);
  if (set) { set.delete(reqId); if (!set.size) pendingByAgent.delete(key); }
}

/**
 * claim 재수확 — 인출(running)됐지만 기한 내 결과(ack)가 없는 잡을 처리한다.
 * - 재시도 남음(claims < MAX_CLAIMS): pending 으로 되돌려 다음 폴에 재인출되게 한다.
 * - 한도 도달: 오류 결과로 종결(ok:false) — UI 폴링이 즉시 실패 사유를 본다(무한 pending 방지).
 * now 는 테스트에서 시간 제어를 위해 주입 가능(운영은 기본 Date.now()).
 */
export function reapCaptureClaims(now = Date.now()) {
  let requeued = 0, failed = 0;
  for (const [reqId, j] of jobs) {
    if (j.state !== 'running') continue;
    if (!j.claimDeadline || now <= j.claimDeadline) continue;
    if ((j.claims || 0) >= MAX_CLAIMS) {
      // 재시도 소진 — 실패 결과로 종결. captureWorker 의 실패 회신과 동일한 { ok:false, reason }
      // 형태라 UI(캡처 화면)가 별도 분기 없이 기존 오류 표시 경로로 처리한다.
      j.state = 'done'; j.doneAt = now;
      j.result = { ok: false, reason: `에이전트 '${j.agent}'가 캡처 인출 후 ${MAX_CLAIMS}회 연속 결과를 회신하지 않았습니다 — 엣지 재시작/네트워크를 확인하세요.` };
      failed++;
      continue;
    }
    // 재시도 여지 있음 — 대기로 복귀시켜 재인출(같은 에이전트의 다음 4초 폴에 다시 나간다).
    j.state = 'pending'; j.takenAt = null; j.claimDeadline = null;
    const key = agentKey(j.agent);
    const set = pendingByAgent.get(key) || new Set();
    set.add(reqId); pendingByAgent.set(key, set);
    requeued++;
  }
  return { requeued, failed };
}

/** 보존기간 지난 잡 정리(완료 5분·미완료 10분). 호출은 각 공개 함수 진입부(별도 타이머 불필요 — UI/에이전트 폴링이 충분히 잦다). */
function prune(now = Date.now()) {
  reapCaptureClaims(now); // 만료 claim 을 먼저 재수확(정리 대상 판정 전에 상태를 확정)
  for (const [reqId, j] of jobs) {
    const done = j.state === 'done';
    const last = done ? (j.doneAt || 0) : Math.max(j.createdAt || 0, j.takenAt || 0);
    if (now - last > (done ? DONE_TTL : UNDONE_TTL)) {
      jobs.delete(reqId);
      dropPending(j.agent, reqId); // 대기 인덱스의 유령 reqId 정리(남으면 MAX_PENDING 유령 점유)
    }
  }
}

/** UI가 위임 캡처 요청 → reqId 반환. spec 은 SSH 자격증명 포함(결과에는 미기록). */
export function enqueueCapture(agent, spec = {}) {
  prune();
  const key = agentKey(agent);
  const reqId = newReqId();
  const set = pendingByAgent.get(key) || new Set();
  // 대기 상한 초과 시 가장 오래된 '대기' 잡을 폐기(종전 arr.splice(oldest) 동작 유지 — 최신 요청 우선).
  if (set.size >= MAX_PENDING) {
    let oldestId = null, oldestAt = Infinity;
    for (const rid of set) { const jj = jobs.get(rid); const at = jj?.createdAt ?? 0; if (at < oldestAt) { oldestAt = at; oldestId = rid; } }
    if (oldestId) { jobs.delete(oldestId); set.delete(oldestId); }
  }
  jobs.set(reqId, { reqId, agent: String(agent || ''), spec, state: 'pending', createdAt: Date.now(), takenAt: null, claims: 0, claimDeadline: null, doneAt: null, result: null });
  set.add(reqId); pendingByAgent.set(key, set);
  return reqId;
}

/** reqId 의 배정 agent(소유권 판정용 — reqId 는 예측가능해 결과 위조 주입을 막아야 함). 없으면 빈 문자열. */
export function captureAgentOfReq(reqId) {
  const j = jobs.get(String(reqId || ''));
  return j ? String(j.agent || '') : '';
}

/**
 * 에이전트가 자기 이름의 대기 잡을 인출(claim). 종전과 달리 잡을 삭제하지 않고 running 으로
 * 전환 + claim 기한을 건다 — 기한 내 결과(ack)가 없으면 reap 이 재인출 가능하게 되돌린다.
 * 기한 = 인출시각 + 캡처시간(spec.seconds, 실행측과 동일하게 1~120s 클램프) + ACK_GRACE_MS.
 */
export function takeCaptureJobs(agent, now = Date.now()) {
  reapCaptureClaims(now); // 만료 claim 을 먼저 되돌려 이번 인출에 즉시 포함(재시도 지연 최소화)
  const key = agentKey(agent);
  const set = pendingByAgent.get(key);
  if (!set || !set.size) return [];
  const out = [];
  for (const reqId of set) {
    const j = jobs.get(reqId);
    // 'pending' 만 claim — reap 복귀/완료 잡의 잔여 reqId 가 셋에 남아도 중복 인출하지 않는다
    // (idracScanJobs v2.287 확정 버그 #15 와 동일한 방어).
    if (!j || j.state !== 'pending') continue;
    // 캡처 예상 시간: 실행측(net/tcpdump.js)의 클램프(1~120s)와 동일하게 계산해야 기한이 실제와 맞는다.
    const sec = Math.min(120, Math.max(1, Number(j.spec?.seconds) || 10));
    j.state = 'running';
    j.takenAt = now;
    j.claims = (j.claims || 0) + 1;
    j.claimDeadline = now + sec * 1000 + ACK_GRACE_MS;
    out.push({ reqId, spec: j.spec });
  }
  pendingByAgent.delete(key); // 인출 시도한 잡은 전부 셋에서 제거(pending 잔여는 위 continue 로 이미 무효)
  return out;
}

/** 에이전트가 캡처 결과 회신(= ack). 성공/실패 모두 여기로 온다({ ok, ... } / { ok:false, reason }). */
export function setCaptureResult(reqId, result) {
  const j = jobs.get(String(reqId || ''));
  if (!j) return false; // TTL 로 정리됐거나 위조 reqId — 저장할 곳 없음(라우트가 agent 소유권은 별도 검사)
  j.state = 'done';
  j.doneAt = Date.now();
  j.claimDeadline = null; // ack — 재수확 대상 아님
  j.result = result ?? { ok: false, reason: '에이전트가 빈 결과를 회신했습니다.' };
  dropPending(j.agent, reqId); // reap 복귀 직후 늦은 결과가 온 경우, 대기 인덱스 잔여 제거(중복 재인출 방지)
  prune();
  return true;
}

/** UI 결과 폴링 — { state: pending|done|unknown, result? }. running 도 'pending' 으로 묶는다(UI 구분 불필요). */
export function getCaptureResult(reqId) {
  prune();
  const j = jobs.get(String(reqId || ''));
  if (!j) return { state: 'unknown' };
  return j.state === 'done' ? { state: 'done', result: j.result } : { state: 'pending' };
}
