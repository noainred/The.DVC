import { describe, it, expect } from 'vitest';
import { fmtDate, spanText, rateText, pctText, clsTone, verdictTone, serverBand, unitProgress, scopeLabel, noteOf, clsOfCode, num } from './diskBadText.js';

const HOUR = 3_600_000; const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;

describe('diskBadText', () => {
  it('값이 없으면 단위 없이 — (못 읽음은 0 이 아니다)', () => {
    expect(fmtDate(null)).toBe('—'); expect(rateText(null)).toBe('—'); expect(pctText(undefined)).toBe('—'); expect(num(null)).toBe('—');
    expect(spanText(NOW, NOW - DAY)).toBe('—');
    expect(rateText(0)).toBe('0.0');
  });
  it('구간 길이', () => {
    expect(spanText(NOW - 10 * DAY, NOW)).toBe('10일');
    expect(spanText(NOW - 400 * DAY, NOW)).toMatch(/^1년/);
  });
  it('색: 복구 불가 빨강 · PDR54/59/57 주황 · 고장 예측 파랑 · 사용 중 빨강', () => {
    expect(clsTone('unrecoverable')).toBe('red'); expect(clsTone('corrected')).toBe('amber'); expect(clsTone('predictive')).toBe('blue'); expect(clsTone('other')).toBe('gray');
    expect(verdictTone('inUse')).toBe('red'); expect(verdictTone('replaced')).toBe('gray');
  });
  it('판정 띠: 못 읽음은 판정하지 않는다 · 기록 없음은 구간과 함께 · 짧은 로그는 경고', () => {
    expect(serverBand(null).title).toMatch(/조회하지 않았습니다/);
    const unread = serverBand({ status: 'unread', coverage: { lastStatusLabel: 'iDRAC 로그인 실패(401)' } });
    expect(unread.tone).toBe('err'); expect(unread.lines[0]).toMatch(/판정하지 않았습니다/);
    const clean = serverBand({ status: 'clean', coverage: { coveredFrom: NOW - 900 * DAY } }, NOW);
    expect(clean.title).toMatch(/기록이 없습니다/); expect(clean.lines[0]).toMatch(/발생한 적 없음/);
    const short = serverBand({ status: 'clean', coverage: { coveredFrom: NOW - 30 * DAY } }, NOW);
    expect(short.tone).toBe('warn');
    const rec = serverBand({ status: 'records', counts: { records: 7, slots: 2, inUse: 1, replaced: 1, unknown: 0 }, coverage: { coveredFrom: NOW - 900 * DAY } }, NOW);
    expect(rec.tone).toBe('bad'); expect(rec.title).toMatch(/7건 · 디스크 자리 2곳/);
  });
  it('진행률 · 범위 이름 · 주석', () => {
    expect(unitProgress({ done: 3, total: 4 })).toEqual({ done: 3, total: 4, pct: 75, text: '3 / 4' });
    expect(unitProgress({ done: 0, total: null }).text).toBe('0 / ?');
    expect(scopeLabel({ scope: 'corp', targetLabel: 'KR 본사' })).toBe('법인 · KR 본사');
    const refs = [{ id: 'PDR54', cls: 'corrected', note: '미디어 오류를 복구 중에 고쳐 씀' }];
    expect(noteOf('PDR54', refs)).toMatch(/고쳐 씀/); expect(noteOf('X', refs)).toBe('');
    expect(clsOfCode('PDR1016', refs)).toBe('other');
  });
});
