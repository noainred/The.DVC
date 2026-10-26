/**
 * veeam/em/client.js — Veeam Backup Enterprise Manager REST(기본 9398) 읽기 전용 수집기(v2.788).
 *
 * 흐름: POST /api/sessionMngr/?v=latest(Basic) → 응답 헤더 X-RestSvcSessionId → GET 들(각 항목 독립) → DELETE /api/logonSessions/{id}(최선).
 * ⚠ 경로·필드는 실장비 미검증(parse.js 머리 주석) — 그래서 **항목마다 따로** 읽고, 한 항목이 실패해도 나머지로 결과를 만든다(실패 항목은 사유와 함께).
 *
 * 규약(veeam/client.js 와 같다):
 *  · **조회 전용** — 작업 시작·중지 같은 쓰기를 이 모듈에 더하지 말 것.
 *  · TLS 는 장비 신뢰 판정(security/tlsTrust.js deviceTlsConnect)을 **비밀번호를 보내기 전에** 거친다 · DNS 리바인딩 차단 · 리다이렉트 거부.
 *  · 로그인의 401·403 은 즉시 중단(authFailed) — 폴러가 주기 수집을 멈춘다(util/authGuard.js). 로그인 뒤 GET 의 401 은 이번 수집만 실패(정지 안 함).
 *    어느 쪽이든 같은 실행 안에서 다시 로그인하지 않는다(자동 재시도 없음 — 계정 잠금).
 *  · 시한(signal)이 끊기면 부분 결과를 성공으로 돌려주지 않는다(직전 완전한 결과를 덮지 않게).
 *  · 오류 문구에 비밀번호·세션 id 를 싣지 않는다(maskText).
 */
import { Agent } from 'undici';
import { withSsrfLookup } from '../../util/ssrfLookup.js';
import { deviceTlsConnect } from '../../security/tlsTrust.js';
import { reqTimeoutMs } from '../../util/envTimeout.js';
import { NO_REDIRECT, refuseRedirect } from '../../util/noRedirect.js';
import { describeFetchError, isTransportError } from '../../storage/collectors/netError.js';
import { readJsonCapped } from '../../util/readCapped.js';
import { authError, maskText, failText } from '../client.js';
import { DEFAULT_EM_PORT, emFingerprint } from './registry.js';
import {
  overviewOf, jobStatsOf, vmsOverviewOf, processedOf, repoReportOf, backupServersOf, repositoriesOf, sessionsOf, firstArray, jobsWithResults, sessionDigest, pick,
  taskSessionsOf, sessionHeadOf, vmTasksOf, vmPointsOf, rowTimeOf,
} from './parse.js';

const dispatcher = new Agent({ connect: deviceTlsConnect({ subsystem: 'veeam-em', label: 'Veeam Enterprise Manager', envKey: 'VEEAM_TLS_VERIFY', envRaw: process.env.VEEAM_TLS_VERIFY, tls: withSsrfLookup({}) }) });
const TIMEOUT_MS = reqTimeoutMs(process.env.VEEAM_HTTP_TIMEOUT_MS, 60_000);
const LOGOUT_TIMEOUT_MS = 5_000;
const BODY_MAX = 32 * 1024 * 1024;
export const SESSION_PAGE = 500;
export const SESSION_MAX_PAGES = 6;         // 세션 최대 3,000건(28 vCenter · 작업 200여 개 · 하루 수백 회 × 7일 기준)
export const SESSION_WINDOW_MS = 7 * 86_400_000;
/** 읽는 항목 — 화면의 '수집 상태' 줄이 이 순서로 말한다. */
export const EM_SECTIONS = Object.freeze(['overview', 'jobStats', 'vms', 'processed', 'repoReport', 'backupServers', 'jobs', 'repositories', 'sessions', 'vmBackups']);
/*
 * v2.795 VM 단위 기록(vmBackups) — BackupTaskSession·VmRestorePoint 를 **새것부터** 페이지로 받다가 기준 시각보다 오래된 행이 나오면 멈춘다
 *   (날짜 필터 문법이 문서로 확인되지 않아 필터에 기대지 않는다). 기준 = 직전 완결 수집 시각 − 겹침(vmStore.js) · 첫 수집은 8일(주간 작업 포함).
 *   이 항목만의 시간 예산(기본 120초)을 넘거나 페이지 상한에 닿으면 거기까지(complete:false — 다음 수집이 같은 기준으로 다시 읽는다).
 */
