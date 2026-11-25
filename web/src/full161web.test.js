// 전체 점검 161회차(5축 반증 · 이어 읽기) — 웹 공통(public/sw.js · api.js).
//  B1 서비스 워커 캐시 정리(156 A6 반증 — Chromium 실측): 나이를 응답 Date 로 재서, immutable 자산(HTTP 캐시가 처음 받은 때의 Date 를 돌려준다) ·
//     서버 시계가 늦은 포탈에서 방금 받은 것까지 지웠다 → 담은 때의 이 브라우저 시각(x-sw-cached-at)으로만 잰다 · 정리 중 새로 받은 주소는 지우지 않는다.
//  B4 로그인 요청에 시한이 없어, 응답 없는 서버에서 로그인 단추가 영영 ‘진행 중’ 이었다(156 추정 E2 — Chromium 실측 215초) → 변경 요청과 같은 백스톱 시한.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { login, getToken, LOGIN_TIMEOUT_TEXT } from './api.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SW = fs.readFileSync(path.join(here, '..', 'public', 'sw.js'), 'utf8');
const DAY = 86_400_000;
const STAMP = 'x-sw-cached-at';
const ORIGIN = 'https://portal.test';

/**
 * 서비스 워커를 가짜 환경에서 돌린다 — 캐시(Map) · fetch · 사건 등록. store 를 넘기면 여러 번 boot 해도 캐시가 이어진다(= 워커가 잠들었다 깬 다음 방문).
 *   dateOf(pathname) — 서버(또는 HTTP 캐시)가 응답에 실어 주는 Date. onMatch(url, cur) — 정리가 캐시를 읽는 순간에 끼어든다(경합 재현).
 */
function boot({ store = new Map(), online = true, dateOf = () => Date.now(), onMatch = null } = {}) {
  const res = (date) => ({ ok: true, type: 'basic', status: 200, statusText: 'OK', body: null,
    headers: new Headers({ 'content-type': 'text/javascript', ...(date == null ? {} : { date: new Date(date).toUTCString() }) }), clone() { return this; } });
  const keyOf = (r) => (typeof r === 'string' ? new URL(r, ORIGIN).href : r.url);
  const cache = {
    keys: async () => [...store.keys()].map((url) => ({ url })),
    match: async (r) => { const cur = store.get(keyOf(r)); if (onMatch) await onMatch(keyOf(r), cur); return cur; },
    delete: async (r) => store.delete(keyOf(r)),
    put: async (r, v) => { store.set(keyOf(r), v); },
  };
  const caches = { open: async () => cache, keys: async () => ['vmportal-shell-v1'], delete: async () => true, match: async (r) => store.get(keyOf(r)) };
  const handlers = {};
  const self = { addEventListener: (n, fn) => { handlers[n] = fn; }, skipWaiting() {}, location: { origin: ORIGIN }, clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => {} } };
  const fetch = async (req) => { if (!online) throw new TypeError('Failed to fetch'); return res(dateOf(new URL(req.url).pathname)); };
  new Function('self', 'caches', 'fetch', SW)(self, caches, fetch);
  const hit = async (pathname, mode = 'no-cors') => {
    const waits = []; let responded = null;
    handlers.fetch({ request: { method: 'GET', url: `${ORIGIN}${pathname}`, mode }, respondWith: (p) => { responded = p; }, waitUntil: (p) => { waits.push(p); } });
    const out = responded ? await responded : undefined;
    await Promise.all(waits);
    return { intercepted: !!responded, out };
  };
  const at = (pathname) => store.get(`${ORIGIN}${pathname}`);
  const seed = (pathname, { stamp = null, date = null } = {}) => store.set(`${ORIGIN}${pathname}`,
    { ok: true, type: 'basic', status: 200, statusText: 'OK', body: null, headers: new Headers({ ...(date == null ? {} : { date: new Date(date).toUTCString() }), ...(stamp == null ? {} : { [STAMP]: String(stamp) }) }), clone() { return this; } });
  return { store, hit, seed, at, has: (pathname) => store.has(`${ORIGIN}${pathname}`) };
}

