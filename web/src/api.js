import { useEffect, useRef, useState } from 'react';

const BASE = '/api';
const TOKEN_KEY = 'vmportal.token';
// 크로스탭 로그아웃 브로드캐스트 키 — sessionStorage 토큰 탭은 자기 sessionStorage 변경으로는
// 다른 탭의 storage 이벤트를 못 받으므로, localStorage에 마커를 써서 모든 탭이 수신하게 한다.
export const LOGOUT_BROADCAST_KEY = 'vmportal.logout';

// 토큰은 두 저장소를 모두 조회 — 로그인의 'KEEP SESSION' 체크 여부에 따라
// localStorage(브라우저 재시작에도 유지) 또는 sessionStorage(탭/브라우저 종료 시 로그아웃)에 저장된다.
export const getToken = () => localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
export const setToken = (t, { persist = true } = {}) => {
  try { localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); } catch { /* */ }
  if (t) (persist ? localStorage : sessionStorage).setItem(TOKEN_KEY, t);
};

/** 다른 탭에 로그아웃을 알린다(localStorage 이벤트는 sessionStorage 토큰 탭도 수신). */
export const broadcastLogout = () => { try { localStorage.setItem(LOGOUT_BROADCAST_KEY, String(Date.now())); } catch { /* */ } };

// Invoked when the API reports the session is no longer valid (401).
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

// 현재 로그인 사용자(권한/도구 게이팅용) — App 이 setCurrentUser 로 채운다.
let _currentUser = null;
export const setCurrentUser = (u) => { _currentUser = (u && typeof u === 'object') ? u : null; };
export const getCurrentUser = () => _currentUser;
// 기능 권한 보유 여부(프론트 게이팅). admin·권한배열 없음(구버전/인증 비활성)은 통과.
export const can = (key) => {
  const u = _currentUser;
  if (!key || !u) return true;
  if (u.role === 'admin') return true;
  if (!Array.isArray(u.permissions)) return true;
  return u.permissions.includes(key);
};
// 특수 기능 개별 도구 접근 가능 여부 — 'tools' 기본 권한 + 역할별 거부목록(toolsDenied)에 없을 것.
export const toolAllowed = (k) => {
  const u = _currentUser;
  if (!u || u.role === 'admin') return true;
  if (!can('tools')) return false;
  const denied = Array.isArray(u.toolsDenied) ? u.toolsDenied : [];
  return !denied.includes(k);
};

/**
 * 권한(403) 응답 정보 — **'장애'가 아니라 '의도된 접근 제어'** 임을 화면에서 구분하기 위한 값.
 *
 * 서버는 권한 거부를 세 형태로 알려준다(server/src/auth/auth.js·routes/admin/shared.js):
 *   · requireRole          → { error:'forbidden', requiredRole:[...] }
 *   · requirePerm          → { error:'forbidden', requiredPerm:[...] }
 *   · requireSettingsOwner → { error:'forbidden', requiredOwner:true, reason }
 *   · 데이터 범위(scope)   → { ok:false, reason:'...범위...' }  (403, 메타데이터 없음)
 * 이 정보가 사라지면 화면은 "오류: forbidden" 같은 문구만 남아 사용자가 시스템 장애로 오해한다.
 */
export class HttpError extends Error {
  constructor(message, { status = 0, path = '', body = null } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.path = path;
    this.requiredRole = Array.isArray(body?.requiredRole) ? body.requiredRole : null;
    this.requiredPerm = Array.isArray(body?.requiredPerm) ? body.requiredPerm : null;
    this.requiredOwner = !!body?.requiredOwner;
    this.serverReason = body?.reason || '';
  }
}
/** 권한 거부(=접근 제어)인가. 장애/버그가 아니라 정책에 따른 정상 거부다. */
export const isPermissionError = (e) => !!e && e.status === 403;

