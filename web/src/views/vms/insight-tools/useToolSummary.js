/**
 * insight-tools/useToolSummary.js — 특수 기능 도구의 요약 모드(`?summary=1`)를 **마운트 1회 + ‘다시 받기’** 로 받는다(v3.21.0).
 *
 * 왜 모듈 저장소인가: 같은 요약을 패널과 ‘확인할 것’ 칸(vmToolChecks)이 함께 쓴다. 따로 부르면 게스트 파티션처럼 캐시가 없는
 *   무거운 조회(DB 의 7일 증가)가 두 번 나간다. 그래서 경로 · 쿼리별로 한 칸을 두고, 그 칸을 보는 화면이 **0 → 1** 이 될 때만 받는다
 *   (함께 마운트된 패널 · 칸은 한 번의 요청을 나눠 본다). 마지막 구독이 빠지면 진행 중 요청을 끊는다(값은 남겨 둔다 — 다음 마운트가 다시 받는다).
 * 규약:
 *  · 15초 폴링 금지(docs/rules/web.md — 무거운 API 는 마운트 1회 + 버튼). 주기 타이머가 없다.
 *  · 늦게 온 이전 응답은 버린다 — 칸마다 세대(gen)를 올리고 그 세대의 응답만 받는다(useLatest 와 같은 생각 · 칸이 여러 화면에 걸려 모듈 쪽에 둔다).
 *  · 다시 받기가 실패해도 이전 값은 지우지 않는다(error 와 data 가 함께 있으면 화면은 값 + 실패 안내를 보인다).
 *  · enabled=false(도구 권한 없음)면 **요청을 보내지 않는다** — 요약이 새지 않게(§6 ⑪).
 *  · fetchJson 옵션은 넷째 자리(fetchJsonArgs2846 스윕).
 */
import { useEffect, useState, useCallback } from 'react';
import { fetchJson } from '../../../api.js';

const cells = new Map();   // key → { st, subs:Set<fn>, gen, ctrl, path, query, opts }
const EMPTY = Object.freeze({ data: null, error: null, loading: false, at: null });

function keyOf(path, query) {
  return `${path}?${JSON.stringify(query || {})}`;
}

function cellOf(path, query, opts) {
  const k = keyOf(path, query);
  let c = cells.get(k);
  if (!c) { c = { st: EMPTY, subs: new Set(), gen: 0, ctrl: null, path, query, opts }; cells.set(k, c); }
  c.opts = opts || c.opts;
  return c;
}

function emit(c, st) {
  c.st = st;
  for (const fn of [...c.subs]) { try { fn(st); } catch { /* 한 화면의 오류가 다른 화면을 막지 않는다 */ } }
}

function load(c) {
  c.gen += 1;
  const g = c.gen;
  try { c.ctrl?.abort(); } catch { /* 이미 끝난 요청 */ }
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  c.ctrl = ac;
  emit(c, { ...c.st, loading: true });
  const o = c.opts || {};
  const fetchOpts = {};
  if (o.timeoutMs > 0) fetchOpts.timeoutMs = o.timeoutMs;
  if (Number.isInteger(o.retries)) fetchOpts.retries = o.retries;
  let req;
  try { req = fetchJson(c.path, { ...(c.query || {}), summary: '1' }, ac?.signal, fetchOpts); } catch (e) { req = Promise.reject(e); }
  return Promise.resolve(req)
    .then((d) => { if (g === c.gen) emit(c, { data: d, error: null, loading: false, at: Date.now() }); })
    .catch((e) => { if (g === c.gen) emit(c, { ...c.st, error: e || new Error('요약을 받지 못했습니다'), loading: false }); });
}

/**
 * @param {string} path  도구 GET 경로(예: 도구 waste 의 경로) — summary=1 은 이 훅이 붙인다
 * @param {object} [query]  더할 쿼리(예: { days: 30 }) — 같은 값이면 같은 칸을 쓴다
 * @param {{enabled?: boolean, timeoutMs?: number, retries?: number}} [opts]
 * @returns {{data:any, error:any, loading:boolean, at:number|null, reload:()=>void}}
 */
export function useToolSummary(path, query = null, opts = {}) {
  const enabled = opts.enabled !== false && !!path;
  const qKey = JSON.stringify(query || {});
  const [st, setSt] = useState(() => (enabled ? cellOf(path, query, opts).st : EMPTY));
  useEffect(() => {
    if (!enabled) { setSt(EMPTY); return undefined; }
    const c = cellOf(path, JSON.parse(qKey), { timeoutMs: opts.timeoutMs, retries: opts.retries });
    const first = c.subs.size === 0;
    c.subs.add(setSt);
    setSt(c.st);
    if (first) load(c);
    return () => {
      c.subs.delete(setSt);
      if (c.subs.size === 0) { c.gen += 1; try { c.ctrl?.abort(); } catch { /* 끝남 */ } c.ctrl = null; if (c.st.loading) c.st = { ...c.st, loading: false }; }
    };
    // opts.timeoutMs · retries 는 칸을 만들 때의 값이면 된다(바뀌어도 다시 받지 않는다).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, path, qKey]);
  const reload = useCallback(() => {
    if (!enabled) return;
    const c = cells.get(keyOf(path, JSON.parse(qKey)));
    if (c && !c.st.loading) load(c);
  }, [enabled, path, qKey]);
  return { ...st, reload };
}

/**
 * 칸을 모두 비운다 — 로그아웃 · 계정 전환 때 accountReset.noteAccount 가 부른다(리뷰 정정).
 *   칸은 모듈 변수라 Portal 이 다시 떠도 남는다 — 비우지 않으면 같은 창에서 다음에 로그인한 계정(범위 계정 · 도구 권한 없는 계정)이
 *   이전 계정의 요약(전 법인 줄)을 받기 전까지 그대로 보고, 다시 받기가 403 이어도 이전 값이 남는다(load 의 catch 는 data 를 지우지 않는다).
 *   진행 중 요청의 늦은 응답도 버린다(세대를 올린다) · 아직 구독 중인 화면에는 빈 상태를 알린다.
 */
export function clearToolSummaryCells() {
  for (const c of cells.values()) {
    c.gen += 1;
    try { c.ctrl?.abort(); } catch { /* 끝남 */ }
    c.ctrl = null;
    emit(c, EMPTY);
  }
  cells.clear();
}

/** 테스트 전용 — 칸을 비운다. */
export function _resetToolSummaryCells() {
  for (const c of cells.values()) { try { c.ctrl?.abort(); } catch { /* 끝남 */ } }
  cells.clear();
}

/** 테스트 전용 — 칸 수와 구독 수. */
export function _toolSummaryCellInfo(path, query = null) {
  const c = cells.get(keyOf(path, query));
  return c ? { subs: c.subs.size, gen: c.gen, st: c.st } : null;
}

/** 테스트 전용 — 칸을 직접 받는다(훅 없이 모듈 동작을 고정). */
export const _internals = { cellOf, load, keyOf };