describe('B1 서비스 워커 — 캐시 나이는 응답 Date 가 아니라 담은 때의 이 브라우저 시각으로 잰다', () => {
  // 기준 시각 — 실제 시각에서 정시 경계로 떨어뜨려 고정한다(docs/rules/common.md). 워커는 가짜 시계(Date)만 읽는다.
  const BASE = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 30 * 60_000;
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(BASE); });
  afterEach(() => { vi.useRealTimers(); });

  it('응답 Date 가 20일 전이어도(immutable 자산의 HTTP 캐시 응답 · 서버 시계가 늦음) 방금 담은 화면 · 조각을 다음 방문에 지우지 않는다', async () => {
    const store = new Map();
    const old = () => Date.now() - 20 * DAY;
    let sw = boot({ store, dateOf: old });
    await sw.hit('/', 'navigate');
    await sw.hit('/assets/index-aaaa1111.js');
    await sw.hit('/assets/Lazy-bbbb2222.js');   // 다른 화면의 조각 — 다음 방문에서는 다시 받지 않는다
    expect(sw.has('/')).toBe(true);             // 방금 받은 화면(/)이 바로 지워지면 서버가 끊긴 사이의 재방문이 열리지 않는다(Chromium: net::ERR_FAILED)
    sw = boot({ store, dateOf: old });          // 워커가 잠들었다 깬 다음 방문(메모리의 ‘마지막 정리 시각’ 이 초기화된다)
    await sw.hit('/', 'navigate');
    await sw.hit('/assets/index-aaaa1111.js');
    expect(sw.has('/')).toBe(true);
    expect(sw.has('/assets/index-aaaa1111.js')).toBe(true);
    expect(sw.has('/assets/Lazy-bbbb2222.js')).toBe(true);
    // 담긴 사본에는 담은 시각이 적혀 있고 나머지 머리말 · 상태는 그대로다
    const root = sw.at('/');
    expect(Number(root.headers.get(STAMP))).toBe(Date.now());
    expect(root.headers.get('content-type')).toBe('text/javascript');
    expect(root.status).toBe(200);
  });

  it('담은 지 14일 넘게 다시 받지 않은 것만 지운다 — 그 사이 다시 받은 것은 남는다(156 의 목적 유지)', async () => {
    const store = new Map();
    const T0 = Date.now();
    let sw = boot({ store });
    await sw.hit('/', 'navigate'); await sw.hit('/assets/Old-aaaa1111.js'); await sw.hit('/assets/Cur-bbbb2222.js');
    vi.setSystemTime(T0 + 10 * DAY);
    sw = boot({ store });
    await sw.hit('/', 'navigate'); await sw.hit('/assets/Cur-bbbb2222.js');
    expect(sw.has('/assets/Old-aaaa1111.js')).toBe(true);   // 10일 — 아직 기한 안
    vi.setSystemTime(T0 + 15 * DAY);
    sw = boot({ store });
    await sw.hit('/', 'navigate');
    expect(sw.has('/assets/Old-aaaa1111.js')).toBe(false);  // 15일째 다시 받지 않음
    expect(sw.has('/assets/Cur-bbbb2222.js')).toBe(true);   // 5일 전에 다시 받음
    expect(sw.has('/')).toBe(true);
  });

  it('표시 없는 항목(옛 판의 워커가 담은 것)은 지우지 않고 지금 시각을 적는다 — 기한은 그때부터 센다', async () => {
    const store = new Map();
    const T0 = Date.now();
    let sw = boot({ store });
    sw.seed('/assets/Legacy-cccc3333.js', { date: T0 - 40 * DAY });   // Date 는 40일 전(처음 받은 때) — 지금도 쓰는 조각일 수 있다
    await sw.hit('/', 'navigate');
    expect(sw.has('/assets/Legacy-cccc3333.js')).toBe(true);
    expect(Number(sw.at('/assets/Legacy-cccc3333.js').headers.get(STAMP))).toBe(T0);
    vi.setSystemTime(T0 + 15 * DAY);
    sw = boot({ store });
    await sw.hit('/', 'navigate');
    expect(sw.has('/assets/Legacy-cccc3333.js')).toBe(false);          // 그 뒤 15일 동안 한 번도 다시 받지 않았다
  });

  it('정리가 읽은 뒤 · 지우기 전에 새로 받은 주소는 지우지 않는다(오래 쉰 뒤의 첫 방문 — 화면 조각을 받는 중에 정리가 돈다)', async () => {
    const store = new Map();
    const T0 = Date.now();
    const p = '/assets/Race-dddd4444.js';
    let again = null;
    const sw = boot({ store, onMatch: async (url) => {
      // 정리가 이 항목(20일 전 표시)을 읽는 바로 그 사이에 화면이 같은 조각을 새로 받아 담는다
      if (url === `${ORIGIN}${p}` && !again) { again = sw.hit(p); await again; }
    } });
    sw.seed(p, { stamp: T0 - 20 * DAY });
    await sw.hit('/', 'navigate');
    expect(again).not.toBeNull();
    expect(sw.has(p)).toBe(true);
    expect(Number(sw.at(p).headers.get(STAMP))).toBe(T0);   // 남은 것은 새로 담은 사본
  });

  it('이 PC 시계가 20일 앞서도 방금 받은 화면(/)은 남는다 · 네트워크가 끊기면 아무것도 지우지 않는다', async () => {
    const store = new Map();
    const T0 = Date.now();
    let sw = boot({ store });
    await sw.hit('/', 'navigate'); await sw.hit('/assets/index-aaaa1111.js');
    vi.setSystemTime(T0 + 20 * DAY);
    sw = boot({ store, online: false });
    const r = await sw.hit('/', 'navigate');
    expect(r.out?.ok).toBe(true);                               // 캐시의 사본으로 답한다
    expect(sw.has('/assets/index-aaaa1111.js')).toBe(true);     // 끊긴 동안에는 정리하지 않는다
    sw = boot({ store });
    await sw.hit('/', 'navigate');
    expect(sw.has('/')).toBe(true);
    expect(Number(sw.at('/').headers.get(STAMP))).toBe(T0 + 20 * DAY);
  });

  it('소스 — 나이 판정에 응답 Date 를 쓰지 않는다', () => {
    expect(SW).not.toMatch(/headers\.get\('date'\)/);
    expect(SW).toMatch(/const STAMP = 'x-sw-cached-at';/);
  });
});

