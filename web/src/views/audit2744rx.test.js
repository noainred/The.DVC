/**
 * v2.744(회귀 검토 RX) — 후속 수정(FB·FC) 적대적 검토 FX-R2 · FX-R3 웹 회귀.
 *
 * FX-R2 호스트·VM 구성 점검 화면은 판정 목록 화면이다 — '합계' 화면용 문장(notReadNote: '합계에서 뺐습니다 — 합계는 하한')이 아니라
 *   판정 목록 문장(notReadJudgeNote)을 쓰고, 비활성 vCenter 만 있으면 배너를 그리지 않는다(coverage 줄 notReadKpiSub 와 같은 판정).
 *   합계 화면(비용 배분·이전 준비도·코어 라이선스)의 notReadNote 는 바이트 단위로 그대로다.
 * FX-R3 audit2744m 의 '화면이 그 값을 넘긴다' 는 소스 정규식이었다 — 여기서는 화면 컴포넌트 함수를 **실제로 실행**해(작은 훅 실행기 —
 *   audit2744k 와 같은 방식, 자식 컴포넌트는 요소로 남는다) 응답 하나로 그려진 배너·coverage 줄·행 표지 글자를 본다.
 *   조기 return 뒤로 가거나 항상 거짓인 조건 안으로 들어가면 여기서 실패한다.
 *   ⚠ 레이아웃·실제 DOM 은 보지 못한다(Chromium 몫 — 정직 기록). 시각은 Date.now() 를 쓰지 않는다.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const H = vi.hoisted(() => {
  const H = { rt: null, api: {}, tab: {} };
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
    fetchJson: call('fetchJson'), postJson: call('postJson'), putJson: call('putJson'),
    downloadFile: () => Promise.resolve(),
    toolAllowed: () => true, can: () => true, canCsv: () => true, hasRole: () => true,
    getCurrentUser: () => ({ username: 'admin', role: 'admin' }),
  };
});

// 하위 탭 훅은 window.location 을 읽는다(node 환경에 없다) — 시험이 고른 탭을 돌려준다.
vi.mock('../hooks/useHashTab.js', () => ({
  useHashTab: ({ base, fallback }) => [H.tab[base.join('/')] ?? fallback, () => {}],
}));

const { notReadNote, notReadJudgeNote, notReadKpiSub } = await import('./bizreport/notReadText.js');
const { default: HostHygieneTool } = await import('./tools/HostHygieneTool.jsx');
const { default: VmHygieneTool } = await import('./tools/VmHygieneTool.jsx');
const { FleetInventory } = await import('./tools/FleetInventory.jsx');

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
const banners = (rt) => all(rt, (e) => e.type === 'div' && /\bbanner\b/.test(e.props?.className || '')).map(textOf);

const NR = [{ vcenterId: 'vc-u', name: 'VC-U', why: 'unreachable' }, { vcenterId: 'vc-p', name: 'VC-P', why: 'pending' }, { vcenterId: 'vc-o', name: 'VC-O', why: 'disabled' }];
const OFF = [{ vcenterId: 'vc-o', name: 'VC-O', why: 'disabled' }];

const hostResp = (notReadVcenters) => ({
  coverage: { hosts: 2, cfg: 2, notCollected: 0, disconnected: 0 }, byCode: {}, rows: [], vcenters: [], clusters: [], scan: null,
  notReadVcenters, partial: (notReadVcenters || []).some((x) => x.why !== 'disabled'),
});
const vmResp = (notReadVcenters) => ({
  coverage: { vms: 3, cfg: 3, dev: 3, notCollected: 0, templates: 0, excepted: 0 }, byCode: {}, rows: [], vcenters: [],
  notReadVcenters, partial: (notReadVcenters || []).some((x) => x.why !== 'disabled'),
});

beforeEach(() => {
  H.api = { fetchJson: () => new Promise(() => {}), postJson: () => new Promise(() => {}), putJson: () => new Promise(() => {}) };
  H.tab = {};
});

// ─────────────────────────────────────────────────────────────────────────────
describe('FX-R2 판정 목록 문장 — notReadJudgeNote', () => {
  it('합계·0 으로 더함을 말하지 않고, 그 vCenter 의 판정 결과가 목록에 없다고 말한다 · 이름은 읽지 못한 것만, 비활성은 개수', () => {
    const t = notReadJudgeNote(NR, '호스트');
    expect(t).toContain('읽지 못한 vCenter 2곳은 판정하지 않았습니다');
    expect(t).toContain('호스트 판정 결과는 이 목록과 개수에 들어 있지 않습니다');
    expect(t).toContain('문제가 없다는 뜻이 아닙니다');
    expect(t).toContain('‘VC-U’(연결 실패)');
    expect(t).toContain('‘VC-P’(첫 수집 중)');
    expect(t).not.toContain('VC-O');
    expect(t).toContain('비활성 1곳은 원래 수집하지 않습니다');
    expect(t).not.toMatch(/합계|0 으로 더하/);
    expect(notReadJudgeNote(NR, 'VM')).toContain('VM 판정 결과는');
  });
  it('비활성만·없음·모양이 틀린 원소면 빈 문자열(coverage 줄 notReadKpiSub 와 같은 판정)', () => {
    expect(notReadJudgeNote(OFF, '호스트')).toBe('');
    expect(notReadKpiSub(OFF)).toBe('');
    expect(notReadJudgeNote([], '호스트')).toBe('');
    expect(notReadJudgeNote(null, '호스트')).toBe('');
    expect(notReadJudgeNote([null, 'x', 3], 'VM')).toBe('');
    // 두 판정이 같은 기준인지 — 읽지 못한(비활성 아닌) 것이 있을 때만 둘 다 말한다.
    for (const list of [NR, OFF, [NR[0]], [NR[1], NR[2]], []]) expect(!!notReadJudgeNote(list, 'VM')).toBe(!!notReadKpiSub(list));
  });
  it('이름은 5곳까지 적고 나머지는 개수 · 백틱·별표 두 개 없음', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ vcenterId: `v${i}`, name: `N${i}`, why: 'stale' }));
    const t = notReadJudgeNote(many, '호스트');
    expect(t).toContain('‘N4’');
    expect(t).not.toContain('‘N5’');
    expect(t).toContain('외 2곳');
    for (const s of [t, notReadJudgeNote(NR, 'VM')]) { expect(s).not.toMatch(/`/); expect(s).not.toMatch(/\*\*/); }
  });
  it('합계 화면 문장(notReadNote)은 예전 그대로다', () => {
    expect(notReadNote(NR)).toBe('읽지 못한 vCenter 2곳은 합계에서 뺐습니다 — 합계는 하한입니다(0 으로 더하지 않았습니다): ‘VC-U’(연결 실패) · ‘VC-P’(첫 수집 중) · ‘VC-O’(비활성). 비활성 1곳은 원래 수집하지 않습니다.');
    expect(notReadNote(OFF)).toBe('비활성 vCenter 만 합계에서 빠졌습니다: ‘VC-O’(비활성).');
    expect(notReadNote([])).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('FX-R2·R3 화면을 실제로 그린다 — 호스트·VM 구성 점검', () => {
  const cases = [
    { Comp: HostHygieneTool, path: '/tools/host-hygiene', resp: hostResp, noun: '호스트', cov: '호스트 2대 · 구성 읽음 2' },
    { Comp: VmHygieneTool, path: '/tools/vm-hygiene', resp: vmResp, noun: 'VM', cov: 'VM 3대 · 구성 읽음 3 · 장치 읽음 3' },
  ];
  for (const c of cases) {
    it(`${c.path}: 읽지 못한 vCenter 가 있으면 coverage 줄 + 판정 목록 배너(합계 문장 아님)`, async () => {
      H.api.fetchJson = (p) => (p === c.path ? Promise.resolve(c.resp(NR)) : (p.endsWith('/settings') ? Promise.resolve({ settings: null }) : new Promise(() => {})));
      const rt = mount(c.Comp, { scope: '' });
      await flush();
      const texts = all(rt, (e) => e.type === 'div').map(textOf);
      expect(texts).toContain(`${c.cov} · ${notReadKpiSub(NR)}`);
      const b = banners(rt);
      expect(b).toContain(notReadJudgeNote(NR, c.noun));
      expect(b.join('\n')).not.toMatch(/합계/);
      unmount(rt);
    });
    it(`${c.path}: 비활성 vCenter 만 있으면 배너를 그리지 않는다 · coverage 줄도 조용하다`, async () => {
      H.api.fetchJson = (p) => (p === c.path ? Promise.resolve(c.resp(OFF)) : (p.endsWith('/settings') ? Promise.resolve({ settings: null }) : new Promise(() => {})));
      const rt = mount(c.Comp, { scope: '' });
      await flush();
      expect(all(rt, (e) => e.type === 'div').map(textOf)).toContain(c.cov);
      expect(banners(rt).join('\n')).not.toMatch(/vCenter|VC-O|비활성/);
      unmount(rt);
    });
    it(`${c.path}: 읽지 못한 vCenter 가 없는 응답(필드 없음)은 예전 화면 그대로`, async () => {
      H.api.fetchJson = (p) => (p === c.path ? Promise.resolve({ ...c.resp([]), notReadVcenters: undefined }) : (p.endsWith('/settings') ? Promise.resolve({ settings: null }) : new Promise(() => {})));
      const rt = mount(c.Comp, { scope: '' });
      await flush();
      expect(all(rt, (e) => e.type === 'div').map(textOf)).toContain(c.cov);
      expect(banners(rt).join('\n')).not.toMatch(/vCenter/);
      unmount(rt);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
describe('FX-R3 통합 서버 인벤토리 — 등록부 손상으로 직전 목록 유지 중인 엣지(실제로 그린다)', () => {
  const fp = { edges: 2, partialEdges: 0, partials: [], omitted: 0, vcenterBlanked: 0, registryUnreadableEdges: 1, registryUnreadable: [{ agent: 'edge-x', reason: '형식 오류', since: 1, holdExpired: false }] };
  const fleet = (fleetPartials) => ({
    mode: 'central', summary: { bareMetal: 2 }, vcenters: [], virtualizationHosts: [], fleetPartials,
    bareMetal: [
      { serverId: 's1', fleetId: 'f1', name: 'bm-1', remoteAgent: 'edge-x', source: 'edge' },
      { serverId: 's2', fleetId: 'f2', name: 'bm-2', remoteAgent: 'edge-y', source: 'edge' },
    ],
  });
  const heldMarks = (rt) => all(rt, (e) => typeof e.type === 'function' && e.props && 'fp' in e.props && 'agent' in e.props);

  it('각주 한 번 + 그 엣지 행에만 \'직전 목록\' 표지', async () => {
    H.api.fetchJson = (p) => (p === '/insights/fleet' ? Promise.resolve(fleet(fp)) : new Promise(() => {}));
    const rt = mount(FleetInventory, { isAdmin: false });
    await flush();
    const notes = all(rt, (e) => e.type === 'div' && /edge-x/.test(textOf(e)) && /직전 목록/.test(textOf(e)));
    expect(notes.length).toBe(1);
    const marks = heldMarks(rt);
    expect(marks.length).toBe(2);   // 엣지 행마다 표지 자리를 그린다
    const out = marks.map((m) => { const r = m.type(m.props); return r ? textOf(r) : ''; });
    expect(out).toEqual(['직전 목록', '']);   // edge-x 만 표지, edge-y 는 없음
    unmount(rt);
  });
  it('보류 중인 엣지가 없으면 각주도 표지도 없다', async () => {
    H.api.fetchJson = (p) => (p === '/insights/fleet' ? Promise.resolve(fleet({ ...fp, registryUnreadable: [], registryUnreadableEdges: 0 })) : new Promise(() => {}));
    const rt = mount(FleetInventory, { isAdmin: false });
    await flush();
    expect(all(rt, (e) => e.type === 'div' && /직전 목록/.test(textOf(e))).length).toBe(0);
    expect(heldMarks(rt).map((m) => m.type(m.props)).filter(Boolean).length).toBe(0);
    unmount(rt);
  });
});
