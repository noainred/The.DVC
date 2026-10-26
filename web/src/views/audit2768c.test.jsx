/**
 * audit2768c.test.jsx — v2.768(3회차) 수정 그룹 G3 웹 회귀: 실패를 삼키거나 이전 대상의 표를 남기던 두 화면.
 *
 *  R3-C4-1  vCenter 로그 › 로그 조회(LogViewer) — 로컬 조회 실패를 catch(()=>{}) 로 삼켜 필터를 바꾼 뒤 실패하면 이전 조건의 행이 남았고,
 *           첫 조회 실패는 '기간 안 로그 없음' 으로 보였다.
 *  R3-C4-2  특수 기능 › 폴더 사용량 Top-N — 대상 전환 시 detail·history 를 비우지 않고, 상세 오류를 20초 폴링이 지웠고, [보기] 의 늦은 응답이 새 대상 화면을 덮었다.
 *
 * 이 저장소의 웹 테스트는 node 환경(DOM 없음)이다 — audit2731g4b 와 같은 **아주 작은 훅 실행기**로 컴포넌트 함수 하나를 직접 부르고
 * 효과를 실행한다(자식 컴포넌트는 그리지 않는다 — 요소로만 남는다). 레이아웃·실제 DOM 은 보지 못한다(Chromium 몫 — 정직 기록).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const H = vi.hoisted(() => {
  const H = { rt: null, api: {} };
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const slot = (init) => {
    const rt = H.rt; const i = rt.i++;
    if (!(i in rt.slots)) rt.slots[i] = init();
    return [rt, i, rt.slots[i]];
  };
  const schedule = (rt) => {
    if (rt.queued || rt.dead) return;
    rt.queued = true;
    queueMicrotask(() => { rt.queued = false; H.render(rt); });
  };
  H.hooks = {
    useState(init) {
      const [rt, , s] = slot(() => ({ v: typeof init === 'function' ? init() : init }));
      if (!s.set) s.set = (u) => { const nv = typeof u === 'function' ? u(s.v) : u; if (Object.is(nv, s.v)) return; s.v = nv; schedule(rt); };
      return [s.v, s.set];
    },
    useReducer(red, initArg, initFn) {
      const [rt, , s] = slot(() => ({ v: initFn ? initFn(initArg) : initArg }));
      if (!s.set) s.set = (a) => { const nv = red(s.v, a); if (Object.is(nv, s.v)) return; s.v = nv; schedule(rt); };
      return [s.v, s.set];
    },
    useRef(init) { const [, , s] = slot(() => ({ current: init })); return s; },
    useMemo(fn, deps) {
      const [, , s] = slot(() => ({ fresh: true }));
      if (s.fresh || !deps || !same(deps, s.deps)) { s.v = fn(); s.deps = deps; s.fresh = false; }
      return s.v;
    },
    useCallback(fn, deps) { return H.hooks.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const [rt, i, s] = slot(() => ({ fresh: true }));
      if (s.fresh || !deps || !same(deps, s.deps)) { s.fresh = false; s.deps = deps; rt.pending.push({ i, fn }); }
    },
    useLayoutEffect(fn, deps) { return H.hooks.useEffect(fn, deps); },
    useContext(ctx) { return ctx?._currentValue; },
  };
  H.render = (rt) => {
    if (rt.dead) return;
    if (++rt.renders > 400) throw new Error('렌더가 끝나지 않는다(무한 갱신)');
    rt.i = 0; rt.pending = [];
    H.rt = rt;
    try { rt.out = rt.Comp(rt.props); } finally { H.rt = null; }
    for (const e of rt.pending) {
      const s = rt.slots[e.i];
      if (typeof s.cleanup === 'function') { try { s.cleanup(); } catch { /* 정리 실패는 시험 대상이 아니다 */ } }
      const c = e.fn();
      s.cleanup = typeof c === 'function' ? c : null;
    }
  };
  return H;
});

vi.mock('react', async (orig) => {
  const real = await orig();
  const base = real.default || real;
  const wrap = (name) => (...a) => (H.rt ? H.hooks[name](...a) : base[name](...a));
  const hooks = Object.fromEntries(['useState', 'useReducer', 'useRef', 'useMemo', 'useCallback', 'useEffect', 'useLayoutEffect', 'useContext'].map((n) => [n, wrap(n)]));
  return { ...real, ...hooks, default: { ...base, ...hooks } };
});

