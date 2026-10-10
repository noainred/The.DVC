/**
 * 점검 3회차(v2.733) 그룹 k — 웹 화면의 '못 읽음을 없음으로'·'실패를 성공으로'·'범위 계정 미적용을 저장됨으로'·레이아웃(C5-01~04).
 *
 * 이 저장소의 웹 테스트는 node 환경(DOM 없음)이라, audit2731g4b 와 같은 **아주 작은 훅 실행기**를 둔다 — 'react' 의 훅을 이 파일
 * 안에서만 갈아 끼워 시험할 컴포넌트 함수 하나를 직접 부르고(자식 컴포넌트는 그리지 않는다 — 요소로만 남는다) 효과를 실행하고
 * setState 로 다시 그린다. 클릭·선택은 요소의 onClick·onChange prop 을 그대로 부른다. 레이아웃·실제 DOM 은 보지 못한다(Chromium 몫).
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
    toolAllowed: () => true, canCsv: () => true, hasRole: () => true, getCurrentUser: () => ({ username: 'admin', role: 'admin' }),
  };
});

// useHashTab(AgentDeploy) 가 window 를 읽는다 — node 환경에는 없으므로 최소한만 둔다.
if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    location: { hash: '' },
    history: { replaceState() {} },
    addEventListener() {}, removeEventListener() {},
    confirm: () => true,
  };
}

const { readFailText, installerState, agentTokSummary, objParticle } = await import('./readFailText.js');
const { scopeSavedText } = await import('./scopeSaveMsg.js');
const { vmCredSaveOutcome } = await import('./gpu-guest/VmCredManager.jsx');

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
const httpErr = (status, message) => Object.assign(new Error(message), { status, name: 'HttpError' });
/** 경로 → 응답 표(함수면 호출 결과). 없는 경로는 빈 객체. */
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

// ── 순수 판정 ───────────────────────────────────────────────────────────────
describe('readFailText — 조회 실패를 0개·없음으로 말하지 않는다(C5-02)', () => {
  it('사유를 싣고 "~라는 뜻이 아닙니다" 를 말한다 · 목적격 조사는 받침으로', () => {
    expect(readFailText('저장된 배포 대상 목록', new Error('/admin/agent-deploy/targets -> 503'), { notMeaning: '대상이 없다는 뜻이 아닙니다' }))
      .toBe('저장된 배포 대상 목록을 읽지 못했습니다(/admin/agent-deploy/targets -> 503) — 대상이 없다는 뜻이 아닙니다.');
    expect(objParticle('수신 통계')).toBe('를');
    expect(objParticle('vCenter 목록')).toBe('을');
    expect(objParticle('vCenter')).toBe('을(를)');
  });
  it('직전 값이 있으면 그 사실을 · 403 은 권한 문장 · 오류가 없으면 null', () => {
    expect(readFailText('수신 통계', new Error('x'), { stale: true })).toContain('다시 읽지 못했습니다(x) — 아래는 직전에 읽은 값입니다');
    expect(readFailText('개별 토큰 발급 현황', httpErr(403, 'forbidden'))).toContain('볼 권한이 없습니다(forbidden)');
    expect(readFailText('수신 통계', null)).toBeNull();
    expect(readFailText('수신 통계', {})).toContain('사유를 읽지 못한 오류입니다');
  });
  it('installerState — 실패는 unknown(배포는 서버가 판정) · 서버가 없다고 하면 missing', () => {
    expect(installerState(null, new Error('503'))).toMatchObject({ kind: 'unknown', canDeploy: true });
    expect(installerState(null, new Error('503')).text).toContain('패키지가 없다는 뜻이 아닙니다');
    expect(installerState(null, new Error('503')).text).not.toContain('찾을 수 없습니다');
    expect(installerState({ available: false }, null)).toMatchObject({ kind: 'missing', canDeploy: false });
    expect(installerState({ available: true, name: 'a.tgz', sizeBytes: 1 }, new Error('x'))).toMatchObject({ kind: 'ok', canDeploy: true });
    expect(installerState(null, null)).toMatchObject({ kind: 'loading', canDeploy: false });
  });
  it('agentTokSummary — 못 읽으면 개수를 말하지 않는다 · 직전 값이 있으면 그 개수 + 다시 읽지 못함', () => {
    expect(agentTokSummary(null, new Error('503'))).toBe('발급 현황을 읽지 못함');
    expect(agentTokSummary(null, new Error('503'))).not.toMatch(/0개/);
    expect(agentTokSummary(null, null)).toBe('불러오는 중…');
    expect(agentTokSummary({ tokens: [{}, {}], auth: { uses: 3 } }, null)).toBe('2개 발급 · 공유 토큰 사용 3회');
    expect(agentTokSummary({ tokens: [{}] }, new Error('x'))).toBe('1개 발급 · 다시 읽지 못함(직전 값)');
  });
});

