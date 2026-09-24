/**
 * RMA 원격 명령 잡 큐(중앙, 인메모리) — claim→ack 2단계 확인응답(captureJobs.js 패턴 이식)
 * + 다중 인스턴스 분배(v2.416).
 *
 *   UI    → POST /api/tools/rma/run { agent, instance?, cmd, args } → enqueueJob → reqId
 *   RMA   → POST /api/central/rma-poll (heartbeat, 롱폴)            → takeJobs (claim)
 *   RMA   → POST /api/central/rma-result { reqId, result }          → setJobResult (= ack)
 *   UI    ← GET  /api/tools/rma/jobs/:reqId                          → pending|running|done|unknown
 *
 * ── 다중 인스턴스 ──
 * 한 법인(agent = 개별 토큰 단위)에 RMA 프로세스가 여러 개(한 서버에 여러 개, 또는 여러 서버에
 * 하나씩) 붙을 수 있다. 각 프로세스는 `instance` 이름(RMA_INSTANCE, 기본 hostname)으로 구별되고
 * 같은 agent 토큰으로 인증한다. 잡은 법인 단위로 등록되며 분배 방식(settings.js, 법인별 설정):
 *   active-active : 누구든 먼저 폴링한 인스턴스가 가져간다(target 없음). 모든 인스턴스가 동시에 일한다.
 *   balance       : 등록 시점에 온라인 인스턴스 중 진행 중 잡이 가장 적은 곳으로 배정(동률은 라운드로빈).
 *   active-backup : 주 인스턴스(설정 primary, 없으면 priority 최저값 → 이름순)에만 배정. 주가
 *                   오프라인이면 그 다음 순위가 자동으로 받는다.
 * 특정 인스턴스를 지정(instance)하면 방식과 무관하게 그 인스턴스만 실행한다.
 * 페일오버 공통 규칙: 배정된 인스턴스가 **오프라인**(하트비트 HEARTBEAT_STALE_MS 초과)이면 같은
 * 법인의 다른 온라인 인스턴스가 대신 가져간다(명시 지정 잡도 동일 — 남겨두면 영영 대기).
 *
 * 캡처 큐와 다른 점 — **MAX_CLAIMS = 1**. 원격 명령은 멱등이 아니다(서비스 재시작·자유 명령).
 * 인출 후 응답 없이 죽으면 다시 내보내지 않고 '결과 미회신' 오류로 종결한다. 재실행은 사람이
 * 결과를 보고 결정한다.
 *
 * 롱폴: RMA 는 4초 폴 대신 최대 wait(기본 20초) 동안 대기한다. 잡이 들어오면 그 법인의 대기 폴을
 * 전부 깨워 즉시 인출을 시도한다(배정 대상이 아닌 인스턴스는 빈 결과로 곧 다시 폴링).
 */
import { modeFor } from './settings.js';
import { saveHistoryRow, listHistoryRows } from './historyDb.js';
import { numOrNull } from '../util/numOrNull.js';
import { capStr, capTrim } from '../util/capStr.js';

const jobs = new Map();            // reqId -> job
const pendingByAgent = new Map();  // agentLower -> Set<reqId>
const waiters = new Map();         // agentLower -> Set<resolve>
const heartbeats = new Map();      // `${agentLower}\0${instanceLower}` -> { agent, instance, lastSeen, info }
const rr = new Map();              // agentLower -> 라운드로빈 커서
const history = [];                // 완료 잡 이력(최근 HISTORY_MAX)

export const DONE_TTL = 30 * 60_000;      // 완료 잡 결과 보존(UI 가 결과를 가져갈 시간)
const UNDONE_TTL = 15 * 60_000;           // 대기/진행 잡 보존 — RMA 가 영영 안 오면 정리
const MAX_PENDING = 20;                   // 법인당 대기 상한
const MAX_CLAIMS = 1;                     // ⚠ 비멱등 — 재인출 금지
const ACK_GRACE_MS = Number(process.env.RMA_ACK_GRACE_MS) || 30_000;
const HISTORY_MAX = 300;
const HISTORY_OUTPUT_MAX = 16 * 1024;     // 이력에는 출력 앞부분만(잡 본체는 DONE_TTL 동안 전문 보존)
export const HEARTBEAT_STALE_MS = Number(process.env.RMA_HEARTBEAT_STALE_MS) || 90_000; // 롱폴 20s·재시도 백오프 여유
/**
 * v2.605(CEN2605-05·TIM2605-03): 하트비트 보관 상한. 예전에는 삭제 경로가 _resetRma 뿐이라 인스턴스 이름을 바꿔 가며 폴링하면
 * (또는 호스트명이 바뀐 인스턴스가) 프로세스 수명 내내 쌓였고, 정책 문자열 길이도 무제한이라 원소 4,000자 × 200개로 인스턴스당
 * 약 0.8MB 가 상주했다(감사 실측 150개 +125MB). ① 원소 글자 200자 ② 법인당 인스턴스 상한(넘치면 가장 오래된 **오프라인**
 * 인스턴스를 내리고, 전부 온라인이면 새 이름을 받지 않는다 — 살아 있는 인스턴스를 밀어내지 않는다) ③ 오래 무응답(기본 7일)인
 * 항목은 정리한다.
 */
