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

vi.mock('../../api.js', async (orig) => {
  const real = await orig();
  const call = (name) => (...a) => (H.api[name] ? H.api[name](...a) : real[name](...a));
  return {
    ...real,
    usePolling: (...a) => H.api.usePolling(...a),
    fetchJson: call('fetchJson'), postJson: call('postJson'), putJson: call('putJson'), delJson: call('delJson'),
    patchJson: call('patchJson'), downloadFile: call('downloadFile'),
    toolAllowed: (k) => (H.denyTools || []).indexOf(k) < 0, can: () => true, canCsv: () => true, getCurrentUser: () => ({ username: 'admin', role: 'admin' }),
  };
});

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

const { ErrorBox, Loading } = await import('../../components/ui.jsx');
const { STable } = await import('../../components/STable.jsx');

beforeEach(() => { H.api = {}; H.denyTools = []; });
afterEach(() => { H.api = {}; H.denyTools = []; });

describe('v2.895 vCenter 탭 12개 — 렌더(얕게)', () => {
  const site = { id: 'vc1', name: 'VC1', status: 'connected', version: '8.0.2', build: '222', metrics: { cpuUsagePct: 41, memUsagePct: 64 }, location: {} };
  const okList = (items) => ({ data: { items }, error: null, loading: false });

  it('탭 줄 12개(이모지 없음) · 기본은 호스트 및 클러스터 · 모니터를 누르면 MonitorTab(문제 및 알람)', async () => {
    const { default: VCenterDetail } = await import('../VCenterDetail.jsx');
    const { default: MonitorTab } = await import('./MonitorTab.jsx');
    H.api.usePolling = (p) => (['/hosts', '/vms', '/datastores', '/networks'].includes(p) ? okList([]) : { data: null, loading: true });
    const rt = mount(VCenterDetail, { site, onBack: () => {} });
    await flush();
    const tabs = all(rt, (e) => e.type === 'button' && e.props.role === 'tab').map((e) => textOf(e).trim());
    expect(tabs.length).toBe(12);
    expect(tabs[0]).toBe('요약');
    expect(tabs[6]).toBe('VM');
    expect(all(rt, (e) => e.type === 'button' && e.props.role === 'tab' && e.props['aria-selected'])[0] && textOf(all(rt, (e) => e.type === 'button' && e.props.role === 'tab' && e.props['aria-selected'] === true)[0]).trim()).toBe('호스트 및 클러스터');
    btnText(rt, '모니터').props.onClick(); await flush();
    const mt = all(rt, (e) => e.type === MonitorTab);
    expect(mt.length).toBe(1);
    expect(mt[0].props.sub).toBe('alarms');
    expect(mt[0].props.perf).toBeTruthy();   // 예전 '추이' 본문이 성능 칸으로 넘어간다
    // 트리 카드(.vcd-tree)는 호스트 · VM · 데이터스토어 · 네트워크 탭에서만 — 빈 카드가 남지 않는다
    expect(all(rt, (e) => e.props?.className === 'vcd-tree card').length).toBe(0);
    unmount(rt);
  });

  it('사용량 조회 체크는 탭 줄이 아니라 호스트/VM 필터 줄에 있다', async () => {
    const { default: VCenterDetail } = await import('../VCenterDetail.jsx');
    H.api.usePolling = (p) => (['/hosts', '/vms', '/datastores', '/networks'].includes(p) ? okList([]) : { data: null, loading: true });
    const rt = mount(VCenterDetail, { site, onBack: () => {} });
    await flush();
    const nav = all(rt, (e) => e.type === 'nav' && e.props.className === 'vcd-views')[0];
    expect(textOf(nav)).not.toMatch(/사용량 조회/);
    expect(all(rt, (e) => e.type === 'label' && /사용량 조회/.test(textOf(e))).length).toBe(1);
    unmount(rt);
  });

  it('요약 — 도구 권한이 없으면 부르지 않고 권한 안내(403) · 알람은 포탈 규칙 배지', async () => {
    const { default: SummaryTab } = await import('./SummaryTab.jsx');
    H.denyTools = ['licenses', 'cert-expiry', 'solutions', 'change-history'];
    const called = [];
    H.api.fetchJson = (p) => { called.push(p); return Promise.resolve({}); };
    H.api.usePolling = (p) => (p === '/alarms' ? { data: { items: [{ id: 'a1', vcenterId: 'vc1', severity: 'critical', entity: 'h1', message: 'Host disconnected' }] }, error: null, loading: false } : { data: null, loading: true });
    const rt = mount(SummaryTab, { site, vcenterId: 'vc1', hosts: [], vms: [], datastores: [], networks: [], hostsOk: true, vmsOk: false, dsOk: true, netOk: false, onGo: () => {} });
    await flush();
    expect(called).toEqual([]);
    const denied = all(rt, (e) => e.type === ErrorBox && e.props.error?.status === 403);
    expect(denied.length).toBe(2);   // 라이선스 · 최근 변경
    expect(all(rt, (e) => e.type === 'span' && textOf(e) === '포탈 규칙').length).toBe(1);
    unmount(rt);
  });

  it('확장 프로그램 — 읽지 못함은 표 대신 확인 불가(0개라 하지 않는다)', async () => {
    const { ExtensionsTab } = await import('./InventoryTabs.jsx');
    H.api.fetchJson = () => Promise.resolve({ items: [{ vcenterId: 'vc1', solutions: [], solutionsUnread: { why: 'error', text: '조회 실패' } }] });
    const rt = mount(ExtensionsTab, { vcenterId: 'vc1' });
    await flush();
    expect(all(rt, (e) => e.type === STable).length).toBe(0);
    expect(all(rt, (e) => /확장 목록을 읽지 못했습니다/.test(textOf(e))).length).toBeGreaterThan(0);
    unmount(rt);
  });

  it('확장 프로그램 — 정상 목록은 정렬 표 · VMware/타사 칩', async () => {
    const { ExtensionsTab } = await import('./InventoryTabs.jsx');
    H.api.fetchJson = () => Promise.resolve({ items: [
      { vcenterId: 'vc1', solutions: [{ key: 'com.vmware.vsan', label: 'vSAN', version: '8', company: 'VMware, Inc.' }, { key: 'com.veeam', label: 'Veeam', version: '12', company: 'Veeam' }] },
      { vcenterId: 'vc2', solutions: [{ key: 'com.vmware.vsan', version: '7' }] },
    ] });
    const rt = mount(ExtensionsTab, { vcenterId: 'vc1' });
    await flush();
    expect(all(rt, (e) => e.type === STable).length).toBe(1);
    expect(btn(rt, (e) => /^VMware 1$/.test(textOf(e).trim()))).toBeTruthy();
    expect(btn(rt, (e) => /^타사 1$/.test(textOf(e).trim()))).toBeTruthy();
    expect(all(rt, (e) => e.type === 'td' && /2 \/ 2 vCenter · 버전 2종/.test(textOf(e))).length).toBe(1);
    unmount(rt);
  });

  it('업데이트 — vCenter 보다 높은 ESXi 판은 확인 필요 배지 · 버전 모름은 따로 센다', async () => {
    const { UpdatesTab } = await import('./InventoryTabs.jsx');
    const rt = mount(UpdatesTab, { site, hostsOk: true, gate: null, hosts: [{ version: '8.0.3', build: '1' }, { version: '7.0.3', build: '2' }, { version: '' }] });
    await flush();
    expect(all(rt, (e) => e.type === 'span' && /vCenter 보다 높음/.test(textOf(e))).length).toBe(1);
    expect(all(rt, (e) => /버전을 보고하지 않은 호스트 1대/.test(textOf(e))).length).toBeGreaterThan(0);
    unmount(rt);
  });
});
