import { describe, it, expect } from 'vitest';
import { dailyReportFailNote, portalHhmm } from './dailyReportText.js';

describe('dailyReportText (v2.603 TIM2603-02)', () => {
  it('실패가 없으면 안내하지 않는다', () => {
    expect(dailyReportFailNote({ failStreak: 0 })).toBe(null);
    expect(dailyReportFailNote({})).toBe(null);
    expect(dailyReportFailNote(null)).toBe(null);
  });
  it('연속 실패·다음 시도(포탈 오프셋 기준)·사유를 말한다', () => {
    const at = Date.UTC(2026, 8, 24, 1, 15);   // KST 10:15
    const n = dailyReportFailNote({ failStreak: 3, nextRetryAt: at, lastFailReason: '웹훅 500', enabled: true, tzOffsetMin: 540 });
    expect(n.streak).toBe(3);
    expect(n.text).toContain('연속 실패 3회');
    expect(n.text).toContain('10:15');
    expect(n.text).toContain('웹훅 500');
    expect(n.text).toContain('바로 시도');
    expect(n.text).not.toMatch(/[`*]/);
  });
  it('꺼져 있으면 다음 시도를 말하지 않는다 · 시각이 없으면 지어내지 않는다', () => {
    expect(dailyReportFailNote({ failStreak: 1, enabled: false }).text).toContain('꺼져 있어');
    expect(dailyReportFailNote({ failStreak: 1, enabled: true, nextRetryAt: null }).text).toContain('알 수 없습니다');
    expect(portalHhmm(null, 540)).toBe(null);
    expect(portalHhmm('', 540)).toBe(null);
    expect(portalHhmm(0, 540)).toBe(null);
  });
});