describe('scopeSavedText — 범위 계정의 전역 값 미적용을 "저장됨·즉시 적용" 으로 말하지 않는다(C5-03)', () => {
  const scoped = { ok: true, settings: {}, ignoredGlobal: ['gpuUtilIntervalSec'], ignoredReason: '전 법인 공용 값은 전체 범위 계정만 바꿀 수 있습니다 — 적용하지 않았습니다.' };
  it('경고가 있으면 적용 주장(즉시 적용)을 붙이지 않고 형제 화면과 같은 경고 문장을 쓴다', () => {
    const o = scopeSavedText(scoped, '저장되었습니다.', ' 새 주기가 즉시 적용됩니다.');
    expect(o.partial).toBe(true);
    expect(o.text).not.toContain('즉시 적용');
    expect(o.text).toContain('⚠ 일부는 적용되지 않았습니다');
    expect(o.text).toContain('적용하지 않은 항목: gpuUtilIntervalSec');
  });
  it('경고가 없으면 예전 문장 그대로', () => {
    expect(scopeSavedText({ ok: true, settings: {} }, '저장되었습니다.', ' 새 주기가 즉시 적용됩니다.')).toEqual({ text: '저장되었습니다. 새 주기가 즉시 적용됩니다.', partial: false });
  });
});

describe('vmCredSaveOutcome — 서버 거부를 성공으로 읽지 않는다(C5-01)', () => {
  it('400 { ok:false, reason, rejected } → 실패 + 사유 + 거부된 IP + 입력 유지 안내', () => {
    const o = vmCredSaveOutcome({ ok: false, reason: '고정 IP 1개가 그 VM 이 보고한 IP 가 아닙니다', rejected: [{ vmId: 'vm1', ip: '10.0.0.9' }] }, {});
    expect(o.ok).toBe(false);
    expect(o.text).toContain('저장하지 못했습니다 — 고정 IP 1개가 그 VM 이 보고한 IP 가 아닙니다');
    expect(o.text).toContain('거부된 IP: 10.0.0.9');
    expect(o.text).toContain('입력한 값은 그대로 두었습니다');
  });
  it('성공 + 비밀번호 폐기 → 저장 문장 뒤에 폐기 안내', () => {
    const o = vmCredSaveOutcome({ ok: true, droppedSecrets: ['password'] }, {});
    expect(o.ok).toBe(true);
    expect(o.text).toContain('VM별 계정을 저장했습니다');
    expect(o.text).toContain('비밀번호을(를) 폐기했습니다');
  });
  it('범위 계정이 보낸 collectMethod 는 적용되지 않았으므로 "auto 로 바꿔 켰습니다" 라고 말하지 않는다', () => {
    const o = vmCredSaveOutcome({ ok: true, ignoredGlobal: ['collectMethod'], ignoredReason: 'r' }, { bumpToAuto: true });
    expect(o.bumped).toBe(false);
    expect(o.text).not.toContain('바꿔 켰습니다');
    expect(o.text).toContain('⚠ 일부는 적용되지 않았습니다');
    expect(vmCredSaveOutcome({ ok: true }, { bumpToAuto: true }).bumped).toBe(true);
  });
});

