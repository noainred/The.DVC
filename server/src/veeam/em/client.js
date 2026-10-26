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
} from './parse.js';

const dispatcher = new Agent({ connect: deviceTlsConnect({ subsystem: 'veeam-em', label: 'Veeam Enterprise Manager', envKey: 'VEEAM_TLS_VERIFY', envRaw: process.env.VEEAM_TLS_VERIFY, tls: withSsrfLookup({}) }) });
const TIMEOUT_MS = reqTimeoutMs(process.env.VEEAM_HTTP_TIMEOUT_MS, 60_000);
const LOGOUT_TIMEOUT_MS = 5_000;
const BODY_MAX = 32 * 1024 * 1024;
export const SESSION_PAGE = 500;
export const SESSION_MAX_PAGES = 6;         // 세션 최대 3,000건(28 vCenter · 작업 200여 개 · 하루 수백 회 × 7일 기준)
export const SESSION_WINDOW_MS = 7 * 86_400_000;
/** 읽는 항목 — 화면의 '수집 상태' 줄이 이 순서로 말한다. */
export const EM_SECTIONS = Object.freeze(['overview', 'jobStats', 'vms', 'processed', 'repoReport', 'backupServers', 'jobs', 'repositories', 'sessions']);

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
  return { login, get, logout, mask: (t) => maskText(t, secrets) };
}

/** EM 세션 질의 문자열 — 최근 창(기본 7일) · 새것부터 · 페이지. */
export function sessionQuery(type, { page = 1, since = null } = {}) {
  const q = new URLSearchParams({ type, format: 'Entities', pageSize: String(SESSION_PAGE), page: String(page), sortDesc: 'CreationTime' });
  if (since != null) q.set('filter', `CreationTime>="${new Date(since).toISOString()}"`);
  return `/api/query?${q.toString()}`;
}

/**
 * EM 1대를 읽어 결과를 만든다. 로그인 실패·인증 실패는 던진다(호출자가 ok:false 결과로 바꾼다).
 * 그 밖의 항목 실패는 sections[항목] = { ok:false, reason } 로 남기고 나머지로 결과를 만든다 — 모든 항목이 실패하면 전체 실패.
 */
export async function collectEm(em, { signal = null, fetchImpl, now = Date.now() } = {}) {
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
    const jobs = jobsBody ? jobsWithResults(jobsBody, sessions, { now }) : null;
    const digest = rawSessions ? sessionDigest(sessions, { now }) : null;
    return {
      ok: true, ts: Date.now(), ms: Date.now() - t0, target: emFingerprint(em), error: '', sections, notes,
      overview, jobStats, vms, processed,
      repoReport: repoReportBody ? repoReportOf(repoReportBody) : null,
      backupServers: backupServersBody ? backupServersOf(backupServersBody) : null,
      repositories: repositoriesBody ? repositoriesOf(repositoriesBody) : null,
      jobs, sessions: digest,
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
