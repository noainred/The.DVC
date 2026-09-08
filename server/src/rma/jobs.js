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
    reason: r.reason || '', stdout: String(r.stdout || '').slice(0, HISTORY_OUTPUT_MAX), stderr: String(r.stderr || '').slice(0, HISTORY_OUTPUT_MAX),
    truncated: !!r.truncated || String(r.stdout || '').length > HISTORY_OUTPUT_MAX,
  });
  if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
  // 영속 이력(v2.417) — sqlite 가 있으면 함께 저장(재시작 후에도 출력까지 남는다). 실패해도 메모리 링은 유지.
  saveHistoryRow({ ...history[0], stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), truncated: !!r.truncated }).catch(() => {});
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

/** ack — 결과 저장. TTL 정리/중복이면 false. */
export function setJobResult(reqId, result) {
  const j = jobs.get(String(reqId || ''));
  if (!j || j.state === 'done') return false;
  const now = Date.now();
  j.state = 'done'; j.doneAt = now; j.claimDeadline = null;
  j.result = result && typeof result === 'object' ? result : { ok: false, reason: '에이전트가 빈 결과를 회신했습니다.' };
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
  const inst = String(instance || '').trim().slice(0, 64) || 'default';
  if (!a) return;
  const safe = {
    hostname: String(info.hostname || '').slice(0, 120),
    version: String(info.version || '').slice(0, 40),
    os: String(info.os || '').slice(0, 120),
    pid: Number(info.pid) || null,
    uptimeSec: Number(info.uptimeSec) || 0,
    priority: Number.isFinite(Number(info.priority)) ? Number(info.priority) : 100,
    allowCustom: !!info.allowCustom,
    signed: !!info.signed,
    busy: !!info.busy,
    comment: String(info.comment || '').slice(0, 200),
    remoteManage: !!info.remoteManage,
    stats: info.stats && typeof info.stats === 'object' ? { active: Number(info.stats.active) || 0, performed: Number(info.stats.performed) || 0, rejected: Number(info.stats.rejected) || 0, testsRun: Number(info.stats.testsRun) || 0, testsFailed: Number(info.stats.testsFailed) || 0 } : null,
    policy: info.policy && typeof info.policy === 'object' ? {
      enabled: (info.policy.enabled || []).map(String).slice(0, 200), disabled: (info.policy.disabled || []).map(String).slice(0, 200),
      enabledTests: (info.policy.enabledTests || []).map(String).slice(0, 200), disabledTests: (info.policy.disabledTests || []).map(String).slice(0, 200),
      serviceUnits: (info.policy.serviceUnits || []).map(String).slice(0, 100), allowReboot: !!info.policy.allowReboot, fileRoots: (info.policy.fileRoots || []).map(String).slice(0, 20),
    } : null,
    scheduleVersion: Number(info.scheduleVersion) || 0, scheduledTests: Number(info.scheduledTests) || 0, outbox: Number(info.outbox) || 0,
    ip,
  };
  heartbeats.set(hbKey(a, inst), { agent: a, instance: inst, lastSeen: Date.now(), info: safe });
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
    return { ...g, mode: cfg.mode, modeExplicit: !!cfg.explicit, primary: cfg.primary || '', activePrimary: primary || '', onlineCount: online.length, pending: pendingByAgent.get(lc(g.agent))?.size || 0, lastSeen: Math.max(...g.instances.map((i) => i.lastSeen)) };
  }).sort((a, b) => a.agent.localeCompare(b.agent));
}

/** 테스트용 초기화. */
export function _resetRma() { jobs.clear(); pendingByAgent.clear(); waiters.clear(); heartbeats.clear(); rr.clear(); history.length = 0; }