// ── C5-01 VM별 계정 저장 ─────────────────────────────────────────────────────
describe('C5-01 VmCredManager — 저장 400 은 사유를 말하고 입력을 지우지 않는다 · 성공 문구는 다시 읽은 뒤에도 남는다', () => {
  const VMS = { vms: [{ id: 'vc1:vm-1', name: 'gpu-vm-1', host: 'esx-1', powerState: 'POWERED_ON', toolsStatus: 'RUNNING', guestOS: 'Ubuntu', ipAddresses: ['10.0.0.5', '10.0.0.6'] }] };
  const open = async (putImpl, vmsImpl) => {
    const { VmCredManager } = await import('./gpu-guest/VmCredManager.jsx');
    let vmCalls = 0;
    H.api.fetchJson = (path) => {
      if (String(path).startsWith('/admin/gpu-guest/vms')) { vmCalls++; return vmsImpl ? vmsImpl(vmCalls) : Promise.resolve(structuredClone(VMS)); }
      return Promise.resolve({});
    };
    H.api.putJson = putImpl;
    const rt = mount(VmCredManager, { vcs: [{ id: 'vc1', name: 'VC1' }], vcenters: {}, collectMethod: 'auto', onSavedShared: () => {}, deployAgent: '' });
    await flush();
    const pick = all(rt, (e) => typeof e.props?.onChange === 'function' && textOf(e).includes('법인(vCenter) 선택'))[0];
    pick.props.onChange({ target: { value: 'vc1' } }); await flush();
    return { rt, vmCalls: () => vmCalls };
  };
  const ipSelect = (rt) => all(rt, (e) => typeof e.props?.title === 'string' && e.props.title.startsWith('SSH 접속에 사용할 IP'))[0];

  it('고정 IP 를 고르고 저장 → 서버 400 → 오류 + 사유가 보이고, 고른 IP 가 그대로이며, 목록을 다시 읽지 않는다', async () => {
    const { rt, vmCalls } = await open(() => Promise.resolve({ ok: false, reason: '고정 IP 1개가 그 VM 이 보고한 IP 가 아닙니다 — 저장 자격증명을 VM 이 보고한 적 없는 주소로 보내지 않습니다(VM 의 알려진 IP 중에서 고르세요).', rejected: [{ vmId: 'vc1:vm-1', ip: '10.0.0.6' }] }));
    expect(vmCalls()).toBe(1);
    ipSelect(rt).props.onChange({ target: { value: '10.0.0.6' } }); await flush();
    btn(rt, (e) => textOf(e) === 'VM별 계정 저장').props.onClick(); await flush();
    const t = textOf(rt.out);
    expect(t).toContain('저장하지 못했습니다');
    expect(t).toContain('고정 IP 1개가 그 VM 이 보고한 IP 가 아닙니다');
    expect(ipSelect(rt).props.value, '고른 IP 가 사라졌다(다시 읽어 덮었다)').toBe('10.0.0.6');
    expect(vmCalls(), '거부된 저장 뒤에 목록을 다시 읽었다').toBe(1);
    unmount(rt);
  });

  it('저장 200 + 비밀번호 폐기 → 다시 읽은 뒤에도 "저장했습니다"·폐기 안내가 남는다', async () => {
    const { rt, vmCalls } = await open(() => Promise.resolve({ ok: true, droppedSecrets: ['password'] }));
    btn(rt, (e) => textOf(e) === 'VM별 계정 저장').props.onClick(); await flush();
    expect(vmCalls()).toBe(2); // 성공이면 다시 읽는다
    const t = textOf(rt.out);
    expect(t).toContain('VM별 계정을 저장했습니다');
    expect(t).toContain('폐기했습니다');
    unmount(rt);
  });

  it('저장은 됐는데 다시 읽기가 실패하면 저장 사실 + 다시 읽기 실패를 함께 말한다', async () => {
    const { rt } = await open(() => Promise.resolve({ ok: true }), (n) => (n === 1 ? Promise.resolve(structuredClone(VMS)) : Promise.reject(new Error('/admin/gpu-guest/vms -> 503'))));
    btn(rt, (e) => textOf(e) === 'VM별 계정 저장').props.onClick(); await flush();
    const t = textOf(rt.out);
    expect(t).toContain('VM별 계정을 저장했습니다');
    expect(t).toContain('VM 목록을 다시 불러오지 못했습니다');
    unmount(rt);
  });

  it('VM 목록 조회 실패 문구가 화면에 보인다(행이 없어도)', async () => {
    const { rt } = await open(() => Promise.resolve({ ok: true }), () => Promise.reject(new Error('/admin/gpu-guest/vms -> 503')));
    expect(textOf(rt.out)).toContain('오류: VM 목록을 불러오지 못했습니다');
    unmount(rt);
  });
});