export const VM_PAGE = 1000;
export const VM_MAX_PAGES = 40;
export const VM_WINDOW_MS = 8 * 86_400_000;
const vmBudgetMs = () => { const n = Number(process.env.VEEAM_EM_VM_BUDGET_MS); return Number.isFinite(n) && n >= 10_000 ? Math.min(n, 600_000) : 120_000; };

const reqSignal = (signal) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS));
function tokenError() {
  const e = new Error('세션 만료·거부(401) — 로그인은 성공했으므로 주기 수집은 멈추지 않습니다(다음 주기에 다시 로그인)');
  e.status = 401; e.kind = 'token'; e.fatal = true;
  return e;
}
const isFatal = (e) => !!(e?.authFailed || e?.fatal);

/** EM 1대 세션. `em` 은 등록부 원소(비밀 포함). fetchImpl 은 테스트 주입용. */
export function makeEmClient(em, { signal = null, fetchImpl = fetch } = {}) {
  const host = em.host; const port = Number(em.port) || DEFAULT_EM_PORT;
  const base = `https://${host}:${port}`;
  const secrets = [String(em.password || '')];
  let sid = ''; let logonId = '';

  async function call(path, init = {}, { ownSignal = null } = {}) {
    try {
      return refuseRedirect(await fetchImpl(`${base}${path}`, { ...init, redirect: NO_REDIRECT, dispatcher, signal: ownSignal || reqSignal(signal) }), `Veeam EM ${host}`);
    } catch (e) {
      if (!isTransportError(e)) throw e;
      throw new Error(describeFetchError(e, { host, port, timeoutMs: TIMEOUT_MS, cancelled: !!signal?.aborted }), { cause: e });
    }
  }
  const headers = (extra = {}) => ({ Accept: 'application/json', ...(sid ? { 'X-RestSvcSessionId': sid } : {}), ...extra });

  async function login() {
    const basic = Buffer.from(`${String(em.username || '')}:${String(em.password || '')}`, 'utf8').toString('base64');
    const res = await call('/api/sessionMngr/?v=latest', { method: 'POST', headers: headers({ Authorization: `Basic ${basic}` }), body: '' });   // 빈 본문(길이 0) — Content-Length 를 손으로 넣지 않는다(fetch 가 정한다)
    if (res.status === 401 || res.status === 403) { try { await res.body?.cancel?.(); } catch { /* */ } throw authError('인증 실패(401) — Enterprise Manager 계정/비밀번호 확인'); }
    if (!res.ok) throw new Error(`로그인 실패(${await failText(res, secrets)})`);
    sid = String(res.headers?.get?.('x-restsvcsessionid') || '').trim();
    let j = null;
    try { j = await readJsonCapped(res, 256 * 1024, 'Veeam EM 로그인 응답'); } catch { j = null; }
    logonId = String(pick(j, 'SessionId') || '').trim().slice(0, 200);
    if (!sid) throw new Error('로그인 응답에 X-RestSvcSessionId 헤더가 없습니다 — Enterprise Manager REST(9398) 주소인지 확인하세요');
    secrets.push(sid);
  }

  async function get(path) {
    const res = await call(path, { method: 'GET', headers: headers() });
    if (res.status === 401) { try { await res.body?.cancel?.(); } catch { /* */ } throw tokenError(); }
    if (!res.ok) { const e = new Error(`${path.split('?')[0]} ← ${await failText(res, secrets)}`); e.status = res.status; throw e; }
    return readJsonCapped(res, BODY_MAX, `Veeam EM ${path.split('?')[0]} 응답`);
  }

  async function logout() {
    if (!sid) return;
    if (logonId) {
      try { const r = await call(`/api/logonSessions/${encodeURIComponent(logonId)}`, { method: 'DELETE', headers: headers() }, { ownSignal: AbortSignal.timeout(LOGOUT_TIMEOUT_MS) }); try { await r.body?.cancel?.(); } catch { /* */ } } catch { /* 최선 */ }
    }
    sid = '';
  }
  // maskFull — 사유 문구(최대 2,000자)용: maskText 는 300자로 자르므로 길이는 두고 비밀만 가린다(세션 id·비밀번호).
  const maskFull = (t) => { let x = String(t || ''); for (const sct of secrets) if (sct && sct.length >= 3) x = x.split(sct).join('***'); return x; };
  return { login, get, logout, mask: (t) => maskText(t, secrets), maskFull };
}

