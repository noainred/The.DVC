/**
 * 점검 1회차(v2.731) 그룹 G4b — 웹 화면의 '못 읽음을 없음으로' · '늦은 응답' · '무음 실패' 회귀(A5-03·04·05·06·07·09·10).
 *
 * 이 저장소의 웹 테스트는 node 환경(DOM 없음)이라 renderToStaticMarkup 으로는 효과(useEffect)·클릭을 볼 수 없다.
 * 그래서 이 파일은 **아주 작은 훅 실행기**를 둔다 — 'react' 의 훅 7종을 이 파일 안에서만 갈아 끼워, 시험할 컴포넌트
 * 함수 하나를 직접 부르고(자식 컴포넌트는 그리지 않는다 — 요소로만 남는다) 효과를 실행하고 setState 로 다시 그린다.
 * 실행기가 돌지 않을 때(H.rt 없음)는 진짜 React 훅으로 넘긴다. 클릭은 요소의 onClick prop 을 그대로 부른다.
 * 레이아웃·실제 DOM 은 보지 못한다(Chromium 몫 — 정직 기록).
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

const { ErrorBox, Loading, DataTable } = await import('../components/ui.jsx');
const { ComposedChart } = await import('recharts');
const { sortChildren } = await import('../components/sortableText.js');
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
  H.api = {
    usePolling: () => ({ data: null, error: null, errorInfo: null, loading: true }),
    fetchJson: () => new Promise(() => {}),
  };
});

// ── A5-03 · A5-05 현재 사용자 ─────────────────────────────────────────────────
describe('A5-03 현재 사용자 추이 — 늦게 온 이전 응답이 새 선택을 덮지 않는다', () => {
  const CU = { now: Date.now(), vcenters: [{ vcenterId: 'vc1', vcenterName: 'VC1', users: 3, vmsOk: 1, vmsFailed: 0 }], records: [], total: { users: 3, names: [] }, kindLabels: {}, settings: { enabled: true, intervalMs: 600_000, guestPublishMs: 600_000 }, poller: { intervalMs: 600_000 } };

  it('90일을 누르고 7일을 누른 뒤 7일 응답이 먼저, 90일 응답이 나중에 와도 차트는 7일이다(90일 요청은 끊는다)', async () => {
    const { WindowsUsersPanel } = await import('./tools/CurrentUsers.jsx');
    H.api.usePolling = (path) => (path === '/tools/curuser' ? { data: CU, error: null, loading: false } : { data: null, loading: true });
    const calls = [];
    H.api.fetchJson = (path, params, signal) => {
      if (path !== '/tools/curuser/history') return Promise.resolve({});
      const d = defer(); calls.push({ params, signal, d }); return d.promise;
    };
    const rt = mount(WindowsUsersPanel, {});
    await flush();
    btnText(rt, '90일').props.onClick(); await flush();
    btnText(rt, '7일').props.onClick(); await flush();
    expect(calls.map((c) => Number(c.params.days))).toEqual([90, 7]);
    calls[1].d.resolve({ rows: [{ ts: 1, users: 7 }], span: null, now: Date.now() }); await flush();
    calls[0].d.resolve({ rows: [{ ts: 2, users: 90 }], span: null, now: Date.now() }); await flush();
    const charts = all(rt, (e) => e.type === ComposedChart);
    expect(charts.length).toBe(1);
    expect(charts[0].props.data.map((r) => r.users)).toEqual([7]);
    expect(calls[0].signal?.aborted, '90일 요청을 끊지 않았다').toBe(true);
    unmount(rt);
  });

  it('법인을 바꾸면 진행 중 요청을 끊고, 그 응답이 와도 그리지 않는다', async () => {
    const { WindowsUsersPanel } = await import('./tools/CurrentUsers.jsx');
    H.api.usePolling = (path) => (path === '/tools/curuser' ? { data: CU, error: null, loading: false } : { data: null, loading: true });
    const calls = [];
    H.api.fetchJson = (path, params, signal) => { const d = defer(); calls.push({ params, signal, d }); return d.promise; };
    const rt = mount(WindowsUsersPanel, {});
    await flush();
    btnText(rt, '불러오기').props.onClick(); await flush();
    const row = all(rt, (e) => e.type === 'tr' && typeof e.props.onClick === 'function')[0];
    row.props.onClick(); await flush();
    calls[0].d.resolve({ rows: [{ ts: 2, users: 99 }] }); await flush();
    expect(all(rt, (e) => e.type === ComposedChart).length).toBe(0);
    expect(calls[0].signal?.aborted).toBe(true);
    unmount(rt);
  });
});

describe('A5-05 작업 로그 정렬값 — 결측은 빈 값(오름차순 맨 앞에 오지 않는다)', () => {
  const sortRows = (col) => {
    const h = React.createElement;
    const rows = [['ok5', 5], ['fail', null], ['ok0', 0], ['ok2', 2]].map(([label, v]) => h('tr', { key: label }, h('td', null, label), h('td', { 'data-sort': col.sort({ [col.key]: v }) }, v == null ? '—' : String(v))));
    return sortChildren(rows, 1, 'asc').map((r) => r.props.children[0].props.children);
  };
  const colsOf = (rt) => all(rt, (e) => Array.isArray(e.props?.metricCols))[0]?.props.metricCols || [];

  it('Windows 수집 작업(서버·고유 사용자) — 결측 ⇒ "" · 오름차순에서 실패 행이 맨 뒤', async () => {
    const { WindowsUsersPanel } = await import('./tools/CurrentUsers.jsx');
    H.api.usePolling = () => ({ data: { now: Date.now(), vcenters: [], records: [], total: {}, settings: {}, poller: {} }, error: null, loading: false });
    const rt = mount(WindowsUsersPanel, {});
    const cols = colsOf(rt);
    expect(cols.map((c) => c.key)).toEqual(['vms', 'users']);
    for (const c of cols) {
      expect(c.sort({ [c.key]: null })).toBe('');
      expect(c.sort({})).toBe('');
      expect(c.sort({ [c.key]: 0 })).toBe('0');
      expect(sortRows(c)).toEqual(['ok0', 'ok2', 'ok5', 'fail']);
    }
    unmount(rt);
  });

  it('Horizon 세션 수집 작업(세션·고유 사용자) — 같은 규칙', async () => {
    const { default: HorizonSessionsPanel } = await import('./tools/HorizonSessionsPanel.jsx');
    H.api.usePolling = () => ({ data: { now: Date.now(), servers: [], total: {}, settings: {}, poller: {} }, error: null, loading: false });
    const rt = mount(HorizonSessionsPanel, {});
    const cols = colsOf(rt);
    expect(cols.map((c) => c.key)).toEqual(['sessions', 'users']);
    for (const c of cols) {
      expect(c.sort({ [c.key]: null })).toBe('');
      expect(sortRows(c)).toEqual(['ok0', 'ok2', 'ok5', 'fail']);
    }
    unmount(rt);
  });

  it('스윕 — 화면 코드에 String(x ?? -N) 정렬 sentinel 이 남아 있지 않다', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { stripComments } = await import('../test/_stripComments.js');
    const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    const hits = [];
    const visit = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) { if (ent.name !== 'node_modules') visit(p); continue; }
        if (!/\.(js|jsx)$/.test(ent.name) || /\.test\./.test(ent.name)) continue;
        const src = stripComments(fs.readFileSync(p, 'utf8'));
        for (const m of src.matchAll(/String\([^()]*\?\?\s*-\d+\s*\)/g)) hits.push(`${path.relative(root, p)}: ${m[0]}`);
      }
    };
    visit(root);
    expect(hits).toEqual([]);
  });
});

// ── A5-04 vCenter 상세 ──────────────────────────────────────────────────────
describe('A5-04 vCenter 상세 — 조회 중·실패·403 을 "없음·0 VM" 으로 그리지 않는다', () => {
  const site = { id: 'vc1', name: 'VC1', status: 'connected', metrics: {}, location: {} };
  const forbidden = httpErr(403, 'forbidden');

  it('호스트·VM 403 · 데이터스토어 조회 중 · 네트워크 500 — 각 표 자리가 권한 안내·불러오는 중·오류다', async () => {
    const { default: VCenterDetail } = await import('./VCenterDetail.jsx');
    H.api.usePolling = (path) => {
      if (path === '/hosts' || path === '/vms') return { data: null, error: 'forbidden', errorInfo: forbidden, loading: false };
      if (path === '/networks') return { data: null, error: '/networks -> 500', errorInfo: null, loading: false };
      return { data: null, error: null, errorInfo: null, loading: true };
    };
    const rt = mount(VCenterDetail, { site, onBack: () => {} });
    await flush();
    // 호스트 트리 자리: 403 권한 안내(ErrorBox 가 AccessDenied 로 바꾼다) — '0 호스트 · VM 0' 트리를 그리지 않는다
    expect(all(rt, (e) => e.type === ErrorBox && e.props.error === forbidden).length).toBeGreaterThanOrEqual(1);
    expect(all(rt, (e) => /^0 호스트/.test(textOf(e))).length).toBe(0);
    // 헤더 VM 수: 받지 못했으면 '—'(0 이 아니다)
    const vmHead = all(rt, (e) => e.type === 'span' && /VM 전체/.test(String(e.props.title || '')))[0];
    expect(textOf(vmHead).replace(/\s+/g, ' ').trim()).toBe('VM —');

    btnText(rt, '💾 데이터스토어').props.onClick(); await flush();
    expect(all(rt, (e) => e.type === DataTable).length).toBe(0);
    expect(all(rt, (e) => e.type === Loading).length).toBe(1);
    expect(textOf(btn(rt, (e) => /^💾 전체 /.test(textOf(e))))).toBe('💾 전체 —');   // 받기 전 칩 개수는 0 이 아니라 —

    btnText(rt, '🌐 네트워크').props.onClick(); await flush();
    expect(all(rt, (e) => e.type === DataTable).length).toBe(0);
    expect(all(rt, (e) => e.type === ErrorBox && e.props.error === '/networks -> 500').length).toBe(1);

    btnText(rt, '🧊 VM 및 폴더').props.onClick(); await flush();
    expect(all(rt, (e) => / VM$/.test(String(e.props?.sub ?? ''))).length).toBe(0);
    expect(all(rt, (e) => e.type === ErrorBox && e.props.error === forbidden).length).toBe(1);
    unmount(rt);
  });

  it('데이터가 실제로 오면 빈 목록일 때만 "데이터스토어 없음"·"네트워크 없음" 이다', async () => {
    const { default: VCenterDetail } = await import('./VCenterDetail.jsx');
    H.api.usePolling = (path) => ((path === '/hosts' || path === '/vms' || path === '/datastores' || path === '/networks')
      ? { data: { items: [] }, error: null, loading: false } : { data: null, loading: true });
    const rt = mount(VCenterDetail, { site, onBack: () => {} });
    await flush();
    btnText(rt, '💾 데이터스토어').props.onClick(); await flush();
    const ds = all(rt, (e) => e.type === DataTable);
    expect(ds.length).toBe(1);
    expect(ds[0].props.emptyText).toBe('데이터스토어 없음');
    btnText(rt, '🌐 네트워크').props.onClick(); await flush();
    expect(all(rt, (e) => e.type === DataTable)[0].props.emptyText).toBe('네트워크 없음');
    unmount(rt);
  });
});

// ── A5-06 게시판 저장 상태 배너 ──────────────────────────────────────────────
describe('A5-06 게시판 저장 상태 — 조회가 한 번 실패해도 다시 읽는 사슬이 끊기지 않는다', () => {
  afterEach(() => { vi.useRealTimers(); });
  const PENDING = { stores: { board: { state: 'pending', loaded: true, unsavedSince: Date.now() - 20_000, retrying: false, writing: true }, notices: { state: 'saved', loaded: true } } };
  const SAVED = { stores: { board: { state: 'saved', loaded: true }, notices: { state: 'saved', loaded: true } } };

  it('대기 → 조회 실패 → (백오프 뒤) 다시 읽어 저장됨이면 멈춘다', async () => {
    const { PersistBanner, persistRetryDelay } = await import('./board/Board.jsx');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const seq = [() => Promise.resolve(PENDING), () => Promise.reject(new Error('시한 초과')), () => Promise.resolve(SAVED)];
    let n = 0;
    H.api.fetchJson = (path) => { expect(path).toBe('/board/persist'); const f = seq[n++] || (() => Promise.resolve(SAVED)); return f(); };
    const rt = mount(PersistBanner, { tick: 0 });
    await flush();
    expect(n).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000); await flush();
    expect(n).toBe(2);                                            // 실패
    expect(rt.out.props.readFail).toEqual({ fails: 1, nextMs: persistRetryDelay(1) });
    expect(rt.out.props.data).toBe(PENDING);                       // 직전 경고는 그대로(조용히 지우지 않는다)
    await vi.advanceTimersByTimeAsync(persistRetryDelay(1)); await flush();
    expect(n, '실패 뒤 다시 읽지 않았다(사슬이 끊겼다)').toBe(3);
    expect(rt.out.props.data).toBe(SAVED);
    expect(rt.out.props.readFail).toBe(null);
    await vi.advanceTimersByTimeAsync(10 * 60_000); await flush();
    expect(n, '저장됐는데 계속 읽는다').toBe(3);
    unmount(rt);
  });

  it('백오프는 두 배씩, 상한 5분 — 실패가 없고 미저장이 없으면 다시 읽지 않는다', async () => {
    const { persistRetryDelay, persistNextDelay, PERSIST_RETRY_MAX_MS } = await import('./board/Board.jsx');
    expect([1, 2, 3, 4, 5, 6, 50, 1e9].map(persistRetryDelay)).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
    expect(PERSIST_RETRY_MAX_MS).toBe(300_000);
    expect(persistNextDelay({ stores: SAVED.stores, fails: 0, tick: 0 })).toBe(null);
    expect(persistNextDelay({ stores: PENDING.stores, fails: 0 })).toBe(10_000);
    expect(persistNextDelay({ stores: PENDING.stores, fails: 3 })).toBe(40_000);
    expect(persistNextDelay({ stores: undefined, fails: 2, tick: 1 })).toBe(20_000);  // 한 번도 못 읽었지만 미저장 쓰기를 봤다
    expect(persistNextDelay({ stores: undefined, fails: 2, tick: 0 })).toBe(null);
  });
});

// ── A5-07 GPU 내보내기 ──────────────────────────────────────────────────────
describe('A5-07 GPU 내보내기 — 이력 정보 조회 실패를 "이력이 없습니다" 로 말하지 않는다', () => {
  it('조회 실패면 "읽지 못했습니다" + 사유, 0건 문구 없음', async () => {
    const { GpuExportModal } = await import('./tools/GpuTool.jsx');
    H.api.fetchJson = (path) => (path.startsWith('/tools/gpu/series-meta')
      ? Promise.reject(httpErr(503, 'GPU 사용률 이력 DB 를 읽지 못했습니다'))
      : Promise.resolve([]));
    const rt = mount(GpuExportModal, { scope: '', onClose: () => {}, onSnapshot: () => {} });
    await flush();
    const t = textOf(rt.out);
    expect(t).toContain('수집 이력 정보를 읽지 못했습니다');
    expect(t).toContain('GPU 사용률 이력 DB 를 읽지 못했습니다');
    expect(t).not.toContain('아직 수집된 GPU 사용률 이력이 없습니다');
    unmount(rt);
  });

  it('exportMetaText — 조회 중 · 실패 · 이력 없음 · 이력 있음(샘플 수 모름은 —)', async () => {
    const { exportMetaText } = await import('./tools/GpuTool.jsx');
    const fmt = (ts) => `T${ts}`;
    expect(exportMetaText(null, fmt).since).toBe('확인 중…');
    const f = exportMetaText({ failed: true, reason: 'x' }, fmt);
    expect(f.tone).toBe('warn'); expect(f.since).toContain('읽지 못했습니다 — x'); expect(f.detail).toContain('이력이 없다는 뜻이 아닙니다');
    expect(exportMetaText({ collectedSince: null, sampleCount: 0 }, fmt).since).toContain('아직 수집된');
    const ok = exportMetaText({ collectedSince: 1_000, latestAt: 2_000, sampleCount: null }, fmt, 1_000 + 3 * 86_400_000);
    expect(ok.since).toBe('T1000 부터 데이터가 쌓여 있습니다');
    expect(ok.detail).toBe('총 3일 누적 · 샘플 —개 · 마지막 T2000');
  });
});

// ── A5-09 게스트 조사 스케줄 ─────────────────────────────────────────────────
describe('A5-09 게스트 조사 작업 — 저장·실행·삭제 실패를 삼키지 않는다', () => {
  const JOBS = { jobs: [{ id: 'j1', name: 'job1', type: 'login-fails', vcenterId: 'vc1', os: 'all', intervalMin: 60, days: 7, maxVms: 100, enabled: true }] };
  const setup = async () => {
    const { default: GuestScanJobs } = await import('./GuestScanJobs.jsx');
    H.api.usePolling = (path) => (path === '/vcenters' ? { data: [{ id: 'vc1', name: 'VC1' }], error: null, loading: false } : { data: null, loading: true });
    H.api.fetchJson = () => Promise.resolve(JOBS);
    const rt = mount(GuestScanJobs, { type: 'login-fails' });
    await flush();
    return rt;
  };
  const formOpen = (rt) => all(rt, (e) => e.type === 'input' && e.props.placeholder === '이름').length === 1;

  it('저장이 404(범위 밖 vCenter)로 거부되면 창을 닫지 않고 오류를 보인다', async () => {
    const rt = await setup();
    btnText(rt, '+ 조사 추가').props.onClick(); await flush();
    expect(formOpen(rt)).toBe(true);
    const vcSel = all(rt, (e) => typeof e.props?.onChange === 'function' && /vCenter 선택/.test(textOf(e)))[0];
    vcSel.props.onChange({ target: { value: 'vc1' } }); await flush();
    const err = httpErr(404, 'vCenter 를 찾을 수 없습니다(범위 제한 계정은 자기 범위 vCenter 를 지정해야 합니다).');
    let putCalls = 0;
    H.api.putJson = () => { putCalls++; return Promise.reject(err); };
    btnText(rt, '저장').props.onClick(); await flush();
    expect(putCalls).toBe(1);
    expect(formOpen(rt), '거부됐는데 창을 닫았다').toBe(true);
    expect(all(rt, (e) => e.type === ErrorBox && e.props.error === err).length).toBe(1);
    unmount(rt);
  });

  it('저장이 400 본문(ok:false)이어도 실패로 본다 · 성공하면 창을 닫는다', async () => {
    const rt = await setup();
    btnText(rt, '+ 조사 추가').props.onClick(); await flush();
    H.api.putJson = () => Promise.resolve({ ok: false, reason: '이름이 너무 깁니다' });
    btnText(rt, '저장').props.onClick(); await flush();
    expect(formOpen(rt)).toBe(true);
    expect(all(rt, (e) => e.type === ErrorBox && e.props.error === '이름이 너무 깁니다').length).toBe(1);
    H.api.putJson = () => Promise.resolve({ id: 'j2', name: 'x' });
    btnText(rt, '저장').props.onClick(); await flush();
    expect(formOpen(rt)).toBe(false);
    expect(all(rt, (e) => e.type === ErrorBox).length).toBe(0);
    unmount(rt);
  });

  it("'지금'(ok:false — 이미 실행 중)·'삭제'(ok:false)·던짐을 표 위에 말한다", async () => {
    const rt = await setup();
    H.api.postJson = () => Promise.resolve({ ok: false, reason: '이미 실행 중입니다.' });
    btnText(rt, '지금').props.onClick(); await flush();
    expect(all(rt, (e) => e.type === ErrorBox && e.props.error === '이미 실행 중입니다.').length).toBe(1);
    H.api.delJson = () => Promise.resolve({ ok: false });
    btnText(rt, '삭제').props.onClick(); await flush();
    expect(all(rt, (e) => e.type === ErrorBox && /삭제하지 못했습니다/.test(String(e.props.error))).length).toBe(1);
    const boom = new Error('서버에 연결하지 못했습니다');
    H.api.putJson = () => Promise.reject(boom);
    btnText(rt, '중지').props.onClick(); await flush();
    expect(all(rt, (e) => e.type === ErrorBox && e.props.error === boom).length).toBe(1);
    unmount(rt);
  });

  it('guestScanFailText — 성공 본문은 null · 거부는 사유 또는 대체 문구', async () => {
    const { guestScanFailText } = await import('./GuestScanJobs.jsx');
    expect(guestScanFailText({ id: 'j1' }, 'f')).toBe(null);
    expect(guestScanFailText({ ok: true }, 'f')).toBe(null);
    expect(guestScanFailText({ ok: false }, 'f')).toBe('f');
    expect(guestScanFailText({ ok: false, reason: 'r' }, 'f')).toBe('r');
    expect(guestScanFailText({ error: 'forbidden' }, 'f')).toBe('forbidden');
    expect(guestScanFailText(null, 'f')).toBe(null);
  });
});

// ── A5-10 사용자 범위 편집 ──────────────────────────────────────────────────
describe('A5-10 사용자 범위 편집 — vCenter 목록 조회 실패를 "표시할 vCenter가 없습니다" 로 말하지 않는다', () => {
  const USERS = { users: [{ username: 'u1', name: 'U1', role: 'viewer', scope: { vcenters: ['vc-a'], regions: [], writeVcenters: [] } }] };
  const openScope = async (vcResult) => {
    const { default: UserAdmin } = await import('./UserAdmin.jsx');
    let vcCalls = 0;
    H.api.fetchJson = (path) => {
      if (path === '/admin/users') return Promise.resolve(USERS);
      if (path === '/admin/permissions') return Promise.resolve(null);
      if (path === '/vcenters') { vcCalls++; return vcResult(vcCalls); }
      return Promise.resolve({});
    };
    const rt = mount(UserAdmin, {});
    await flush();
    btn(rt, (e) => e.props.title === '이 계정이 볼 수 있는 vCenter/리전을 제한합니다.').props.onClick(); await flush();
    return { rt, calls: () => vcCalls };
  };

  it('조회 실패 → "읽지 못했습니다" + 지금 선택 유지 안내 + 다시 읽기, "표시할 vCenter가 없습니다" 없음', async () => {
    const { rt, calls } = await openScope((n) => (n === 1 ? Promise.reject(new Error('시한 초과')) : Promise.resolve([{ id: 'vc-a', name: 'A' }])));
    expect(textOf(rt.out)).not.toContain('표시할 vCenter가 없습니다');
    const errEls = all(rt, (e) => typeof e.type === 'function' && e.props?.err && typeof e.props?.onRetry === 'function');
    expect(errEls.length).toBe(2);                         // 조회 범위·수정 범위 두 칸
    expect(errEls[0].props.selected).toEqual(['vc-a']);
    // 안내 컴포넌트는 훅이 없는 순수 함수 — 직접 불러 글을 본다(실행기는 자식 컴포넌트를 그리지 않는다).
    const msg = textOf(errEls[0].type(errEls[0].props));
    expect(msg).toContain('vCenter 목록을 읽지 못했습니다 — 0개라는 뜻이 아닙니다.');
    expect(msg).toContain('사유: 시한 초과');
    expect(msg).toContain('지금 선택(vc-a)은 그대로 유지됩니다');
    expect(all(rt, (e) => e.type === 'input' && e.props.type === 'checkbox' && e.props.checked === true).length).toBe(0); // 목록이 없어 vCenter 체크박스가 없다
    // 다시 읽기 → 성공하면 안내가 사라지고 체크박스가 나온다(지금 선택 vc-a 가 체크된 채)
    errEls[0].props.onRetry(); await flush();
    expect(calls()).toBe(2);
    expect(all(rt, (e) => typeof e.type === 'function' && e.props?.err && typeof e.props?.onRetry === 'function').length).toBe(0);
    expect(all(rt, (e) => e.type === 'input' && e.props.type === 'checkbox' && e.props.checked === true).length).toBeGreaterThanOrEqual(1);
    unmount(rt);
  });

  it('정말 0개면 그대로 "표시할 vCenter가 없습니다"', async () => {
    const { rt } = await openScope(() => Promise.resolve([]));
    expect(textOf(rt.out)).toContain('표시할 vCenter가 없습니다');
    unmount(rt);
  });

  it('vcListState — 배열이면 목록, 실패·배열 아님이면 오류(0개로 바꾸지 않는다)', async () => {
    const { vcListState } = await import('./UserAdmin.jsx');
    expect(vcListState({ ok: true, v: [] })).toEqual({ list: [] });
    expect(vcListState({ ok: true, v: { items: [] } }).err).toMatch(/형식/);
    const e = new Error('x');
    expect(vcListState({ ok: false, e }).err).toBe(e);
    expect(vcListState(null).err).toMatch(/읽지 못했습니다/);
  });
});