// ── C5-02 조회 실패를 '0개·없음' 으로 ─────────────────────────────────────────
describe('C5-02 Edge 설치 — 대상·설치 패키지 조회 실패', () => {
  const base = {
    '/admin/packages': {}, '/admin/central-token': {}, '/admin/agent-deploy/defaults': {},
    '/admin/vcenters': { vcenters: [] }, '/admin/datacenters': { datacenters: [] },
  };
  it('대상 조회 503 → "(0)"·"저장된 대상이 없습니다" 가 아니라 읽지 못했다 + 다시 읽기', async () => {
    const { default: AgentDeploy } = await import('./AgentDeploy.jsx');
    window.location.hash = '#/settings/agent-deploy/status';
    H.api.fetchJson = routes({ ...base, '/admin/agent-deploy/installer': { available: true, name: 'p.tgz', sizeBytes: 1048576 }, '/admin/agent-deploy/targets': () => Promise.reject(new Error('/admin/agent-deploy/targets -> 503')) });
    const rt = mount(AgentDeploy, {}); await flush();
    const t = textOf(rt.out);
    expect(t).not.toContain('저장된 대상 (0)');
    expect(t).not.toContain('저장된 대상이 없습니다');
    expect(t).toContain('저장된 배포 대상 목록을 읽지 못했습니다');
    expect(t).toContain('대상이 없다는 뜻이 아닙니다');
    expect(btn(rt, (e) => textOf(e) === '다시 읽기')).toBeTruthy();
    unmount(rt);
  });
  it('설치 패키지 조회 503 → "찾을 수 없습니다"(틀린 원인)가 아니고 배포 버튼을 잠그지 않는다', async () => {
    const { default: AgentDeploy } = await import('./AgentDeploy.jsx');
    window.location.hash = '#/settings/agent-deploy/add';
    H.api.fetchJson = routes({ ...base, '/admin/agent-deploy/targets': { targets: [] }, '/admin/agent-deploy/installer': () => Promise.reject(new Error('/admin/agent-deploy/installer -> 503')) });
    const rt = mount(AgentDeploy, {}); await flush();
    const t = textOf(rt.out);
    expect(t).not.toContain('설치 패키지를 찾을 수 없습니다');
    expect(t).toContain('설치 패키지 상태를 읽지 못했습니다');
    // host 를 넣으면 배포 버튼이 열린다(설치 패키지 판정은 서버가 한다)
    const hostInput = all(rt, (e) => e.type === 'input' && e.props.placeholder === '10.30.0.21')[0];
    hostInput.props.onChange({ target: { value: '10.30.0.21', type: 'text' } }); await flush();
    expect(btn(rt, (e) => textOf(e) === '배포 + 설치').props.disabled).toBe(false);
    unmount(rt);
  });
  it('서버가 패키지가 없다고 하면(available:false) 예전 문구와 잠금 그대로', async () => {
    const { default: AgentDeploy } = await import('./AgentDeploy.jsx');
    window.location.hash = '#/settings/agent-deploy/add';
    H.api.fetchJson = routes({ ...base, '/admin/agent-deploy/targets': { targets: [] }, '/admin/agent-deploy/installer': { available: false } });
    const rt = mount(AgentDeploy, {}); await flush();
    expect(textOf(rt.out)).toContain('설치 패키지를 찾을 수 없습니다');
    const hostInput = all(rt, (e) => e.type === 'input' && e.props.placeholder === '10.30.0.21')[0];
    hostInput.props.onChange({ target: { value: '10.30.0.21', type: 'text' } }); await flush();
    expect(btn(rt, (e) => textOf(e) === '배포 + 설치').props.disabled).toBe(true);
    unmount(rt);
  });
});

