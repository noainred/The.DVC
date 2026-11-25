// powerHistText.test.js — v3.39.0 VM 전원 이력 화면 문구 · 달력 계산(지역 시각 기준 — 시험도 지역 생성자로 만든다).
import { describe, it, expect } from 'vitest';
import {
  durText, durRangeText, whenText, clipSegs, sumsOf, onRatio, pctText, dayBarStyle, ratioBarStyle, monthsBack, monthCells, sumsText, factText, currentText, defaultDayKey, dayKey,
} from './powerHistText.js';
import { normObjTab, POWER_TAB } from '../vcd/objTabs.js';

const H = 3_600_000;
const D = 24 * H;
const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();

describe('길이 · 시각 글', () => {
  it('durText — 일 · 시간 · 분, 값이 없으면 —', () => {
    expect(durText(3 * D + 4 * H)).toBe('3일 4시간');
    expect(durText(5 * H + 20 * 60_000)).toBe('5시간 20분');
    expect(durText(7 * 60_000)).toBe('7분');
    expect(durText(null)).toBe('—');
    expect(durText('')).toBe('—');
  });
  it('durRangeText — 위 끝 모르면 이상 · 같으면 하나 · 아니면 범위', () => {
    expect(durRangeText(0, 24 * H)).toBe('0분 ~ 1일');
    expect(durRangeText(2 * H, null)).toBe('2시간 이상');
    expect(durRangeText(2 * H, 2 * H + 30_000)).toBe('2시간');
    expect(durRangeText(null, 5)).toBe('—');
  });
  it('whenText — 정확하면 시각 · 아니면 사이(같은 날은 시:분만)', () => {
    expect(whenText({ ts: at(2026, 3, 8, 19, 20), exact: true })).toBe('2026-03-08 19:20');
    expect(whenText({ ts: at(2026, 3, 8, 12), lo: at(2026, 3, 8, 6) })).toBe('2026-03-08 06:00 ~ 12:00 사이');
    expect(whenText({ ts: at(2026, 3, 9, 0, 10), lo: at(2026, 3, 8, 23, 50) })).toBe('2026-03-08 23:50 ~ 03-09 00:10 사이');
  });
});

describe('합 · 비율 — 경계 불확실 · 기록 없음은 분모에서 뺀다', () => {
  const segs = [
    { a: at(2026, 3, 8), b: at(2026, 3, 8, 19, 20), st: 'on' },
    { a: at(2026, 3, 8, 19, 20), b: at(2026, 3, 8, 19, 30), st: 'est' },
    { a: at(2026, 3, 8, 19, 30), b: at(2026, 3, 9, 6), st: 'off' },
    { a: at(2026, 3, 9, 6), b: at(2026, 3, 9, 8), st: 'unk' },
  ];
  it('하루로 자른 합', () => {
    const s = sumsOf(clipSegs(segs, at(2026, 3, 8), at(2026, 3, 9)));
    expect(s.on).toBe(19 * H + 20 * 60_000);
    expect(s.est).toBe(10 * 60_000);
    expect(s.off).toBe(4 * H + 30 * 60_000);
    expect(onRatio(s)).toBeCloseTo((19 * 60 + 20) / (24 * 60 - 10), 6);
  });
  it('판정된 시간이 없으면 비율은 null(0% 가 아니다)', () => {
    expect(onRatio({ on: 0, off: 0, est: 5, unk: 9 })).toBe(null);
    expect(pctText(null)).toBe('—');
    expect(ratioBarStyle({ on: 0, off: 0, est: 0, unk: 0 })).toBe(null);
  });
  it('sumsText — 0 인 것은 뺀다', () => {
    expect(sumsText({ on: 2 * H, off: 0, est: 0, unk: H })).toBe('켜짐 2시간 · 판정 못함 1시간');
  });
  it('하루 띠 — 0시→24시 비율로 칠하고 빈 앞부분은 투명', () => {
    const a = at(2026, 3, 8); const b = at(2026, 3, 9);
    const st = dayBarStyle([{ a: a + 12 * H, b, st: 'off' }], a, b);
    expect(st.backgroundImage).toContain('transparent 0% 50.00%');
    expect(st.backgroundImage).toContain('var(--pwh-off) 50.00% 100.00%');
    expect(dayBarStyle([], a, b)).toBe(null);
  });
});

