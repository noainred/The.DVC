/**
 * v2.744 리드 후속 FA — 웹 회귀(같은 이름 클러스터 key·표시 · 주문형 성능 '직접 수집 대상 아님' 표시 · 성능 창 409 자동 새로고침).
 *
 * ① v2.744 VC-02 가 /tools/capacity 행을 (vCenter, 클러스터 moref) 로 나누고 clusterRef·vcDatacenter·sameName 을 실었다 — 그런데
 *    그 행을 **이름** 으로 key·표시하는 화면(consoleData.clusterRows → V4·관제 콘솔 Compute, V4 Compare, 특수 기능 클러스터 수용여력)이
 *    남아 같은 이름 행 둘이 같은 React key·같은 글자로 보였다. 판정은 views/clustercfg/clusterCfgText.js clusterRowKey·clusterNameLabel 한 벌.
 * ② v2.744 VC-04 가 비활성·점검중·엣지 위임 vCenter 의 주문형 성능 조회에 로그인하지 않고 skipReason·skippedVcenters 를 싣는데, 화면이
 *    그 필드를 그리지 않아 '표본 없음'·'—' 로만 보였다. 문구는 views/vcAuthStopText.js 한 벌(인증 정지라고 말하지 않는다).
 * ③ 성능 창은 409 + skipReason 을 일반 오류로 보고 20초 자동 새로고침을 계속했다 — 인증 정지처럼 멈춘다.
 *
 * 이 저장소의 웹 테스트는 node 환경(DOM 없음)이다. 효과(useEffect)가 필요한 화면은 audit2731g4b.test.jsx 와 같은 **작은 훅 실행기**로
 * 컴포넌트 함수 하나를 직접 부르고(자식 컴포넌트는 요소로 남는다), 효과가 필요 없는 화면은 renderToStaticMarkup 으로 그린다.
 * 레이아웃·실제 DOM 은 보지 못한다(Chromium 몫 — 정직 기록). 시각은 Date.now() 를 쓰지 않는다(고정 값).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const H = vi.hoisted(() => {
  const H = { rt: null, api: {}, tab: {}, stTables: [] };
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
    fetchJson: call('fetchJson'), postJson: call('postJson'),
    toolAllowed: () => true, can: () => true, canCsv: () => true, getCurrentUser: () => ({ username: 'admin', role: 'admin' }),
  };
});

// 하위 탭 훅은 window.location 을 읽는다(node 환경에 없다) — 시험이 고른 탭을 돌려준다.
vi.mock('../hooks/useHashTab.js', () => ({
  useHashTab: ({ base, fallback }) => [H.tab[base.join('/')] ?? fallback, () => {}],
}));

// STable 은 표 행(tr)의 React key 를 기록한다 — renderToStaticMarkup 은 key 를 HTML 에 남기지 않으므로 여기서 본다.
vi.mock('../components/STable.jsx', async () => {
  const React = (await vi.importActual('react')).default;
  const keysOf = (node, out) => {
    if (node == null || typeof node === 'boolean') return out;
    if (Array.isArray(node)) { for (const c of node) keysOf(c, out); return out; }
    if (typeof node !== 'object' || !node.props) return out;
    if (node.type === 'tr') out.push(node.key);
    keysOf(node.props.children, out);
    return out;
  };
  function STable({ children }) {
    H.stTables.push(keysOf(children, []).filter((k) => k !== null));
    return React.createElement('table', null, children);
  }
  return { STable, default: STable };
});

const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { DataTable } = await import('../components/ui.jsx');
const BoldText = (await import('../components/boldText.jsx')).default;

// ── 훅 실행기 도우미 ─────────────────────────────────────────────────────────
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
const html = (el) => renderToStaticMarkup(el);
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

beforeEach(() => {
  H.api = {
    usePolling: () => ({ data: null, error: null, errorInfo: null, loading: true }),
    fetchJson: () => new Promise(() => {}),
    postJson: () => new Promise(() => {}),
  };
  H.tab = {};
  H.stTables = [];
});
afterEach(() => { vi.useRealTimers(); });

// /tools/capacity 응답 모양(server/src/routes/api/toolsCapacity.js) — 같은 vCenter 의 두 데이터센터에 'Prod' 가 하나씩.
const capRow = (over) => ({
  vcenterId: 'vc-a', cluster: 'Prod', clusterRef: null, vcDatacenter: null, sameName: 1, hosts: 4, vms: 10, vmsOn: 8,
  cores: 64, memTotalGB: 1024, vcpuAllocated: 100, vcpuTotal: 120, ramAllocatedGB: 900, vcpuPerCore: 1.6, ramOvercommitPct: 88,
  cpuUsedPct: 40, memUsedPct: 60, hostsUsageExcluded: 0, capacityUnknown: 0, ramHeadroomGB: 124, ...over,
});
const SEOUL = capRow({ clusterRef: 'domain-c10', vcDatacenter: 'DC-Seoul', sameName: 2, cpuUsedPct: 95, ramOvercommitPct: 120, ramHeadroomGB: 50 });
const BUSAN = capRow({ clusterRef: 'domain-c20', vcDatacenter: 'DC-Busan', sameName: 2, cpuUsedPct: 30, memUsedPct: 20, ramHeadroomGB: 400 });
const OTHER = capRow({ vcenterId: 'vc-b', cluster: 'Dev', clusterRef: 'domain-c7', vcDatacenter: 'DC-X', hosts: 3, cpuUsedPct: 10, memUsedPct: 10, ramHeadroomGB: 800 });
const CAP = { clusters: [SEOUL, BUSAN, OTHER], totals: { clusters: 3, hosts: 11, cores: 192, vcpuAllocated: 300, vcpuPerCore: 1.6, memTotalGB: 3072, ramAllocatedGB: 2700, ramHeadroomGB: 374, capacityUnknown: 0 } };
const scope = { q: '', region: '', focusVc: '', inScope: () => true, scoped: (list) => list || [] };
const dupFree = (keys) => new Set(keys).size === keys.length;

// ─────────────────────────────────────────────────────────────────────────────
describe('① 같은 이름 다른 데이터센터 클러스터 — key·표시는 clusterRowKey·clusterNameLabel', () => {
  it('consoleData.clusterRows: 같은 이름 두 행의 key 가 다르고 이름에 데이터센터가 붙는다(어드바이저 제목도)', async () => {
    const { clusterRows, capacityAdvice } = await import('../console/consoleData.js');
    const rows = clusterRows([SEOUL, BUSAN, OTHER]);
    const keys = rows.map((r) => r.key);
    expect(dupFree(keys)).toBe(true);
    expect(rows.map((r) => r.name).sort()).toEqual(['Dev', 'Prod · DC-Busan', 'Prod · DC-Seoul']);
    // ref 를 싣지 않은 옛 행(구버전 엣지 스냅샷)은 예전 키·이름 그대로
    const legacy = clusterRows([capRow({ cluster: 'Old', clusterRef: null, sameName: 1 })])[0];
    expect(legacy.key).toBe('vc-a|Old');
    expect(legacy.name).toBe('Old');
    const adv = capacityAdvice([SEOUL, BUSAN, OTHER]);
    expect(adv.find((a) => a.level === 2).title).toContain('Prod · DC-Seoul');
  });

  it('관제 콘솔 Compute: 클러스터 주의 목록이 두 Prod 를 데이터센터로 구분해 그린다(v2.747 V4 Compute 는 셸과 함께 지웠다)', async () => {
    H.api.usePolling = (p) => (p === '/tools/capacity' ? { data: CAP, error: null, loading: false } : { data: null, error: null, loading: true });
    const { default: ConsoleCompute } = await import('../console/pages/ConsoleCompute.jsx');
    for (const C of [ConsoleCompute]) {
      const out = html(React.createElement(C, { global: null, ov: null, sitesAll: [], scope, polls: { ov: null }, phase: null, phaseText: null, health: null }));
      expect(out).toContain('Prod · DC-Seoul');
      expect(out).toContain('Prod · DC-Busan');
    }
  });

  it('특수 기능 › 클러스터 수용여력: 표 행 key 가 겹치지 않고 클러스터 칸·정렬 값이 데이터센터를 붙인 이름이다', async () => {
    H.api.fetchJson = (p) => (p === '/tools/capacity' ? Promise.resolve(CAP) : new Promise(() => {}));
    const { Capacity } = await import('./tools/CapacityTools.jsx');
    const rt = mount(Capacity, { scope: '' });
    await flush();
    const dt = all(rt, (e) => e.type === DataTable)[0];
    expect(dt).toBeTruthy();
    const keys = dt.props.rows.map((r, i) => r.id || r.key || i);
    expect(dupFree(keys)).toBe(true);
    expect(keys.some((k) => /domain-c10/.test(String(k)))).toBe(true);
    const col = dt.props.columns.find((c) => c.key === 'cluster');
    const seoul = dt.props.rows.find((r) => r.clusterRef === 'domain-c10');
    expect(textOf(col.render(seoul))).toBe('Prod · DC-Seoul');
    expect(col.sortValue(seoul)).toBe('Prod · DC-Seoul');
    unmount(rt);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('② 직접 수집 대상이 아닌 vCenter(skipReason·skippedVcenters) — 인증 정지라고 말하지 않고 이유를 말한다', () => {
  it('skipSingleText: 사유 라벨과 조치를 말하고, 사유가 없으면 빈 문자열 · 백틱 0', async () => {
    const { skipSingleText, SKIP_REASON_TEXT, SKIP_HOW } = await import('./vcAuthStopText.js');
    expect(skipSingleText(null)).toBe('');
    expect(skipSingleText({ authStopped: true })).toBe('');
    for (const k of Object.keys(SKIP_REASON_TEXT)) {
      const t = skipSingleText({ skipReason: k, reason: 'x' });
      expect(t).toContain(SKIP_REASON_TEXT[k]);
      expect(t).not.toMatch(/인증 실패|인증 정지/);
      expect(t).not.toContain('`');
    }
    expect(Object.keys(SKIP_HOW).sort()).toEqual(Object.keys(SKIP_REASON_TEXT).sort());
    expect(skipSingleText({ skipReason: 'unknown-x' })).toContain('직접 수집 대상 아님');
  });

  it('vCenter 상세 › 추이(호스트·클러스터): skipReason 응답은 "가져오지 못했다" 가 아니라 직접 수집 대상이 아니라고 말한다', async () => {
    const { TrendEmptyNote } = await import('./VCenterDetail.jsx');
    const out = html(React.createElement(TrendEmptyNote, { d: { points: [], skipReason: 'maintenance', reason: '점검중 vCenter — 수집이 멈춰 있어 이 포탈이 로그인하지 않습니다' } }));
    expect(out).toContain('직접 수집하지 않는 vCenter');
    expect(out).toContain('점검중');
    expect(out).not.toContain('가져오지 못했습니다');
    // 인증 정지·일반 실패는 예전 그대로
    expect(html(React.createElement(TrendEmptyNote, { d: { points: [], authStopped: { attempts: 2 } } }))).toContain('인증 실패로 조회를 멈췄습니다');
    expect(html(React.createElement(TrendEmptyNote, { d: { points: [], reason: 'boom' } }))).toContain('가져오지 못했습니다');
  });

  it('vCenter 상세 › VM 실사용률 칸: 건너뛴 vCenter 의 VM 은 "표본 없음" 이 아니라 사유', async () => {
    const { VmUsageCell } = await import('./VCenterDetail.jsx');
    const out = html(React.createElement(VmUsageCell, { enabled: true, u: null, known: true, days: 30, skip: { skipReason: 'site', reason: '엣지 위임 vCenter — 담당 엣지가 수집하므로 중앙이 직접 로그인하지 않습니다' } }));
    expect(out).toContain('엣지 위임');
    expect(out).not.toContain('표본 없음');
    expect(out).not.toContain('인증');
  });

  it('vCenter 상세: /vms/usage 의 skippedVcenters 를 모아 행·머리 배지로 넘긴다(배선)', () => {
    const s = read('views/VCenterDetail.jsx');
    expect(s).toMatch(/r\?\.skippedVcenters/);
    expect(s).toMatch(/skip:\s*usageInfo\.skippedVcenters\?\.\[vm\.vcenterId\]/);
    expect(s).toMatch(/skipNote\(usageInfo\.skippedVcenters\)/);
  });

  it('VM 찾기(유휴 VM 분석): 건너뛴 VM 의 유휴 칸은 사유, 각주는 skipNote', async () => {
    const res = {
      items: [
        { id: 'vc-s:vm-1', name: 'a', vcenterId: 'vc-s', powerState: 'POWERED_ON', cpuUsagePct: 3, avgDayCpu: null, avgWeekCpu: null, idle: null, skipReason: 'site' },
        { id: 'vc-o:vm-2', name: 'b', vcenterId: 'vc-o', powerState: 'POWERED_ON', cpuUsagePct: 3, avgDayCpu: 2, avgWeekCpu: 2, idle: true },
      ],
      facets: { vcenters: [], folders: [], clusters: [], resourcePools: [] },
      avgComputed: true, avgCap: 40, avgTruncated: false, idleCount: 1, idleThreshold: 5, authStopped: {},
      skippedVcenters: { 'vc-s': { skipReason: 'site', reason: '엣지 위임 vCenter — 담당 엣지가 수집하므로 중앙이 직접 로그인하지 않습니다' } },
    };
    H.api.usePolling = () => ({ data: [], error: null, loading: false });
    H.api.postJson = () => Promise.resolve(res);
    const { VmFinder } = await import('./tools/VmFinderTool.jsx');
    const rt = mount(VmFinder, {});
    await flush();
    const dt = all(rt, (e) => e.type === DataTable)[0];
    const idle = dt.props.columns.find((c) => c.key === 'idle');
    const cell = textOf(idle.render(res.items[0]));
    expect(cell).toContain('엣지 위임');
    expect(cell).not.toContain('인증');
    const notes = all(rt, (e) => e.type === BoldText).map((e) => e.props.text).join('\n');
    expect(notes).toContain('직접 수집하지 않는 vCenter');
    unmount(rt);
  });

  it('특수 기능 › 최적화 CPU 과할당: 스파크라인 칸·각주가 건너뛴 vCenter 를 말한다', async () => {
    H.tab['tools/waste'] = 'cpu';
    const waste = {
      overAllocated: {
        thresholds: { cpuIdlePct: 10, memIdlePct: 20 }, excludedNoHostMhz: 0, memTop: [],
        cpu: { idleGHz: 7.9, allocGHz: 8, usedGHz: 0.1, savingPct: 50 }, mem: { idleGB: 0, allocGB: 0, usedGB: 0, savingPct: null },
        cpuTop: [{ id: 'vc-m:vm-9', name: 'x', vcenterId: 'vc-m', vcpu: 4, cpuAllocMhz: 8000, cpuUsedMhz: 100, cpuIdleMhz: 7900, cpuUsagePct: 1, cpuSavingPct: 50, host: 'h' }],
      },
      poweredOff: { count: 0, storageGB: 0, vms: [] }, thinReclaim: { reclaimableGB: 0, count: 0 },
      snapshots: { count: 0, sizeGB: 0, vms: [] }, noTools: { count: 0, vms: [] }, byVcenter: [],
    };
    H.api.fetchJson = (p) => (p === '/tools/waste' ? Promise.resolve(waste) : new Promise(() => {}));
    H.api.postJson = (p) => (p === '/tools/waste/spark'
      ? Promise.resolve({ series: { 'vc-m:vm-9': null }, maxVms: 24, authStopped: {}, skippedVcenters: { 'vc-m': { skipReason: 'maintenance', reason: '점검중 vCenter — 수집이 멈춰 있어 이 포탈이 로그인하지 않습니다' } } })
      : new Promise(() => {}));
    const { Waste, Sparkline, SparkNote } = await import('./tools/CapacityTools.jsx');
    const rt = mount(Waste, { scope: '' });
    await flush();
    const dt = all(rt, (e) => e.type === DataTable && e.props.columns.some((c) => c.key === 'spark'))[0];
    expect(dt).toBeTruthy();
    const sparkEl = dt.props.columns.find((c) => c.key === 'spark').render(waste.overAllocated.cpuTop[0]);
    expect(sparkEl.props.skip?.skipReason).toBe('maintenance');
    const cell = html(sparkEl);
    expect(cell).toContain('점검중');
    expect(cell).not.toContain('인증');
    const note = all(rt, (e) => e.type === SparkNote)[0];
    expect(html(note)).toContain('직접 수집하지 않는 vCenter');
    // 순수 칸: 응답 전(요청 안 함)은 사유를 말하지 않는다
    expect(html(React.createElement(Sparkline, { points: undefined, requested: false, skip: { skipReason: 'site' } }))).not.toContain('엣지 위임');
    unmount(rt);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('③ 성능 창 — 409 + skipReason 이면 사유를 말하고 20초 자동 새로고침을 멈춘다', () => {
  it('metricErrorState: skipReason 본문을 skip 으로, 다른 오류는 그대로', async () => {
    const { metricErrorState, metricSkipText, stopsAutoRefresh } = await import('../components/vmMetricsText.js');
    const err = Object.assign(new Error('점검중'), { status: 409, body: { ok: false, skipReason: 'maintenance', reason: '점검중 vCenter — 수집이 멈춰 있어 이 포탈이 로그인하지 않습니다' } });
    const s = metricErrorState(err);
    expect(s.authStopped).toBe(null);
    expect(s.skip).toEqual({ skipReason: 'maintenance', reason: '점검중 vCenter — 수집이 멈춰 있어 이 포탈이 로그인하지 않습니다' });
    expect(stopsAutoRefresh(s)).toBe(true);
    const t = metricSkipText(s.skip);
    expect(t).toContain('점검중');
    expect(t).toContain('자동 갱신');
    expect(t).not.toMatch(/인증 실패|인증 정지/);
    expect(t).not.toContain('`');
    const other = metricErrorState(Object.assign(new Error('SOAP 500'), { status: 502, body: { error: 'x' } }));
    expect(other.skip).toBe(null);
    expect(stopsAutoRefresh(other)).toBe(false);
    expect(metricErrorState({ body: { skipReason: '' } }).skip).toBe(null);
    expect(metricSkipText(null)).toBe('');
  });

  it('MetricModal: skipReason 409 를 받으면 자동 새로고침 타이머를 멈추고(로그인 0 이어도 같은 409 를 20초마다 받지 않는다) 사유를 그린다', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let calls = 0;
    H.api.fetchJson = () => { calls += 1; return Promise.reject(Object.assign(new Error('엣지 위임'), { status: 409, body: { ok: false, skipReason: 'site', reason: '엣지 위임 vCenter — 담당 엣지가 수집하므로 중앙이 직접 로그인하지 않습니다' } })); };
    const { MetricModal } = await import('../components/VmMetrics.jsx');
    const rt = mount(MetricModal, { metricsPath: '/vms/vc-s%3Avm-1/metrics', name: 'vm-1', onClose: () => {} });
    await flush();
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(65_000); await flush();
    expect(calls).toBe(1);
    const texts = all(rt, (e) => e.type === BoldText).map((e) => e.props.text).join('\n');
    expect(texts).toContain('엣지 위임');
    expect(all(rt, (e) => /조회 실패/.test(textOf(e))).length).toBe(0);
    unmount(rt);
  });
});
