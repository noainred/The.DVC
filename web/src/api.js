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
// 호출자 signal(언마운트 취소)과 타임아웃을 결합(미지원 브라우저는 호출자 signal만).
function withTimeout(signal, ms) {
  const to = timeoutSignal(ms);
  if (!signal) return to;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, to]) : signal;
}

export async function fetchJson(path, params = {}, signal) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== null)
  ).toString();
  const url = `${BASE}${path}${qs ? `?${qs}` : ''}`;
  const retries = 2;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: authHeaders(), signal: withTimeout(signal, GET_TIMEOUT_MS) });
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
      const data = await res.json().catch(() => null);
      throw new Error(data?.reason || data?.error || `${path} -> ${res.status}`);
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
  if (!res.ok && res.status !== 409) throw new Error(data.reason || data.error || `${path} -> ${res.status}`);
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
  if (!res.ok && res.status !== 409 && res.status !== 400) throw new Error(data.reason || data.error || `${path} -> ${res.status}`);
  return data;
}
export const putJson = (path, body) => sendJson(path, 'PUT', body);
export const patchJson = (path, body) => sendJson(path, 'PATCH', body);
export const delJson = (path) => sendJson(path, 'DELETE');

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
  const [loading, setLoading] = useState(true);
  const paramsKey = JSON.stringify(params);
  const savedParams = useRef(params);
  savedParams.current = params;

  useEffect(() => {
    if (!path) { setLoading(false); return undefined; }
    // 파라미터(스코프) 변경 시 직전 스코프의 데이터를 비운다 — 남겨두면 새 응답이 오기 전까지
    // (고RTT에서 수 초) 이전 스코프의 데이터가 새 선택의 화면처럼 표시된다.
    setData(null); setError(null); setLoading(true);
    let active = true;
    let inFlight = false;
    let timer = null;
    let lastEtag = null; // 이 (path,params)에 대한 마지막 ETag(효과 재실행 시 리셋)
    const controller = new AbortController();

    const tick = async () => {
      if (inFlight || !active) return;
      inFlight = true;
      try {
        const r = await pollFetch(path, savedParams.current, controller.signal, lastEtag);
        if (active) {
          lastEtag = r.etag || lastEtag;
          if (!r.notModified) setData(r.data); // 304면 직전 데이터 유지(변동 없음)
          setError(null);
        }
      } catch (err) {
        if (active && !controller.signal.aborted) setError(err.message);
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
      if (active) schedule();
    };
    // 탭이 다시 보이면 즉시 한 번 갱신(백그라운드 동안 멈춰 있던 데이터 최신화).
    const onVisible = () => { if (active && typeof document !== 'undefined' && !document.hidden) tick(); };

    tick().then(() => { if (active) schedule(); });
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      controller.abort();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, paramsKey, intervalMs]);

  return { data, error, loading };
}