vi.mock('../api.js', async (orig) => {
  const real = await orig();
  const call = (name) => (...a) => (H.api[name] ? H.api[name](...a) : real[name](...a));
  return {
    ...real,
    usePolling: (...a) => H.api.usePolling(...a),
    fetchJson: call('fetchJson'), postJson: call('postJson'), putJson: call('putJson'), delJson: call('delJson'),
    patchJson: call('patchJson'), downloadFile: call('downloadFile'),
    toolAllowed: () => true, canCsv: () => true, getCurrentUser: () => ({ username: 'admin', role: 'admin' }),
  };
});

const { ErrorBox } = await import('../components/ui.jsx');
const React = (await import('react')).default;

// ── 실행기 도우미 ─────────────────────────────────────────────────────────────
function mount(Comp, props = {}) {
  const rt = { Comp, props, slots: [], i: 0, out: null, pending: [], queued: false, renders: 0, dead: false };
  H.render(rt);
  return rt;
}
function unmount(rt) {
  rt.dead = true;
  for (const s of rt.slots) if (s && typeof s.cleanup === 'function') { try { s.cleanup(); } catch { /* */ } }
}
const realSetImmediate = globalThis.setImmediate;
async function flush(n = 25) { for (let k = 0; k < n; k++) await new Promise((r) => realSetImmediate(r)); }
const isEl = (n) => !!n && typeof n === 'object' && '$$typeof' in n && 'props' in n;
function* walk(n) {
  if (n == null || typeof n === 'boolean') return;
  if (Array.isArray(n)) { for (const c of n) yield* walk(c); return; }
  if (!isEl(n)) return;
  yield n;
  for (const [k, v] of Object.entries(n.props || {})) {
    if (k === 'children' || isEl(v) || (Array.isArray(v) && v.some(isEl))) yield* walk(v);
  }
}
const textOf = (n) => {
  if (n == null || typeof n === 'boolean') return '';
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(textOf).join('');
  if (isEl(n)) return textOf(n.props?.children);
  return '';
};
const all = (rt, pred) => [...walk(rt.out)].filter(pred);
const btn = (rt, pred) => all(rt, (e) => e.type === 'button' && pred(e))[0];
const btnText = (rt, s) => btn(rt, (e) => textOf(e).trim() === s);
const defer = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const httpErr = (status, message) => Object.assign(new Error(message), { status, name: 'HttpError' });



beforeEach(() => {
  H.api = { usePolling: () => ({ data: null, error: null, loading: true }), fetchJson: () => new Promise(() => {}) };
});

const SETTINGS = { settings: { targets: [{ id: 'A', agent: 'e1', path: '/mnt/a' }, { id: 'B', agent: 'e1', path: '/mnt/b' }] } };
const scanOf = (root, name, bytes, targetId) => ({ scan: { id: root, root, ts: 1, target_id: targetId, total_bytes: bytes, sum_bytes: bytes, count: 1, entries: [{ name, bytes }] }, prev: null, compare: null });
const selOf = (rt, v) => all(rt, (e) => e.props && typeof e.props.onChange === 'function' && e.props.value === v)[0];
const hasErrorBox = (rt) => all(rt, (e) => e.type === ErrorBox).length > 0;