/**
 * 메시지 → 권한 정보 사이드 채널.
 *
 * 왜 필요한가: 공용 `ErrorBox` 는 `message`(문자열)만 받고 86개 파일·132곳이 그 계약에 의존한다
 * (`usePolling` 도 `error` 를 문자열로 보관). 그 계약을 깨지 않고 403 을 '접근 제어 안내'로
 * 렌더하려면, 메시지에서 권한 정보를 되찾을 통로가 필요하다.
 * 오탐 방지: 403 + 권한 메타데이터가 실제로 온 경우에만 등록하고, TTL·상한을 둔다. 서버의 권한
 * 거부 문구는 고유한 문장이라 같은 문자열이 다른 원인으로 5분 내 재현될 여지는 사실상 없다.
 */
const permMemo = new Map();          // message -> { info, at }
const PERM_MEMO_TTL_MS = 5 * 60_000;
const PERM_MEMO_MAX = 50;
export function notePermissionError(message, info) {
  if (!message || !info) return;
  permMemo.set(String(message), { info, at: Date.now() });
  if (permMemo.size > PERM_MEMO_MAX) {
    // 가장 오래된 항목부터 제거(삽입 순서 = Map 순회 순서).
    for (const k of permMemo.keys()) { permMemo.delete(k); if (permMemo.size <= PERM_MEMO_MAX) break; }
  }
}
/** 이 메시지가 권한 거부에서 온 것이면 그 정보를, 아니면 null. */
export function permissionInfoFor(message) {
  const hit = permMemo.get(String(message ?? ''));
  if (!hit) return null;
  if (Date.now() - hit.at > PERM_MEMO_TTL_MS) { permMemo.delete(String(message)); return null; }
  return hit.info;
}

/** !res.ok 공통 처리 — 사유를 살리고 403 이면 권한 정보를 보존한다. */
function httpFail(path, res, data) {
  const msg = data?.reason || data?.error || `${path} -> ${res.status}`;
  const err = new HttpError(msg, { status: res.status, path, body: data });
  if (res.status === 403) notePermissionError(msg, err);
  return err;
}

function authHeaders(extra = {}) {
  const token = getToken();
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
}

// 고RTT/반열림 연결에서 무한 스피너를 막기 위한 클라이언트 타임아웃.
// - GET(조회): 짧게(20s) + 일시 오류 재시도. - 변경(POST/PUT/DELETE): 정상 장기 작업
//   (배포/프로비저닝/스캔)을 끊지 않도록 넉넉한 백스톱(180s)만 적용하고 재시도는 안 함.
const GET_TIMEOUT_MS = 20_000;
const MUT_TIMEOUT_MS = 180_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isTransientFront = (err, status) => {
  if (status) return [408, 425, 429, 500, 502, 503, 504].includes(status);
  const m = `${err?.name || ''} ${err?.message || ''}`;
  return /AbortError|TimeoutError|timeout|Failed to fetch|NetworkError|network|load failed|ERR_NETWORK/i.test(m);
};
// 타임아웃 signal — 구형 브라우저(Chrome<103 등, 업데이트가 막힌 관리 단말)에는
// AbortSignal.timeout이 없어 'AbortSignal.timeout is not a function'으로 모든 요청이 죽는다.
// 미지원이면 AbortController+setTimeout으로 동일 동작을 폴백한다.
function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(new DOMException('timeout', 'TimeoutError')), ms);
  return c.signal;
}
// 호출자 signal(언마운트 취소)과 타임아웃을 결합. AbortSignal.any(Chrome 116+)가 없으면
// 이전에는 호출자 signal만 반환해 타임아웃이 통째로 사라졌다(구형 브라우저에서 반열림 TCP가
// 영구 pending → inFlight 가드로 폴링 정지). 폴백에서 두 signal의 abort를 수동 중계한다.
function withTimeout(signal, ms) {
  const to = timeoutSignal(ms);
  if (!signal) return to;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, to]);
  const c = new AbortController();
  const onAbort = (src) => { try { c.abort(src?.reason); } catch { c.abort(); } };
  if (signal.aborted || to.aborted) onAbort(signal.aborted ? signal : to);
  else {
    signal.addEventListener('abort', () => onAbort(signal), { once: true });
    to.addEventListener('abort', () => onAbort(to), { once: true });
  }
  return c.signal;
}