export const HEARTBEAT_ELEM_MAX = 200;
export const HEARTBEAT_MAX_INSTANCES = Math.max(2, Number(process.env.RMA_MAX_INSTANCES_PER_AGENT) || 32);
export const HEARTBEAT_PURGE_MS = Math.max(HEARTBEAT_STALE_MS * 2, Number(process.env.RMA_HEARTBEAT_PURGE_MS) || 7 * 86_400_000);
let _hbSweptAt = 0;
const _hbRefuseLogAt = new Map();
/**
 * v2.606(감사 RECENT2606-06): 상한으로 거절한 인스턴스 — 법인(소문자) → { count, lastAt, byInstance: Map(instance → lastAt) }.
 *   예전에는 콘솔 1분 1줄뿐이라 설정 화면이 '거절된 인스턴스가 있다' 를 말하지 못했다. 인스턴스 이름은 법인당
 *   REFUSED_TRACK_MAX 개까지만 기억한다(이름을 바꿔 가며 보내도 메모리가 자라지 않게 — 법인 수는 개별 토큰 수로 유계).
 */
const _hbRefused = new Map();
const REFUSED_TRACK_MAX = 64;
export const HEARTBEAT_REFUSED_REASON = `이 법인의 RMA 인스턴스 수 상한(${HEARTBEAT_MAX_INSTANCES}, RMA_MAX_INSTANCES_PER_AGENT)에 닿아 이 인스턴스를 받지 않았습니다 — 작업이 배달되지 않습니다. 쓰지 않는 인스턴스를 정리하거나(오프라인 90초 뒤 자리가 납니다) 상한을 올리세요.`;
function noteRefused(agent, inst, now) {
  const k = lc(agent);
  const r = _hbRefused.get(k) || { count: 0, lastAt: 0, byInstance: new Map() };
  r.count += 1; r.lastAt = now;
  r.byInstance.delete(inst);
  r.byInstance.set(inst, now);
  while (r.byInstance.size > REFUSED_TRACK_MAX) r.byInstance.delete(r.byInstance.keys().next().value);
  _hbRefused.set(k, r);
}
function sweepHeartbeats(now) {
  if (now - _hbSweptAt < 60_000) return;
  _hbSweptAt = now;
  for (const [k, h] of heartbeats) if (now - h.lastSeen > HEARTBEAT_PURGE_MS) heartbeats.delete(k);
}

let seq = 0;
const newReqId = () => `rma_${Date.now().toString(36)}_${(seq++).toString(36)}`;
const lc = (a) => String(a || '').trim().toLowerCase();
const hbKey = (agent, instance) => `${lc(agent)}\0${lc(instance)}`;

function dropPending(agent, reqId) {
  const key = lc(agent);
  const set = pendingByAgent.get(key);
  if (set) { set.delete(reqId); if (!set.size) pendingByAgent.delete(key); }
}