describe('R3-C4-2 DirUsageReport — 대상 전환·상세 오류·[보기] 늦은 응답', () => {
  it('A → B 전환 중(응답 대기)에는 A 의 표가 남지 않는다', async () => {
    const { DirUsageReport } = await import('./tools/DirUsageReport.jsx');
    H.api.fetchJson = (p) => {
      if (p === '/admin/dir-usage') return Promise.resolve(SETTINGS);
      if (p === '/admin/dir-usage/history/A') return Promise.resolve({ scans: [{ id: 1, ts: 1 }] });
      if (p === '/admin/dir-usage/scan/1') return Promise.resolve(scanOf('/mnt/a', 'alice-A', 5000, 'A'));
      return new Promise(() => {});
    };
    const rt = mount(DirUsageReport, {});
    await flush();
    expect(textOf(rt.out)).toContain('alice-A');
    selOf(rt, 'A').props.onChange({ target: { value: 'B' } });
    await flush();
    expect(selOf(rt, 'B')).toBeTruthy();
    expect(textOf(rt.out)).not.toContain('alice-A');
    expect(textOf(rt.out)).not.toContain('아직 수집 결과가 없습니다');   // 불러오는 중에 '없다' 고 단정하지 않는다
    unmount(rt);
  });

  it('B 조회가 실패하면 A 의 표 대신 상세 오류 — 20초 폴링(설정 재조회 성공)이 그 오류를 지우지 않는다', async () => {
    const { DirUsageReport } = await import('./tools/DirUsageReport.jsx');
    const timers = [];
    const realSI = globalThis.setInterval; const realCI = globalThis.clearInterval;
    globalThis.setInterval = (fn) => { timers.push(fn); return timers.length; };
    globalThis.clearInterval = () => {};
    try {
      H.api.fetchJson = (p) => {
        if (p === '/admin/dir-usage') return Promise.resolve(SETTINGS);
        if (p === '/admin/dir-usage/history/A') return Promise.resolve({ scans: [{ id: 1, ts: 1 }] });
        if (p === '/admin/dir-usage/scan/1') return Promise.resolve(scanOf('/mnt/a', 'alice-A', 5000, 'A'));
        if (p === '/admin/dir-usage/history/B') return Promise.reject(new Error('timeout'));
        return new Promise(() => {});
      };
      const rt = mount(DirUsageReport, {});
      await flush();
      selOf(rt, 'A').props.onChange({ target: { value: 'B' } });
      await flush();
      expect(textOf(rt.out)).not.toContain('alice-A');
      expect(hasErrorBox(rt)).toBe(true);
      expect(textOf(rt.out)).not.toContain('아직 수집 결과가 없습니다');
      for (const fn of timers) fn();   // 20초 폴링 1회 — 설정 재조회 성공(setErr(null))
      await flush();
      expect(hasErrorBox(rt)).toBe(true);
      unmount(rt);
    } finally { globalThis.setInterval = realSI; globalThis.clearInterval = realCI; }
  });

  it('A 이력의 [보기] 를 누른 뒤 B 로 바꾸면 늦게 온 A 스캔은 버린다', async () => {
    const { DirUsageReport } = await import('./tools/DirUsageReport.jsx');
    const slowOld = defer();
    H.api.fetchJson = (p) => {
      if (p === '/admin/dir-usage') return Promise.resolve(SETTINGS);
      if (p === '/admin/dir-usage/history/A') return Promise.resolve({ scans: [{ id: 1, ts: 2 }, { id: 2, ts: 1 }] });
      if (p === '/admin/dir-usage/scan/1') return Promise.resolve(scanOf('/mnt/a', 'alice-A', 5000, 'A'));
      if (p === '/admin/dir-usage/scan/2') return slowOld.promise;
      if (p === '/admin/dir-usage/history/B') return Promise.resolve({ scans: [{ id: 9, ts: 3 }] });
      if (p === '/admin/dir-usage/scan/9') return Promise.resolve(scanOf('/mnt/b', 'bob-B', 7000, 'B'));
      return new Promise(() => {});
    };
    const rt = mount(DirUsageReport, {});
    await flush();
    const views = all(rt, (e) => e.type === 'button' && textOf(e).trim() === '보기');
    expect(views.length).toBe(2);
    views[1].props.onClick();   // A 의 옛 회차 보기(느림)
    selOf(rt, 'A').props.onChange({ target: { value: 'B' } });
    await flush();
    expect(textOf(rt.out)).toContain('bob-B');
    slowOld.resolve(scanOf('/mnt/a', 'alice-OLD', 4000, 'A'));
    await flush();
    expect(textOf(rt.out)).not.toContain('alice-OLD');
    expect(textOf(rt.out)).toContain('bob-B');
    unmount(rt);
  });

  it('[보기] 실패는 상세 오류로 보이고, 같은 대상에서는 정상 [보기] 가 반영된다', async () => {
    const { DirUsageReport } = await import('./tools/DirUsageReport.jsx');
    H.api.fetchJson = (p) => {
      if (p === '/admin/dir-usage') return Promise.resolve(SETTINGS);
      if (p === '/admin/dir-usage/history/A') return Promise.resolve({ scans: [{ id: 1, ts: 2 }, { id: 2, ts: 1 }] });
      if (p === '/admin/dir-usage/scan/1') return Promise.resolve(scanOf('/mnt/a', 'alice-A', 5000, 'A'));
      if (p === '/admin/dir-usage/scan/2') return Promise.resolve(scanOf('/mnt/a', 'alice-OLD', 4000, 'A'));
      return new Promise(() => {});
    };
    const rt = mount(DirUsageReport, {});
    await flush();
    all(rt, (e) => e.type === 'button' && textOf(e).trim() === '보기')[1].props.onClick();
    await flush();
    expect(textOf(rt.out)).toContain('alice-OLD');
    unmount(rt);
  });

  it('설정 조회 403 이면 폴링을 멈춘다(v2.621 유지)', async () => {
    const { DirUsageReport } = await import('./tools/DirUsageReport.jsx');
    let cleared = 0;
    const realSI = globalThis.setInterval; const realCI = globalThis.clearInterval;
    globalThis.setInterval = () => 77; globalThis.clearInterval = (id) => { if (id === 77) cleared++; };
    try {
      H.api.fetchJson = (p) => (p === '/admin/dir-usage' ? Promise.reject(httpErr(403, 'forbidden')) : new Promise(() => {}));
      const rt = mount(DirUsageReport, {});
      await flush();
      expect(cleared).toBe(1);
      unmount(rt);
    } finally { globalThis.setInterval = realSI; globalThis.clearInterval = realCI; }
  });
});

