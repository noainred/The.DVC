import { describe, it, expect } from 'vitest';
import { elapsedText, agoText } from './relTime.js';

// v3.10.10(공통 기능 점검 8회차): 반올림한 값이 다음 단위에 닿으면 다음 단위로 — 예전엔 '60초 전'·'60분 전'·'24시간 전' 이 나왔다.
describe('relTime 경계', () => {
  it('반올림해 다음 단위에 닿으면 올린다', () => {
    expect(elapsedText(59_600)).toBe('1분 전');
    expect(elapsedText(59_499)).toBe('59초 전');
    expect(elapsedText(59.5 * 60_000)).toBe('1시간 전');
    expect(elapsedText(59.4 * 60_000)).toBe('59분 전');
    expect(elapsedText(23.5 * 3_600_000)).toBe('1일 전');
    expect(elapsedText(23.4 * 3_600_000)).toBe('23시간 전');
  });
  it('기존 규칙은 그대로 — 반올림 · 방금 · 결측 · 미래 · 0 은 미기록', () => {
    expect(elapsedText(90_000)).toBe('2분 전');            // 반올림(머리말 정정 — 내림이 아니다)
    expect(elapsedText(30_000)).toBe('30초 전');
    expect(elapsedText(500)).toBe('방금');
    expect(elapsedText(30_000, { subMinute: '방금' })).toBe('방금');
    expect(elapsedText(59_600, { subMinute: '방금' })).toBe('방금');
    expect(elapsedText(4_000, { subMinute: 5_000 })).toBe('방금');
    expect(elapsedText(6_000, { subMinute: 5_000 })).toBe('6초 전');
    expect(elapsedText(null)).toBe('—');
    expect(elapsedText('', { dash: null })).toBe(null);
    expect(elapsedText(-5)).toBe('방금');
    expect(elapsedText(-5, { future: 'null' })).toBe(null);
    expect(elapsedText(3 * 86_400_000)).toBe('3일 전');
    expect(agoText(0, 10_000)).toBe('—');
    expect(agoText(10_000 - 3_600_000 + 1_000, 10_000)).toBe('—');  // 음수 ts 는 미기록
    expect(agoText(1_000_000 - 120_000, 1_000_000)).toBe('2분 전');
  });
});