function pushHistory(j, now) {
  const r = j.result || {};
  history.unshift({
    reqId: j.reqId, agent: j.agent, instance: j.instance || j.target || '', cmd: j.spec?.cmd, args: j.spec?.args || {}, label: j.spec?.label || '',
    user: j.user || '', createdAt: j.createdAt, takenAt: j.takenAt, doneAt: now,
    ok: !!r.ok, exitCode: r.exitCode ?? null, timedOut: !!r.timedOut, durationMs: r.durationMs ?? null,
    reason: r.reason || '', stdout: capStr(r.stdout || '', HISTORY_OUTPUT_MAX), stderr: capStr(r.stderr || '', HISTORY_OUTPUT_MAX), // v2.607(TIM2607-01): 평탄화
    truncated: !!r.truncated || String(r.stdout || '').length > HISTORY_OUTPUT_MAX,
  });
  if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
  // 영속 이력(v2.417) — sqlite 가 있으면 함께 저장(재시작 후에도 출력까지 남는다). 실패해도 메모리 링은 유지.
  // v2.602(CEN2602-03): 적재 실패를 조용히 삼키지 않는다 — saveHistoryRow 는 실패하면 false 를 돌려준다.
  saveHistoryRow({ ...history[0], stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), truncated: !!r.truncated })
    .then((okSaved) => { if (okSaved === false) console.warn(`[rma] 명령 이력 영속 적재 실패 reqId=${j.reqId} (DB 없음 또는 INSERT 오류 — 메모리 이력만 남습니다)`); })
    .catch((e) => console.warn(`[rma] 명령 이력 영속 적재 오류 reqId=${j.reqId}: ${e?.message || e}`));
}

/** 기한 내 ack 없는 running 잡 → 재인출 없이(비멱등) 오류 종결. now 주입은 테스트용. */
export function reapClaims(now = Date.now()) {
  let failed = 0;
  for (const [, j] of jobs) {
    if (j.state !== 'running' || !j.claimDeadline || now <= j.claimDeadline) continue;
    j.state = 'done'; j.doneAt = now; j.claimDeadline = null;
    j.result = { ok: false, reason: `인스턴스 '${j.instance || '?'}' 가 명령 인출 후 기한(${Math.round((j.timeoutMs + ACK_GRACE_MS) / 1000)}초) 내 결과를 회신하지 않았습니다 — 명령이 실행됐을 수 있으니 상태를 확인한 뒤 재실행하세요.` };
    pushHistory(j, now);
    failed++;
  }
  return { failed };
}

function prune(now = Date.now()) {
  reapClaims(now);
  for (const [reqId, j] of jobs) {
    const done = j.state === 'done';
    const last = done ? (j.doneAt || 0) : Math.max(j.createdAt || 0, j.takenAt || 0);
    if (now - last > (done ? DONE_TTL : UNDONE_TTL)) { jobs.delete(reqId); dropPending(j.agent, reqId); }
  }
}

function wake(agent) {
  const key = lc(agent);
  const set = waiters.get(key);
  if (!set) return;
  waiters.delete(key);
  for (const resolve of set) { try { resolve(); } catch { /* */ } }
}

// ── 인스턴스 상태 ──
function instancesOf(agent, now = Date.now()) {
  const key = lc(agent);
  const out = [];
  for (const h of heartbeats.values()) if (lc(h.agent) === key) out.push({ ...h, online: now - h.lastSeen <= HEARTBEAT_STALE_MS });
  return out;
}
const isOnline = (agent, instance, now) => { const h = heartbeats.get(hbKey(agent, instance)); return !!h && now - h.lastSeen <= HEARTBEAT_STALE_MS; };
function runningCount(agent, instance) {
  let n = 0;
  for (const j of jobs.values()) if (j.state === 'running' && lc(j.agent) === lc(agent) && lc(j.instance) === lc(instance)) n++;
  return n;
}
// 배정 대상 결정(순수 — 하트비트 상태 기반). 온라인 인스턴스가 없으면 null(=누구든 먼저 오는 쪽).
export function pickInstance(agent, mode, { primary = '', now = Date.now() } = {}) {
  const online = instancesOf(agent, now).filter((h) => h.online);
  if (!online.length) return null;
  if (mode === 'active-backup') {
    const p = primary && online.find((h) => lc(h.instance) === lc(primary));
    if (p) return p.instance;
    online.sort((a, b) => (a.info.priority - b.info.priority) || a.instance.localeCompare(b.instance));
    return online[0].instance;
  }
  if (mode === 'balance') {
    const loads = online.map((h) => ({ h, n: runningCount(agent, h.instance) + pendingTargeted(agent, h.instance) }));
    const min = Math.min(...loads.map((x) => x.n));
    const cands = loads.filter((x) => x.n === min).map((x) => x.h).sort((a, b) => a.instance.localeCompare(b.instance));
    const cur = rr.get(lc(agent)) || 0;
    rr.set(lc(agent), cur + 1);
    return cands[cur % cands.length].instance;
  }
  return null; // active-active
}
function pendingTargeted(agent, instance) {
  let n = 0;
  const set = pendingByAgent.get(lc(agent));
  if (!set) return 0;
  for (const id of set) { const j = jobs.get(id); if (j && j.state === 'pending' && lc(j.target) === lc(instance)) n++; }
  return n;
}