describe('C5-02 수집 서버 — 수신 통계·개별 토큰 조회 실패', () => {
  const base = { '/admin/collectors': { collectors: [], transport: null }, '/health': { version: '2.733.0' }, '/admin/datacenters': { datacenters: [] } };
  it('수신 통계 503 → "아직 수신된 push가 없습니다" 가 아니라 읽지 못했다', async () => {
    const { default: Collectors } = await import('./Collectors.jsx');
    H.api.fetchJson = routes({ ...base, '/admin/central/agent-tokens': { tokens: [], auth: {} }, '/admin/central/ingest-stats': () => Promise.reject(new Error('/admin/central/ingest-stats -> 503')) });
    const rt = mount(Collectors, {}); await flush();
    const ing = all(rt, (e) => typeof e.type === 'function' && e.type.name === 'IngestStats')[0];
    expect(ing, 'IngestStats 요소').toBeTruthy();
    const sub = mount(ing.type, ing.props); await flush();
    const t = textOf(sub.out);
    expect(t).not.toContain('아직 수신된 push가 없습니다');
    expect(t).toContain('수신 통계를 읽지 못했습니다');
    unmount(sub); unmount(rt);
  });
  it('개별 토큰 503 → "(0개 발급" 이 아니라 "발급 현황을 읽지 못함" + 사유', async () => {
    const { default: Collectors } = await import('./Collectors.jsx');
    H.api.fetchJson = routes({ ...base, '/admin/central/ingest-stats': { rows: [] }, '/admin/central/agent-tokens': () => Promise.reject(new Error('/admin/central/agent-tokens -> 503')) });
    const rt = mount(Collectors, {}); await flush();
    const t = textOf(rt.out);
    expect(t).not.toMatch(/\(0개 발급/);
    expect(t).toContain('발급 현황을 읽지 못함');
    expect(t).toContain('개별 토큰 발급 현황을 읽지 못했습니다');
    unmount(rt);
  });
});

describe('C5-02 GPU 게스트 설정 — vCenter 목록 조회 실패', () => {
  it('vCenter 목록 503 → "등록된 vCenter가 없습니다" 가 아니라 읽지 못했다', async () => {
    const { default: GpuGuestSettings } = await import('./GpuGuestSettings.jsx');
    H.api.fetchJson = routes({
      '/admin/gpu-guest/settings': { settings: { enabled: false, vcenters: {} }, status: {} },
      '/admin/gpu-guest/deploy/agents': { agents: [] },
      '/admin/vcenters': () => Promise.reject(new Error('/admin/vcenters -> 503')),
    });
    const rt = mount(GpuGuestSettings, {}); await flush();
    const t = textOf(rt.out);
    expect(t).not.toContain('등록된 vCenter가 없습니다');
    expect(t).toContain('vCenter 목록을 읽지 못했습니다');
    expect(t).toContain('등록된 vCenter 가 없다는 뜻이 아닙니다');
    unmount(rt);
  });
});

describe('C5-02 VM 생성 — 원본 목록 조회 실패', () => {
  it('원본 503 → "0개 일치"·"일치하는 템플릿/VM이 없습니다" 가 아니라 읽지 못했다', async () => {
    const { default: VmProvision } = await import('./VmProvision.jsx');
    H.api.usePolling = (path) => (path === '/vcenters' ? { data: [{ id: 'vc1', name: 'VC1' }], error: null, loading: false } : { data: null, loading: true });
    H.api.fetchJson = routes({
      '/provision/placement': {},
      '/provision/sources': () => Promise.reject(new Error('/provision/sources -> 503')),
    });
    H.api.postJson = () => Promise.resolve({ count: 0 });
    const rt = mount(VmProvision, {});
    await new Promise((r) => setTimeout(r, 320)); // 원본 조회는 250ms 디바운스
    await flush();
    const t = textOf(rt.out);
    expect(t).not.toContain('0개 일치');
    expect(t).not.toContain('일치하는 템플릿/VM이 없습니다');
    expect(t).toContain('복제할 원본(템플릿/VM) 목록을 읽지 못했습니다');
    unmount(rt);
  });
});

// ── C5-03 범위 계정 저장 ─────────────────────────────────────────────────────
describe('C5-03 범위 계정 저장 응답(ignoredGlobal)을 화면이 말한다', () => {
  const REASON = '전 법인 공용 값은 전체 범위 계정만 바꿀 수 있습니다 — 적용하지 않았습니다.';
  const metrics = { settings: { sampleIntervalMs: 60000, retentionDays: 1830, rawRetentionDays: 0, gpuUtilEnabled: true, gpuUtilIntervalSec: 60 }, status: {}, limits: { minIntervalMs: 10000, maxIntervalMs: 86400000 } };
  it('지표 수집 주기 — "새 주기가 즉시 적용됩니다" 대신 미적용 경고', async () => {
    const { default: MetricsSettings } = await import('./MetricsSettings.jsx');
    H.api.fetchJson = routes({ '/admin/metrics/settings': structuredClone(metrics) });
    H.api.putJson = (path, body) => Promise.resolve({ ok: true, ...structuredClone(metrics), ignoredGlobal: Object.keys(body).filter((k) => body[k] !== undefined), ignoredReason: REASON });
    const rt = mount(MetricsSettings, {}); await flush();
    btn(rt, (e) => textOf(e) === '저장').props.onClick(); await flush();
    const t = textOf(rt.out);
    expect(t).not.toContain('즉시 적용됩니다');
    expect(t).toContain('⚠ 일부는 적용되지 않았습니다');
    unmount(rt);
  });
  it('GPU 사용량 수집 — 같은 규칙', async () => {
    const { default: GpuSettings } = await import('./GpuSettings.jsx');
    H.api.fetchJson = routes({ '/admin/metrics/settings': structuredClone(metrics) });
    H.api.putJson = () => Promise.resolve({ ok: true, ...structuredClone(metrics), ignoredGlobal: ['gpuUtilEnabled', 'gpuUtilIntervalSec'], ignoredReason: REASON });
    const rt = mount(GpuSettings, {}); await flush();
    btn(rt, (e) => textOf(e) === '저장').props.onClick(); await flush();
    const t = textOf(rt.out);
    expect(t).not.toContain('즉시 적용됩니다');
    expect(t).toContain('적용하지 않은 항목: gpuUtilEnabled, gpuUtilIntervalSec');
    unmount(rt);
  });
  it('전원 꺼짐 점검 — "저장됨 — N시간마다 점검(…적용)" 만 말하지 않는다', async () => {
    const { default: PowerOffCheckSettings } = await import('./PowerOffCheckSettings.jsx');
    const cur = { ok: true, settings: { enabled: true, intervalHours: 6 }, limits: { minHours: 1, maxHours: 168 } };
    H.api.fetchJson = routes({ '/tools/waste/off-check': structuredClone(cur) });
    H.api.putJson = () => Promise.resolve({ ok: true, settings: { enabled: true, intervalHours: 6 }, ignoredGlobal: ['enabled', 'intervalHours'], ignoredReason: REASON });
    const rt = mount(PowerOffCheckSettings, {}); await flush();
    btn(rt, (e) => textOf(e) === '저장').props.onClick(); await flush();
    const t = textOf(rt.out);
    expect(t).not.toContain('다음 틱부터 적용');
    expect(t).toContain('⚠ 일부는 적용되지 않았습니다');
    unmount(rt);
  });
  it('게스트 디스크 — 응답을 읽어 미적용을 말한다(예전엔 조용히 되돌아갔다)', async () => {
    const { default: GuestDiskReport } = await import('./tools/GuestDiskReport.jsx');
    const data = { rows: [], vmCount: 0, settings: { enabled: false, intervalHours: 12 }, poller: {}, db: {}, clusters: [] };
    H.api.fetchJson = routes({ '/tools/guest-disk': structuredClone(data) });
    let puts = 0;
    H.api.putJson = () => { puts++; return Promise.resolve({ ok: true, settings: { enabled: false, intervalHours: 12 }, ignoredGlobal: ['enabled', 'intervalHours'], ignoredReason: REASON }); };
    const rt = mount(GuestDiskReport, {}); await flush();
    const save = btn(rt, (e) => textOf(e) === '저장');
    expect(save, '설정 저장 버튼').toBeTruthy();
    save.props.onClick(); await flush();
    expect(puts).toBe(1);
    const t = textOf(rt.out);
    expect(t).toContain('⚠ 일부는 적용되지 않았습니다');
    expect(t).toContain('적용하지 않은 항목: enabled, intervalHours');
    unmount(rt);
  });
});

// ── C5-04 레이아웃 ─────────────────────────────────────────────────────────
describe('C5-04 로그 분석 — "유형" 입력칸이 110px 라벨 밖으로 넘치지 않는다', () => {
  it('유형 입력칸은 최소폭을 풀고(minWidth 0) 라벨 폭을 채운다', async () => {
    const { default: AnalyzeTab } = await import('./svcmon/AnalyzeTab.jsx');
    H.api.fetchJson = routes({ '/svcmon/log/windows': { files: [] } });
    const rt = mount(AnalyzeTab, {}); await flush();
    const inp = all(rt, (e) => e.type === 'input' && e.props.placeholder === 'ping/tcp…')[0];
    expect(inp).toBeTruthy();
    expect(inp.props.style?.minWidth).toBe(0);
    expect(inp.props.style?.width).toBe('100%');
    unmount(rt);
  });
});