describe('달력', () => {
  it('monthsBack — 오래된 달부터 12개 · offset 은 그만큼 앞으로', () => {
    const ms = monthsBack(at(2026, 11, 25, 16), 12);
    expect(ms).toHaveLength(12);
    expect([ms[0].y, ms[0].m, ms[11].y, ms[11].m]).toEqual([2025, 12, 2026, 11]);
    const back = monthsBack(at(2026, 11, 25, 16), 12, 12);
    expect([back[0].y, back[0].m, back[11].m]).toEqual([2024, 12, 11]);
  });
  it('monthCells — 첫 주 빈칸 · 기록 전 · 미래 · 바뀐 날', () => {
    const now = at(2026, 3, 20, 10);
    const segs = [
      { a: at(2026, 3, 5), b: at(2026, 3, 8, 19, 20), st: 'on' },
      { a: at(2026, 3, 8, 19, 20), b: now, st: 'off' },
    ];
    const m = monthsBack(now, 1)[0];
    const c = monthCells(m, segs, now);
    expect(c.blanks).toBe(new Date(2026, 2, 1).getDay());
    expect(c.days).toHaveLength(31);
    expect(c.days[0].none).toBe(true);          // 3월 1일 — 기록 전
    expect(c.days[7].changed).toBe(true);       // 3월 8일 — 켜짐 → 꺼짐
    expect(c.days[8].changed).toBe(false);
    expect(c.days[20].future).toBe(true);       // 3월 21일
    expect(c.days[19].future).toBe(false);      // 오늘(진행 중)
    expect(c.sums.off).toBe(now - at(2026, 3, 8, 19, 20));
    expect(c.days[7].aria).toContain('3월 8일');
  });
  it('기본 선택 날 — 최근 전환의 날 · 없으면 기준일', () => {
    expect(defaultDayKey([{ ts: at(2026, 11, 12, 8, 15) }], at(2026, 11, 25))).toBe('2026-11-12');
    expect(defaultDayKey([], at(2026, 11, 25, 9))).toBe(dayKey(at(2026, 11, 25)));
  });
});

describe('사실 글 — 기록 시작 전은 날짜를 지어내지 않는다', () => {
  it('factText', () => {
    expect(factText({ before: at(2025, 12, 1) }).main).toBe('기록 시작 전');
    expect(factText({ ts: at(2026, 2, 23, 14, 5), exact: true, user: 'VSPHERE.LOCAL\\ops' })).toEqual({ main: '2026-02-23 14:05', sub: 'vCenter 이벤트 · VSPHERE.LOCAL\\ops' });
    expect(factText({ ts: at(2026, 2, 23, 14, 10), lo: at(2026, 2, 23, 14), src: 'watch' }, { watchMs: 600_000 }).sub).toBe('포탈 관측 · 정밀도 10분');
    expect(factText(null).main).toBe('기록 없음');
  });
  it('currentText — 진행 시간 · 시작을 모르면 이상', () => {
    const now = at(2026, 11, 25, 16);
    expect(currentText({ current: { state: 'off', ts: at(2026, 10, 29, 16), exact: true } }, now).head).toBe('꺼짐 · 27일째');
    expect(currentText({ current: { state: 'on', before: at(2026, 11, 1, 16) } }, now).head).toBe('켜짐 · 24일 이상');
    expect(currentText({ current: null, gone: true }, now).head).toBe('지금 목록에 없음');
  });
});

describe('개체 보기 탭 키', () => {
  it("'power' 는 VM 에만 — 호스트는 요약으로", () => {
    expect(POWER_TAB.k).toBe('power');
    expect(normObjTab('vm', 'power')).toBe('power');
    expect(normObjTab('host', 'power')).toBe('summary');
  });
});
