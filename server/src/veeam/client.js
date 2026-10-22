/**
 * veeam/client.js — Veeam Backup & Replication REST(v12+, 기본 포트 9419) 읽기 전용 수집기(v2.751).
 *
 * 흐름: POST /api/oauth2/token(grant_type=password) → GET /api/v1/jobs · /api/v1/jobs/states · /api/v1/backupObjects(페이지)
 *       · /api/v1/sessions(실행 중) · 실행 중 세션마다 /api/v1/sessions/{id}/taskSessions → POST /api/oauth2/logout(최선).
 * 모든 요청에 `x-api-version` 헤더가 필요하다(토큰 요청 포함 — Veeam 문서). 판은 서버마다 등록부의 apiVersion.
 *
 * 규약:
 *  · **조회 전용** — 작업 시작·중지 같은 POST 를 이 모듈에 더하지 말 것(백업 모니터링은 읽기만 한다).
 *  · TLS 는 장비 신뢰 판정(security/tlsTrust.js deviceTlsConnect — CA 체인 또는 승인 지문)을 **비밀번호를 보내기 전에** 거친다.
 *    Veeam 기본 인증서는 자체서명이라 처음에는 '승인 대기' 로 끊긴다 — 설정 › Security › 장비 신뢰에서 승인한다(그 노드에서).
 *  · DNS 리바인딩 차단(withSsrfLookup) · 리다이렉트 거부(토큰을 다른 주소로 따라 보내지 않는다).
 *  · 401 은 즉시 중단(authFailed 표지) — 폴러가 주기 수집을 멈춘다(util/authGuard.js, 계정 잠금 예방). 자동 재시도 없음.
 *  · 오류 문구에 비밀번호·토큰을 싣지 않는다(응답 본문에 되울려도 가린다).
 */
import { Agent } from 'undici';
import { withSsrfLookup } from '../util/ssrfLookup.js';
import { deviceTlsConnect } from '../security/tlsTrust.js';
import { reqTimeoutMs } from '../util/envTimeout.js';
import { NO_REDIRECT, refuseRedirect } from '../util/noRedirect.js';
import { describeFetchError, isTransportError } from '../storage/collectors/netError.js';
import { readJsonCapped } from '../util/readCapped.js';
import { readBodyPrefix } from '../util/readPrefix.js';
import { pushAll } from '../util/pushAll.js';
import { buildServerResult, listOf } from './parse.js';
import { DEFAULT_PORT, DEFAULT_API_VERSION } from './registry.js';

const dispatcher = new Agent({ connect: deviceTlsConnect({ subsystem: 'veeam', label: 'Veeam', envKey: 'VEEAM_TLS_VERIFY', envRaw: process.env.VEEAM_TLS_VERIFY, tls: withSsrfLookup({}) }) });
const TIMEOUT_MS = reqTimeoutMs(process.env.VEEAM_HTTP_TIMEOUT_MS, 60_000);
const PAGE = 500;
const MAX_PAGES = 60;            // backupObjects 최대 3만 건(5,850 VM 규모의 다섯 배)
const MAX_SESSIONS = 20;         // 실행 중 세션의 task 조회 상한(요청 수 상한)
const BODY_MAX = 32 * 1024 * 1024;

const reqSignal = (signal) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS));

export function authError(message = '인증 실패(401) — Veeam 계정/비밀번호 확인') {
  const e = new Error(message); e.authFailed = true; e.status = 401; e.kind = 'auth';
  return e;
}

/** 오류 문구에서 비밀을 가린다 — **가린 뒤에** 자른다(v2.751 검토 #8: 먼저 자르면 경계에 걸린 비밀의 앞부분이 남는다). URL 인코딩된 형태도 가린다. */
function maskText(text, secrets) {
  let t = String(text || '').slice(0, 8192).replace(/[\x00-\x1f]+/g, ' '); // eslint-disable-line no-control-regex
  for (const sct of secrets) {
    if (!sct || sct.length < 3) continue;
    for (const form of new Set([sct, encodeURIComponent(sct), new URLSearchParams({ p: sct }).toString().slice(2)])) {
      if (form && t.includes(form)) t = t.split(form).join('***');
    }
  }
  return t.trim().slice(0, 300);
}

