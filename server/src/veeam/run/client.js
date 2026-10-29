/**
 * veeam/run/client.js — Veeam B&R REST **쓰기** 클라이언트(v2.818 'Backup 현황 › 백업 실행').
 *
 * 왜 따로인가: 모니터링 클라이언트(veeam/client.js)는 '조회 전용 — 작업 시작 POST 를 더하지 말 것' 이 설계 규칙이다. 상태를 바꾸는 요청은
 *   이 파일에만 둔다(읽기 수집 경로가 실수로 백업을 시작하는 일이 구조적으로 없게). 로그인·오류 가림·TLS 판정은 같은 규칙을 그대로 쓴다:
 *  · TLS: 같은 장비 신뢰 판정(deviceTlsConnect subsystem 'veeam', env VEEAM_TLS_VERIFY) — 모니터링에서 승인한 지문을 그대로 쓴다.
 *  · DNS 리바인딩 차단(withSsrfLookup) · 리다이렉트 거부(refuseRedirect).
 *  · 토큰 요청의 401·403·400 invalid_grant 는 authFailed(인증 정지 — dispatch 가 기록). 같은 실행 안에서 다시 로그인하지 않는다.
 *  · 오류 문구의 비밀번호·토큰은 가린다(veeam/client.js maskText·failText).
 *  · 전송 오류(연결 끊김·시한)는 status 0 의 RunHttpError — exec.js 가 상태 변경 요청이면 '결과 모름' 으로 다룬다(Veeam 이 받았을 수 있다).
 */
import { Agent } from 'undici';
import { withSsrfLookup } from '../../util/ssrfLookup.js';
import { deviceTlsConnect } from '../../security/tlsTrust.js';
import { reqTimeoutMs } from '../../util/envTimeout.js';
import { NO_REDIRECT, refuseRedirect } from '../../util/noRedirect.js';
import { describeFetchError, isTransportError } from '../../storage/collectors/netError.js';
import { readTextCapped } from '../../util/readCapped.js';
import { authError, failText } from '../client.js';
import { DEFAULT_PORT, DEFAULT_API_VERSION } from '../registry.js';

const dispatcher = new Agent({ connect: deviceTlsConnect({ subsystem: 'veeam', label: 'Veeam', envKey: 'VEEAM_TLS_VERIFY', envRaw: process.env.VEEAM_TLS_VERIFY, tls: withSsrfLookup({}) }) });
export const TIMEOUT_MS = reqTimeoutMs(process.env.VEEAM_RUN_HTTP_TIMEOUT_MS, 60_000);
const BODY_MAX = 16 * 1024 * 1024;
const PAGE = 500;
const LOGOUT_TIMEOUT_MS = 5_000;

/** HTTP 오류 — status(전송 오류는 0)를 싣는다. exec.js 가 '모양을 모른다(4xx)' · '결과 모름(0·408·5xx)' 을 가른다. */
export class RunHttpError extends Error {
  constructor(msg, status = 0) { super(msg); this.name = 'RunHttpError'; this.status = status; }
}

/**
 * 서버 1대 세션. server = 등록부 원소(비밀 포함 — 이 노드의 veeam/registry.js 사본). fetchImpl 은 테스트 주입용.
 * @returns {{ login:Function, call:Function, list:Function, logout:Function, apiVersion:string }}
 */