describe('B4 로그인 — 응답 없는 서버에서 영영 기다리지 않는다', () => {
  const origFetch = globalThis.fetch;
  const origTimeout = AbortSignal.timeout;
  const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } }; };
  beforeEach(() => { globalThis.localStorage = mem(); globalThis.sessionStorage = mem(); });
  afterEach(() => { globalThis.fetch = origFetch; AbortSignal.timeout = origTimeout; });

  it('로그인 요청에 시한 신호를 싣고(변경 요청과 같은 180초), 시한이 지나면 사람이 읽을 문구로 던진다', async () => {
    const asked = []; const ctl = new AbortController();
    AbortSignal.timeout = (ms) => { asked.push(ms); return ctl.signal; };
    let seenSignal = null;
    // 매달린 서버 — 신호가 끊을 때까지 답하지 않는다(브라우저 fetch 와 같은 꼴: 신호의 사유로 거절)
    globalThis.fetch = (url, init) => new Promise((_, reject) => {
      seenSignal = init?.signal || null;
      if (!seenSignal) return;   // 신호가 없으면 영영 끝나지 않는다(수정 전)
      seenSignal.addEventListener('abort', () => reject(seenSignal.reason));
    });
    const p = login('user161', 'pw');
    const settled = vi.fn(); p.then(settled, settled);
    await new Promise((r) => setTimeout(r, 20));
    expect(seenSignal).not.toBeNull();
    expect(asked).toEqual([180_000]);
    expect(settled).not.toHaveBeenCalled();   // 시한 전에는 기다린다
    ctl.abort(new DOMException('signal timed out', 'TimeoutError'));
    await expect(p).rejects.toThrow(LOGIN_TIMEOUT_TEXT);
    expect(getToken()).toBeNull();
  });

  it('시한이 아닌 실패(401 · 429 · 연결 거부)와 성공은 예전 그대로다', async () => {
    const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    globalThis.fetch = async () => json(401, {});
    await expect(login('u', 'p')).rejects.toThrow('아이디 또는 비밀번호가 올바르지 않습니다.');
    globalThis.fetch = async () => json(429, { error: '잠시 뒤 다시 시도하세요(잠금).' });
    await expect(login('u', 'p')).rejects.toThrow('잠시 뒤 다시 시도하세요(잠금).');
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await expect(login('u', 'p')).rejects.toThrow('Failed to fetch');
    globalThis.fetch = async () => json(200, { token: 't-161', user: { username: 'u', role: 'admin' } });
    expect(await login('u', 'p')).toEqual({ username: 'u', role: 'admin' });
    expect(getToken()).toBe('t-161');
  });
});
