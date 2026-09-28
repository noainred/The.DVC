// v2.635 — 베어메탈 스토리지 디스크 사용량 추이 차트의 정직성 규칙.
import { describe, it, expect } from 'vitest';
import {
  bytesText, changeText, pctOf, summaryOf, yMaxOf, pathFor, dotsFor, gapMsFor, xTicksFor,
  pointsNote, partialNote, emptyNote, spanNote, MODES, FALLBACK_PERIODS,
} from './bmStorHistoryText.js';

const TB = 1024 ** 4; const H = 3_600_000;
const t0 = 1_790_000_000_000;
const pt = (h, used, extra = {}) => ({ ts: t0 + h * H, usedBytes: used * TB, totalBytes: 100 * TB, availBytes: (100 - used) * TB, read: 3, servers: 3, partial: false, ...extra });

describe('bmStorHistoryText', () => {
  it('보기 3종 · 기간 5종(1일/7일/1달/분기/반기)', () => {
    expect(MODES.map((m) => m.label)).toEqual(['합계', '그룹별', '서버별']);
    expect(FALLBACK_PERIODS.map((p) => p.label)).toEqual(['1일', '7일', '1달', '분기', '반기']);
  });

  it('못 읽은 값은 단위 없이 — · null 은 0 바이트가 아니다', () => {
    expect(bytesText(null)).toBe('—');
    expect(bytesText('')).toBe('—');
    expect(bytesText(2.5 * TB)).toBe('2.5 TB');
    expect(changeText(null)).toBe('—');
    expect(changeText(0)).toBe('변화 없음');
    expect(changeText(-TB)).toBe('−1.0 TB');
    expect(changeText(TB)).toBe('+1.0 TB');
    expect(pctOf({ usedBytes: 0, availBytes: 0 })).toBeNull();
    expect(pctOf({ usedBytes: 1, availBytes: 3 })).toBe(25);
  });

  it('부분 합은 선으로 잇지 않고 요약 변화 계산에서도 뺀다', () => {
    const s = { points: [pt(0, 40), pt(12, 10, { partial: true, read: 1 }), pt(24, 42)] };
    const sum = summaryOf(s);
    expect(sum.partial).toBe(1);
    expect(sum.full).toBe(2);
    expect(sum.change).toBe(2 * TB);
    const p = pathFor(s.points, { t0, t1: t0 + 24 * H, yMax: yMaxOf(s), gapMs: 36 * H });
    expect(p.n).toBe(2);
    const dots = dotsFor(s.points, { t0, t1: t0 + 24 * H, yMax: yMaxOf(s) });
    expect(dots.filter((d) => d.partial)).toHaveLength(1);
  });

  it('기록이 빠진 슬롯은 선을 끊는다(간격 > 적재 간격 × 1.5) · 점 1개면 선이 없다', () => {
    const pts = [pt(0, 40), pt(12, 41), pt(48, 45), pt(60, 46)];
    const p = pathFor(pts, { t0, t1: t0 + 60 * H, yMax: 105 * TB, gapMs: gapMsFor(12) });
    expect(p.breaks).toBe(1);
    expect(p.d.match(/M/g)).toHaveLength(2);
    expect(pathFor([pt(0, 40)], { t0, t1: t0 + H, yMax: 1 })).toBeNull();
    expect(gapMsFor(null)).toBe(18 * H);
  });

  it('y축은 0 부터 · 최댓값은 용량의 105%', () => {
    expect(yMaxOf({ points: [pt(0, 40)] })).toBeCloseTo(105 * TB);
    expect(yMaxOf({ points: [] })).toBe(1);
    const p = pathFor([pt(0, 0), pt(12, 0)], { t0, t1: t0 + 12 * H, yMax: 105 * TB, h: 150 });
    expect(p.d).toContain(',150.0');   // 0 은 바닥
  });

  it('x 눈금: 1일은 시각, 그 밖은 날짜(KST)', () => {
    const at = Date.UTC(2026, 8, 28, 15, 0, 0);   // 09-29 00:00 KST
    expect(xTicksFor(at, at + 24 * H, 1)[0].label).toBe('29일 00시');
    expect(xTicksFor(at, at + 7 * 24 * H, 7)[0].label).toBe('09/29');
    expect(xTicksFor(null, 1, 1)).toEqual([]);
  });

  it('안내 문구: 1일은 점이 적다고 말한다 · 부분 합은 있을 때만 · 빈 이유를 나눈다', () => {
    expect(pointsNote({ days: 1 }, 12)).toContain('최대 3개');
    expect(pointsNote({ days: 1 }, 12)).toContain('1일 차트');
    expect(pointsNote({ days: 7 }, 12)).not.toContain('1일 차트');
    expect(partialNote(0)).toBe('');
    expect(partialNote(2)).toContain('부분 합');
    expect(emptyNote({ available: false, dbError: 'x' })).toContain('DB 를 열지 못했습니다');
    expect(emptyNote({ seriesCount: 0, status: { idleReason: '기동 뒤 첫 수집을 기다리는 중입니다' } })).toContain('첫 수집');
    expect(emptyNote({ seriesCount: 0, mode: 'group', status: {} })).toContain('그룹');
    expect(emptyNote({ seriesCount: 3 })).toBe('');
  });

  it('기간 앞부분이 빈 이유를 단정하지 않는다', () => {
    const note = spanNote({ first: t0 + 5 * 24 * H }, t0, 1825);
    expect(note).toContain('기록을 시작하기 전이거나 보존 기간');
    expect(spanNote({ first: t0 }, t0, 1825)).toBe('');
    expect(spanNote({ first: t0 + 5 * 24 * H }, t0, 0)).toContain('전부 보관');
  });

  it('화면 문구에 백틱이 없다(BoldText 는 **강조**만 해석한다)', () => {
    for (const s of [pointsNote({ days: 1 }, 12), partialNote(3), emptyNote({ seriesCount: 0, status: {} }), spanNote({ first: t0 + 5 * 24 * H }, t0, 30)]) {
      expect(s).not.toContain('`');
    }
  });
});
