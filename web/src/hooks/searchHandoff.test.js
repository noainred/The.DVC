import { describe, it, expect } from 'vitest';
import { handoffSearch, takeSearch } from './searchHandoff.js';

describe('검색어 인계', () => {
  it('받는 화면이 1회 꺼내고 지운다', () => {
    handoffSearch('ipam', ' 10.0.0.5 ', 1000);
    expect(takeSearch('serial-lookup', 1000)).toBe('');
    expect(takeSearch('ipam', 1000)).toBe('10.0.0.5');
    expect(takeSearch('ipam', 1000)).toBe('');
  });
  it('30초가 지나면 버린다', () => {
    handoffSearch('ipam', 'x', 0);
    expect(takeSearch('ipam', 31_000)).toBe('');
  });
  it('빈 검색어는 남기지 않는다', () => {
    handoffSearch('ipam', '   ', 0);
    expect(takeSearch('ipam', 0)).toBe('');
  });
});

describe('v2.617 — 이미 열린 화면도 즉시 받는다', async () => {
  const { onSearchHandoff } = await import('./searchHandoff.js');
  it('구독자가 받으면 지워져 30초 잔류가 없다', () => {
    const got = [];
    const off = onSearchHandoff((t) => { if (t === 'ipam') got.push(takeSearch('ipam', 1000)); });
    handoffSearch('ipam', '10.1.1.1', 1000);
    expect(got).toEqual(['10.1.1.1']);
    expect(takeSearch('ipam', 1000)).toBe('');
    off();
    handoffSearch('ipam', 'y', 1000);
    expect(got).toHaveLength(1);
    expect(takeSearch('ipam', 1000)).toBe('y');
  });
  it('구독자 오류가 보내는 쪽을 막지 않는다', () => {
    const off = onSearchHandoff(() => { throw new Error('x'); });
    expect(() => handoffSearch('serial-lookup', 'z', 1000)).not.toThrow();
    off();
    expect(takeSearch('serial-lookup', 1000)).toBe('z');
  });
});

describe('v2.911 — 한 이동에 검색어 + 고른 장비를 함께', async () => {
  const { handoffMany, onSearchHandoff } = await import('./searchHandoff.js');
  it('target 별로 남고 각자 꺼낸다 · 새로 남기면 이전 묶음은 버린다', () => {
    handoffMany([['storage-mon', 'PMAX-1'], ['storage-mon:focus', 'st-1']], 1000);
    expect(takeSearch('storage-mon:focus', 1000)).toBe('st-1');
    expect(takeSearch('storage-mon', 1000)).toBe('PMAX-1');
    handoffMany([['cvp', 'a'], ['cvp:focus', 'b']], 1000);
    handoffSearch('ipam', '10.0.0.1', 1000);
    expect(takeSearch('cvp', 1000)).toBe('');
    expect(takeSearch('cvp:focus', 1000)).toBe('');
    expect(takeSearch('ipam', 1000)).toBe('10.0.0.1');
  });
  it('이미 열린 화면이 앞의 것을 받아도 뒤의 것은 남는다(앱 상단 필터 + 화면 상세)', () => {
    const off = onSearchHandoff((t) => { if (t === 'datastores') takeSearch('datastores', 1000); });
    handoffMany([['datastores', 'ds-1'], ['datastores:focus', 'vc:ds-1']], 1000);
    off();
    expect(takeSearch('datastores', 1000)).toBe('');
    expect(takeSearch('datastores:focus', 1000)).toBe('vc:ds-1');
  });
});

// v2.927(A5): 새 탭 인계 — localStorage 일회용 칸 + 창 이름(주소에는 싣지 않는다).
import { stashForNewTab, consumeNewTabHandoff, NEWTAB_KEY, NEWTAB_PREFIX, NEWTAB_TTL_MS } from './searchHandoff.js';

function memStorage() {
  const m = new Map();
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _m: m,
  };
}
const NONCE = '0123456789abcdef';

