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