/**
 * 잡 등록. spec = { cmd, args, timeoutMs, label, issuedAt } — sign(reqId) 콜백이 있으면 spec.sig 를 붙인다.
 * instance 를 주면 그 인스턴스 전용, 아니면 법인 설정(mode)에 따라 배정. 반환 { reqId, target }.
 */
export function enqueueJob(agent, spec = {}, { user = '', timeoutMs = 30_000, instance = '', now = Date.now(), sign = null } = {}) {
  prune(now);
  const key = lc(agent);
  if (!key) throw new Error('agent 가 필요합니다.');
  const set = pendingByAgent.get(key) || new Set();
  if (set.size >= MAX_PENDING) throw new Error(`법인 '${agent}' 대기 명령이 ${MAX_PENDING}개를 넘었습니다 — RMA 가 폴링 중인지 확인하세요.`);
  const cfg = modeFor(agent);
  const target = instance ? String(instance).trim() : pickInstance(agent, cfg.mode, { primary: cfg.primary, now });
  const reqId = newReqId();
  if (typeof sign === 'function') spec = { ...spec, sig: sign(reqId) }; // 서명은 reqId 를 포함해야 하므로 여기서 붙인다
  jobs.set(reqId, { reqId, agent: String(agent).trim(), spec, user, timeoutMs, target: target || '', explicit: !!instance, mode: cfg.mode, instance: '', state: 'pending', createdAt: now, takenAt: null, claims: 0, claimDeadline: null, doneAt: null, result: null });
  set.add(reqId); pendingByAgent.set(key, set);
  wake(agent);
  return { reqId, target: target || '' };
}

export function jobAgentOf(reqId) { const j = jobs.get(String(reqId || '')); return j ? j.agent : ''; }

/** 인출(claim): 이 인스턴스가 받을 수 있는 pending 잡 — target 없음 / target 일치 / target 오프라인(페일오버). */
export function takeJobs(agent, instance = '', now = Date.now()) {
  reapClaims(now);
  const key = lc(agent);
  const set = pendingByAgent.get(key);
  if (!set || !set.size) return [];
  const out = [];
  for (const reqId of [...set]) {
    const j = jobs.get(reqId);
    if (!j || j.state !== 'pending') { set.delete(reqId); continue; }
    if ((j.claims || 0) >= MAX_CLAIMS) { set.delete(reqId); continue; }
    if (j.target && lc(j.target) !== lc(instance) && isOnline(agent, j.target, now)) continue; // 다른 온라인 인스턴스 몫
    j.state = 'running'; j.takenAt = now; j.claims = (j.claims || 0) + 1; j.instance = String(instance || '');
    j.failover = !!(j.target && lc(j.target) !== lc(instance));
    j.claimDeadline = now + j.timeoutMs + ACK_GRACE_MS;
    set.delete(reqId);
    out.push({ reqId, ...j.spec });
    // 1회 입력 계정(spec.secret)은 인출 즉시 중앙 메모리에서 지운다 — getJob/이력/재인출 어디에도 남지 않는다(v2.419).
    if (j.spec && j.spec.secret) { j.spec = { ...j.spec }; delete j.spec.secret; }
  }
  if (!set.size) pendingByAgent.delete(key);
  return out;
}

/** 롱폴 인출 — 받을 잡이 없으면 최대 waitMs 동안 enqueue 를 기다린다(도착 시 즉시 재시도). */
export async function takeJobsWait(agent, instance = '', waitMs = 0, { isAlive = () => true } = {}) {
  const now = takeJobs(agent, instance);
  if (now.length || waitMs <= 0) return now;
  const key = lc(agent);
  await new Promise((resolve) => {
    const set = waiters.get(key) || new Set();
    const done = () => { clearTimeout(t); set.delete(done); if (!set.size && waiters.get(key) === set) waiters.delete(key); resolve(); };
    const t = setTimeout(done, waitMs); // unref 하지 않는다 — 응답 대기 중인 HTTP 요청이 있으므로 루프를 살려야 한다
    set.add(done); waiters.set(key, set);
  });
  if (!isAlive()) return []; // 대기 중 연결이 끊겼다 — claim 하지 않는다(v2.428). 잡은 큐에 남아 다음 폴이 가져간다.
  return takeJobs(agent, instance);
}

