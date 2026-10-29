/**
 * v2.741 그룹 GI(웹 화면) — WEB-01 · WEB-02 · WEB-04 · LEFT-09 · LEFT-11 회귀.
 *
 * 컴포넌트는 audit2733k 와 같은 **아주 작은 훅 실행기**로 직접 부른다 — 'react' 훅을 이 파일 안에서만 갈아 끼워
 * 시험할 컴포넌트 함수 하나를 부르고(자식 컴포넌트는 그리지 않는다 — 요소로만 남는다) 효과를 실행하고 setState 로 다시 그린다.
 * 레이아웃·실제 DOM 은 보지 못한다(Chromium 몫).
 *
 *  · WEB-01  Platform '전체 호스트·전체 VM' KPI 와 개요 VM 차트가 첫 수집 중·비활성·연결 실패 vCenter 의 hosts:0·vms:0 을 더하거나 0 막대로 그렸다.
 *  · WEB-02  CSV 수식 가드가 유한 음수·순수 숫자 문자열에도 작은따옴표를 붙여 엑셀에서 텍스트가 됐다(서버 사본과 같은 입력 대조).
 *  · WEB-04  업그레이드·VM 성능 트래킹 설정이 저장 뒤 다시 읽기 실패로 화면 전체를 ErrorBox 로 바꿨다(결과 문구·폼 소실).
 *  · LEFT-09 용량 어드바이저가 서버의 판정 계산 시각(summaryAt)·재계산 중(summaryRefreshing)을 말하지 않았다.
 *  · LEFT-11 GPU 게스트 진단이 vCenter 목록 실패를 삼켰다 · IdracAdmin 이 쓰이지 않는 /admin/vcenters 를 불렀다.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    toolAllowed: () => true, canCsv: () => true, hasRole: () => true, can: () => true,
    getCurrentUser: () => ({ username: 'admin', role: 'admin' }),
  };
});

if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    location: { hash: '' },
    history: { replaceState() {} },
    addEventListener() {}, removeEventListener() {},
    confirm: () => true,
  };
}

const { guardCell, csvCell, toCsv } = await import('../util/csv.js');
const serverCsv = await import('../../../server/src/util/csv.js');
const { corpSiteStatus, countableTotals, corpVmChart, partialNote } = await import('./corpSiteStatus.js');
const { chartGroup } = await import('./execOverviewText.js');
const { ErrorBox } = await import('../components/ui.jsx');

// ── 실행기 도우미(audit2733k 와 같은 모양) ────────────────────────────────────
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
async function flush(n = 30) { for (let k = 0; k < n; k++) await new Promise((r) => realSetImmediate(r)); }
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
const routes = (table) => (path, ...rest) => {
  const p = String(path).split('?')[0];
  const key = Object.keys(table).find((k) => k === path || k === p);
  if (!key) return Promise.resolve({});
  const v = table[key];
  return typeof v === 'function' ? v(path, ...rest) : Promise.resolve(v);
};

beforeEach(() => {
  H.api = {
    usePolling: () => ({ data: null, error: null, errorInfo: null, loading: true }),
    fetchJson: () => new Promise(() => {}),
  };
});

// ── WEB-01 ──────────────────────────────────────────────────────────────────
// 롤업은 첫 수집 중·비활성·이월 값 없는 연결 실패 vCenter 에 hosts:0·vms:0 을 준다 — 그대로 더하면 부분 합이 합계처럼 보인다.
const SITES = [
  { id: 'vc-a', name: 'AZ', status: 'connected', location: { region: 'Asia' }, metrics: { hosts: 4, vms: 20, vmsPoweredOn: 18 } },
  { id: 'vc-b', name: 'AZ-IRS', status: 'connected', location: { region: 'Asia' }, metrics: { hosts: 2, vms: 6, vmsPoweredOn: 5 } },
  { id: 'vc-p', name: 'GM1', status: 'pending', location: { region: 'Europe' }, metrics: { hosts: 0, vms: 0, vmsPoweredOn: 0 } },
  { id: 'vc-d', name: 'HB', status: 'disabled', location: { region: 'Europe' }, metrics: { hosts: 0, vms: 0, vmsPoweredOn: 0 } },
  { id: 'vc-u', name: 'SN', status: 'unreachable', location: { region: 'Europe' }, metrics: { hosts: 0, vms: 0, vmsPoweredOn: 0 } },
  // 연결 실패지만 마지막 정상 값을 이월 중 — 법인 표와 같이 '낡은 값' 으로 센다.
  { id: 'vc-s', name: 'HM-IRS', status: 'unreachable', stale: true, location: { region: 'Asia' }, metrics: { hosts: 3, vms: 9, vmsPoweredOn: 9 } },
];
const isIrs = (s) => /\birs\b/i.test(s.name || '');

describe('WEB-01 countableTotals — 셀 수 있는 vCenter 만 더하고 뺀 곳 수를 밝힌다', () => {
  it('판정은 corpSiteStatus().countable 하나다(법인 표와 같은 기준)', () => {
    const t = countableTotals(SITES, { isIrs });
    const want = SITES.filter((s) => corpSiteStatus(s).countable);
    expect(t.counted).toBe(want.length);
    expect(t.missing).toBe(SITES.length - want.length);
    expect(t.hosts).toBe(4 + 2 + 3);
    expect(t.vms).toBe(20 + 6 + 9);
    expect(t.irsHosts).toBe(2 + 3);
    expect(t.irsVms).toBe(6 + 9);
    expect(t.davinciHosts).toBe(4);
    expect(t.davinciVms).toBe(20);
    expect(t.note).toBe('최소 · 미수집 3곳 제외');
  });
  it('전부 셀 수 있으면 표지가 없다 · 하나도 셀 수 없으면 0 이 아니라 null', () => {
    expect(countableTotals(SITES.slice(0, 2), { isIrs }).note).toBeNull();
    const none = countableTotals(SITES.slice(2, 5), { isIrs });
    expect(none).toMatchObject({ hosts: null, vms: null, irsHosts: null, davinciVms: null, counted: 0, missing: 3 });
    // 등록 0개는 '모른다' 가 아니라 셀 것이 없는 것이다.
    expect(countableTotals([], { isIrs })).toMatchObject({ hosts: 0, vms: 0, missing: 0, note: null });
  });
  it('부분 합 표지 문구(v2.747 — 합계 행 corpTotalLabel 은 V6 셸과 함께 지웠다)', () => {
    expect(partialNote(2)).toBe('최소 · 미수집 2곳 제외');
    expect(partialNote(0)).toBeNull();
  });
});

describe('WEB-01 corpVmChart — 미수집 vCenter 는 0 막대가 아니라 막대 없음(null)', () => {
  it('막대 값·리전 합계·문구', () => {
    const c = corpVmChart(SITES, { groupOf: chartGroup });
    const byName = Object.fromEntries(c.bars.map((b) => [b.name, b]));
    expect(byName['vc-a']).toMatchObject({ VM: 20, On: 18, uncounted: false });
    for (const id of ['vc-p', 'vc-d', 'vc-u']) expect(byName[id]).toMatchObject({ VM: null, On: null, uncounted: true });
    expect(byName['vc-s']).toMatchObject({ VM: 9, On: 9 });
    expect(c.missing).toBe(3);
    const total = Object.values(c.groups).reduce((a, v) => a + v, 0);
    expect(total).toBe(20 + 6 + 9);
    expect(c.note).toContain('미수집 3곳은 막대를 그리지 않았습니다');
    expect(c.pieNote).toContain('미수집 3곳');
    expect(corpVmChart(SITES.slice(0, 2), { groupOf: chartGroup }).note).toBeNull();
  });
});

describe('WEB-01 화면 — Platform KPI 와 개요 차트가 그 판정을 쓴다', () => {
  it('VCenters: 전체 호스트·VM KPI 가 미수집 곳을 더하지 않고 표지를 단다', async () => {
    const { default: VCenters } = await import('./VCenters.jsx');
    H.api.usePolling = (p) => (p === '/vcenters' ? { data: SITES, error: null, loading: false } : { data: null, loading: true });
    const rt = mount(VCenters, {});
    const kpis = all(rt, (e) => e.props?.className === 'card kpi');
    const host = kpis.find((k) => textOf(k).startsWith('전체 호스트'));
    const vm = kpis.find((k) => textOf(k).startsWith('전체 VM'));
    expect(textOf(host)).toContain('전체 호스트9');
    expect(textOf(host)).toContain('다빈치 4개 · IRS 5개');
    expect(textOf(host)).toContain('최소 · 미수집 3곳 제외');
    expect(textOf(vm)).toContain('전체 VM35');
    expect(textOf(vm)).toContain('최소 · 미수집 3곳 제외');
    unmount(rt);
  });
  it('VCenters: 전부 미수집이면 0 이 아니라 —', async () => {
    const { default: VCenters } = await import('./VCenters.jsx');
    H.api.usePolling = (p) => (p === '/vcenters' ? { data: SITES.slice(2, 5), error: null, loading: false } : { data: null, loading: true });
    const rt = mount(VCenters, {});
    const vm = all(rt, (e) => e.props?.className === 'card kpi').find((k) => textOf(k).startsWith('전체 VM'));
    expect(textOf(vm)).toContain('전체 VM—');
    expect(textOf(vm)).not.toMatch(/전체 VM0/);
    unmount(rt);
  });
  it('Overview: VM 분포 막대에 미수집 vCenter 가 0 이 아니라 null 로 실리고 각주가 붙는다', async () => {
    const { default: Overview } = await import('./Overview.jsx');
    const ov = {
      global: { vcenters: SITES.length, vcentersConnected: 2, hosts: 9, vms: 35, datastores: 1, cpuTotalGhz: 1, memTotalGB: 1, storageTotalTB: 1 },
      sites: SITES,
    };
    H.api.usePolling = (p) => (p === '/overview' ? { data: ov, error: null, loading: false } : { data: null, loading: true });
    const rt = mount(Overview, {});
    const charts = all(rt, (e) => Array.isArray(e.props?.data) && e.props.data.some((d) => d && 'VM' in d));
    expect(charts.length).toBe(1);
    const bars = charts[0].props.data;
    expect(bars.find((b) => b.name === 'vc-p').VM).toBeNull();
    expect(bars.find((b) => b.name === 'vc-d').On).toBeNull();
    expect(bars.find((b) => b.name === 'vc-a').VM).toBe(20);
    expect(all(rt, (e) => 'data-partial-note' in (e.props || {})).map(textOf).join(' ')).toContain('미수집 3곳은 막대를 그리지 않았습니다');
    // 리전 파이는 셀 수 있는 vCenter 만 — 합이 35.
    const pie = all(rt, (e) => e.props?.dataKey === 'value' && Array.isArray(e.props?.data))[0];
    expect(pie.props.data.reduce((a, d) => a + d.value, 0)).toBe(35);
    unmount(rt);
  });
});

// ── WEB-02 ──────────────────────────────────────────────────────────────────
describe('WEB-02 CSV 수식 가드 — 유한 숫자·순수 숫자 문자열은 가드하지 않는다', () => {
  it('음수·소수·지수는 숫자 그대로(엑셀이 숫자로 읽는다) — + 로 시작하는 문자열은 가드', () => {
    expect(guardCell(-12.5)).toBe('-12.5');
    expect(guardCell('-12.5')).toBe('-12.5');
    expect(guardCell('+3')).toBe("'+3"); // '+' 로 시작하는 숫자열은 가드(+82… 전화번호 보호)
    expect(guardCell('+821012345678')).toBe("'+821012345678");
    expect(guardCell('-7')).toBe('-7');
    expect(guardCell('1e-3')).toBe('1e-3');
    expect(guardCell(0)).toBe('0');
    expect(csvCell(-3)).toBe('-3');
    expect(toCsv([['delta'], [-4.25]])).toBe('delta\r\n-4.25');
  });
  it('수식 모양 문자열은 계속 가드한다(보안 계약은 그대로)', () => {
    for (const v of ['=1+1', '-2+3', '+1+1', '@SUM(A1)', '\t5', '-cmd|calc', '-.5', '-1,2', '-Infinity', '-12\n', '- 3']) {
      expect(guardCell(v).startsWith("'")).toBe(true);
    }
    expect(guardCell(-Infinity)).toBe("'-Infinity"); // 유한 숫자만 통과한다
  });
  it('서버 사본(server/src/util/csv.js)과 같은 입력에 같은 결과', () => {
    const inputs = [null, undefined, '', 0, -0, 12, -12.5, 1e21, -1e-7, NaN, Infinity, -Infinity, '-12.5', '+3', '1E5', '-1e+5',
      '=1+1', '-2+3', '+1+1', '@x', '\tx', '\rx', '-', '+', '--1', '-0x1A', '0x1A', '1.', '.5', '-.5', '１２', '-１２', 'web-01', '서울-DC', "'-2"];
    for (const v of inputs) expect(serverCsv.guardCell(v)).toBe(guardCell(v));
    // 역함수 쌍 — 옛 파일의 가드('-12.5)도 되돌리고, 새 파일(-12.5)은 그대로 둔다.
    expect(serverCsv.unguardCell("'-12.5")).toBe('-12.5');
    expect(serverCsv.unguardCell(serverCsv.guardCell('-12.5'))).toBe('-12.5');
    expect(serverCsv.unguardCell(serverCsv.guardCell('-2+3'))).toBe('-2+3');
  });
});

// ── WEB-04 ──────────────────────────────────────────────────────────────────
const UP_STATUS = { version: '2.741.0', enabled: true, installDir: '/opt/vmware-portal', pollIntervalMs: 3_600_000, autoApply: false };

describe('WEB-04 업그레이드 — 저장 뒤 다시 읽기 실패가 화면을 지우지 않는다', () => {
  it('순수 판정: 첫 조회 실패만 전체 오류 · 직전 값이 있으면 배너', async () => {
    const { upgradeReloadView } = await import('./Upgrade.jsx');
    expect(upgradeReloadView(null, null)).toEqual({ full: false, banner: null });
    expect(upgradeReloadView(null, new Error('503'))).toEqual({ full: true, banner: null });
    const v = upgradeReloadView(UP_STATUS, new Error('/upgrade/status -> 503'));
    expect(v.full).toBe(false);
    expect(v.banner).toContain('업그레이드 상태를 다시 읽지 못했습니다(/upgrade/status -> 503) — 아래는 직전에 읽은 값입니다');
  });
  it('설정 저장 성공 → 다시 읽기 503: 결과 문구·폼이 남고 배너가 사유를 말한다', async () => {
    const { default: Upgrade } = await import('./Upgrade.jsx');
    let fail = false;
    H.api.fetchJson = (p) => (p === '/upgrade/status'
      ? (fail ? Promise.reject(new Error('/upgrade/status -> 503')) : Promise.resolve(UP_STATUS))
      : Promise.resolve({}));
    H.api.putJson = () => { fail = true; return Promise.resolve({ ok: true }); };
    const rt = mount(Upgrade, {}); await flush();
    const save = btn(rt, (e) => e.props?.onClick && textOf(e).includes('저장'));
    expect(save).toBeTruthy();
    await save.props.onClick(); await flush();
    expect(rt.out?.type).not.toBe(ErrorBox);
    const t = textOf(rt.out);
    expect(t).toContain('시스템 자동 업그레이드');
    expect(t).toContain('업그레이드 상태를 다시 읽지 못했습니다');
    expect(btn(rt, (e) => textOf(e).includes('저장'))).toBeTruthy(); // 폼이 그대로 있다
    unmount(rt);
  });
  it('첫 조회 실패는 화면 전체 오류(직전 값이 없다)', async () => {
    const { default: Upgrade } = await import('./Upgrade.jsx');
    H.api.fetchJson = () => Promise.reject(new Error('/upgrade/status -> 500'));
    const rt = mount(Upgrade, {}); await flush();
    expect(rt.out?.type).toBe(ErrorBox);
    unmount(rt);
  });
});

describe('WEB-04 VM 성능 트래킹 설정 — 저장 뒤 다시 읽기 실패가 카드를 지우지 않는다', () => {
  const D = { settings: { enabled: true, retentionDays: 90, vcenterIds: [], trackTotal: true }, vcenters: [{ id: 'vc-a', name: 'AZ' }], usage: [], totalBytes: 0 };
  it('순수 판정', async () => {
    const { vmPerfReloadView } = await import('./MetricsSettings.jsx');
    expect(vmPerfReloadView(null, new Error('x'))).toEqual({ full: true, banner: null });
    expect(vmPerfReloadView(D, null)).toEqual({ full: false, banner: null });
    expect(vmPerfReloadView(D, new Error('x')).banner).toContain('VM 성능 트래킹 설정을 다시 읽지 못했습니다(x)');
  });
  it('저장 성공 → 다시 읽기 실패: \'저장되었습니다\' 와 폼이 남는다', async () => {
    const { VmPerfTrackingSettings } = await import('./MetricsSettings.jsx');
    let fail = false;
    H.api.fetchJson = (p) => (p === '/tools/waste/settings'
      ? (fail ? Promise.reject(new Error('/tools/waste/settings -> 502')) : Promise.resolve(D))
      : Promise.resolve({}));
    H.api.putJson = () => { fail = true; return Promise.resolve({ ok: true, settings: D.settings }); };
    const rt = mount(VmPerfTrackingSettings, {}); await flush();
    const save = btn(rt, (e) => textOf(e) === '저장');
    expect(save).toBeTruthy();
    await save.props.onClick(); await flush();
    expect(rt.out?.type).not.toBe(ErrorBox);
    const t = textOf(rt.out);
    expect(t).toContain('저장되었습니다');
    expect(t).toContain('VM 성능 트래킹 설정을 다시 읽지 못했습니다');
    unmount(rt);
  });
});

// ── LEFT-09 ─────────────────────────────────────────────────────────────────
describe('LEFT-09 용량 어드바이저 — 판정 계산 시각과 재계산 중을 말한다', () => {
  const NOW = 1_800_000_000_000;
  it('순수 판정: 계산 시각을 모르면 말하지 않는다 · 재계산 중이면 밝힌다', async () => {
    const { summaryCalcNote } = await import('./CapacityAdvisor.jsx');
    expect(summaryCalcNote({ hosts: [] }, NOW)).toBeNull();
    expect(summaryCalcNote({ summaryAt: null }, NOW)).toBeNull();
    expect(summaryCalcNote({ summaryAt: 0 }, NOW)).toBeNull();
    const a = summaryCalcNote({ summaryAt: NOW - 3 * 60_000, summaryTtlMs: 60_000, summaryRefreshing: true }, NOW);
    expect(a.text).toBe('호스트 판정 계산 3분 전 · 지금 다시 계산 중');
    expect(a.title).toContain('최대 60초');
    expect(summaryCalcNote({ summaryAt: NOW - 20_000, summaryTtlMs: 60_000, summaryRefreshing: false }, NOW).text).toBe('호스트 판정 계산 20초 전');
  });
  it('화면: /capacity/summary 응답의 summaryAt·summaryRefreshing 이 호스트 선택 카드에 보인다', async () => {
    const { default: CapacityAdvisor } = await import('./CapacityAdvisor.jsx');
    const summary = { hosts: [{ k: 'local', fresh: true, groups: { cpu: 'ok' }, lastTs: Date.now() }], collectors: [], windows: [],
      summaryAt: Date.now() - 5 * 60_000, summaryTtlMs: 60_000, summaryRefreshing: true };
    H.api.usePolling = (p) => (p === '/capacity/summary' ? { data: summary, error: null, loading: false } : { data: null, loading: true });
    const rt = mount(CapacityAdvisor, {});
    const note = all(rt, (e) => 'data-summary-calc' in (e.props || {}))[0];
    expect(note).toBeTruthy();
    expect(textOf(note)).toBe('호스트 판정 계산 5분 전 · 지금 다시 계산 중');
    unmount(rt);
  });
});

// ── LEFT-11 ─────────────────────────────────────────────────────────────────
describe('LEFT-11 GPU 게스트 진단 — vCenter 목록 실패를 삼키지 않는다', () => {
  it('문구: 읽지 못함 + 드롭다운이 줄어든 이유 · 403 은 권한 문장', async () => {
    const { vcListFailText } = await import('./GpuGuestDiag.jsx');
    expect(vcListFailText(null)).toBeNull();
    expect(vcListFailText(new Error('/vcenters -> 503'))).toBe('vCenter 목록을 읽지 못했습니다(/vcenters -> 503) — 진단 데이터가 있는 vCenter 만 id 로 보입니다(등록된 vCenter 가 없다는 뜻이 아닙니다).');
    const e403 = Object.assign(new Error('forbidden'), { status: 403, name: 'HttpError' });
    expect(vcListFailText(e403)).toContain('볼 권한이 없습니다');
  });
  it('화면: /vcenters 503 이면 드롭다운 아래에 사유 한 줄', async () => {
    const { default: GpuGuestDiag } = await import('./GpuGuestDiag.jsx');
    H.api.fetchJson = routes({
      '/admin/gpu-guest/diag': { local: { at: 1, vcenters: [{ vcId: 'vc-a', counts: {} }] }, agents: [] },
      '/vcenters': () => Promise.reject(new Error('/vcenters -> 503')),
    });
    const rt = mount(GpuGuestDiag, {}); await flush();
    const line = all(rt, (e) => 'data-read-fail' in (e.props || {}))[0];
    expect(line).toBeTruthy();
    expect(textOf(line)).toContain('vCenter 목록을 읽지 못했습니다(/vcenters -> 503)');
    unmount(rt);
  });
  it('화면: 성공하면 그 줄이 없다', async () => {
    const { default: GpuGuestDiag } = await import('./GpuGuestDiag.jsx');
    H.api.fetchJson = routes({
      '/admin/gpu-guest/diag': { local: { at: 1, vcenters: [] }, agents: [] },
      '/vcenters': [{ id: 'vc-a', name: 'AZ' }],
    });
    const rt = mount(GpuGuestDiag, {}); await flush();
    expect(all(rt, (e) => 'data-read-fail' in (e.props || {}))).toHaveLength(0);
    unmount(rt);
  });
});

describe('LEFT-11 IdracAdmin — 쓰이지 않는 vCenter 목록을 부르지 않는다', () => {
  it('진입해도 /admin/vcenters·/vcenters 를 요청하지 않는다', async () => {
    const { default: IdracAdmin } = await import('./IdracAdmin.jsx');
    const calls = [];
    H.api.fetchJson = (p, ...rest) => { calls.push(String(p).split('?')[0]); return routes({})(p, ...rest); };
    const rt = mount(IdracAdmin, {}); await flush();
    expect(calls).toContain('/admin/idrac');
    expect(calls).not.toContain('/admin/vcenters');
    expect(calls).not.toContain('/vcenters');
    unmount(rt);
  });
});
