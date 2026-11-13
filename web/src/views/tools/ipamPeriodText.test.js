// v2.995.1 — IP 사용 이력 창의 사용 · 미사용 기간(periodText). 해제된 적 없는 IP 의 '총 미사용 기간' 이 '0ms' 로 보였다.
import { describe, it, expect } from 'vitest';
import { periodText, fmtDur } from './ipamShared.jsx';

describe('periodText — 기간은 사람 단위', () => {
  it('그 종류의 구간이 없으면 없음(0ms 가 아니다)', () => {
    expect(periodText(0, 0)).toBe('없음');
    expect(fmtDur(0)).toBe('0ms'); // 스캔 소요용 포매터는 그대로(스캔 상태 · 실행 이력 표)
  });
  it('1분 미만은 1분 미만 · 그 이상은 fmtDur', () => {
    expect(periodText(0)).toBe('1분 미만');
    expect(periodText(59_999)).toBe('1분 미만');
    expect(periodText(60_000)).toBe('1분 0초');
    expect(periodText(21 * 86_400_000)).toBe('21일 0시간');
  });
  it('못 읽은 값은 — (0 으로 읽지 않는다)', () => {
    for (const v of [null, undefined, '', 'x', -5, Number.NaN]) expect(periodText(v)).toBe('—');
  });
});
