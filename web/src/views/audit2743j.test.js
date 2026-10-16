/**
 * v2.743(점검 2회차 그룹 GJ) — 웹 회귀.
 *  WEB-01  HAProxy 경로 '지금 점검' 문구 — 성공은 r.ok === true 일 때만 · 개수는 okCount · 대상 0개는 그 사실을 말한다.
 *  WEB-02  사용자 관리 — 계정 행 동작(역할 변경 등) 뒤 load() 가 저장하지 않은 '기능 권한(역할별)' 편집과 경고를 덮지 않는다.
 *          순수 판정(mergeReloadedPerms) + **실제 UserAdmin 화면**(아주 작은 훅 실행기 — audit2731g4b 와 같은 방식)으로 본다.
 *  WEB-04  vCenter 로그 '지금 수집' 문구 — busy·skipped·로그인 거부·수집 실패·수집 대상 아님을 각각 다르게.
 * 레이아웃·실제 DOM 은 보지 못한다(Chromium 몫 — 정직 기록).
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
    fetchJson: call('fetchJson'), postJson: call('postJson'), putJson: call('putJson'), delJson: call('delJson'),
    patchJson: call('patchJson'),
    toolAllowed: () => true, canCsv: () => true, getCurrentUser: () => ({ username: 'admin', role: 'admin' }),
  };
});

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

beforeEach(() => { H.api = { fetchJson: () => new Promise(() => {}) }; });

const BAD_MARKUP = /`|\*\*/;

// ─────────────────────────────── WEB-01 ───────────────────────────────
describe('WEB-01 relayRunText — HAProxy 경로 지금 점검 결과 문구', () => {
  it('정상 0개(전부 실패)도 점검 완료다 — "점검 실패: undefined" 가 아니다', async () => {
    const { relayRunText } = await import('./tools/RelayCheckTool.jsx');
    const t = relayRunText({ ok: true, total: 3, okCount: 0, fail: 3, durationMs: 4200 });
    expect(t).toBe('점검 완료 — 대상 3 · 정상 0 · 실패 3 (4초)');
    expect(t).not.toMatch(/undefined/);
  });
  it('예전 서버처럼 ok 가 숫자(정상 개수)면 성공으로 읽지 않는다 — 성공은 ok === true 뿐', async () => {
    const { relayRunText } = await import('./tools/RelayCheckTool.jsx');
    expect(relayRunText({ ok: 2, total: 3, fail: 1 })).toMatch(/^점검 실패: /);
    expect(relayRunText({ ok: 0, total: 3, fail: 3 })).not.toMatch(/undefined/);
  });
  it('대상 0개는 그 사실을 말한다', async () => {
    const { relayRunText } = await import('./tools/RelayCheckTool.jsx');
    expect(relayRunText({ ok: true, total: 0, okCount: 0, fail: 0 })).toMatch(/점검할 대상이 없습니다/);
    expect(relayRunText({ ok: true, total: 0, okCount: 0, fail: 0, demoOnly: true, skippedNonDemo: 2 })).toMatch(/2개는 점검하지 않았습니다/);
  });
  it('꺼짐·진행 중(ok:false + reason)은 사유를, 사유가 없으면 대체 문구를', async () => {
    const { relayRunText } = await import('./tools/RelayCheckTool.jsx');
    expect(relayRunText({ ok: false, reason: '이전 점검 진행 중(겹침 방지)' })).toBe('점검 실패: 이전 점검 진행 중(겹침 방지)');
    expect(relayRunText({ ok: false })).toBe('점검 실패: 서버가 사유를 주지 않았습니다.');
    expect(relayRunText(null)).toMatch(/^점검 실패: /);
  });
  it('개수를 모르면 — (0 으로 채우지 않는다) · 문구에 백틱·별표 없음', async () => {
    const { relayRunText } = await import('./tools/RelayCheckTool.jsx');
    const t = relayRunText({ ok: true, total: 2 });
    expect(t).toBe('점검 완료 — 대상 2 · 정상 — · 실패 —');
    for (const r of [{ ok: true, total: 2, okCount: 1, fail: 1 }, { ok: true, total: 0 }, { ok: false }]) expect(relayRunText(r)).not.toMatch(BAD_MARKUP);
  });
});

