/**
 * veeam/run/runs.js — 백업 요청(실행) 기록과 Veeam 세션 추적(v2.818).
 *
 * 흐름: 라우트가 plan.planBackup 결과로 `startRun` → 그룹(서버×방식)마다 순서대로 dispatchOp(quickBackup|portalJob) → 받은 세션 id 를 VM 에 붙인다 →
 *   추적 타이머(20초, 재진입 가드)가 끝나지 않은 세션을 **서버마다 한 번에**(dispatchOp 'sessions') 읽어 VM 별 상태를 갱신한다.
 *   시한(기본 24시간)이 지나도 끝나지 않으면 '확인 불가' 로 닫는다(무한 대기 금지).
 *
 * VM 상태 원칙('못 읽은 값은 0 이 아니다' 의 실행판):
 *  · unknown(확인 불가) — 성공도 실패도 아니다. 요청이 Veeam 에 닿았는지·끝났는지 모를 때(세션 id 없음·전송 오류·엣지 미회신·시한 초과).
 *  · skipped(보내지 않음) — Veeam 에 보내지 않은 것(매핑 없음·인증 정지·건너뜀 설정·시한 지남).
 *  · 자동 재시도 없음 — 실패·모름인 백업 요청을 포탈이 다시 보내지 않는다(이중 실행·계정 잠금 방지).
 * 동시성: 서버마다 진행 중 실행 1건(라우트가 activeRunFor 로 409) — 확인과 삽입이 같은 동기 구간이다.
 * 저장: `veeam-backup-runs.json`(최근 100건, 원자적 쓰기 · 손상이면 preserveCorrupt — 이름 규약 '-runs' 로 설정 백업 트리거에서 빠진다).
 *   재시작하면 '보내던 중' 이던 VM 은 확인 불가로 닫고(다시 보내지 않는다), 세션을 받은 VM 은 추적을 이어 간다.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, clampIntervalMs } from '../../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../../util/atomicWrite.js';
import { registerStateFile } from '../../util/stateFiles.js';
import { getServerWithSecret } from '../registry.js';
import { dispatchOp } from './dispatch.js';
import { serverRunSettings, getRunSettings } from './settings.js';
import { portalJobName } from './plan.js';
import { poolRun } from '../../util/pool.js';
import { notePortalRun } from './portalVms.js';

const FILE_NAME = 'veeam-backup-runs.json';
registerStateFile(FILE_NAME);
const FILE = () => path.join(config.configDir, FILE_NAME);
const MAX_RUNS = 100;
export const TRACK_MS = clampIntervalMs(Number(process.env.VEEAM_RUN_TRACK_MS) || 20_000, 20_000, 5_000);
export const RUN_DEADLINE_MS = clampIntervalMs(Number(process.env.VEEAM_RUN_DEADLINE_MS) || 24 * 3_600_000, 24 * 3_600_000, 60_000);
const TRACK_CONCURRENCY = 4;
const FINAL = new Set(['success', 'warning', 'failed', 'skipped', 'unknown']);

let _runs = null;
let _timer = null;
let _tracking = false;

function load() {
  if (_runs) return _runs;
  _runs = [];
  if (!fs.existsSync(FILE())) return _runs;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    _runs = Array.isArray(raw?.runs) ? raw.runs.filter((r) => r && typeof r === 'object' && typeof r.id === 'string' && Array.isArray(r.vms) && Array.isArray(r.groups)) : [];
  } catch (e) { preserveCorrupt(FILE(), e?.message); _runs = []; }   // 손상 원본은 보존(감사 근거)하고 빈 기록으로 시작
  // 파일에서 읽은 실행은 **이전 프로세스의 것**이다 — 읽는 이 순간(동기)에만 복구한다. 기동 뒤 타이머에서 복구하면
  // 그 사이 이 프로세스가 시작한 살아 있는 실행까지 '재시작으로 끊김' 으로 닫는다(2차 반증 N1 — 이중 실행 문이 열린다).
  if (recoverRuns(_runs)) persist();
  return _runs;
}
/** 상한 — 끝난 실행부터 오래된 순으로 버린다(진행 중 실행을 잘라 내면 추적·409 가드가 사라진다). */
function trim(runs) {
  for (let i = runs.length - 1; runs.length > MAX_RUNS && i >= 0; i--) if (runs[i].status !== 'running') runs.splice(i, 1);
}
function persist() {
  try { atomicWriteFileSync(FILE(), JSON.stringify({ version: 1, runs: load() }), { mode: 0o600 }); }
  catch (e) { console.warn(`[veeam-run] 실행 기록 저장 실패: ${e?.message || e}`); }
}

