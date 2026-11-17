/**
 * 전체 점검 129회차 — 웹 공통 골격 1차(API 클라이언트 · 세션 · 셸).
 *
 *  A1 늦게 온 401 이 새 세션을 끝내지 않는다(api.js expireSession — 그 요청이 보낸 토큰이 지금 토큰일 때만).
 *  A2 로그아웃 · 계정 전환이면 원격 콘솔 세션 저장소(대상 서버 비밀번호를 든다)를 비운다(accountReset.js + App).
 *  A3 로그인하지 않은 동안 위험 알림 폴링을 하지 않는다(pwa.js).
 *  A4 다른 탭이 다른 계정으로 로그인하면 이 탭의 화면도 그 계정으로 바꾼다(accountReset.tokenChangeAction + App).
 *  A5 브라우저의 실제 시한 초과 문구('signal timed out')를 '응답 지연' 안내로 알아본다(serviceDownText).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fetchJson, postJson, putJson, delJson, postBinary, fetchBlob, downloadFile, postDownload,
  getToken, setToken, setUnauthorizedHandler, setCurrentUser, TOKEN_KEY,
} from './api.js';
import { _resetPerfClient } from './perfClient.js';
import { accountKeyOf, noteAccount, tokenChangeAction, _resetAccountForTest } from './accountReset.js';
import { openRemoteSession, setSessionCreds, duplicateSession, closeAllSessions, _remoteStateForTest } from './remote/sessions.js';
import { serviceDownKind } from './components/serviceDownText.js';
import { startAlertNotifications } from './pwa.js';
import { stripComments } from './test/_stripComments.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, rel), 'utf8');

const origFetch = globalThis.fetch;
const memStore = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
};
let unauthorized = 0;

beforeEach(() => {
  _resetPerfClient();
  globalThis.localStorage = memStore();
  globalThis.sessionStorage = memStore();
  unauthorized = 0;
  setUnauthorizedHandler(() => { unauthorized += 1; });
});
afterEach(() => { globalThis.fetch = origFetch; setUnauthorizedHandler(() => {}); setCurrentUser(null); vi.useRealTimers(); });

/** 응답을 나중에 정하는 fetch — 보낸 Authorization 을 기록한다. */
function deferredFetch() {
  const calls = [];
  globalThis.fetch = (url, init = {}) => new Promise((resolve) => {
    calls.push({ url, auth: (init.headers || {}).Authorization || null, resolve });
  });
  return calls;
}
const res = (status, body = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => null },
  json: async () => body,
  blob: async () => ({ size: 0 }),
});

describe('A1 — 늦게 온 401 은 그 요청의 토큰이 지금 토큰일 때만 세션을 끝낸다', () => {
  it('옛 토큰으로 나간 요청의 401 이 다시 로그인한 뒤에 오면 새 토큰을 지우지 않는다', async () => {
    const calls = deferredFetch();
    setToken('tok-old');
    const p = fetchJson('/vms', {}, undefined, { retries: 0 });
    expect(calls[0].auth).toBe('Bearer tok-old');
    setToken(null);            // 로그아웃
    setToken('tok-new');       // 다른 계정(또는 같은 계정)으로 다시 로그인
    calls[0].resolve(res(401));
    await expect(p).rejects.toThrow('세션이 만료되었습니다');   // 던지는 계약은 그대로
    expect(getToken()).toBe('tok-new');
    expect(unauthorized).toBe(0);
  });

  it('토큰 없이 나간 요청(로그인 화면의 폴링)의 401 이 로그인 직후에 와도 방금 받은 토큰이 남는다', async () => {
    const calls = deferredFetch();
    const p = fetchJson('/insights/incidents', { limit: 30 }, undefined, { retries: 0 });
    expect(calls[0].auth).toBe(null);
    setToken('tok-fresh', { persist: false });
    calls[0].resolve(res(401));
    await expect(p).rejects.toThrow();
    expect(getToken()).toBe('tok-fresh');
    expect(unauthorized).toBe(0);
  });

  it('지금 토큰으로 나간 요청의 401 은 예전처럼 세션을 끝낸다(토큰 삭제 + 처리기 1회)', async () => {
    const calls = deferredFetch();
    setToken('tok-live');
    const p = fetchJson('/vms', {}, undefined, { retries: 0 });
    calls[0].resolve(res(401));
    await expect(p).rejects.toThrow('세션이 만료되었습니다');
    expect(getToken()).toBe(null);
    expect(unauthorized).toBe(1);
  });

  it('토큰이 없고 지금도 없으면(로그인 전) 예전처럼 처리기를 부른다', async () => {
    const calls = deferredFetch();
    const p = fetchJson('/vms', {}, undefined, { retries: 0 });
    calls[0].resolve(res(401));
    await expect(p).rejects.toThrow();
    expect(unauthorized).toBe(1);
  });

  it('변경 · 올리기 · 내려받기 헬퍼도 같다 — 연장으로 토큰이 바뀐 뒤 옛 토큰 요청의 401', async () => {
    const runs = [
      () => postJson('/x', { a: 1 }),
      () => putJson('/x', { a: 1 }),
      () => delJson('/x'),
      () => postBinary('/x', 'blob'),
      () => fetchBlob('/x'),
      () => downloadFile('/x'),
      () => postDownload('/x', {}),
    ];
    for (const run of runs) {
      const calls = deferredFetch();
      setToken('tok-1');
      const p = run();
      expect(calls[0].auth).toBe('Bearer tok-1');
      setToken('tok-2');                       // 세션 연장(SessionExpiryGuard) · 다른 탭의 재로그인
      calls[0].resolve(res(401));
      await expect(p).rejects.toThrow('세션이 만료되었습니다');
      expect(getToken()).toBe('tok-2');
      expect(unauthorized).toBe(0);
    }
  });

  it('소스: 401 처리는 expireSession 하나 — 헬퍼마다 토큰을 직접 지우지 않는다(폴링 pollFetch 포함)', () => {
    const src = stripComments(read('api.js'));
    expect(src.match(/setToken\(null\)/g)?.length).toBe(1);
    expect(src.match(/res\.status === 401\) \{ expireSession\(sent\);/g)?.length).toBe(8);
    expect(/res\.status === 401\) \{ setToken\(null\)/.test(src)).toBe(false);
    // 보낸 토큰을 적는 자리도 8곳(fetchJson · postJson · sendJson · postBinary · fetchBlob · downloadFile · postDownload · pollFetch)
    expect(src.match(/, sent\)/g)?.length).toBe(8);
  });
});