/**
 * 대기 중인 롱폴을 **전부 즉시 깨운다** — 종료(SIGTERM) 경로 전용 (v2.456).
 *
 * 왜 필요한가: 엣지 RMA 는 최대 55초짜리 롱폴로 HTTP 연결을 열어 둔다(`routes/central.js`).
 * 법인이 여러 개면 항상 그만큼의 연결이 살아 있고, `server.close()` 는 **열린 연결이 전부
 * 끝나야** 콜백을 부른다. 그래서 재시작할 때마다 종료 유예(기본 8초)를 통째로 소진하고
 * 강제 종료됐다 — 업그레이드가 그만큼 느려 보였다(실측: stop 8.2초 + start 1.0초).
 *
 * 깨우면 각 롱폴은 '받을 잡 없음'으로 즉시 응답하고 연결이 닫혀 `server.close()` 가 곧바로
 * 완료된다. 잡을 잃지 않는다 — 깨어난 폴은 큐를 다시 확인하고, 큐에 남은 잡은 다음 폴이 가져간다.
 */
export function releaseAllWaiters() {
  let n = 0;
  for (const set of waiters.values()) {
    for (const resolve of set) { try { resolve(); n++; } catch { /* */ } }
  }
  waiters.clear();
  return n;
}

// v2.602(감사 CEN2602-03): 엣지 회신 결과는 **아는 필드만, 아는 모양으로** 담는다. 예전에는 원문 객체를 그대로 보관해
//   ① `reason` 이 객체면 명령 이력 표가 React #31 로 죽었고 ② `exitCode` 가 객체면 영속 이력 INSERT 가 바인드 오류로
//   **조용히** 실패했다(saveHistoryRow 가 false 만 돌려준다). 개별 토큰 엣지가 자기 잡에만 할 수 있는 일이지만,
//   화면을 죽이는 값은 수신 지점에서 막는다(v2.598 CENTRAL 규약 — 정제는 저장 함수 안에).
//   글자 상한은 엣지 출력 상한(RMA_MAX_OUTPUT 기본 256KB)보다 넉넉히 두고, 잘랐으면 truncated 로 밝힌다.
const RESULT_TEXT_MAX = Math.max(256 * 1024, Number(process.env.RMA_MAX_OUTPUT) || 0) * 2;
const REASON_MAX = 2000;
const ARGV_MAX = 64; const ARGV_ITEM_MAX = 1000;
// v2.607(TIM2607-01·LEFT2607-05): capStr — `.slice` 는 결과 본문(최대 수 MB) 원문을 붙잡는다.
const str = (v, n) => capStr(v, n);
export function sanitizeRmaResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { ok: false, reason: '에이전트가 빈 결과를 회신했습니다.' };
  const r = result;
  const rawOut = typeof r.stdout === 'string' ? r.stdout : ''; const rawErr = typeof r.stderr === 'string' ? r.stderr : '';
  const out = {
    ok: r.ok === true, timedOut: r.timedOut === true, rejected: r.rejected === true, clipped: r.clipped === true,
    truncated: r.truncated === true || rawOut.length > RESULT_TEXT_MAX || rawErr.length > RESULT_TEXT_MAX,
    exitCode: numOrNull(r.exitCode), durationMs: numOrNull(r.durationMs),
    stdout: capStr(rawOut, RESULT_TEXT_MAX), stderr: capStr(rawErr, RESULT_TEXT_MAX),
  };
  const reason = str(r.reason, REASON_MAX); if (reason) out.reason = reason;
  if (typeof r.signal === 'string' && r.signal) out.signal = capStr(r.signal, 32);
  const cmd = str(r.cmd, 64); if (cmd) out.cmd = cmd;
  const inst = str(r.instance, 64); if (inst) out.instance = inst;
  if (Array.isArray(r.argv)) out.argv = r.argv.slice(0, ARGV_MAX).filter((x) => typeof x === 'string' || typeof x === 'number').map((x) => capStr(x, ARGV_ITEM_MAX));
  if (r.restartSelf === true) out.restartSelf = true;
  // 원문이 객체·배열이던 필드는 버렸다는 사실을 남긴다(조용히 빼지 않는다).
  const bad = ['reason', 'exitCode', 'durationMs', 'stdout', 'stderr', 'argv'].filter((k) => r[k] != null && typeof r[k] === 'object' && !(k === 'argv' && Array.isArray(r[k])));
  if (bad.length) out.invalidFields = bad;
  return out;
}

