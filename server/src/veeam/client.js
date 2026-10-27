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
 *  · **로그인**(토큰 요청)의 401·403·invalid_grant 는 즉시 중단(authFailed 표지) — 폴러가 주기 수집을 멈춘다(util/authGuard.js, 계정 잠금 예방).
 *    로그인이 성공한 뒤 GET 의 401(토큰 만료·VBR 서비스 재시작)은 자격증명 문제가 아니다 — 이번 수집만 실패(kind 'token'), 정지하지 않는다(v2.761 A3).
 *    어느 쪽이든 같은 실행 안에서 다시 로그인하지 않는다(자동 재시도 없음).
 *  · 시한(signal)이 끊기면 부분 결과를 성공으로 돌려주지 않는다(v2.761 A2 — 직전 완전한 결과를 덮지 않게).
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
import { poolSettled } from '../util/pool.js';
import { buildServerResult, listOf, isBackupSessionType, licenseOf } from './parse.js';
import { DEFAULT_PORT, DEFAULT_API_VERSION, accessFingerprint } from './registry.js';
import { numOrNull } from '../util/numOrNull.js';

const dispatcher = new Agent({ connect: deviceTlsConnect({ subsystem: 'veeam', label: 'Veeam', envKey: 'VEEAM_TLS_VERIFY', envRaw: process.env.VEEAM_TLS_VERIFY, tls: withSsrfLookup({}) }) });
const TIMEOUT_MS = reqTimeoutMs(process.env.VEEAM_HTTP_TIMEOUT_MS, 60_000);
const PAGE = 500;
const MAX_PAGES = 60;            // backupObjects 최대 3만 건(5,850 VM 규모의 다섯 배)
const MAX_SESSIONS = 20;         // 실행 중 세션의 task 조회 상한(요청 수 상한)
const MAX_LAST_JOBS = 40;        // '마지막으로 끝난 세션' 의 task 를 읽을 작업 수 상한(VM 별 완료 시각·결과)
const MAX_BACKUPS = 100;         // 파일(용량)을 읽을 백업(체인) 수 상한
const TASK_MAX_PAGES = 10;       // v2.763(V1-7): 세션 하나의 task 페이지 상한(VM 5천 대 — 그 너머는 잘렸다고 말한다)
const RP_MAX_PAGES = 100;        // 복원 지점 최대 5만 건
const FILES_UNSUPPORTED_N = 3;   // 백업 파일 목록이 처음부터 연속 이만큼 404·400 이면 '이 판은 미지원'(v2.761 A7 — 한 건은 개별 경합)
const LOGOUT_TIMEOUT_MS = 5_000; // logout 은 상위 시한과 따로(시한이 끊긴 뒤에도 토큰 세션을 닫으려 시도한다 — v2.761 A2)
const BODY_MAX = 32 * 1024 * 1024;

/**
 * v2.762(G-I1): 판 올림 키 — 경로 틀. '/api/v1/<모음>/<id>/<하위>' 의 id 마디를 '{id}' 로 바꾼다(백업·세션마다 400→재요청과
 *   '판 올림' notes 가 쌓이지 않게). 하위 경로가 없는 넷째 마디('/api/v1/jobs/states')는 id 가 아니다.
 */
export const pathTemplate = (p) => String(p || '').split('/').map((seg, i, a) => (i >= 4 && i % 2 === 0 && i < a.length - 1 ? '{id}' : seg)).join('/');

const reqSignal = (signal) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS));

export function authError(message = '인증 실패(401) — Veeam 계정/비밀번호 확인') {
  const e = new Error(message); e.authFailed = true; e.status = 401; e.kind = 'auth';
  return e;
}
/** 로그인 뒤 GET 의 401(v2.761 A3) — 이번 수집 전체를 실패로(fatal) 하되 인증 정지는 하지 않는다(authFailed 없음). */
function tokenError() {
  const e = new Error('토큰 만료·거부(401) — 로그인은 성공했으므로 주기 수집은 멈추지 않습니다(다음 주기에 다시 로그인)');
  e.status = 401; e.kind = 'token'; e.fatal = true;
  return e;
}
/** 부분 결과로 넘기지 않고 수집 전체를 실패시킬 오류인가 — 인증 실패·토큰 거부. */
const isFatal = (e) => !!(e?.authFailed || e?.fatal);