export function listRuns() { return load(); }
export function getRun(id) { return load().find((r) => r.id === id) || null; }
/** 이 서버로 진행 중인 실행이 있나. */
export function activeRunFor(serverId) { return load().find((r) => r.status === 'running' && r.groups.some((g) => g.serverId === serverId)) || null; }

/*
 * v2.819 관리 작업(잡에서 빼기·백업 삭제) 자리 — 실행 기록을 만들지 않는 상태 변경도 서버마다 하나씩(반증 F4: 두 관리자가 동시에 빼면
 * GET→PUT 이 겹쳐 한쪽 변경이 사라지고, 삭제 중 포탈 백업이 끼면 뺀 VM 이 잡에 되살아난다). 확인과 차지는 같은 동기 구간이다.
 * 메모리만 — 재시작하면 비지만, 그때는 진행 중이던 요청도 끝났다(라우트가 await 하는 동안만 잡는다).
 */
const _manageBusy = new Map();   // serverId → { id, kind, at, user }
/** 이 서버로 진행 중인 실행 또는 관리 작업 — { id, kind } | null. 백업 실행·복원·빼기·삭제가 모두 이것을 본다. */
export function serverBusy(serverId) {
  const run = activeRunFor(serverId);
  if (run) return { id: run.id, kind: run.mode || 'run' };
  return _manageBusy.get(serverId) || null;
}
/** 관리 작업 자리를 차지한다 — 이미 바쁘면 null. 끝나면 releaseServer(token). */
export function claimServer(serverId, kind, user = '') {
  if (serverBusy(serverId)) return null;
  const token = { id: `mng_${crypto.randomBytes(4).toString('hex')}`, kind, at: Date.now(), user: String(user).slice(0, 64) };
  _manageBusy.set(serverId, token);
  return token;
}
export function releaseServer(serverId, token) { if (_manageBusy.get(serverId) === token) _manageBusy.delete(serverId); }

const vmState = (s) => {
  const t = String(s || '').toLowerCase();
  if (t === 'success') return 'success';
  if (t === 'warning') return 'warning';
  if (t === 'failed' || t === 'error') return 'failed';
  return '';
};

function settle(run) {
  try { notePortalRun(run); } catch (e) { console.warn(`[veeam-run] 포탈 백업 VM 목록 반영 실패: ${e?.message || e}`); }   // v2.819 — 진행 중 상태도(배지가 '진행 중' 을 보인다)
  if (!run.vms.every((v) => FINAL.has(v.state))) return;
  run.status = 'done';
  run.finishedAt = run.finishedAt || Date.now();
  const c = (s) => run.vms.filter((v) => v.state === s).length;
  run.summary = { success: c('success'), warning: c('warning'), failed: c('failed'), unknown: c('unknown'), skipped: c('skipped') };
}

/**
 * 실행 시작. plan = planBackup 결과, vcById = vCenter id → {id,name}(포탈 전용 잡 이름).
 * 반환은 run(즉시 — 실제 요청은 비동기로 이어진다).
 */