// ─────────────────────────────── WEB-04 ───────────────────────────────
describe('WEB-04 vcLogCollectText — vCenter 로그 지금 수집 결과 문구', () => {
  const fmt = () => 'T';
  it('진행 중(busy)이면 이번 요청으로 수집하지 않았다고 말한다(직전 건수를 이번 결과로 말하지 않는다)', async () => {
    const { vcLogCollectText } = await import('./VcenterLogs.jsx');
    const t = vcLogCollectText({ ok: true, busy: true, runningSince: 1 }, fmt);
    expect(t).toMatch(/진행 중/);
    expect(t).toMatch(/새로 수집하지 않았습니다/);
    expect(t).toMatch(/T 시작/);
    expect(t).not.toMatch(/수집 완료/);
    expect(vcLogCollectText({ ok: true, busy: true }, fmt)).not.toMatch(/시작\)/);
  });
  it('꺼짐(skipped)은 0건 수집이 아니다', async () => {
    const { vcLogCollectText } = await import('./VcenterLogs.jsx');
    const t = vcLogCollectText({ ok: true, at: 1, collected: 0, skipped: true }, fmt);
    expect(t).toMatch(/꺼져 있어 수집하지 않았습니다/);
    expect(t).not.toMatch(/0건/);
  });
  it('정상은 수집 완료 N건, 문제가 있으면 수집 완료라고 하지 않고 각각을 센다', async () => {
    const { vcLogCollectText } = await import('./VcenterLogs.jsx');
    expect(vcLogCollectText({ ok: true, collected: 12 }, fmt)).toBe('수집 완료: 12건 적재');
    const t = vcLogCollectText({ ok: true, collected: 0, authRejected: [{ vcenterId: 'a' }], failed: [{ vcenterId: 'vc-x', error: 'fetch failed' }, { vcenterId: 'vc-y', error: 'e' }], notCollected: [{ vcenterId: 's', why: 'site' }] }, fmt);
    expect(t).toMatch(/^수집 끝\(일부 실패\): 0건 적재/);
    expect(t).toMatch(/로그인 거부 1곳/);
    expect(t).toMatch(/수집 실패 2곳\(vc-x: fetch failed 외\)/);
    expect(t).toMatch(/수집 대상이 아닌 vCenter 1곳/);
    expect(t).not.toMatch(/수집 완료/);
    expect(vcLogCollectText({ ok: true, collected: 0, failed: [], failedOmitted: 3 }, fmt)).toMatch(/수집 실패 3곳/);
    expect(vcLogCollectText({ ok: true, collected: 1, authStopped: ['a', 'b'] }, fmt)).toMatch(/인증 실패로 멈춘 vCenter 2곳 건너뜀/);
  });
  it('건수를 모르면 — · 본문이 아니면 읽지 못했다 · 문구에 백틱·별표 없음', async () => {
    const { vcLogCollectText } = await import('./VcenterLogs.jsx');
    expect(vcLogCollectText({ ok: true, collected: null }, fmt)).toBe('수집 완료: — 적재');
    expect(vcLogCollectText(null, fmt)).toMatch(/읽지 못했습니다/);
    expect(vcLogCollectText({ ok: false, reason: 'x' }, fmt)).toBe('오류: x');
    for (const r of [{ busy: true }, { skipped: true }, { collected: 1, failed: [{ vcenterId: 'a', error: 'b' }] }]) expect(vcLogCollectText(r, fmt)).not.toMatch(BAD_MARKUP);
  });
});

// ─────────────────────────────── WEB-02 ───────────────────────────────
describe('WEB-02 mergeReloadedPerms(순수)', () => {
  const cur = { catalog: [1], matrix: { operator: ['a', 'b'], viewer: ['a'], toolsDenied: { operator: ['t1'], viewer: [] }, adminDenied: ['data.csv'], users: { u1: { mode: 'allow', tools: [] } } } };
  const srv = { catalog: [1, 2], canEditAdminRow: true, matrix: { operator: ['a'], viewer: [], toolsDenied: { operator: [], viewer: [] }, adminDenied: [], users: {} } };
  it('편집이 없으면 서버 값 그대로', async () => {
    const { mergeReloadedPerms } = await import('./userAdmin/permReload.js');
    const m = mergeReloadedPerms(cur, srv, false);
    expect(m.perms).toBe(srv); expect(m.dirty).toBe(false); expect(m.kept).toBe(false);
  });
  it('편집 중이면 역할별 편집 칸만 화면 값을 지키고, 사용자별 재정의·카탈로그는 서버 값', async () => {
    const { mergeReloadedPerms, PERM_EDIT_KEYS } = await import('./userAdmin/permReload.js');
    const m = mergeReloadedPerms(cur, srv, true);
    expect(m.dirty).toBe(true); expect(m.kept).toBe(true);
    for (const k of PERM_EDIT_KEYS) expect(m.perms.matrix[k]).toEqual(cur.matrix[k]);
    expect(m.perms.matrix.users).toEqual({});           // 계정 삭제 등으로 서버에서 바뀐 재정의는 서버 값
    expect(m.perms.catalog).toEqual([1, 2]);
    expect(m.perms.canEditAdminRow).toBe(true);
    expect(srv.matrix.operator).toEqual(['a'], '입력을 바꾸지 않는다');
  });
  it('다시 읽기 실패면 지금 값 그대로 · 지금 값이 없으면 서버 값', async () => {
    const { mergeReloadedPerms } = await import('./userAdmin/permReload.js');
    expect(mergeReloadedPerms(cur, null, true)).toEqual({ perms: cur, dirty: true, kept: false });
    expect(mergeReloadedPerms(null, srv, true).perms).toBe(srv);
  });
  it('PERM_EDIT_KEYS 는 savePerms 가 서버로 보내는 칸과 같다(소스 대조)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { PERM_EDIT_KEYS } = await import('./userAdmin/permReload.js');
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'UserAdmin.jsx'), 'utf8');
    const i = src.indexOf('const savePerms');
    const body = src.slice(i, src.indexOf('};', i));
    for (const k of PERM_EDIT_KEYS) expect(body).toContain(`${k}:`);
  });
});

