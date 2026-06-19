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

export async function fetchJson(path, params = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== null)
  ).toString();
  const res = await fetch(`${BASE}${path}${qs ? `?${qs}` : ''}`, { headers: authHeaders() });
  if (res.status === 401) {
    setToken(null);
    onUnauthorized();
    throw new Error('세션이 만료되었습니다. 다시 로그인하세요.');
  }
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

export async function postJson(path, body = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
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
  });
  if (res.status === 401) { setToken(null); onUnauthorized(); throw new Error('세션이 만료되었습니다.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 409 && res.status !== 400) throw new Error(data.reason || data.error || `${path} -> ${res.status}`);
  return data;
}
export const putJson = (path, body) => sendJson(path, 'PUT', body);
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
    let active = true;
    let timer;
    const tick = async () => {
      try {
        const json = await fetchJson(path, savedParams.current);
        if (active) { setData(json); setError(null); }
      } catch (err) {
        if (active) setError(err.message);
      } finally {
        if (active) setLoading(false);
      }
    };
    tick();
    timer = setInterval(tick, intervalMs);
    return () => { active = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, paramsKey, intervalMs]);

  return { data, error, loading };
}