describe('A2 — 로그아웃 · 계정 전환이면 원격 콘솔 세션(대상 서버 비밀번호)을 비운다', () => {
  beforeEach(() => { closeAllSessions(); _resetAccountForTest(); });

  it('accountKeyOf — 계정 이름 · 인증을 끈 포탈의 표시 이름 · 로그아웃은 null', () => {
    expect(accountKeyOf({ username: 'alice', name: '앨리스' })).toBe('alice');
    expect(accountKeyOf({ name: 'Anonymous', role: 'admin' })).toBe('Anonymous');
    expect(accountKeyOf(null)).toBe(null);
    expect(accountKeyOf('loading')).toBe(null);
    expect(accountKeyOf({ username: '  ' })).toBe(null);
  });

  it('같은 계정이 이어지는 동안에는 비우지 않고, 로그아웃하면 비운다 — 다음 계정이 Dup 으로 이전 비밀번호를 쓸 수 없다', () => {
    expect(noteAccount('alice')).toBe(false);          // 이 창의 첫 판정
    const id = openRemoteSession({ kind: 'ssh', mapping: { id: 'm1', name: 'db01' } });
    setSessionCreds(id, { username: 'root', password: 'S3cret!' });
    openRemoteSession({ kind: 'ssh', mapping: { id: 'm2', name: 'db02' }, initialCreds: { username: 'root', password: 'auto-pw' } });
    expect(noteAccount('alice')).toBe(false);          // /auth/me 재조회 등 — 같은 계정
    expect(_remoteStateForTest().sessions.length).toBe(2);

    expect(noteAccount(null)).toBe(true);              // 로그아웃(유휴 · 만료 · 401 · 다른 탭 로그아웃 모두 user=null)
    const st = _remoteStateForTest();
    expect(st.sessions).toEqual([]);
    expect(st.activeId).toBe(null);
    duplicateSession(id);                              // 이전 탭을 복제해도 아무것도 생기지 않는다
    expect(_remoteStateForTest().sessions).toEqual([]);
    expect(JSON.stringify(_remoteStateForTest())).not.toContain('S3cret!');
    expect(JSON.stringify(_remoteStateForTest())).not.toContain('auto-pw');
    expect(noteAccount('bob')).toBe(true);             // 다음 계정 로그인 — 이미 비어 있다
    expect(_remoteStateForTest().sessions).toEqual([]);
  });

  it('로그아웃을 거치지 않은 계정 전환(다른 탭 로그인)도 비운다', () => {
    noteAccount('alice');
    openRemoteSession({ kind: 'rdp', mapping: { id: 'm9', name: 'win01' } });
    expect(noteAccount('bob')).toBe(true);
    expect(_remoteStateForTest().sessions).toEqual([]);
  });

  it('소스: App 이 사용자 변경마다 알리고(부팅 중 제외), Portal 을 계정 열쇠로 새로 마운트한다', () => {
    const app = stripComments(read('App.jsx'));
    expect(/useEffect\(\(\) => \{ if \(user !== 'loading'\) noteAccount\(accountKeyOf\(user\)\); \}, \[user\]\);/.test(app)).toBe(true);
    expect(/<Portal key=\{accountKeyOf\(user\) \|\| 'anon'\} user=\{user\}/.test(app)).toBe(true);
  });
});