describe('WEB-02 UserAdmin 화면 — 역할 변경 뒤에도 저장하지 않은 매트릭스 편집과 경고가 남는다', () => {
  const PERMS = () => ({
    catalog: [{ key: 'inv.vms', label: 'VM 목록', group: '인벤토리' }],
    roles: ['admin', 'operator', 'viewer'],
    canEditAdminRow: false,
    matrix: { operator: [], viewer: [], toolsDenied: { operator: [], viewer: [] }, adminDenied: [], users: {} },
  });
  const usersOf = (role) => ({ users: [{ username: 'u1', name: 'U1', role, scope: { vcenters: [], regions: [], writeVcenters: [] } }] });

  it('operator 칸을 켠 뒤 u1 의 역할을 바꿔도(load 재조회) 켠 칸·저장 버튼·경고가 그대로', async () => {
    const { default: UserAdmin } = await import('./UserAdmin.jsx');
    let role = 'viewer'; let userCalls = 0; let permCalls = 0;
    H.api.fetchJson = (p) => {
      if (p === '/admin/users') { userCalls++; return Promise.resolve(usersOf(role)); }
      if (p === '/admin/permissions') { permCalls++; return Promise.resolve(PERMS()); }
      if (p === '/vcenters') return Promise.resolve([]);
      return Promise.resolve({});
    };
    H.api.patchJson = (p, body) => { role = body.role; return Promise.resolve({ ok: true }); };
    const rt = mount(UserAdmin, {});
    await flush();
    const permBoxes = () => all(rt, (e) => e.type === 'input' && e.props.type === 'checkbox' && e.props.readOnly === false);
    expect(permBoxes().length).toBe(2);                       // inv.vms 의 operator·viewer 칸
    expect(permBoxes()[0].props.checked).toBe(false);
    permBoxes()[0].props.onChange();                          // operator 에 inv.vms 켬(저장 안 함)
    await flush();
    expect(permBoxes()[0].props.checked).toBe(true);
    expect(textOf(rt.out)).toContain('변경사항이 저장되지 않았습니다');
    // 계정 행 동작 — 역할 변경 → load() 가 /admin/users·/admin/permissions 를 다시 읽는다
    const roleSel = all(rt, (e) => typeof e.props?.onChange === 'function' && e.props?.value === 'viewer' && e.props?.style?.maxWidth === 130)[0];
    expect(roleSel).toBeTruthy();
    roleSel.props.onChange({ target: { value: 'operator' } });
    await flush();
    expect(userCalls).toBe(2);
    expect(permCalls).toBe(2);
    expect(all(rt, (e) => typeof e.props?.onChange === 'function' && e.props?.value === 'operator' && e.props?.style?.maxWidth === 130).length).toBe(1); // 역할 변경은 반영됐다
    expect(permBoxes()[0].props.checked).toBe(true);          // 저장 안 한 편집은 남는다
    expect(textOf(rt.out)).toContain('변경사항이 저장되지 않았습니다');
    const saveBtn = all(rt, (e) => e.type === 'button' && textOf(e).trim() === '저장')[0];
    expect(saveBtn.props.disabled).toBe(false);
    unmount(rt);
  });

  it('편집이 없으면 다시 읽은 서버 값을 그대로 보인다', async () => {
    const { default: UserAdmin } = await import('./UserAdmin.jsx');
    let n = 0;
    H.api.fetchJson = (p) => {
      if (p === '/admin/users') return Promise.resolve(usersOf('viewer'));
      if (p === '/admin/permissions') { n++; const x = PERMS(); if (n > 1) x.matrix.operator = ['inv.vms']; return Promise.resolve(x); }
      if (p === '/vcenters') return Promise.resolve([]);
      return Promise.resolve({});
    };
    H.api.patchJson = () => Promise.resolve({ ok: true });
    const rt = mount(UserAdmin, {});
    await flush();
    const permBoxes = () => all(rt, (e) => e.type === 'input' && e.props.type === 'checkbox' && e.props.readOnly === false);
    expect(permBoxes()[0].props.checked).toBe(false);
    all(rt, (e) => typeof e.props?.onChange === 'function' && e.props?.value === 'viewer' && e.props?.style?.maxWidth === 130)[0].props.onChange({ target: { value: 'operator' } });
    await flush();
    expect(permBoxes()[0].props.checked).toBe(true);          // 서버가 바뀐 값
    expect(textOf(rt.out)).not.toContain('변경사항이 저장되지 않았습니다');
    unmount(rt);
  });
});
