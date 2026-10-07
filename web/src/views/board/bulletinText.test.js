import { describe, it, expect } from 'vitest';
import { readHides, isHidden, visibleNotices, withHidden, writeHides, timeText, windowText, noticeState, toLocalInput, fromLocalInput, HIDE_KEY, HIDE_MAX } from './bulletinText.js';

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
const N = (rev, extra = {}) => ({ id: rev.split(':')[0], rev, title: rev, ...extra });

describe('접속 공지 숨김', () => {
  it('오늘 하루는 그날만, 다시 보지 않기는 그 판만 숨긴다', () => {
    const h = withHidden({}, ['a:1'], 'today', ['a:1', 'b:1'], '2026-10-08');
    expect(isHidden(N('a:1'), h, '2026-10-08')).toBe(true);
    expect(isHidden(N('a:1'), h, '2026-10-09')).toBe(false);
    const f = withHidden(h, ['b:1'], 'forever', ['a:1', 'b:1'], '2026-10-08');
    expect(isHidden(N('b:1'), f, '2030-01-01')).toBe(true);
    // 관리자가 고치면 rev 가 바뀌어 다시 보인다.
    expect(isHidden(N('b:2'), f, '2030-01-01')).toBe(false);
  });
  it('지금 목록에 없는 옛 판은 지우고 상한을 둔다', () => {
    const h = withHidden({ 'old:1': 'forever', 'a:1': 'forever' }, [], 'today', ['a:1']);
    expect(Object.keys(h)).toEqual(['a:1']);
    const many = Array.from({ length: HIDE_MAX + 20 }, (_, i) => `n${i}:1`);
    expect(Object.keys(withHidden({}, many, 'forever', many)).length).toBe(HIDE_MAX);
  });
  it('저장소가 깨졌거나 던져도 숨김 없이 보인다', () => {
    const bad = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(readHides(bad)).toEqual({});
    expect(writeHides(bad, {})).toBe(false);
    const s = mem(); s.setItem(HIDE_KEY, '[1,2]');
    expect(readHides(s)).toEqual({});
    s.setItem(HIDE_KEY, '{깨짐');
    expect(readHides(s)).toEqual({});
    expect(visibleNotices([N('a:1'), null, { title: 'rev 없음' }], {}, '2026-10-08').map((n) => n.rev)).toEqual(['a:1']);
  });
  it('빈 날짜로는 오늘 숨김이 성립하지 않는다', () => {
    expect(isHidden(N('a:1'), { 'a:1': '' }, '')).toBe(false);
  });
});

describe('공지 표기', () => {
  it('값이 없으면 단위·날짜를 지어내지 않는다', () => {
    expect(timeText(null)).toBe('—');
    expect(timeText('')).toBe('—');
    expect(timeText('abc')).toBe('—');
    expect(windowText({})).toBe('기간 제한 없음');
    expect(toLocalInput(null)).toBe('');
    expect(fromLocalInput('')).toBe(null);
    expect(fromLocalInput('nope')).toBe(null);
  });
  it('입력 왕복', () => {
    const t = new Date(2026, 9, 8, 9, 5).getTime();
    expect(fromLocalInput(toLocalInput(t))).toBe(t);
    expect(timeText(t)).toBe('2026-10-08 09:05');
  });
  it('상태: 꺼짐 > 예정 > 종료 > 노출 중', () => {
    const now = 1000;
    expect(noticeState({ enabled: false, startAt: 2000 }, now).key).toBe('off');
    expect(noticeState({ startAt: 2000 }, now).key).toBe('scheduled');
    expect(noticeState({ endAt: 1000 }, now).key).toBe('ended');
    expect(noticeState({ startAt: 500, endAt: 2000 }, now).key).toBe('live');
  });
});
