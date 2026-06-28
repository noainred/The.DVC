import { useEffect, useRef, useState } from 'react';

const BASE = '/api';
const TOKEN_KEY = 'vmportal.token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

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
// 호출자 signal(언마운트 취소)과 타임아웃을 결합(미지원 브라우저는 호출자 signal만).
function withTimeout(signal, ms) {
  const to = AbortSignal.timeout(ms);
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
      throw new Error(`${path} -> ${res.status}`);
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
    signal: AbortSignal.timeout(MUT_TIMEOUT_MS),
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
    signal: AbortSignal.timeout(MUT_TIMEOUT_MS),
  });
  if (res.status === 401) { setToken(null); onUnauthorized(); throw new Error('세션이 만료되었습니다.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 409 && res.status !== 400) throw new Error(data.reason || data.error || `${path} -> ${res.status}`);
  return data;
}
export const putJson = (path, body) => sendJson(path, 'PUT', body);
export const patchJson = (path, body) => sendJson(path, 'PATCH', body);
export const delJson = (path) => sendJson(path, 'DELETE');

export async function login(username, password) {
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
  setToken(data.token);
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

/** Poll an endpoint on an interval and expose {data, error, loading}. */
export function usePolling(path, params = {}, intervalMs = 15_000) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const paramsKey = JSON.stringify(params);
  const savedParams = useRef(params);
  savedParams.current = params;

  useEffect(() => {
    // A falsy path disables polling (e.g. conditional/late-bound endpoints).
    if (!path) { setLoading(false); return undefined; }
    let active = true;
    let inFlight = false; // 고RTT에서 이전 요청이 끝나기 전 다음 tick이 겹쳐 쌓이는 것 방지
    let timer;
    const controller = new AbortController();
    const tick = async () => {
      if (inFlight) return; // 직전 요청 진행 중이면 이번 주기는 건너뜀(적체 방지)
      inFlight = true;
      try {
        const json = await fetchJson(path, savedParams.current, controller.signal);
        if (active) { setData(json); setError(null); }
      } catch (err) {
        // 일시 실패 시 직전 데이터(setData)는 유지하고 error만 표시 → 화면이 깜빡이지 않음.
        if (active && !controller.signal.aborted) setError(err.message);
      } finally {
        inFlight = false;
        if (active) setLoading(false);
      }
    };
    tick();
    timer = setInterval(tick, intervalMs);
    return () => { active = false; clearInterval(timer); controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, paramsKey, intervalMs]);

  return { data, error, loading };
}
