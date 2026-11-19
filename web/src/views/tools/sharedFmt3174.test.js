import { describe, it, expect } from 'vitest';
import { fmtWatts, fmtKwh, tempColor } from './shared.jsx';
import { fmtW, fmtWh } from '../../util/fmt.js';

// v3.17.5(2차 공통 기능 점검 4회차): shared.jsx 의 전력 포맷터는 util/fmt.js 사본이었다 — 빈 문자열이 '0 W' · '0 kWh' 가 됐다.
describe('tools/shared.jsx 포맷터 = util/fmt.js', () => {
  it('같은 입력에 같은 출력 · 못 읽은 값은 —', () => {
    for (const v of [0, 950, 131133, 2.5e6, 3e9, -1500, '1500', null, undefined, '', '  ', 'abc', []]) {
      expect(fmtWatts(v)).toBe(fmtW(v));
      expect(fmtKwh(v)).toBe(fmtWh(v));
    }
    expect(fmtWatts('')).toBe('—');
    expect(fmtKwh('')).toBe('—');
  });
  it('tempColor — 빈 문자열은 0℃(초록)가 아니라 모름', () => {
    expect(tempColor('')).toBe('var(--text-faint)');
    expect(tempColor(null)).toBe('var(--text-faint)');
    expect(tempColor(25)).toBe('var(--green)');
    expect(tempColor('45')).toBe('var(--red)');
  });
});