export function startRun(plan, { user = '', vcById = new Map(), mode = 'quick' } = {}) {
  const runs = load();
  const prefix = getRunSettings().jobPrefix;
  const run = {
    id: `vbr_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`, at: Date.now(), user: String(user).slice(0, 64), mode, status: 'running',
    groups: plan.groups.map((g) => ({
      serverId: g.serverId, serverName: g.serverName, kind: g.kind, vcenterId: g.vcenterId || '',
      jobName: g.kind === 'portal' ? portalJobName(prefix, vcById.get(g.vcenterId) || { id: g.vcenterId }) : '',
      state: 'queued', reason: '', variant: '', notes: [], sessions: [],
    })),
    vms: plan.vms.map((v) => ({
      vmId: v.vmId, name: v.name, vcenterId: v.vcenterId, objectId: v.objectId, hostName: v.hostName || '', serverId: v.serverId, serverName: v.serverName, how: v.how,
      sizeGB: typeof v.sizeGB === 'number' ? v.sizeGB : null, provisionedGB: typeof v.provisionedGB === 'number' ? v.provisionedGB : null,   // v2.822.2 백업 대상 크기(vCenter 값)
      state: v.how === 'skip' ? 'skipped' : 'queued', detail: v.reason || '', progress: null, sessionId: '',
      ...(v.how === 'restore' && v.restore ? { restore: v.restore } : {}),   // v2.819 { restorePointId, newName, dest, pointAt } — 비밀 없음
    })),
  };
  runs.unshift(run);
  trim(runs);
  settle(run);
  persist();
  if (run.status === 'running') execute(run).catch((e) => console.warn(`[veeam-run] 실행 ${run.id} 오류: ${e?.message || e}`));
  return run;
}

async function execute(run) {
  for (const g of run.groups) {
    const server = getServerWithSecret(g.serverId);
    const mine = run.vms.filter((v) => v.serverId === g.serverId && v.how === g.kind && (!g.vcenterId || v.vcenterId === g.vcenterId));
    const refs = mine.map((v) => ({ name: v.name, objectId: v.objectId, hostName: v.hostName }));
    g.state = 'starting';
    for (const v of mine) v.state = 'starting';
    persist();
    let r;
    if (g.kind === 'restore') {
      // v2.819 새 VM 복원 — 그룹마다 VM 1대(라우트가 그렇게 만든다). 원래 위치 복원은 없다(manage.js RESTORE_TYPE).
      const v = mine[0];
      r = await dispatchOp(server, 'restoreVm', { restorePointId: v.restore?.restorePointId, vm: { name: v.name, objectId: v.objectId }, newName: v.restore?.newName, dest: v.restore?.dest, jobName: v.restore?.jobName || '', reason: `포탈 백업 관리 — ${run.user || ''}`.slice(0, 200) });
    } else if (g.kind === 'quick') r = await dispatchOp(server, 'quickBackup', { vms: refs });
    else { const st = serverRunSettings(g.serverId); r = await dispatchOp(server, 'portalJob', { jobName: g.jobName, repositoryId: st.repositoryId, retention: st.retention, vms: refs }); }
    g.variant = r.variant || ''; g.notes = r.notes || []; g.reason = r.reason || '';
    if (r.jobId) g.jobId = r.jobId;
    if (r.ok) {
      g.state = 'running';
      g.sessions = (r.sessions || []).map((s) => ({ id: s.id, objectIds: s.objectIds, finished: !s.id, result: '', state: '', ...(s.unknown ? { unknown: true } : {}) }));
      for (const v of mine) {
        // 다른 VM 의 세션에 붙이지 않는다 — 그 VM 을 담은 세션이 없으면(VM 별 요청 중 이 VM 만 거절) 실패다.
        const s = g.sessions.find((x) => x.objectIds.includes(v.objectId));
        if (!s) { v.state = 'failed'; v.detail = (r.notes || []).find((n) => n.startsWith(`${v.name}:`)) || 'Veeam 이 이 VM 의 요청을 거절했습니다.'; continue; }
        if (!s.id) {
          v.state = 'unknown';
          v.detail = s.unknown ? (r.notes || []).find((n) => n.startsWith(`${v.name}:`)) || '응답을 받지 못해 Veeam 이 시작했는지 알 수 없습니다 — 포탈은 다시 보내지 않습니다. Veeam 콘솔에서 확인하세요.'
            : 'Veeam 이 요청을 받았지만 세션 id 를 확인하지 못했습니다 — 결과는 Veeam 콘솔에서 확인하세요.';
          continue;
        }
        v.state = 'running'; v.sessionId = s.id;
        v.detail = g.kind === 'restore' ? `새 VM '${v.restore?.newName || ''}' 으로 복원(전원 꺼짐)` : g.kind === 'portal' ? `포탈 전용 잡 '${g.jobName}'${r.created ? '(새로 만듦)' : ''}` : 'Quick Backup';
      }
      if (g.sessions.every((s) => s.finished)) g.state = 'done';
    } else {
      g.state = r.unknown ? 'unknown' : 'failed';
      const st = r.unknown ? 'unknown' : (r.notSent || r.authStopped ? 'skipped' : 'failed');
      for (const v of mine) { v.state = st; v.detail = r.reason || '실패'; }
    }
    settle(run);
    persist();
  }
}