describe('A3 — 로그인하지 않은 동안에는 위험 알림 폴링을 하지 않는다', () => {
  it('사용자가 없으면 요청 0건 · 로그인하면 다시 묻는다', async () => {
    vi.useFakeTimers();
    const had = { window: globalThis.window, Notification: globalThis.Notification };
    globalThis.Notification = { permission: 'granted' };
    globalThis.window = { Notification: globalThis.Notification };
    let n = 0;
    globalThis.fetch = async () => { n += 1; return res(200, { open: [] }); };
    try {
      setCurrentUser(null);
      startAlertNotifications(60_000);
      await vi.advanceTimersByTimeAsync(5_000);          // 첫 틱
      await vi.advanceTimersByTimeAsync(60_000);         // 둘째 틱
      expect(n).toBe(0);                                 // 예전: 로그인 화면에서 60초마다 401
      setCurrentUser({ username: 'alice', role: 'viewer' });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(n).toBe(1);
      setCurrentUser(null);                              // 로그아웃 뒤에는 다시 멈춘다
      await vi.advanceTimersByTimeAsync(120_000);
      expect(n).toBe(1);
    } finally {
      globalThis.window = had.window; globalThis.Notification = had.Notification;
    }
  });
});

describe('A4 — 다른 탭이 토큰을 바꿨을 때', () => {
  it('새 토큰의 주인이 다른 계정이면 switch · 같은 계정(연장 · 재로그인)이거나 못 읽었으면 keep', () => {
    const alice = { username: 'alice', role: 'viewer' };
    expect(tokenChangeAction(alice, { username: 'bob', role: 'admin' })).toBe('switch');
    expect(tokenChangeAction(alice, { username: 'alice', role: 'admin' })).toBe('keep');
    expect(tokenChangeAction(alice, null)).toBe('keep');          // /auth/me 실패 — 단정하지 않는다
    expect(tokenChangeAction(null, { username: 'bob' })).toBe('keep');   // 이 탭은 로그인 화면 — 자동 로그인하지 않는다
    expect(tokenChangeAction('loading', { username: 'bob' })).toBe('keep');
  });

  it('소스: App 의 storage 처리기가 토큰 열쇠 변경을 보고 /auth/me 로 주인을 확인한다 · 열쇠는 api.js 것 하나', () => {
    expect(TOKEN_KEY).toBe('vmportal.token');
    const app = stripComments(read('App.jsx'));
    const at = app.indexOf('e.key === TOKEN_KEY && e.newValue && e.newValue !== e.oldValue');
    expect(at).toBeGreaterThan(0);
    const body = app.slice(at, at + 700);
    expect(body).toContain('fetchMe()');
    expect(body).toContain("tokenChangeAction(userRef.current, me) !== 'switch'");
    expect(body).toContain('noteAccount(accountKeyOf(me))');
    expect(body.indexOf('noteAccount(accountKeyOf(me))')).toBeLessThan(body.indexOf('setUser(me)'));   // 화면을 바꾸기 전에 비운다
  });
});

describe('A5 — 실제 시한 초과 문구를 응답 지연 안내로 알아본다', () => {
  it('브라우저 문구(문장 전체)는 timeout', () => {
    for (const m of ['signal timed out', 'The operation timed out.', 'The operation timed out', 'The operation was aborted due to timeout', ' signal timed out ']) {
      expect(serviceDownKind(m), m).toBe('timeout');
    }
  });

  it('장비 · 서버 사유 문장에 든 timed out 은 포탈 지연으로 바꾸지 않는다 · 4xx 는 그대로 null', () => {
    for (const m of ['SSH 접속 실패: connect timed out', 'iDRAC 10.0.0.1 timed out', 'timeout', 'vCenter 응답 시간 초과', `x${' signal timed out'.repeat(8)}`]) {
      expect(serviceDownKind(m), m).toBe(null);
    }
    expect(serviceDownKind('signal timed out', { status: 409 })).toBe(null);
  });

  it('fetchJson 이 시한으로 끊겼을 때의 오류 문구가 그대로 timeout 으로 판정된다(기본 경로 · 구형 브라우저 폴백 경로)', async () => {
    globalThis.fetch = (url, init = {}) => new Promise((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
    const e1 = await fetchJson('/slow', {}, undefined, { timeoutMs: 20, retries: 0 }).catch((e) => e);
    expect(e1.name).toBe('TimeoutError');
    expect(serviceDownKind(e1.message)).toBe('timeout');

    const orig = AbortSignal.timeout;
    AbortSignal.timeout = undefined;                     // Chrome < 103 — api.js timeoutSignal 폴백
    try {
      const e2 = await fetchJson('/slow', {}, undefined, { timeoutMs: 20, retries: 0 }).catch((e) => e);
      expect(e2.name).toBe('TimeoutError');
      expect(e2.message).toBe('signal timed out');
      expect(serviceDownKind(e2.message)).toBe('timeout');
    } finally { AbortSignal.timeout = orig; }
  });
});