/**
 * GET JSON 조회 — 기본은 20초 타임아웃 + 일시 오류 2회 재시도(고RTT 폴링용).
 * opts(v2.277 추가): 오래 걸리는 단건 조회를 위한 호출별 재정의.
 *   { timeoutMs, retries } — 예: 데이터스토어 브라우즈(/datastores/:id/browse)는 서버가
 *   vCenter 탐색 태스크를 최대 90초 기다리므로 기본 20초×3회로는 항상 타임아웃했고,
 *   재시도는 서버 60초 캐시의 '같은 진행중 프라미스'에 합류만 해 무의미했다(확정 버그 v2.277).
 *   그런 호출은 { timeoutMs: 150_000, retries: 0 } 처럼 길게 1회만 기다린다.
 */
export async function fetchJson(path, params = {}, signal, opts = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== null)
  ).toString();
  const url = `${BASE}${path}${qs ? `?${qs}` : ''}`;
  const timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : GET_TIMEOUT_MS;
  const retries = Number.isInteger(opts.retries) && opts.retries >= 0 ? opts.retries : 2;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: authHeaders(), signal: withTimeout(signal, timeoutMs) });
    } catch (err) {
      lastErr = err;
      if (signal?.aborted) throw err;                 // 사용자가 취소(언마운트) → 재시도 안 함
      if (attempt < retries && isTransientFront(err)) { await sleep(300 * 2 ** attempt); continue; }
      throw err;
    }
    if (res.status === 401) { setToken(null); onUnauthorized(); throw new Error('세션이 만료되었습니다. 다시 로그인하세요.'); }
    if (!res.ok) {
      if (attempt < retries && isTransientFront(null, res.status)) { await sleep(300 * 2 ** attempt); continue; }
      // 서버가 준 사유(reason/error)를 우선 노출 — 불투명한 'path -> 404' 대신 원인을 보여준다.
      // 403 은 권한 정보를 함께 보존해 화면이 '접근 제어 안내'로 렌더할 수 있게 한다(HttpError).
      const data = await res.json().catch(() => null);
      throw httpFail(path, res, data);
    }
    return res.json();
  }
  throw lastErr;
}

export async function postJson(path, body = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal: timeoutSignal(MUT_TIMEOUT_MS),
  });
  if (res.status === 401) { setToken(null); onUnauthorized(); throw new Error('세션이 만료되었습니다.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 409) throw httpFail(path, res, data);
  return data;
}

export async function sendJson(path, method, body = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: method === 'DELETE' && !Object.keys(body).length ? undefined : JSON.stringify(body),
    signal: timeoutSignal(MUT_TIMEOUT_MS),
  });
  if (res.status === 401) { setToken(null); onUnauthorized(); throw new Error('세션이 만료되었습니다.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 409 && res.status !== 400) throw httpFail(path, res, data);
  return data;
}
export const putJson = (path, body) => sendJson(path, 'PUT', body);
export const patchJson = (path, body) => sendJson(path, 'PATCH', body);
export const delJson = (path) => sendJson(path, 'DELETE');

/**
 * 인증이 필요한 파일 다운로드 — `<a href="/api/...">` 는 Authorization 헤더를 붙이지 못해
 * 서버가 401 을 돌려준다(authMiddleware 는 Bearer 헤더만 인정한다). 반드시 fetch 로 받아
 * blob 로 저장한다. 응답이 커도 브라우저가 스트림을 받아 blob 로 조립한다.
 *
 * @param {string} path  `/api` 이후 경로 (예: `/svcmon/log/files/results-20260807.csv`)
 * @param {string} [filename] 저장 이름. 생략하면 Content-Disposition → 경로 마지막 조각.
 */
export async function downloadFile(path, filename = '') {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  if (res.status === 401) { setToken(null); onUnauthorized(); throw new Error('세션이 만료되었습니다.'); }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    // 403 이면 권한 정보를 보존한다 — 다운로드 버튼도 '권한 없음' 안내로 이어져야 한다.
    throw httpFail(path, res, data || {});
  }
  const cd = res.headers.get('content-disposition') || '';
  const m = /filename="?([^";]+)"?/i.exec(cd);
  const name = filename || (m && decodeURIComponent(m[1])) || path.split('/').pop() || 'download';
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}

