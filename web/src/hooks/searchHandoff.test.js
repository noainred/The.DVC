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
