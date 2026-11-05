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