describe('새 탭 인계(v2.927)', () => {
  it('남긴 칸을 새 탭이 한 번 꺼내 메모리 인계로 옮기고 칸 · 창 이름을 지운다', () => {
    const st = memStorage();
    const name = stashForNewTab([['storage-mon', 'unity-01'], ['storage-mon:focus', 'st-7']], { storage: st, now: 1000, nonce: NONCE });
    expect(name).toBe(NEWTAB_PREFIX + NONCE);
    expect(st.getItem(NEWTAB_KEY + NONCE)).toBeTruthy();
    const win = { name };
    expect(consumeNewTabHandoff({ win, storage: st, now: 2000 })).toBe(true);
    expect(win.name).toBe('');
    expect(st.getItem(NEWTAB_KEY + NONCE)).toBe(null);
    expect(takeSearch('storage-mon', 2000)).toBe('unity-01');
    expect(takeSearch('storage-mon:focus', 2000)).toBe('st-7');
    // 두 번째 시작(새로 고침)에는 아무것도 없다
    expect(consumeNewTabHandoff({ win: { name }, storage: st, now: 2100 })).toBe(false);
  });
  it('넘길 것이 없거나 번호가 이상하면 칸을 만들지 않는다', () => {
    const st = memStorage();
    expect(stashForNewTab([], { storage: st, now: 0, nonce: NONCE })).toBe('');
    expect(stashForNewTab([['ipam', '10.0.0.5']], { storage: st, now: 0, nonce: 'xyz' })).toBe('');
    expect(st.length).toBe(0);
  });
  it('60초가 지난 칸은 버리고, 다음에 남길 때 낡은 칸을 치운다', () => {
    const st = memStorage();
    const name = stashForNewTab([['ipam', '10.0.0.5']], { storage: st, now: 0, nonce: NONCE });
    expect(consumeNewTabHandoff({ win: { name }, storage: st, now: NEWTAB_TTL_MS + 1 })).toBe(false);
    expect(takeSearch('ipam', NEWTAB_TTL_MS + 1)).toBe('');
    st.setItem(NEWTAB_KEY + 'aaaaaaaaaaaaaaaa', JSON.stringify({ e: [['ipam', 'x']], at: 0 }));
    stashForNewTab([['ipam', 'y']], { storage: st, now: NEWTAB_TTL_MS + 5, nonce: 'bbbbbbbbbbbbbbbb' });
    expect(st.getItem(NEWTAB_KEY + 'aaaaaaaaaaaaaaaa')).toBe(null);
    expect(st.getItem(NEWTAB_KEY + 'bbbbbbbbbbbbbbbb')).toBeTruthy();
  });
  it('우리 접두가 아닌 창 이름 · 형식이 다른 번호 · 손댄 값은 무시하거나 다시 자른다', () => {
    const st = memStorage();
    const w1 = { name: 'other-window' };
    expect(consumeNewTabHandoff({ win: w1, storage: st, now: 0 })).toBe(false);
    expect(w1.name).toBe('other-window'); // 남의 창 이름은 건드리지 않는다
    expect(consumeNewTabHandoff({ win: { name: NEWTAB_PREFIX + '../x' }, storage: st, now: 0 })).toBe(false);
    st.setItem(NEWTAB_KEY + NONCE, JSON.stringify({ e: [['ipam', 'z'.repeat(5000)], 'bad', ['a', 'b'], ['c', 'd'], ['e', 'f'], ['g', 'h']], at: 0 }));
    expect(consumeNewTabHandoff({ win: { name: NEWTAB_PREFIX + NONCE }, storage: st, now: 10 })).toBe(true);
    expect(takeSearch('ipam', 10)).toHaveLength(200);
    expect(takeSearch('g', 10)).toBe(''); // 4칸까지만
  });
  it('저장소가 막혀 있으면 빈 이름(주소만 연다)', () => {
    const st = { length: 0, key: () => null, getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
    expect(stashForNewTab([['ipam', '10.0.0.5']], { storage: st, now: 0, nonce: NONCE })).toBe('');
  });
});