/** 오류 문구에서 비밀을 가린다 — **가린 뒤에** 자른다(v2.751 검토 #8: 먼저 자르면 경계에 걸린 비밀의 앞부분이 남는다). URL 인코딩된 형태도 가린다. */
export function maskText(text, secrets) {
  let t = String(text || '').slice(0, 8192).replace(/[\x00-\x1f]+/g, ' '); // eslint-disable-line no-control-regex
  for (const sct of secrets) {
    if (!sct || sct.length < 3) continue;
    for (const form of new Set([sct, encodeURIComponent(sct), new URLSearchParams({ p: sct }).toString().slice(2)])) {
      if (form && t.includes(form)) t = t.split(form).join('***');
    }
  }
  return t.trim().slice(0, 300);
}

const verKey = (v) => { const m = /^v?(\d{1,3})\.(\d{1,3})-rev(\d{1,3})$/i.exec(String(v || '').trim()); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };
const verCmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
/**
 * '판을 지원하지 않습니다' 거절문에서 지원 목록을 읽어 지금 판보다 높은 것 중 가장 높은 판을 돌려준다. 없으면 null.
 * 예(실서버 VBR 12.3): 'Unsupported RESTAPI version. The following versions are supported: v1.0-rev1, …, v1.2-rev0'
 */
export function higherVersion(text, current) {
  const t = String(text || '').slice(0, 2000);
  if (!/unsupported\s+rest\s*api\s+version/i.test(t)) return null;
  const cur = verKey(current);
  let best = null; let bestKey = null;
  for (const m of t.matchAll(/\bv?(\d{1,3}\.\d{1,3}-rev\d{1,3})\b/gi)) {
    const k = verKey(m[1]);
    if (!k || (cur && verCmp(k, cur) <= 0)) continue;
    if (!bestKey || verCmp(k, bestKey) > 0) { best = m[1]; bestKey = k; }
  }
  return best;
}