/**
 * POST 로 파일을 내려받는다(서버가 본문을 받아 파일을 만들어 응답하는 경우 — 예: 현재 화면의
 * 표를 CSV 로 내보내기). GET downloadFile 과 동작은 같고 method/body 만 다르다.
 */
export async function postDownload(path, body = {}, filename = '') {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal: timeoutSignal(MUT_TIMEOUT_MS),
  });
  if (res.status === 401) { setToken(null); onUnauthorized(); throw new Error('세션이 만료되었습니다.'); }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    // 403 이면 권한 정보를 보존한다 — 다운로드 버튼도 '권한 없음' 안내로 이어져야 한다.
    throw httpFail(path, res, data || {});
  }
  const cd = res.headers.get('content-disposition') || '';
  const m = /filename="?([^";]+)"?/i.exec(cd);
  const name = filename || (m && decodeURIComponent(m[1])) || path.split('/').pop() || 'download';
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}

export async function login(username, password, { keep = true } = {}) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const msg = res.status === 401 ? '아이디 또는 비밀번호가 올바르지 않습니다.' : `로그인 실패 (${res.status})`;
    throw new Error(msg);
  }
  const data = await res.json();
  setToken(data.token, { persist: keep }); // keep=false → 브라우저/탭 종료 시 자동 로그아웃
  return data.user;
}

export async function fetchAuthConfig() {
  const res = await fetch(`${BASE}/auth/config`);
  return res.ok ? res.json() : { authEnabled: true };
}

export async function fetchMe() {
  const res = await fetch(`${BASE}/auth/me`, { headers: authHeaders() });
  if (!res.ok) return null;
  const data = await res.json();
  return data.user;
}

// 폴링용 조건부 fetch — ETag(If-None-Match) 지원. 서버가 캐시 헤더(ETag)를 주는 무거운
// 엔드포인트는 변동 없으면 304(본문 없음)를 받아 대역폭/직렬화를 아낀다. ETag 미지원 응답은
// 기존과 동일하게 전체 본문을 받는다(하위호환). 반환 { notModified, data, etag }.
async function pollFetch(path, params, signal, etag) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== null)
  ).toString();
  const url = `${BASE}${path}${qs ? `?${qs}` : ''}`;
  const retries = 2;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: authHeaders(etag ? { 'If-None-Match': etag } : {}),
        signal: withTimeout(signal, GET_TIMEOUT_MS),
        cache: 'no-store', // 브라우저 캐시 대신 우리가 ETag/304를 직접 구동(결정적)
      });
    } catch (err) {
      lastErr = err;
      if (signal?.aborted) throw err;
      if (attempt < retries && isTransientFront(err)) { await sleep(300 * 2 ** attempt); continue; }
      throw err;
    }
    if (res.status === 401) { setToken(null); onUnauthorized(); throw new Error('세션이 만료되었습니다. 다시 로그인하세요.'); }
    if (res.status === 304) return { notModified: true, etag: res.headers.get('ETag') || etag };
    if (!res.ok) {
      if (attempt < retries && isTransientFront(null, res.status)) { await sleep(300 * 2 ** attempt); continue; }
      throw new Error(`${path} -> ${res.status}`);
    }
    return { notModified: false, data: await res.json(), etag: res.headers.get('ETag') || null };
  }
  throw lastErr;
}