/** ack — 결과 저장. TTL 정리/중복이면 false. */
export function setJobResult(reqId, result) {
  const j = jobs.get(String(reqId || ''));
  if (!j || j.state === 'done') return false;
  const now = Date.now();
  j.state = 'done'; j.doneAt = now; j.claimDeadline = null;
  j.result = sanitizeRmaResult(result);
  dropPending(j.agent, reqId);
  pushHistory(j, now);
  prune(now);
  return true;
}

export function getJob(reqId) {
  prune();
  const j = jobs.get(String(reqId || ''));
  if (!j) return { state: 'unknown' };
  const base = { reqId: j.reqId, agent: j.agent, target: j.target, instance: j.instance, failover: !!j.failover, mode: j.mode, cmd: j.spec?.cmd, args: j.spec?.args || {}, label: j.spec?.label || '', user: j.user, createdAt: j.createdAt, takenAt: j.takenAt };
  if (j.state === 'done') return { state: 'done', ...base, doneAt: j.doneAt, result: j.result };
  return { state: j.state === 'running' ? 'running' : 'pending', ...base };
}

/** 이력 조회(비동기) — sqlite 이력이 있으면 그것을, 없으면 메모리 링을 돌려준다. */
export async function listHistoryAsync(opts = {}) {
  const rows = await listHistoryRows(opts).catch(() => null);
  return rows ?? listHistory(opts);
}

export function listHistory({ agent = '', limit = 100 } = {}) {
  const key = lc(agent);
  const rows = key ? history.filter((h) => lc(h.agent) === key) : history;
  return rows.slice(0, Math.max(1, Math.min(HISTORY_MAX, limit)));
}

/** 하트비트 기록(폴마다). info 는 에이전트 자기 보고 — 표시·배정용일 뿐 권한 판정에 쓰지 않는다. */
export function noteHeartbeat(agent, instance, info = {}, { ip = '' } = {}) {
  const a = String(agent || '').trim();
  const inst = capTrim(instance || '', 64) || 'default';
  if (!a) return;
  // v2.601(감사 CEN2601-05): 정책 목록은 **배열일 때만** 읽는다. 예전 `(info.policy.enabled || []).map` 은 문자열·객체가 오면
  //   TypeError → rma-poll 이 매 폴 500 이라 하트비트가 기록되지 않고 작업도 배달되지 않았다. 배열이 아닌 필드는 빈 목록 +
  //   `policyInvalid` 로 밝힌다(조용히 버리지 않는다). info 자체가 객체가 아니어도 던지지 않게.
  if (!info || typeof info !== 'object') info = {};
  const invalid = [];
  const arr = (k, n) => {
    const v = info.policy?.[k];
    if (v == null) return [];
    if (!Array.isArray(v)) { invalid.push(k); return []; }
    return v.slice(0, n).filter((x) => typeof x === 'string' || typeof x === 'number').map((x) => capStr(x, HEARTBEAT_ELEM_MAX));
  };
  const safe = {
    hostname: capStr(info.hostname || '', 120), // v2.607(LEFT2607-05): 평탄화
    version: capStr(info.version || '', 40),
    os: capStr(info.os || '', 120),
    pid: Number(info.pid) || null,
    uptimeSec: Number(info.uptimeSec) || 0,
    priority: Number.isFinite(Number(info.priority)) ? Number(info.priority) : 100,
    allowCustom: !!info.allowCustom,
    signed: !!info.signed,
    busy: !!info.busy,
    comment: capStr(info.comment || '', 200),
    remoteManage: !!info.remoteManage,
    stats: info.stats && typeof info.stats === 'object' ? { active: Number(info.stats.active) || 0, performed: Number(info.stats.performed) || 0, rejected: Number(info.stats.rejected) || 0, testsRun: Number(info.stats.testsRun) || 0, testsFailed: Number(info.stats.testsFailed) || 0 } : null,
    policy: info.policy && typeof info.policy === 'object' ? {
      enabled: arr('enabled', 200), disabled: arr('disabled', 200),
      enabledTests: arr('enabledTests', 200), disabledTests: arr('disabledTests', 200),
      serviceUnits: arr('serviceUnits', 100), allowReboot: !!info.policy.allowReboot, fileRoots: arr('fileRoots', 20),
    } : null,
    scheduleVersion: Number(info.scheduleVersion) || 0, scheduledTests: Number(info.scheduledTests) || 0, outbox: Number(info.outbox) || 0,
    ip,
  };
  if (safe.policy && invalid.length) safe.policy.policyInvalid = invalid;
  const now = Date.now();
  sweepHeartbeats(now);
  const key = hbKey(a, inst);
  if (!heartbeats.has(key)) {
    const mine = [];
    for (const [k, h] of heartbeats) if (lc(h.agent) === lc(a)) mine.push([k, h.lastSeen]);
    if (mine.length >= HEARTBEAT_MAX_INSTANCES) {
      mine.sort((x, y) => x[1] - y[1]);
      const [oldKey, oldSeen] = mine[0];
      if (now - oldSeen <= HEARTBEAT_STALE_MS) {
        const lw = _hbRefuseLogAt.get(lc(a)) || 0;   // 로그는 법인당 1분에 1줄(거절이 곧 로그 폭주가 되지 않게 — 법인 수는 개별 토큰 수로 유계)
        if (now - lw >= 60_000) { _hbRefuseLogAt.set(lc(a), now); console.warn(`[rma] 하트비트: ${a} 인스턴스 수 상한(${HEARTBEAT_MAX_INSTANCES}) — 새 인스턴스 '${inst}' 를 받지 않았다(온라인 인스턴스를 밀어내지 않는다)`); }
        noteRefused(a, inst, now);
        return { ok: false, refused: true, reason: HEARTBEAT_REFUSED_REASON };
      }
      heartbeats.delete(oldKey);
    }
  }
  heartbeats.set(key, { agent: a, instance: inst, lastSeen: now, info: safe });
  return { ok: true };
}