export async function failText(res, secrets) {
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

  async function call(path, init = {}, { ownSignal = null } = {}) {
    let res;
    try {
      res = refuseRedirect(await fetchImpl(`${base}${path}`, { ...init, redirect: NO_REDIRECT, dispatcher, signal: ownSignal || reqSignal(signal) }), `Veeam ${host}`);
    } catch (e) {
      if (!isTransportError(e)) throw e;
      throw new Error(describeFetchError(e, { host, port, timeoutMs: TIMEOUT_MS, cancelled: !!signal?.aborted }), { cause: e });
    }
    return res;
  }
  const headers = (extra = {}, ver = apiVersion) => ({ Accept: 'application/json', 'x-api-version': ver, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra });
  // 경로마다 쓰는 판 — 서버가 '이 판은 지원하지 않습니다(지원: …)' 로 거절한 경로만 지원 목록의 가장 높은 판으로 올린다(v2.752, 실서버:
  // VBR 12.3 은 /api/v1/restorePoints 를 1.2-rev0 이상에서만 준다). 그 밖의 경로는 등록한 판 그대로(응답 모양이 판마다 다를 수 있다).
  const pathVer = new Map();
  const bumped = [];

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

  async function get(path, retried = false) {
    const base0 = path.split('?')[0];
    const key = pathTemplate(base0);
    const ver = pathVer.get(key) || apiVersion;
    const res = await call(path, { method: 'GET', headers: headers({}, ver) });
    if (res.status === 401) { try { await res.body?.cancel?.(); } catch { /* */ } throw tokenError(); }
    if (!res.ok) {
      const text = await failText(res, secrets);
      if (res.status === 400 && !retried) { // 한 번만 — 올린 판으로도 실패하면 그 오류를 그대로 던진다
        const now = pathVer.get(key);
        // 같은 틀의 다른 요청(4병렬)이 그 사이 판을 올렸으면 그 판으로 한 번 더(판 올림 기록은 틀마다 1건).
        if (now && now !== ver) return get(path, true);
        const up = !now ? higherVersion(text, ver) : null;
        if (up) { pathVer.set(key, up); bumped.push({ path: key, from: ver, to: up }); return get(path, true); }
      }
      const e = new Error(`${base0} ← ${text}`); e.status = res.status; throw e;
    }
    return readJsonCapped(res, BODY_MAX, `Veeam ${base0} 응답`);
  }

  /**
   * 페이지를 합친 원소 배열. 상한(maxPages)에서 멈췄거나 total 보다 적게 끝났으면 배열에 truncated:true 를 단다(호출부가 안내한다).
   * v2.761 A4: skip 은 **받은 개수**로 누적한다(서버가 limit 을 낮춰 주면 p*PAGE 는 건너뛴다) · pagination.total 이 있으면 그것으로
   *   끝을 정한다('짧은 페이지 = 끝' 은 total 이 없을 때만). total 이 null·빈 값이면 모름(Number(null)===0 함정).
   */
  async function getAll(path, { maxPages = MAX_PAGES } = {}) {
    const out = [];
    for (let p = 0; p < maxPages; p++) {
      const sep = path.includes('?') ? '&' : '?';
      const body = await get(`${path}${sep}skip=${out.length}&limit=${PAGE}`);
      const items = listOf(body);
      pushAll(out, items); // 백업 객체는 수만 건일 수 있다 — 펼침 인자 push 금지
      const tv = body?.pagination?.total;
      const total = typeof tv === 'number' || (typeof tv === 'string' && tv.trim() !== '') ? Number(tv) : NaN;
      const hasTotal = Number.isFinite(total) && total >= 0;
      if (!items.length) { if (hasTotal && out.length < total) out.truncated = true; return out; }
      if (hasTotal ? out.length >= total : items.length < PAGE) return out;
    }
    out.truncated = true;
    return out;
  }

  async function logout() {
    if (!token) return;
    try { const r = await call('/api/oauth2/logout', { method: 'POST', headers: headers() }, { ownSignal: AbortSignal.timeout(LOGOUT_TIMEOUT_MS) }); try { await r.body?.cancel?.(); } catch { /* */ } } catch { /* 최선 */ }
    token = '';
  }
  return { login, get, getAll, logout, apiVersion, bumped };
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
      try { return await fn(); } catch (e) { if (isFatal(e)) throw e; notes.push(`${label}을(를) 읽지 못했습니다: ${String(e?.message || e).slice(0, 200)}`); return null; }
    };
    // v2.761 A4: 상한·total 로 잘린 목록은 사실을 말한다(예전에는 복원 지점만 안내했다).
    const cut = (label, arr) => { if (arr?.truncated) notes.push(`${label}이(가) ${arr.length}개에서 잘려 일부만 읽었습니다`); return arr; };
    cut('작업 목록', jobs);
    const states = cut('작업 상태', await soft('작업 상태', () => c.getAll('/api/v1/jobs/states')));
    const backupObjects = cut('백업 객체', await soft('백업 객체', () => c.getAll('/api/v1/backupObjects')));
    // 실행 중 세션 — 필터 이름이 판마다 다를 수 있어 거절(400)이면 필터 없이 최근 세션을 받아 직접 거른다.
    let sesList = await soft('실행 중 세션', async () => {
      try { return listOf(await c.get(`/api/v1/sessions?stateFilter=Working&limit=${PAGE}`)); }
      catch (e) { if (e?.status === 400) return listOf(await c.get(`/api/v1/sessions?limit=${PAGE}`)); throw e; }
    });
    sesList = (sesList || []).filter((x) => x && typeof x === 'object' && /^(working|starting|resuming)$/i.test(String(x.state || ''))
      && isBackupSessionType(x.sessionType)); // v2.761 A1: 끝난 세션 필터와 같은 판정(백업 복사·복제 제외)
    if (sesList.length > MAX_SESSIONS) notes.push(`실행 중 세션 ${sesList.length}개 중 ${MAX_SESSIONS}개만 VM 단위로 읽었습니다(나머지는 작업 단위)`);
    const authOf = (rs) => { const x = rs.find((r) => r.status === 'rejected' && isFatal(r.reason)); if (x) throw x.reason; }; // 묶음 안의 401 도 전체 실패로
    // v2.762(G-I2): 실행 중 세션의 task 도 4병렬(고RTT 800ms 에서 순차 20건 = 16초가 서버 시한에서 빠졌다). 순서·'skipped' 원소는 그대로.
    const sessions = sesList.map((ses, i) => (i >= MAX_SESSIONS ? { session: ses, tasks: null, tasksError: 'skipped' } : null));
    authOf(await poolSettled(sesList.slice(0, MAX_SESSIONS), 4, async (ses, i) => {
      const id = encodeURIComponent(String(ses.id || ''));
      // v2.763(V1-7): task 도 total 까지 페이지로 읽는다(예전에는 limit 500 한 쪽만 — 501번째 VM 부터 '백업 중' 에서 빠지고 running 이 확정 0 처럼 나갔다).
      //   상한에서 잘리면 그 세션은 작업 단위 표시로(일부 task 로 '나머지는 안 돈다' 고 단정하지 않는다).
      try {
        const tasks = await c.getAll(`/api/v1/sessions/${id}/taskSessions`, { maxPages: TASK_MAX_PAGES });
        sessions[i] = tasks.truncated ? { session: ses, tasks: null, tasksError: 'truncated' } : { session: ses, tasks };
      } catch (e) { if (isFatal(e)) throw e; sessions[i] = { session: ses, tasks: null, tasksError: String(e?.message || e).slice(0, 120) }; }
    }));
    if (sessions.some((x) => x.tasksError && x.tasksError !== 'skipped' && x.tasksError !== 'truncated')) notes.push('실행 중 세션의 VM 단위 task 를 읽지 못해 그 작업의 VM 을 작업 단위로 \'백업 중\' 표시했습니다');
    if (sessions.some((x) => x.tasksError === 'truncated')) notes.push(`실행 중 세션의 task 가 ${TASK_MAX_PAGES * PAGE}개를 넘어 그 작업의 VM 을 작업 단위로 '백업 중' 표시했습니다`);
    // ── 상세(v2.751 사용자 요청: 백업 완료 시각 · 복원 지점 · 용량) — 각각 실패해도 나머지로 결과를 만든다 ──────────
    // 작업마다 마지막으로 끝난 백업 세션 → 그 세션의 VM 별 task(완료 시각·결과·처리 용량).
    const recent = await soft('최근 세션', async () => {
      try { return listOf(await c.get(`/api/v1/sessions?limit=${PAGE}&orderColumn=CreationTime&orderAsc=false`)); }
      catch (e) { if (e?.status === 400) return listOf(await c.get(`/api/v1/sessions?limit=${PAGE}`)); throw e; }
    });
    const lastByJob = new Map();
    for (const x of recent || []) {
      if (!x || typeof x !== 'object' || !x.jobId || !/^stopped$/i.test(String(x.state || ''))) continue;
      if (!isBackupSessionType(x.sessionType)) continue;
      const t = Date.parse(x.endTime || x.creationTime || '') || 0;
      const prev = lastByJob.get(x.jobId);
      if (!prev || t > prev.t) lastByJob.set(x.jobId, { t, ses: x });
    }
    const lastList = [...lastByJob.values()].sort((a, b) => b.t - a.t).slice(0, MAX_LAST_JOBS);
    const lastTasks = []; let lastCut = 0;
    authOf(await poolSettled(lastList, 4, async ({ ses }) => {
      try {
        const tasks = await c.getAll(`/api/v1/sessions/${encodeURIComponent(String(ses.id || ''))}/taskSessions`, { maxPages: TASK_MAX_PAGES }); // v2.763(V1-7)
        if (tasks.truncated) lastCut++;
        lastTasks.push({ session: ses, tasks });
      } catch (e) { if (isFatal(e)) throw e; }
    }));
    if (lastList.length && !lastTasks.length) notes.push('끝난 세션의 VM 별 결과(task)를 읽지 못해 완료 시각은 복원 지점 생성 시각으로 보여 줍니다');
    if (lastCut) notes.push(`끝난 세션 ${lastCut}개는 task 가 ${TASK_MAX_PAGES * PAGE}개를 넘어 일부 VM 의 마지막 결과를 비웠습니다`);
    // 복원 지점: /api/v1/restorePoints 는 1.2-rev0 판부터(그 아래 판은 판 거절 → 위 get 이 지원 판으로 올려 다시 읽는다).
    // 1.2 를 지원하지 않는 서버(VBR 12.0~12.2)는 같은 정보를 /api/v1/objectRestorePoints 로 준다(1.1-rev0 문서).
    const restorePoints = await soft('복원 지점', async () => {
      try { return await c.getAll('/api/v1/restorePoints', { maxPages: RP_MAX_PAGES }); }
      catch (e) {
        if (isFatal(e) || (e?.status !== 400 && e?.status !== 404)) throw e;
        try { return await c.getAll('/api/v1/objectRestorePoints', { maxPages: RP_MAX_PAGES }); }
        catch (e2) { if (isFatal(e2)) throw e2; throw new Error(`${String(e.message).slice(0, 160)} · ${String(e2?.message || e2).slice(0, 160)}`); }
      }
    });
    if (restorePoints?.truncated) notes.push(`복원 지점이 ${restorePoints.length}개를 넘어 일부만 읽었습니다`);
    // 백업(체인)과 그 파일(용량). v2.761 A7: 한 백업의 404·400(목록과 파일 조회 사이 삭제 등)은 **그 백업만** 용량을 비운다.
    //   '이 판은 미지원' 은 성공이 한 번도 없이 처음부터 연속 FILES_UNSUPPORTED_N 건(또는 시도한 전부)이 404·400 일 때만 — 그 뒤로는 묻지 않는다.
    const backupList = cut('백업 목록', (await soft('백업 목록', () => c.getAll('/api/v1/backups'))) || []);
    const backups = [];
    let filesUnsupported = false; let filesOk = false; let filesMissing = 0; let filesTried = 0;
    const filesFailBy = new Map(); // v2.762(G-I3): 404·400 밖 실패 — 상태 코드(없으면 전송 오류·시한)별 건수만(원문은 주소가 섞여 싣지 않는다)
    const filesInFlight = new Set();
    authOf(await poolSettled(backupList.slice(0, MAX_BACKUPS), 4, async (b) => {
      if (!b || typeof b !== 'object' || !b.id) return;
      // v2.763(V1-6): '판 미지원' 은 성공이 한 번도 없을 때만 — 404·400 이 먼저 N 건 와도 아직 도는 요청(늦게 오는 성공)이 끝날 때까지 기다린 뒤 정한다.
      //   예전에는 4병렬 첫 묶음의 404 3건이 먼저 오면 바로 켜져 나머지를 묻지 않고, 늦게 온 성공이 있어도 '판 미지원' 이라 단정했다.
      if (!filesOk && !filesUnsupported && filesMissing >= FILES_UNSUPPORTED_N && filesInFlight.size) await Promise.allSettled([...filesInFlight]);
      if (!filesOk && filesMissing >= FILES_UNSUPPORTED_N) filesUnsupported = true;
      if (filesUnsupported && !filesOk) { backups.push({ backup: b, files: null }); return; }
      filesTried++;
      const req = c.get(`/api/v1/backups/${encodeURIComponent(String(b.id))}/backupFiles?limit=${PAGE}`);
      filesInFlight.add(req);
      try { backups.push({ backup: b, files: await req }); filesOk = true; }
      catch (e) {
        if (isFatal(e)) throw e;
        if (e?.status === 404 || e?.status === 400) filesMissing++;
        else { const k = Number.isInteger(e?.status) ? `HTTP ${e.status}` : '전송 오류·시한'; filesFailBy.set(k, (filesFailBy.get(k) || 0) + 1); }
        backups.push({ backup: b, files: null });
      } finally { filesInFlight.delete(req); }
    }));
    if ((filesUnsupported && !filesOk) || (!filesOk && filesMissing > 0 && filesMissing === filesTried)) notes.push('이 Veeam 판은 백업 파일 목록(용량)을 REST 로 주지 않아 용량을 표시하지 못합니다');
    else if (filesMissing) notes.push(`백업 ${filesMissing}개는 파일 목록을 받지 못해(404·400) 그 백업만 용량을 비웠습니다`);
    if (filesFailBy.size) {
      const n = [...filesFailBy.values()].reduce((a, b) => a + b, 0);
      notes.push(`백업 ${n}개는 파일 목록 조회가 실패해(${[...filesFailBy].map(([k, v]) => `${k} ${v}건`).join(' · ')}) 그 백업만 용량을 비웠습니다`);
    }
    if (backupList.length > MAX_BACKUPS) notes.push(`백업 ${backupList.length}개 중 ${MAX_BACKUPS}개만 용량을 읽었습니다`);
    for (const b of c.bumped) notes.push(`${b.path} 는 이 서버가 판 ${b.from} 으로는 주지 않아 지원 판 ${b.to} 으로 읽었습니다`);
    // v2.761 A2: 시한이 끊긴 뒤의 요청은 모두 '취소' 로 실패하고 soft·세션 루프·두 묶음이 그것을 삼킨다 — 여기서 결과를 만들면 잘린 결과가
    //   ok:true 로 저장돼 직전 완전한 결과(lastOk)를 덮는다. 전체 실패로 던진다(withDeadline 이 시한 문구로 바꾼다).
    if (signal?.aborted) throw new Error('수집 시한이 지나 일부만 읽었습니다 — 부분 결과는 저장하지 않습니다');
    // v2.788 라이선스(사용 수량·만료) — 판에 따라 없을 수 있다(soft · 404 는 '이 판은 REST 로 주지 않음').
    const licRaw = await soft('라이선스', async () => { try { return await c.get('/api/v1/license'); } catch (e) { if (e?.status === 404) return null; throw e; } });
    const license = licenseOf(licRaw);
        const r = buildServerResult({ jobs, states, backupObjects, sessions, lastTasks, restorePoints, backups });
    // v2.762(G1): target = 읽은 접속처 지문(registry.accessFingerprint) — 중앙·store 가 등록부의 지금 접속처와 대조한다.
    return { ok: true, ts: Date.now(), ms: Date.now() - t0, apiVersion: c.apiVersion, target: accessFingerprint(server), error: '', jobs: r.jobs, vms: r.vms, counts: r.counts, backups: r.backups, ...(license ? { license } : {}), notes: [...notes, ...r.notes] };
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
    // v2.763(V1-I2): total 이 없으면 '작업 수 모름'(null) — Number(null)===0 으로 '작업 0개' 라 하지 않는다(limit=1 이라 받은 수로 대신할 수도 없다).
    const total = numOrNull(body?.pagination?.total);
    return { ok: true, ms: Date.now() - t0, apiVersion: c.apiVersion, jobs: total != null && total >= 0 ? total : null };
  } finally { await c.logout(); }
}