async function failText(res, secrets) {
  let text = '';
  // 앞부분만 읽는다(본문 전체를 읽고 자르지 않는다). 상한에서 잘렸으면 끝 256자를 버린다 — 경계에 걸려 반쯤 남은 비밀은 가림이 못 찾는다.
  try { const r = await readBodyPrefix(res, 4096); text = r.capped ? r.text.slice(0, -256) : r.text; } catch { text = ''; }
  let detail = '';
  try { const j = JSON.parse(text); detail = String(j?.message || j?.errorCode || j?.error_description || j?.error || ''); } catch { detail = text; }
  return `HTTP ${res.status}${detail ? ` — ${maskText(detail, secrets)}` : ''}`;
}

/**
 * 서버 1대 세션. `server` 는 등록부 원소(비밀 포함). fetchImpl 은 테스트 주입용.
 */
export function makeVeeamClient(server, { signal = null, fetchImpl = fetch } = {}) {
  const host = server.host; const port = Number(server.port) || DEFAULT_PORT;
  const base = `https://${host}:${port}`;
  const apiVersion = server.apiVersion || DEFAULT_API_VERSION;
  const secrets = [String(server.password || '')];
  let token = '';

  async function call(path, init = {}) {
    let res;
    try {
      res = refuseRedirect(await fetchImpl(`${base}${path}`, { ...init, redirect: NO_REDIRECT, dispatcher, signal: reqSignal(signal) }), `Veeam ${host}`);
    } catch (e) {
      if (!isTransportError(e)) throw e;
      throw new Error(describeFetchError(e, { host, port, timeoutMs: TIMEOUT_MS, cancelled: !!signal?.aborted }), { cause: e });
    }
    return res;
  }
  const headers = (extra = {}) => ({ Accept: 'application/json', 'x-api-version': apiVersion, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra });

  async function login() {
    const body = new URLSearchParams({ grant_type: 'password', username: String(server.username || ''), password: String(server.password || '') });
    const res = await call('/api/oauth2/token', { method: 'POST', headers: headers({ 'Content-Type': 'application/x-www-form-urlencoded' }), body: body.toString() });
    if (res.status === 401 || res.status === 403) { try { await res.body?.cancel?.(); } catch { /* */ } throw authError(); }
    // 잘못된 계정은 400 invalid_grant 로 오는 판도 있다 — 그것도 인증 실패다(주기 수집을 멈춰 계정 잠금을 막는다).
    if (res.status === 400) {
      const t = await failText(res, secrets);
      if (/invalid_grant|password|credential|logon|unauthori/i.test(t)) throw authError(`인증 실패 — ${t}`);
      throw new Error(`토큰 요청 거부(${t}) — API 판('${apiVersion}')이 이 서버에서 지원되는지 확인하세요`);
    }
    if (!res.ok) throw new Error(`토큰 요청 실패(${await failText(res, secrets)})`);
    const j = await readJsonCapped(res, 256 * 1024, 'Veeam 토큰 응답');
    token = typeof j?.access_token === 'string' ? j.access_token : '';
    if (!token) throw new Error('토큰 응답에 access_token 이 없습니다');
    secrets.push(token);
  }

  async function get(path) {
    const res = await call(path, { method: 'GET', headers: headers() });
    if (res.status === 401) { try { await res.body?.cancel?.(); } catch { /* */ } throw authError('인증 만료·거부(401)'); }
    if (!res.ok) { const e = new Error(`${path.split('?')[0]} ← ${await failText(res, secrets)}`); e.status = res.status; throw e; }
    return readJsonCapped(res, BODY_MAX, `Veeam ${path.split('?')[0]} 응답`);
  }

  /** 페이지를 합친 원소 배열. */
  async function getAll(path) {
    const out = [];
    for (let p = 0; p < MAX_PAGES; p++) {
      const sep = path.includes('?') ? '&' : '?';
      const body = await get(`${path}${sep}skip=${p * PAGE}&limit=${PAGE}`);
      const items = listOf(body);
      pushAll(out, items); // 백업 객체는 수만 건일 수 있다 — 펼침 인자 push 금지
      const total = Number(body?.pagination?.total);
      if (items.length < PAGE || (Number.isFinite(total) && out.length >= total)) break;
    }
    return out;
  }

  async function logout() {
    if (!token) return;
    try { const r = await call('/api/oauth2/logout', { method: 'POST', headers: headers() }); try { await r.body?.cancel?.(); } catch { /* */ } } catch { /* 최선 */ }
    token = '';
  }
  return { login, get, getAll, logout, apiVersion };
}

