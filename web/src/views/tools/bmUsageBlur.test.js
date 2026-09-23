import { describe, it, expect } from 'vitest';
import { blurNumber, BLANK_KEPT_TEXT } from './bmUsageText.js';

describe('blurNumber (v2.583 #36)', () => {
  it('빈 칸·공백·숫자 아님은 null(저장하지 않음)', () => {
    for (const v of ['', '   ', null, undefined, 'abc']) expect(blurNumber(v)).toBe(null);
  });
  it('숫자는 그대로, 0 도 유효', () => {
    expect(blurNumber('0')).toBe(0);
    expect(blurNumber(' 15 ')).toBe(15);
    expect(blurNumber('90')).toBe(90);
  });
  it('안내 문구에 백틱이 없다', () => { expect(BLANK_KEPT_TEXT.includes('`')).toBe(false); });
});