/** 세션 결과 → VM 상태(run 을 고친다). 작업 목록을 읽었는데 그 VM 이 없으면 세션 전체 결과로 단정하지 않는다. */
/** 진행 지표(없는 값은 null — 0 을 만들지 않는다). */
function metricsOf(src, scope, ses) {
  const n = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  return {
    scope, state: String(src?.state || '').slice(0, 40), message: String(src?.message || '').slice(0, 300),
    startedAt: n(src?.startedAt) ?? n(ses?.startedAt), endedAt: n(src?.endedAt),
    processedBytes: n(src?.processedBytes), readBytes: n(src?.readBytes), transferredBytes: n(src?.transferredBytes),
    sessionState: String(ses?.state || '').slice(0, 40), at: Date.now(),
  };
}

export function applySession(run, sessionId, s) {
  // 이 세션이 VM 하나만 담았나(복원·VM 별 Quick) — 그러면 세션 결과가 곧 그 VM 의 결과다. 작업 목록에 그 이름이 없어도(복원 작업은 새 VM 이름으로
  //   적힐 수 있다 · 작업이 없는 세션 종류) '확인 불가' 로 두지 않는다(v2.820.1 B5). 여러 VM 세션은 지금처럼 단정하지 않는다.
  //   ⚠ 포탈 전용 잡 세션은 제외 — 그 세션은 잡에 이미 들어 있던 다른 VM 도 함께 돌고, objectIds 에는 이번에 넣은 VM 만 있다(재검토 재현).
  const members = run.vms.filter((x) => x.sessionId === sessionId);
  const grp = (run.groups || []).find((g) => (g.sessions || []).some((x) => x.id === sessionId));
  const sess = grp ? grp.sessions.find((x) => x.id === sessionId) : null;
  const dedicated = members.length === 1 && !!sess && Array.isArray(sess.objectIds) && sess.objectIds.length === 1
    && (grp.kind === 'restore' || grp.kind === 'quick');
  for (const v of members.filter((x) => !FINAL.has(x.state))) {
    const t = (s.tasks || []).find((x) => (x.objectId && x.objectId === v.objectId) || (x.name && (x.name === v.name || (v.restore?.newName && x.name === v.restore.newName))))
      || (dedicated && (s.tasks || []).length === 1 ? s.tasks[0] : null);
    // v2.822.2 진행 상세 — VM 의 작업 값이 있으면 그것(scope 'vm'), 없으면 세션 값(scope 'session' — 여러 VM 세션이면 세션 전체 합이라 화면이 그렇게 말한다).
    v.metrics = metricsOf(t || s, t ? 'vm' : 'session', s);
    if (t) {
      v.progress = t.progress;
      const st = vmState(t.result);
      if (st && (s.finished || /stopped|finished|completed/i.test(t.state))) { v.state = st; v.detail = t.message || v.detail; continue; }
      if (s.finished) { v.state = 'unknown'; v.detail = `세션은 끝났지만 이 VM 의 결과를 읽지 못했습니다${t.message ? ` — ${t.message}` : ''}`; }
      continue;
    }
    if (s.finished) {
      const st = vmState(s.result);
      if (s.progress != null) v.progress = s.progress;
      if (st && dedicated) { v.state = st; v.detail = `세션 결과(이 VM 만 담은 세션${!s.tasksKnown && s.tasksError ? ` · VM 별 작업은 읽지 못함 — ${s.tasksError}` : ''})${s.message ? ` — ${s.message}` : ''}`; continue; }
      if (st && !s.tasksKnown) { v.state = st; v.detail = `세션 전체 결과(VM 별 결과는 읽지 못함${s.tasksError ? ` — ${s.tasksError}` : ''})${s.message ? ` — ${s.message}` : ''}`; }
      else { v.state = 'unknown'; v.detail = s.tasksKnown ? '세션은 끝났지만 이 VM 의 작업 기록이 없습니다.' : '세션은 끝났지만 결과를 읽지 못했습니다.'; }
    } else if (s.progress != null) v.progress = s.progress;   // 최신 값으로(처음 값에 고정하면 끝난 VM 이 0% 로 남는다 — 2026-10-29 현장 기록)
  }
}