describe('R3-C4-1 LogViewer — 로컬 조회 실패', () => {
  const ROW = { ts: 1, vcenterId: 'vc-a', severity: 'error', type: 't', entity: 'e', user: 'u', message: 'OLD-ROW' };
  it('필터를 바꾼 뒤 조회가 실패하면 이전 조건의 행을 비우고 오류를 보인다(빈 목록 문구 없음)', async () => {
    const { LogViewer, vcLogEmptyText, VCLOG_DEFAULT_PERIOD } = await import('./VcenterLogs.jsx');
    let fail = false;
    H.api.usePolling = () => ({ data: [{ id: 'vc-a', name: 'vc-a' }], error: null, loading: false });
    H.api.fetchJson = (p) => {
      if (p === '/tools/vclogs/sources') return Promise.resolve({ local: [], remote: [] });
      if (p.startsWith('/tools/vclogs?')) return fail ? Promise.reject(new Error('boom')) : Promise.resolve({ rows: [ROW], total: 1 });
      return new Promise(() => {});
    };
    const rt = mount(LogViewer, {});
    await flush();
    expect(textOf(rt.out)).toContain('OLD-ROW');
    fail = true;
    const sev = all(rt, (e) => e.props && typeof e.props.onChange === 'function' && textOf(e).includes('전체 심각도'))[0];
    sev.props.onChange({ target: { value: 'error' } });
    await flush();
    expect(textOf(rt.out)).not.toContain('OLD-ROW');
    expect(hasErrorBox(rt)).toBe(true);
    expect(textOf(rt.out)).not.toContain(vcLogEmptyText(VCLOG_DEFAULT_PERIOD));
    unmount(rt);
  });

  it('첫 조회 실패는 \'로그 없음\' 이 아니라 오류', async () => {
    const { LogViewer, vcLogEmptyText, VCLOG_DEFAULT_PERIOD } = await import('./VcenterLogs.jsx');
    H.api.usePolling = () => ({ data: [], error: null, loading: false });
    H.api.fetchJson = (p) => {
      if (p === '/tools/vclogs/sources') return Promise.resolve({ local: [], remote: [] });
      if (p.startsWith('/tools/vclogs?')) return Promise.reject(httpErr(500, 'internal'));
      return new Promise(() => {});
    };
    const rt = mount(LogViewer, {});
    await flush();
    expect(hasErrorBox(rt)).toBe(true);
    expect(textOf(rt.out)).not.toContain(vcLogEmptyText(VCLOG_DEFAULT_PERIOD));
    unmount(rt);
  });

  it('대조: 정상 빈 결과는 빈 목록 문구', async () => {
    const { LogViewer, vcLogEmptyText, VCLOG_DEFAULT_PERIOD } = await import('./VcenterLogs.jsx');
    H.api.usePolling = () => ({ data: [], error: null, loading: false });
    H.api.fetchJson = (p) => {
      if (p === '/tools/vclogs/sources') return Promise.resolve({ local: [], remote: [] });
      if (p.startsWith('/tools/vclogs?')) return Promise.resolve({ rows: [], total: 0 });
      return new Promise(() => {});
    };
    const rt = mount(LogViewer, {});
    await flush();
    expect(hasErrorBox(rt)).toBe(false);
    expect(textOf(rt.out)).toContain(vcLogEmptyText(VCLOG_DEFAULT_PERIOD));
    unmount(rt);
  });
});