/** EM 세션 질의 문자열 — 최근 창(기본 7일) · 새것부터 · 페이지. */
export function sessionQuery(type, { page = 1, since = null } = {}) {
  const q = new URLSearchParams({ type, format: 'Entities', pageSize: String(SESSION_PAGE), page: String(page), sortDesc: 'CreationTime' });
  if (since != null) q.set('filter', `CreationTime>="${new Date(since).toISOString()}"`);
  return `/api/query?${q.toString()}`;
}

/** v2.795 VM 단위 질의 — 새것부터 · 페이지(필터 없음). */
export function vmQuery(type, page = 1) {
  const q = new URLSearchParams({ type, format: 'Entities', pageSize: String(VM_PAGE), page: String(page), sortDesc: 'CreationTime' });
  return `/api/query?${q.toString()}`;
}

/**
 * v2.795 VM 단위 기록 읽기 — 두 유형을 각각(한쪽 실패는 사유만 남기고 다른 쪽을 살린다 · 둘 다 실패면 던진다).
 * @returns {{ tasks, points, complete:boolean, errors:object }}
 */
export async function readVmBackups(c, { since, signal = null, budgetMs = vmBudgetMs(), clock = Date.now } = {}) {
  const until = clock() + budgetMs;
  const out = { tasks: [], points: [], complete: true, errors: {} };
  for (const [type, key, conv] of [['BackupTaskSession', 'tasks', vmTasksOf], ['VmRestorePoint', 'points', vmPointsOf]]) {
    try {
      for (let p = 1; ; p++) {
        if (signal?.aborted) throw new Error('수집 시한이 지났습니다');
        if (p > VM_MAX_PAGES || clock() > until) { out.complete = false; break; }
        const list = firstArray(await c.get(vmQuery(type, p)));
        let older = false;
        const fresh = [];
        for (const x of list) { const t = rowTimeOf(x); if (t != null && t < since) { older = true; continue; } fresh.push(x); }
        for (const x of conv(fresh)) out[key].push(x);
        if (older || list.length < VM_PAGE) break;
      }
    } catch (e) {
      if (isFatal(e) || signal?.aborted) throw e;
      out.errors[key] = c.mask(String(e?.message || e)).slice(0, 160);
      out.complete = false;
    }
  }
  if (out.errors.tasks && out.errors.points) throw new Error(`VM 별 작업 결과·복원 지점을 모두 읽지 못했습니다 — ${out.errors.tasks}`);
  return out;
}

/**
 * EM 1대를 읽어 결과를 만든다. 로그인 실패·인증 실패는 던진다(호출자가 ok:false 결과로 바꾼다).
 * 그 밖의 항목 실패는 sections[항목] = { ok:false, reason } 로 남기고 나머지로 결과를 만든다 — 모든 항목이 실패하면 전체 실패.
 */