/** 추적 1회 — 끝나지 않은 세션을 서버마다 한 번에 읽는다(재진입 가드). */
export async function trackOnce(now = Date.now()) {
  if (_tracking) return { skipped: true };
  _tracking = true;
  let changed = false;
  try {
    const active = load().filter((r) => r.status === 'running');
    for (const run of active) {
      if (now - run.at <= RUN_DEADLINE_MS) continue;
      for (const v of run.vms) if (!FINAL.has(v.state)) { v.state = 'unknown'; v.detail = `결과 확인 시한(${Math.round(RUN_DEADLINE_MS / 3_600_000)}시간)을 넘겼습니다 — Veeam 콘솔에서 확인하세요.`; }
      settle(run); changed = true;
    }
    // 서버별 끝나지 않은 세션 모음
    const byServer = new Map(); // serverId → [{run, g, s}]
    for (const run of load().filter((r) => r.status === 'running')) {
      for (const g of run.groups) {
        if (g.state !== 'running') continue;
        for (const s of g.sessions) if (!s.finished && s.id) { const a = byServer.get(g.serverId) || []; a.push({ run, g, s }); byServer.set(g.serverId, a); }
      }
    }
    // 서버마다 병렬(동시 4) — 꺼진 엣지 하나의 회신 시한이 다른 서버의 추적을 늦추지 않게(2차 반증 N8).
    await poolRun([...byServer], TRACK_CONCURRENCY, async ([serverId, list]) => {
      const server = getServerWithSecret(serverId);
      if (!server) {
        for (const { run, s } of list) { s.finished = true; for (const v of run.vms) if (v.sessionId === s.id && !FINAL.has(v.state)) { v.state = 'unknown'; v.detail = 'Veeam 서버 등록이 삭제돼 결과를 읽을 수 없습니다.'; } }
        changed = true; return;
      }
      const r = await dispatchOp(server, 'sessions', { sessionIds: list.slice(0, 50).map((x) => x.s.id) });
      if (!r.ok) { for (const { s } of list) { s.lastError = String(r.reason || '').slice(0, 300); s.lastErrorAt = Date.now(); } changed = true; return; }
      const got = new Map((r.sessions || []).map((x) => [x.id, x]));
      for (const { run, s } of list) {
        const x = got.get(s.id);
        if (!x) continue;
        if (!x.ok) { s.lastError = x.reason; s.lastErrorAt = Date.now(); changed = true; continue; }
        s.lastError = ''; s.state = x.state; s.result = x.result; s.progress = x.progress; s.tasksError = x.tasksError || '';
        if (x.finished) s.finished = true;
        applySession(run, s.id, x);
        changed = true;
      }
    });
    for (const run of load().filter((r) => r.status === 'running')) {
      for (const g of run.groups) if (g.state === 'running' && g.sessions.every((s) => s.finished || !s.id)) g.state = 'done';
      settle(run);
    }
  } finally {
    _tracking = false;
    if (changed) persist();
  }
  return { ok: true };
}

