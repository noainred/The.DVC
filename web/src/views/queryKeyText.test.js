import { describe, it, expect } from 'vitest';
import { queryKey, keepRowsOnError } from './queryKeyText.js';

describe('RECENT2612-06 조회 키 — 선택을 바꾼 뒤 실패하면 이전 선택의 행을 남기지 않는다', () => {
  it('같은 조건(키 순서·빈 값 무관)은 같은 키', () => {
    expect(queryKey({ vcenterId: 'vc-1', mismatch: '' })).toBe(queryKey({ vcenterId: 'vc-1' }));
    expect(queryKey({ a: 1, b: 2 })).toBe(queryKey({ b: 2, a: 1 }));
    expect(queryKey({ vcenterId: 'vc-1' })).not.toBe(queryKey({ vcenterId: 'vc-2' }));
    expect(queryKey({ mm: true })).not.toBe(queryKey({ mm: false }));
  });
  it('같은 조회의 재시도 실패만 직전 행을 남긴다', () => {
    const k1 = queryKey({ vcenterId: 'vc-1' });
    const k2 = queryKey({ vcenterId: 'vc-2' });
    expect(keepRowsOnError(k1, k1)).toBe(true);
    expect(keepRowsOnError(k1, k2)).toBe(false);
    expect(keepRowsOnError(null, k1)).toBe(false);
  });
});