export async function collectEm(em, { signal = null, fetchImpl, now = Date.now(), vmSince = null } = {}) {
  const t0 = Date.now();
  const c = makeEmClient(em, { signal, ...(fetchImpl ? { fetchImpl } : {}) });
  const sections = {}; const notes = [];
  await c.login();
  try {
    const soft = async (key, fn) => {
      try { const v = await fn(); sections[key] = { ok: true }; return v; }
      catch (e) { if (isFatal(e)) throw e; sections[key] = { ok: false, reason: c.mask(String(e?.message || e)).slice(0, 200), ...(Number.isInteger(e?.status) ? { status: e.status } : {}) }; return null; }
    };
    const overview = overviewOf(await soft('overview', () => c.get('/api/reports/summary/overview')));
    const jobStats = jobStatsOf(await soft('jobStats', () => c.get('/api/reports/summary/job_statistics')));
    const vms = vmsOverviewOf(await soft('vms', () => c.get('/api/reports/summary/vms_overview')));
    const processed = processedOf(await soft('processed', () => c.get('/api/reports/summary/processed_vms')));
    const repoReportBody = await soft('repoReport', () => c.get('/api/reports/summary/repository'));
    const backupServersBody = await soft('backupServers', () => c.get('/api/backupServers?format=Entity'));
    const jobsBody = await soft('jobs', () => c.get('/api/jobs?format=Entity'));
    const repositoriesBody = await soft('repositories', () => c.get('/api/repositories?format=Entity'));
    // 세션 — 최근 7일 · 새것부터 · 페이지 상한. 필터를 거절(400)하면 필터 없이 받아 직접 거른다(정렬은 받은 대로 — 그래서 상한에 걸리면 알린다).
    const rawSessions = await soft('sessions', async () => {
      const out = []; let truncated = false; let filtered = true; let replicaErr = '';
      for (const type of ['BackupJobSession', 'ReplicaJobSession']) {
        for (let p = 1; p <= SESSION_MAX_PAGES; p++) {
          let body;
          try { body = await c.get(sessionQuery(type, { page: p, since: filtered ? now - SESSION_WINDOW_MS : null })); }
          catch (e) {
            if (e?.status === 400 && filtered && p === 1) { filtered = false; body = await c.get(sessionQuery(type, { page: p })); }
            // 복제 세션은 덤이다 — 실패해도 백업 세션은 살린다(받지 않는 판·권한 부족). 인증·시한 실패만 위로.
            else if (type === 'ReplicaJobSession' && !isFatal(e) && !signal?.aborted) { replicaErr = c.mask(String(e?.message || e)).slice(0, 160); break; }
            else throw e;
          }
          const list = firstArray(body);
          for (const x of list) out.push(x);
          if (list.length < SESSION_PAGE) break;
          if (p === SESSION_MAX_PAGES) truncated = true;
        }
      }
      return { list: out, truncated, filtered, replicaErr };
    });
    // v2.795 VM 단위 기록 — 결과에는 행 수만 싣고, 행(vmRows)은 폴러가 vmStore 에 합친 뒤 버린다(veeam-em-latest.json 을 키우지 않게).
    const since = Number.isFinite(vmSince) && vmSince > now - 400 * 86_400_000 ? vmSince : now - VM_WINDOW_MS;
    const vmRows = await soft('vmBackups', () => readVmBackups(c, { since, signal }));
    if (signal?.aborted) throw new Error('수집 시한이 지나 일부만 읽었습니다 — 부분 결과는 저장하지 않습니다');
    if (!Object.values(sections).some((s) => s.ok)) {
      const first = Object.entries(sections).find(([, s]) => !s.ok);
      throw new Error(`Enterprise Manager 의 어떤 항목도 읽지 못했습니다${first ? ` — ${first[0]}: ${first[1].reason}` : ''}`);
    }
    let sessions = sessionsOf(rawSessions?.list || []);
    if (rawSessions && !rawSessions.filtered) {
      sessions = sessions.filter((s) => (s.end ?? s.start ?? 0) >= now - SESSION_WINDOW_MS || (s.end == null && s.start == null));
      notes.push('이 EM 이 세션 기간 필터를 받지 않아 필터 없이 받아 7일로 걸렀습니다(오래된 세션이 많으면 최근 것이 빠질 수 있습니다)');
    }
    if (rawSessions?.replicaErr) notes.push(`복제 작업 세션은 읽지 못했습니다(백업 세션만): ${rawSessions.replicaErr}`);
    if (rawSessions?.truncated) notes.push(`세션이 많아 유형별 ${SESSION_PAGE * SESSION_MAX_PAGES}건까지만 읽었습니다(새것부터)`);
    if (vmRows && !vmRows.complete) notes.push(`VM 별 기록은 일부만 읽었습니다(새것부터 — 시간·페이지 상한${vmRows.errors.tasks ? ' · 작업 결과 실패' : ''}${vmRows.errors.points ? ' · 복원 지점 실패' : ''}) — 다음 수집이 같은 기준으로 다시 읽습니다`);
    const jobs = jobsBody ? jobsWithResults(jobsBody, sessions, { now }) : null;
    const digest = rawSessions ? sessionDigest(sessions, { now }) : null;
    return {
      ok: true, ts: Date.now(), ms: Date.now() - t0, target: emFingerprint(em), error: '', sections, notes,
      overview, jobStats, vms, processed,
      repoReport: repoReportBody ? repoReportOf(repoReportBody) : null,
      backupServers: backupServersBody ? backupServersOf(backupServersBody) : null,
      repositories: repositoriesBody ? repositoriesOf(repositoriesBody) : null,
      jobs, sessions: digest,
      vmBackups: vmRows ? { since, tasks: vmRows.tasks.length, points: vmRows.points.length, complete: vmRows.complete, errors: vmRows.errors } : null,
      ...(vmRows ? { vmRows: { since, tasks: vmRows.tasks, points: vmRows.points, complete: vmRows.complete } } : {}),
    };
  } finally {
    await c.logout();
  }
}