/** 재시작 직후(파일을 처음 읽을 때만) — 보내던 중(starting) VM 은 Veeam 이 받았는지 모른다: 다시 보내지 않고 확인 불가로 닫는다. 세션을 받은 VM 은 추적을 잇는다. */
function recoverRuns(runs) {
  let n = 0;
  for (const run of runs.filter((r) => r.status === 'running')) {
    for (const g of run.groups) if (g.state === 'starting' || g.state === 'queued') { g.state = 'failed'; g.reason = '포탈이 재시작돼 요청이 끊겼습니다.'; }
    for (const v of run.vms) {
      if (v.state === 'starting') { v.state = 'unknown'; v.detail = '요청을 보내는 중에 포탈이 재시작했습니다 — Veeam 이 받았는지 알 수 없습니다(다시 보내지 않았습니다). Veeam 콘솔에서 확인하세요.'; n++; }
      else if (v.state === 'queued') { v.state = 'skipped'; v.detail = '보내기 전에 포탈이 재시작했습니다 — 보내지 않았습니다.'; n++; }
    }
    settle(run);
  }
  return n;
}

/**
 * 관리자가 실행을 닫는다(2차 반증 N3 — 세션 추적이 계속 실패하면 그 서버의 새 실행이 시한까지 409 로 막힌다).
 * 끝나지 않은 VM 은 '확인 불가' — 포탈 기록만 닫는다. Veeam 의 세션·잡은 멈추지 않는다.
 */
export function closeRun(id, { user = '' } = {}) {
  const run = getRun(id);
  if (!run) return { ok: false, status: 404 };
  if (run.status !== 'running') return { ok: false, status: 409, reason: '이미 끝난 실행입니다.' };
  if (run.vms.some((v) => v.state === 'starting' || v.state === 'queued')) return { ok: false, status: 409, reason: '아직 Veeam 에 보내는 중인 VM 이 있습니다 — 요청이 끝난 뒤 닫을 수 있습니다.' };
  const who = String(user).slice(0, 64);
  for (const v of run.vms) if (!FINAL.has(v.state)) { v.state = 'unknown'; v.detail = `관리자(${who})가 실행 기록을 닫았습니다 — 포탈은 더 추적하지 않습니다. 결과는 Veeam 콘솔에서 확인하세요.`; }
  for (const g of run.groups) { if (g.state === 'running') g.state = 'done'; for (const s of g.sessions) s.finished = true; }
  run.closedBy = who;
  settle(run);
  persist();
  return { ok: true, run };
}

export function startVeeamRunTracker() {
  if (config.agent.centralUrl) return; // 엣지 노드 — 실행 기록은 중앙만
  if (_timer) return;
  load();   // 재시작 복구는 첫 읽기에서(위 load 주석)
  _timer = setInterval(() => { trackOnce().catch((e) => console.warn(`[veeam-run] 세션 추적 실패: ${e?.message || e}`)); }, TRACK_MS);
  _timer.unref?.();
}

export function _resetForTest() { _runs = null; _tracking = false; _manageBusy.clear(); try { fs.rmSync(FILE()); } catch { /* 없음 */ } }
