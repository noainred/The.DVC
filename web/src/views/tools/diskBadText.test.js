import { describe, it, expect } from 'vitest';
import { fmtDate, spanText, rateText, pctText, clsTone, verdictTone, serverBand, unitProgress, scopeLabel, noteOf, clsOfCode, num, diagInfo, shortLogNote, READ_STOP_LABEL } from './diskBadText.js';

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
    // v3.8.2: 이틀 미만은 시간으로(실사용 화면에 '0일치' 가 나왔다).
    expect(spanText(NOW - 20 * HOUR, NOW)).toBe('20시간');
    expect(spanText(NOW - 10 * 60_000, NOW)).toBe('1시간');
    expect(spanText(NOW - 2 * DAY, NOW)).toBe('2일');
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
  it('v3.8.2 읽기 진단: 읽은 사실만 · 로그인 기록이 절반을 넘으면 경고 · 없으면 null', () => {
    expect(diagInfo(null)).toBe(null);
    const d = diagInfo({ at: NOW, read: 3853, pages: 78, ms: 41_000, distinct: 9, reachedEnd: true, oldest: NOW - 20 * HOUR, newest: NOW - HOUR,
      top: [{ code: 'USR0030', n: 1900 }, { code: 'USR0032', n: 1890 }], loginShare: 0.98, loginCodes: ['USR0030', 'USR0032'] });
    expect(d.lines[0]).toContain('3,853건'); expect(d.lines[0]).toContain('78쪽'); expect(d.lines[0]).toContain('41초');
    expect(d.lines[1]).toContain('19시간');
    expect(d.lines[2]).toContain('USR0030 1,900'); expect(d.lines[2]).toContain('그 밖 7종');
    expect(d.warn).toContain('98%'); expect(d.warn).toContain('보관 로그');
    expect(diagInfo({ at: NOW, read: 500, pages: 10, ms: null, top: [], loginShare: 0.1 }).warn).toBe('');
    expect(diagInfo({ at: NOW, read: null, pages: null, ms: null }).lines[0]).toContain('—건');
    for (const k of ['short', 'empty']) expect(READ_STOP_LABEL[k]).toBeTruthy();
  });
  it('v3.8.2 전 법인 경고: 로그가 30일 미만만 남은 서버가 있을 때만 · 0 을 과거에 없었다로 읽지 않게', () => {
    expect(shortLogNote(null)).toBe(null);
    expect(shortLogNote({ shortLog: 0, spanKnown: 40 })).toBe(null);
    const n = shortLogNote({ shortLog: 42, spanKnown: 42, shortLogDays: 30, medianLogDays: 0.8, loginHeavy: 30, diagKnown: 42 });
    expect(n.title).toContain('42대 가운데 42대'); expect(n.title).toContain('30일 미만');
    expect(n.body).toContain('과거에 없었다'); expect(n.body).toContain('19시간'); expect(n.body).toContain('30대');
    expect(shortLogNote({ shortLog: 3, spanKnown: 40, shortLogDays: 30, medianLogDays: 400 }).body).toContain('400일');
  });
  it('v3.8.2 판정 띠: 짧은 로그는 활성 로그라고 말하고 보관 로그를 읽지 않는다는 것을 밝힌다', () => {
    const b = serverBand({ status: 'clean', coverage: { coveredFrom: NOW - 20 * HOUR } }, NOW);
    expect(b.tone).toBe('warn'); expect(b.title).toContain('20시간'); expect(b.title).not.toContain('0일');
    expect(b.lines[0]).toContain('활성 로그'); expect(b.lines[0]).toContain('보관 로그');
  });
});