/** 연결 시험 — 로그인 + 전체 개요 1건(결과 전체를 만들지 않는다). */
export async function testEm(em, { signal = null, fetchImpl } = {}) {
  const t0 = Date.now();
  const c = makeEmClient(em, { signal, ...(fetchImpl ? { fetchImpl } : {}) });
  await c.login();
  try {
    const o = overviewOf(await c.get('/api/reports/summary/overview'));
    return { ok: true, ms: Date.now() - t0, backupServers: o?.backupServers ?? null };
  } finally { await c.logout(); }
}

/** EM 세션 UID('urn:veeam:BackupJobSession:<GUID>' 또는 GUID) → 경로에 넣을 GUID. 형식이 아니면 ''(지어내지 않는다). */
export function sessionIdOf(uid) {
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(String(uid || '').trim().slice(-120));
  return m ? m[1].toLowerCase() : '';
}

/**
 * v2.788.1 실패·경고 상세 — 세션 1건의 머리(사유 포함일 수 있음)와 VM 별 결과·사유. 사람이 눌렀을 때만 부른다(주기 수집 아님).
 * 인증 실패는 던진다(authFailed — 호출부가 정지를 기록한다). 두 항목은 각각 soft — 하나만 읽혀도 돌려준다.
 */
export async function sessionDetail(em, uid, { signal = null, fetchImpl } = {}) {
  const id = sessionIdOf(uid);
  if (!id) throw new Error('세션 식별자 형식이 아닙니다');
  const c = makeEmClient(em, { signal, ...(fetchImpl ? { fetchImpl } : {}) });
  await c.login();
  try {
    const out = { head: null, tasks: null, errors: {} };
    try { out.head = sessionHeadOf(await c.get(`/api/backupSessions/${id}?format=Entity`)); } catch (e) { if (isFatal(e)) throw e; out.errors.head = c.mask(String(e?.message || e)).slice(0, 200); }
    try { out.tasks = taskSessionsOf(await c.get(`/api/backupSessions/${id}/taskSessions?format=Entity`)).map((t) => ({ ...t, reason: c.maskFull(t.reason) })); }
    catch (e) { if (isFatal(e)) throw e; out.errors.tasks = c.mask(String(e?.message || e)).slice(0, 200); }
    if (out.head?.reason) out.head.reason = c.maskFull(out.head.reason);
    if (!out.head && !out.tasks) throw new Error(`세션 상세를 읽지 못했습니다 — ${out.errors.tasks || out.errors.head || '사유 모름'}`);
    return out;
  } finally { await c.logout(); }
}