/**
 * 서버 1대를 읽어 결과(push·보관 모양)를 만든다. 실패는 던진다(호출자가 ok:false 결과로 바꾼다).
 * 부분 실패(상태·백업 객체·세션)는 notes 로 남기고 나머지로 결과를 만든다 — 작업 목록조차 못 읽으면 실패다.
 */
export async function collectVeeamServer(server, { signal = null, fetchImpl } = {}) {
  const t0 = Date.now();
  const c = makeVeeamClient(server, { signal, ...(fetchImpl ? { fetchImpl } : {}) });
  const notes = [];
  await c.login();
  try {
    const jobs = await c.getAll('/api/v1/jobs');
    const soft = async (label, fn) => {
      try { return await fn(); } catch (e) { if (e?.authFailed) throw e; notes.push(`${label}을(를) 읽지 못했습니다: ${String(e?.message || e).slice(0, 200)}`); return null; }
    };
    const states = await soft('작업 상태', () => c.getAll('/api/v1/jobs/states'));
    const backupObjects = await soft('백업 객체', () => c.getAll('/api/v1/backupObjects'));
    // 실행 중 세션 — 필터 이름이 판마다 다를 수 있어 거절(400)이면 필터 없이 최근 세션을 받아 직접 거른다.
    let sesList = await soft('실행 중 세션', async () => {
      try { return listOf(await c.get(`/api/v1/sessions?stateFilter=Working&limit=${PAGE}`)); }
      catch (e) { if (e?.status === 400) return listOf(await c.get(`/api/v1/sessions?limit=${PAGE}`)); throw e; }
    });
    sesList = (sesList || []).filter((x) => x && typeof x === 'object' && /^(working|starting|resuming)$/i.test(String(x.state || ''))
      && (!x.sessionType || /backup/i.test(String(x.sessionType))));
    if (sesList.length > MAX_SESSIONS) notes.push(`실행 중 세션 ${sesList.length}개 중 ${MAX_SESSIONS}개만 VM 단위로 읽었습니다(나머지는 작업 단위)`);
    const sessions = [];
    for (const [i, ses] of sesList.entries()) {
      if (i >= MAX_SESSIONS) { sessions.push({ session: ses, tasks: null, tasksError: 'skipped' }); continue; }
      const id = encodeURIComponent(String(ses.id || ''));
      try { sessions.push({ session: ses, tasks: await c.get(`/api/v1/sessions/${id}/taskSessions?limit=${PAGE}`) }); }
      catch (e) { if (e?.authFailed) throw e; sessions.push({ session: ses, tasks: null, tasksError: String(e?.message || e).slice(0, 120) }); }
    }
    if (sessions.some((x) => x.tasksError && x.tasksError !== 'skipped')) notes.push('실행 중 세션의 VM 단위 task 를 읽지 못해 그 작업의 VM 을 작업 단위로 \'백업 중\' 표시했습니다');
    const r = buildServerResult({ jobs, states, backupObjects, sessions });
    return { ok: true, ts: Date.now(), ms: Date.now() - t0, apiVersion: c.apiVersion, error: '', jobs: r.jobs, vms: r.vms, counts: r.counts, notes: [...notes, ...r.notes] };
  } finally {
    await c.logout();
  }
}

/** 연결 시험 — 로그인 + 작업 수만(결과 전체를 만들지 않는다). */
export async function testVeeamServer(server, { signal = null, fetchImpl } = {}) {
  const t0 = Date.now();
  const c = makeVeeamClient(server, { signal, ...(fetchImpl ? { fetchImpl } : {}) });
  await c.login();
  try {
    const body = await c.get('/api/v1/jobs?limit=1');
    const total = Number(body?.pagination?.total);
    return { ok: true, ms: Date.now() - t0, apiVersion: c.apiVersion, jobs: Number.isFinite(total) ? total : listOf(body).length };
  } finally { await c.logout(); }
}
