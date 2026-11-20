/**
 * views/tools/bmTrendLoad.js — 추이 계열 조회기(v2.923 · 3b). React 없이 테스트한다(가짜 fetcher).
 *
 *  · 추이 API 는 **지표 하나 = 요청 하나**다(`/tools/bm-usage/perf/:key/history?kind&metric&dev&from&to&res`). 탭이 계열 여러 개를 한꺼번에
 *    부르면 엣지 위임 서버는 그 수만큼 엣지 대행이 생긴다 — **동시 4개**로 줄을 세운다(엣지 · 중앙을 한 번에 몰지 않는다).
 *  · 창(서버 · from · to)이 바뀌면 세대(gen)를 올려 **늦게 온 이전 창 응답을 버린다** · 같은 창 · 같은 계열은 한 번만 부른다(진행 중 공유).
 *  · 폴링하지 않는다 — 탭을 열 때 · 기간/구간을 바꿀 때 · ‘다시 읽기’ 때만.
 */
import { fetchJson } from '../../api.js';
import { seriesKey } from './bmTrendText.js';
import { perfPath } from './bmPerfUrl.js'; // 다음 점검 ①: 서버 = (법인, 키) 쌍 — 요청에 법인을 싣는다

export const TREND_CONCURRENCY = 4;

/** 기본 조회 — 계열 하나. 폴백 재시도 1회(엣지 대행이 느리면 사용자가 다시 읽는다). 다음 점검 ①: vc = 그 서버의 법인(서버 = (법인, 키) 쌍). */
export function trendFetcher(itemKey, vc = '') {
  const path = perfPath(itemKey, '', '/history');
  return (spec, win, signal) => fetchJson(path, {
    kind: spec.kind || 'server', metric: spec.metric, ...(spec.dev ? { dev: spec.dev } : {}),
    ...(win?.from != null ? { from: Math.floor(win.from) } : {}), ...(win?.to != null ? { to: Math.floor(win.to) } : {}),
    ...(vc ? { vcenterId: String(vc) } : {}),
  }, signal, { retries: 1, timeoutMs: 90_000 });
}

/**
 * @param {(spec, win, signal) => Promise<object>} fetcher
 * @param {{concurrency?:number}} [o]
 * @returns {{ setWindow:(winKey:string)=>void, request:(specs:Array, win:object, onResult:(key:string, val:object)=>void)=>void, cancel:()=>void, stats:()=>object }}
 */
export function createTrendLoader(fetcher, { concurrency = TREND_CONCURRENCY } = {}) {
  let gen = 0; let winKey = '';
  let done = new Map();      // key → 결과(이 창)
  let pending = new Set();   // key(대기 · 진행)
  let queue = [];
  let active = 0;
  let ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const pump = () => {
    while (active < Math.max(1, concurrency) && queue.length) {
      const job = queue.shift();
      if (job.gen !== gen) { pending.delete(job.key); continue; }
      active += 1;
      const myGen = job.gen;
      Promise.resolve().then(() => fetcher(job.spec, job.win, ac?.signal))
        .then((d) => ({ status: d && d.ok === false ? 'fail' : 'ok', data: d || null, error: null }))
        .catch((e) => ({ status: 'error', data: null, error: e }))
        .then((val) => {
          active -= 1;
          if (myGen === gen) {
            pending.delete(job.key);
            if (!(val.error && val.error.name === 'AbortError')) { done.set(job.key, val); job.onResult(job.key, val); }
          }
          pump();
        });
    }
  };
  return {
    /** 창이 바뀌면 세대를 올리고 진행 중 요청을 끊는다(늦은 응답은 버림). 같은 창이면 아무것도 하지 않는다. */
    setWindow(k) {
      if (k === winKey) return;
      winKey = k; gen += 1; done = new Map(); pending = new Set(); queue = [];
      try { ac?.abort(); } catch { /* */ }
      ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    },
    /** 아직 없는 계열만 줄에 넣는다(이미 받았거나 진행 중이면 건너뜀 · 받은 것은 곧바로 onResult). */
    request(specs = [], win = {}, onResult = () => {}) {
      for (const spec of specs) {
        const key = seriesKey(spec);
        if (done.has(key)) { onResult(key, done.get(key)); continue; }
        if (pending.has(key)) continue;
        pending.add(key);
        queue.push({ key, spec, win, onResult, gen });
        onResult(key, { status: 'loading', data: null, error: null });
      }
      pump();
    },
    /** 언마운트 — 진행 중을 끊고 이후 응답을 버린다. */
    cancel() {
      gen += 1; queue = []; pending = new Set();
      try { ac?.abort(); } catch { /* */ }
      ac = typeof AbortController !== 'undefined' ? new AbortController() : null;   // 다시 쓰일 수 있다(개발 모드 이중 마운트) — 끊긴 신호를 물려주지 않는다
    },
    stats() { return { gen, winKey, active, queued: queue.length, done: done.size }; },
  };
}
