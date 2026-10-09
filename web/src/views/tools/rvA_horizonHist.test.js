/**
 * rvA_horizonHist.test.js — 검토 I-09: Horizon '현재 사용자' 추이의 늦은 응답이 새 선택을 덮던 결함.
 *
 * 화면(HorizonSessionsPanel)은 `createHistLoader(fetcher, setState)` 를 쓰고 fetcher 는
 * `fetchJson('/tools/horizon-sessions/history', params, signal)` 이다. 아래는
 *  ① 지연 가능한 fetcher 를 주입해 역순 완료를 재현하고
 *  ② **실제 api.js fetchJson** + 지연 가능한 전역 fetch(signal 을 존중) 로 같은 경로를 돌린다.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fetchJson } from '../../api.js';
import { histReqKey, sameHistKey, histView, isAbortError, createHistLoader } from './horizonHistLoader.js';
import { stripComments } from '../../test/_stripComments.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);

/** 지연 fetcher — 요청마다 손으로 완료·실패시킨다. honorAbort 면 signal 이 끊기면 AbortError 로 거부한다. */
function deferredFetcher({ honorAbort = true } = {}) {
  const pend = [];
  const fetcher = (params, signal) => new Promise((resolve, reject) => {
    const item = { params, signal, resolve, reject };
    pend.push(item);
    if (honorAbort && signal) signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  const find = (days, sid) => pend.find((x) => x.params.days === days && x.params.serverId === sid);
  return { fetcher, pend, find };
}
function recorder() {
  const states = []; let cur = null;
  const set = (s) => { cur = s; states.push(s); };
  return { set, states, get cur() { return cur; } };
}

describe('I-09 요청 키·표시 판정(순수)', () => {
  it('키는 숫자·문자열 표기를 맞춘다', () => {
    expect(histReqKey('7', null)).toEqual({ days: 7, serverId: '' });
    expect(sameHistKey(histReqKey(7, 'A'), { days: '7', serverId: 'A' })).toBe(true);
    expect(sameHistKey(histReqKey(7, 'A'), histReqKey(1, 'A'))).toBe(false);
    expect(sameHistKey(histReqKey(7, 'A'), histReqKey(7, 'B'))).toBe(false);
    expect(sameHistKey(null, histReqKey(7, ''))).toBe(false);
  });
  it('지금 선택과 키가 다른 상태(응답·오류·로딩)는 보이지 않는다', () => {
    const st = { key: histReqKey(7, 'A'), rep: { rows: [1] }, err: null, loading: false };
    expect(histView(st, 7, 'A').hist).toEqual({ rows: [1] });
    expect(histView(st, 1, 'A')).toEqual({ hist: null, err: null, loading: false });
    expect(histView(st, 7, 'B')).toEqual({ hist: null, err: null, loading: false });
    expect(histView({ key: histReqKey(7, 'B'), rep: null, err: new Error('x'), loading: false }, 7, 'A').err).toBe(null);
    expect(histView(null, 7, '')).toEqual({ hist: null, err: null, loading: false });
  });
  it('끊긴 요청(AbortError)만 취소로 본다 — 시한 초과(TimeoutError)는 장애다', () => {
    expect(isAbortError(new DOMException('x', 'AbortError'))).toBe(true);
    expect(isAbortError(new DOMException('x', 'TimeoutError'))).toBe(false);
    expect(isAbortError(new Error('503'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});

describe('I-09 최신 요청만 반영(지연 fetcher 주입)', () => {
  it('7일 → 1일, 1일이 먼저 끝나고 7일이 늦게 끝나도 화면은 1일', async () => {
    for (const honorAbort of [true, false]) {
      const f = deferredFetcher({ honorAbort }); const r = recorder();
      const L = createHistLoader(f.fetcher, r.set);
      const p7 = L.load(7, ''); const p1 = L.load(1, '');
      expect(f.find(7, '').signal.aborted).toBe(true);           // 새 요청이 이전 요청을 끊는다
      f.find(1, '').resolve({ rows: ['1일'] }); await p1;
      const n = r.states.length;
      f.find(7, '').resolve({ rows: ['7일'] }); await p7;           // honorAbort=false: 끊겨도 응답이 늦게 온다
      expect(r.states.length).toBe(n);                              // 늦은 응답은 상태를 바꾸지 않는다
      expect(histView(r.cur, 1, '').hist).toEqual({ rows: ['1일'] });
      expect(histView(r.cur, 1, '').err).toBe(null);
    }
  });
  it('서버 A·7일 → 서버 B·1일(B 먼저 완료) — 화면은 B·1일(검토 재현 시나리오)', async () => {
    const f = deferredFetcher({ honorAbort: false }); const r = recorder();
    const L = createHistLoader(f.fetcher, r.set);
    const pa = L.load(7, 'A');
    L.dropUnless(7, 'B');                                           // 화면: 행 클릭으로 서버 B 선택(효과가 부른다)
    expect(f.find(7, 'A').signal.aborted).toBe(true);
    const pb = L.load(1, 'B');
    f.find(1, 'B').resolve({ who: 'B·1일' }); await pb;
    f.find(7, 'A').resolve({ who: 'A·7일' }); await pa;
    expect(r.cur.key).toEqual({ days: 1, serverId: 'B' });
    expect(histView(r.cur, 1, 'B').hist).toEqual({ who: 'B·1일' });
    expect(histView(r.cur, 7, 'A').hist).toBe(null);
  });
  it('같은 키로 방금 시작한 요청은 dropUnless 가 끊지 않는다(기간 칩 = setDays + load 같은 틱)', async () => {
    const f = deferredFetcher(); const r = recorder();
    const L = createHistLoader(f.fetcher, r.set);
    const p = L.load(30, 'A');
    L.dropUnless(30, 'A');
    expect(f.find(30, 'A').signal.aborted).toBe(false);
    f.find(30, 'A').resolve({ ok: 1 }); await p;
    expect(histView(r.cur, 30, 'A').hist).toEqual({ ok: 1 });
  });
  it('성공 → 다른 요청 실패: 실패한 선택에는 오류만, 이전 성공 데이터는 그 선택에 섞이지 않는다', async () => {
    const f = deferredFetcher(); const r = recorder();
    const L = createHistLoader(f.fetcher, r.set);
    const pa = L.load(7, 'A'); f.find(7, 'A').resolve({ who: 'A' }); await pa;
    const pb = L.load(7, 'B'); f.find(7, 'B').reject(new Error('503 서비스 불가')); await pb;
    const v = histView(r.cur, 7, 'B');
    expect(v.hist).toBe(null);
    expect(v.err.message).toBe('503 서비스 불가');
    expect(histView(r.cur, 7, 'A').hist).toBe(null);                // A 화면으로 돌아가면 다시 불러온다(다른 선택의 오류를 보이지 않는다)
  });
  it('이전 요청이 늦게 실패해도 최신 성공을 오류로 덮지 않는다', async () => {
    const f = deferredFetcher({ honorAbort: false }); const r = recorder();
    const L = createHistLoader(f.fetcher, r.set);
    const p7 = L.load(7, 'A'); const p1 = L.load(1, 'A');
    f.find(1, 'A').resolve({ who: 'A·1일' }); await p1;
    f.find(7, 'A').reject(new Error('503 서비스 불가')); await p7;
    expect(histView(r.cur, 1, 'A')).toEqual({ hist: { who: 'A·1일' }, err: null, loading: false });
  });
  it('unmount(cancel) 뒤 응답·실패·AbortError 는 어떤 상태도 바꾸지 않는다', async () => {
    for (const end of ['resolve', 'reject', 'abort']) {
      const f = deferredFetcher({ honorAbort: end === 'abort' }); const r = recorder();
      const L = createHistLoader(f.fetcher, r.set);
      const p = L.load(7, 'A');
      const n = r.states.length;
      L.cancel();
      expect(f.find(7, 'A').signal.aborted).toBe(true);
      if (end === 'resolve') f.find(7, 'A').resolve({ late: true });
      if (end === 'reject') f.find(7, 'A').reject(new Error('late'));
      await p;
      expect(r.states.length).toBe(n);
      expect(L.pending()).toBe(null);
    }
  });
  it('최신 요청의 AbortError(외부에서 끊김)는 오류로 보이지 않고 로딩만 내린다 · 최신 요청의 시한 초과는 오류다', async () => {
    const r = recorder();
    const L = createHistLoader(async () => { throw new DOMException('aborted', 'AbortError'); }, r.set);
    await L.load(7, 'A');
    expect(histView(r.cur, 7, 'A')).toEqual({ hist: null, err: null, loading: false });
    const r2 = recorder();
    const L2 = createHistLoader(async () => { throw new DOMException('signal timed out', 'TimeoutError'); }, r2.set);
    await L2.load(7, 'A');
    expect(histView(r2.cur, 7, 'A').err?.name).toBe('TimeoutError');
  });
  it('로딩 중에는 loading 이 참이고, 상태에는 요청 키가 붙어 있다', () => {
    const f = deferredFetcher(); const r = recorder();
    const L = createHistLoader(f.fetcher, r.set);
    L.load(90, 'A');
    expect(r.cur).toMatchObject({ key: { days: 90, serverId: 'A' }, loading: true, rep: null, err: null });
    expect(f.find(90, 'A').params).toEqual({ serverId: 'A', days: 90 });
    L.cancel();
  });
});

describe('I-09 실제 fetchJson 경로(전역 fetch 만 지연 합성)', () => {
  const store = () => { const mem = new Map(); return { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }; };
  let saved; let reqs;
  beforeEach(() => {
    saved = { fetch: globalThis.fetch, ls: globalThis.localStorage, ss: globalThis.sessionStorage };
    globalThis.localStorage = store(); globalThis.sessionStorage = store();
    reqs = [];
    globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
      const item = { url: String(url), init, resolve, reject };
      reqs.push(item);
      init?.signal?.addEventListener('abort', () => reject(init.signal.reason ?? new DOMException('aborted', 'AbortError')), { once: true });
    });
  });
  afterEach(() => { globalThis.fetch = saved.fetch; globalThis.localStorage = saved.ls; globalThis.sessionStorage = saved.ss; });
  const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('A·7일 → B·1일: B 먼저 끝나고 A 는 끊긴다 — 화면은 B·1일, 취소는 오류가 아니다', async () => {
    const r = recorder();
    const L = createHistLoader((p, signal) => fetchJson('/tools/horizon-sessions/history', p, signal), r.set);
    const pa = L.load(7, 'A'); await tick();
    L.dropUnless(1, 'B');
    const pb = L.load(1, 'B'); await tick();
    const a = reqs.find((x) => x.url.includes('serverId=A'));
    const b = reqs.find((x) => x.url.includes('serverId=B'));
    expect(a.url).toBe('/api/tools/horizon-sessions/history?serverId=A&days=7');
    expect(b.url).toBe('/api/tools/horizon-sessions/history?serverId=B&days=1');
    expect(a.init.signal.aborted).toBe(true);
    b.resolve(ok({ who: 'B·1일', rows: [] })); await pb;
    await pa;                                                        // A 는 AbortError 로 끝났다(재시도 없이)
    expect(reqs.filter((x) => x.url.includes('serverId=A'))).toHaveLength(1);
    expect(histView(r.cur, 1, 'B')).toEqual({ hist: { who: 'B·1일', rows: [] }, err: null, loading: false });
    expect(r.states.some((s) => s.err)).toBe(false);
  });
  it('전체(서버 미선택)는 serverId 를 싣지 않는다', async () => {
    const r = recorder();
    const L = createHistLoader((p, signal) => fetchJson('/tools/horizon-sessions/history', p, signal), r.set);
    const p = L.load(30, ''); await tick();
    expect(reqs[0].url).toBe('/api/tools/horizon-sessions/history?days=30');
    reqs[0].resolve(ok({ rows: [] })); await p;
    expect(histView(r.cur, 30, '').hist).toEqual({ rows: [] });
  });
});

describe('I-09 화면 배선(보조 소스 확인)', () => {
  it('HorizonSessionsPanel 은 로더·키 판정을 쓰고, 응답을 바로 setHist 하지 않는다 · unmount 와 선택 변경에서 끊는다', () => {
    const s = stripComments(fs.readFileSync(path.join(HERE, 'HorizonSessionsPanel.jsx'), 'utf8'));
    expect(s).toMatch(/createHistLoader\(\(p, signal\) => fetchJson\('\/tools\/horizon-sessions\/history', p, signal\)/);
    expect(s).toMatch(/histView\(histState, days, serverId\)/);
    expect(s).toMatch(/useEffect\(\(\) => \(\) => histLoader\.cancel\(\)/);
    expect(s).toMatch(/histLoader\.dropUnless\(days, serverId\)/);
    expect(s).not.toMatch(/setHist\(await fetchJson/);
  });
});