/** Poll an endpoint on an interval and expose {data, error, loading}.
 *  최적화: 백그라운드 탭이면 폴링 일시정지(가시화 시 즉시 갱신), 주기에 ±10% 지터(동시 사용자
 *  부하 분산), ETag/304로 변동 없는 응답은 본문 미수신. in-flight 가드·언마운트 취소 유지. */
export function usePolling(path, params = {}, intervalMs = 15_000) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  // 권한 거부(403) 정보 — 있으면 뷰가 '접근 제어 안내'로 렌더할 수 있다(ErrorBox 가 자동 처리하므로
  // 대개 쓸 필요는 없지만, 자체 오류 UI 를 가진 화면이 명시적으로 판정할 수 있게 노출한다).
  const [errorInfo, setErrorInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const paramsKey = JSON.stringify(params);
  const savedParams = useRef(params);
  savedParams.current = params;

  useEffect(() => {
    if (!path) { setLoading(false); return undefined; }
    // 파라미터(스코프) 변경 시 직전 스코프의 데이터를 비운다 — 남겨두면 새 응답이 오기 전까지
    // (고RTT에서 수 초) 이전 스코프의 데이터가 새 선택의 화면처럼 표시된다.
    setData(null); setError(null); setErrorInfo(null); setLoading(true);
    let active = true;
    let inFlight = false;
    let timer = null;
    let lastEtag = null; // 이 (path,params)에 대한 마지막 ETag(효과 재실행 시 리셋)
    // 권한 거부(403)를 받으면 이 (path,params) 조합의 폴링을 중단한다 — 정책 거부는 재시도해도
    // 결과가 같고, 15초마다 같은 403 을 만드는 것은 서버 로그·감사만 오염시킨다.
    let forbidden = false;
    const controller = new AbortController();

    const tick = async () => {
      if (inFlight || !active || forbidden) return;
      inFlight = true;
      try {
        const r = await pollFetch(path, savedParams.current, controller.signal, lastEtag);
        if (active) {
          lastEtag = r.etag || lastEtag;
          if (!r.notModified) setData(r.data); // 304면 직전 데이터 유지(변동 없음)
          setError(null); setErrorInfo(null);
        }
      } catch (err) {
        if (active && !controller.signal.aborted) {
          setError(err.message);
          // 403 은 일시 오류가 아니라 정책 거부다 — 폴링을 멈춰 같은 거부를 반복 요청하지 않는다
          // (서버 로그·감사 오염 방지). 권한이 바뀌면 화면 재진입/새로고침으로 다시 시도된다.
          if (err.status === 403) { forbidden = true; setErrorInfo(err); }
        }
      } finally {
        inFlight = false;
        if (active) setLoading(false);
      }
    };

    // 자가 스케줄(지터 적용) — setInterval 대신 매 주기 ±10% 흔들어 다수 사용자 폴링이 한꺼번에
    // 몰리지 않게 분산. 백그라운드 탭(document.hidden)이면 네트워크 호출을 건너뛴다.
    const schedule = () => {
      const jitter = intervalMs * (0.9 + Math.random() * 0.2);
      timer = setTimeout(loop, jitter);
    };
    const loop = async () => {
      if (!active) return;
      if (typeof document === 'undefined' || !document.hidden) await tick();
      if (active && !forbidden) schedule();
    };
    // 탭이 다시 보이면 즉시 한 번 갱신(백그라운드 동안 멈춰 있던 데이터 최신화).
    const onVisible = () => { if (active && !forbidden && typeof document !== 'undefined' && !document.hidden) tick(); };

    tick().then(() => { if (active && !forbidden) schedule(); });
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      controller.abort();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, paramsKey, intervalMs]);

  // errorInfo: 403(권한 거부)이면 HttpError, 그 외 null. 공용 ErrorBox 가 자동으로 안내 화면을
  // 그리므로 대개 쓸 필요는 없고, 자체 오류 UI 를 가진 화면이 명시 판정할 때 쓴다.
  return { data, error, errorInfo, loading };
}