/** 법인의 온라인 인스턴스 이름 목록(스케줄 배정용). */
export function onlineInstances(agent, now = Date.now()) {
  return instancesOf(agent, now).filter((h) => h.online).map((h) => h.instance);
}

/** 법인별 인스턴스 그룹 목록(UI). */
export function listRmaAgents(now = Date.now()) {
  const groups = new Map();
  for (const h of heartbeats.values()) {
    const key = lc(h.agent);
    const g = groups.get(key) || { agent: h.agent, instances: [] };
    g.instances.push({ instance: h.instance, lastSeen: h.lastSeen, online: now - h.lastSeen <= HEARTBEAT_STALE_MS, ...h.info, running: runningCount(h.agent, h.instance) });
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => {
    const cfg = modeFor(g.agent);
    const online = g.instances.filter((i) => i.online);
    g.instances.sort((a, b) => (a.priority - b.priority) || a.instance.localeCompare(b.instance));
    const primary = cfg.mode === 'active-backup' ? pickInstance(g.agent, 'active-backup', { primary: cfg.primary, now }) : '';
    // v2.606(RECENT2606-06): 상한으로 거절한 인스턴스 수(최근 = 온라인 판정 창 안) — 조용한 거절 금지.
    const rf = _hbRefused.get(lc(g.agent));
    const refusedRecent = rf ? [...rf.byInstance.entries()].filter(([, at]) => now - at <= HEARTBEAT_STALE_MS).map(([inst]) => inst) : [];
    return { ...g, mode: cfg.mode, modeExplicit: !!cfg.explicit, primary: cfg.primary || '', activePrimary: primary || '', onlineCount: online.length, pending: pendingByAgent.get(lc(g.agent))?.size || 0, lastSeen: Math.max(...g.instances.map((i) => i.lastSeen)),
      refusedCount: rf?.count || 0, refusedLastAt: rf?.lastAt || null, refusedRecent: refusedRecent.length, refusedInstances: refusedRecent.slice(0, 16), maxInstances: HEARTBEAT_MAX_INSTANCES };
  }).sort((a, b) => a.agent.localeCompare(b.agent));
}

/** 테스트용 초기화. */
export function _resetRma() { _hbSweptAt = 0; _hbRefuseLogAt.clear(); _hbRefused.clear(); jobs.clear(); pendingByAgent.clear(); waiters.clear(); heartbeats.clear(); rr.clear(); history.length = 0; }