export function makeRunClient(server, { signal = null, fetchImpl = fetch } = {}) {
  const host = String(server.host || ''); const port = Number(server.port) || DEFAULT_PORT;
  const base = `https://${host}:${port}`;
  const apiVersion = server.apiVersion || DEFAULT_API_VERSION;
  const secrets = [String(server.password || '')];
  let token = '';
  const sig = () => (signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS));

  async function raw(path, init) {
    try {
      return refuseRedirect(await fetchImpl(`${base}${path}`, { ...init, redirect: NO_REDIRECT, dispatcher, signal: init.signal || sig() }), `Veeam ${host}`);
    } catch (e) {
      if (e instanceof RunHttpError) throw e;
      // 3xx(refuseRedirect) — 서버가 처리하지 않고 다른 주소를 가리켰다: 결과 모름이 아니라 그 상태 코드의 거절이다.
      if (e?.redirect === true) throw new RunHttpError(String(e.message || '').slice(0, 300), Number(e.status) || 300);
      if (!isTransportError(e)) throw new RunHttpError(String(e?.message || e).slice(0, 300), 0);
      throw new RunHttpError(describeFetchError(e, { host, port, timeoutMs: TIMEOUT_MS, cancelled: !!signal?.aborted }), 0);
    }
  }
  const headers = (extra = {}) => ({ Accept: 'application/json', 'x-api-version': apiVersion, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra });

  async function login() {
    const body = new URLSearchParams({ grant_type: 'password', username: String(server.username || ''), password: String(server.password || '') });
    const res = await raw('/api/oauth2/token', { method: 'POST', headers: headers({ 'Content-Type': 'application/x-www-form-urlencoded' }), body: body.toString() });
    if (res.status === 401 || res.status === 403) { try { await res.body?.cancel?.(); } catch { /* */ } throw authError(); }
    if (res.status === 400) {
      const t = await failText(res, secrets);
      if (/invalid_grant|password|credential|logon|unauthori/i.test(t)) throw authError(`인증 실패 — ${t}`);
      throw new RunHttpError(`토큰 요청 거부(${t}) — API 판('${apiVersion}')이 이 서버에서 지원되는지 확인하세요`, 400);
    }
    if (!res.ok) throw new RunHttpError(`토큰 요청 실패(${await failText(res, secrets)})`, res.status);
    let j = null;
    try { j = JSON.parse(await readTextCapped(res, 256 * 1024, 'Veeam 토큰 응답')); } catch { j = null; }
    token = typeof j?.access_token === 'string' ? j.access_token : '';
    if (!token) throw new RunHttpError('토큰 응답에 access_token 이 없습니다', res.status);
    secrets.push(token);
  }

  /**
   * 요청 1건 — 2xx 면 { status, json }(본문 없으면 null). 그 밖은 RunHttpError(가린 사유).
   * @param {'GET'|'POST'|'PUT'} method
   * @param {string} path '/api/v1/…'(경로만 — 호스트를 바꿀 수 없다)
   */
  async function call(method, path, { body, query } = {}) {
    if (typeof path !== 'string' || !path.startsWith('/api/v1/')) throw new RunHttpError('잘못된 경로', 0);
    let p = path;
    if (query && typeof query === 'object') {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
      const s = qs.toString();
      if (s) p += (p.includes('?') ? '&' : '?') + s;
    }
    const res = await raw(p, { method, headers: headers(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (!res.ok) throw new RunHttpError(`${method} ${path} ← ${await failText(res, secrets)}`, res.status);
    // 상태 변경 요청은 2xx 를 받은 순간 Veeam 이 이미 받아들였다 — 그 뒤 본문 읽기가 끊기거나 JSON 이 아니어도 '실패' 로 던지지 않는다
    // (실패로 보이면 사람이 다시 눌러 같은 백업이 두 번 돈다 — 2차 반증 N2). 본문 없이(json null) 돌려주면 호출측이 '세션 id 모름' 으로 다룬다.
    const mutating = method !== 'GET';
    let text = '';
    try { text = await readTextCapped(res, BODY_MAX, `Veeam ${path} 응답`); }
    catch (e) { if (mutating) return { status: res.status, json: null, bodyError: String(e?.message || e).slice(0, 200) }; throw e; }
    if (!text.trim()) return { status: res.status, json: null };
    try { return { status: res.status, json: JSON.parse(text) }; } catch {
      if (mutating) return { status: res.status, json: null, bodyError: '응답이 JSON 이 아닙니다' };
      throw new RunHttpError(`${method} ${path} 응답이 JSON 이 아닙니다`, res.status);
    }
  }

  /** 목록(`{data:[…], pagination}`)을 상한까지. */
  async function list(path, { max = 2000, query = {} } = {}) {
    const out = [];
    for (let guard = 0; guard < 100; guard++) {
      const { json } = await call('GET', path, { query: { ...query, skip: out.length, limit: PAGE } });
      const data = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
      for (const x of data) { if (out.length >= max) return out; out.push(x); }
      const total = Number(json?.pagination?.total);
      if (Array.isArray(json) || data.length < PAGE || (Number.isFinite(total) && out.length >= total)) return out;
    }
    return out;
  }

  async function logout() {
    if (!token) return;
    try { const r = await raw('/api/oauth2/logout', { method: 'POST', headers: headers(), signal: AbortSignal.timeout(LOGOUT_TIMEOUT_MS) }); try { await r.body?.cancel?.(); } catch { /* */ } } catch { /* 최선 */ }
    token = '';
  }
  return { login, call, list, logout, apiVersion };
}
