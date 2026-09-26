import { describe, it, expect } from 'vitest';
import {
  TEMP_WARN_C, TEMP_HOT_C, BUCKET_MIN, BUCKET_MAX, BUCKET_COUNT, tempNum,
  tempBuckets, thresholdLeftPct, showBucketLabel, bucketTitle,
  barPct1530, heatPct, tileFill, gridCols, tileSize, layoutGroup,
  sparkPath, sparkDeltaText, sparkSeriesLabel, tempCounts, hotList, compareRows, rowTint,
  densityMetrics,
} from './board.js';

const R = (curC, extra = {}) => ({ curC, ...extra });

describe('히스토그램 버킷 (v2.556)', () => {
  it('33칸이고 14~46℃ 를 덮는다', () => {
    const b = tempBuckets([]);
    expect(b).toHaveLength(BUCKET_COUNT);
    expect(BUCKET_COUNT).toBe(33);
    expect(b[0].t).toBe(BUCKET_MIN);
    expect(b[32].t).toBe(BUCKET_MAX);
    expect(b[32].last).toBe(true);
  });

  it('★ 범위 밖은 양끝에 클램프한다 — 막대 합이 대수와 같아야 한다(부제가 거짓이 되지 않게)', () => {
    const rows = [R(-5), R(9), R(20.9), R(60), R(999)];
    const b = tempBuckets(rows);
    expect(b.reduce((a, x) => a + x.n, 0)).toBe(5);
    expect(b[0].n).toBe(2);        // -5, 9 → 14℃ 칸
    expect(b[32].n).toBe(2);       // 60, 999 → 46℃+ 칸
    expect(b[20 - BUCKET_MIN].n).toBe(1);
  });

  it('★ 값을 못 읽은 행은 0℃ 칸에 넣지 않는다(결측 ≠ 0)', () => {
    const b = tempBuckets([R(null), R(undefined), R(NaN), R('')]);
    expect(b.reduce((a, x) => a + x.n, 0)).toBe(0);
  });

  it('임계선 위치는 칸 수 기준 — 시안의 54.5% / 78.8%', () => {
    expect(thresholdLeftPct(TEMP_WARN_C)).toBeCloseTo(54.545, 2);
    expect(thresholdLeftPct(TEMP_HOT_C)).toBeCloseTo(78.787, 2);
  });

  it('임계 이상 막대는 낮아도 개수 라벨을 보여준다(놓치면 안 되는 값)', () => {
    expect(showBucketLabel({ t: 41, n: 1 }, 500)).toBe(true);
    expect(showBucketLabel({ t: 20, n: 1 }, 500)).toBe(false);
    expect(showBucketLabel({ t: 20, n: 400 }, 500)).toBe(true);
    expect(showBucketLabel({ t: 41, n: 0 }, 500)).toBe(false);  // 0건은 라벨도 없다
  });

  it("마지막 칸 툴팁은 '이상' 이라고 적는다", () => {
    expect(bucketTitle({ t: 46, n: 3, last: true })).toBe('46℃ 이상 · 3대');
    expect(bucketTitle({ t: 20, n: 137 })).toBe('20~21℃ · 137대');
  });
});

describe('tempNum — 결측을 0℃ 로 읽지 않는다(v2.556 자체 테스트가 잡은 결함)', () => {
  it("null·''·NaN·객체는 null", () => {
    for (const bad of [null, undefined, '', '  x', NaN, {}, []]) expect(tempNum(bad)).toBe(null);
  });
  it('숫자와 숫자 문자열은 그대로 · 0℃ 는 유효한 값이다', () => {
    expect(tempNum(0)).toBe(0);
    expect(tempNum('21.5')).toBe(21.5);
    expect(tempNum(-3)).toBe(-3);
  });
});

describe('막대 폭', () => {
  it('15~30℃ 스케일 · 값 없으면 0(막대를 그리지 않는다)', () => {
    expect(barPct1530(15)).toBe(2);
    expect(barPct1530(30)).toBe(100);
    expect(barPct1530(22.5)).toBe(50);
    expect(barPct1530(null)).toBe(0);
    expect(barPct1530(undefined)).toBe(0);
  });
  it('히트셀은 15~45℃ 스케일', () => {
    expect(heatPct(45)).toBe(100);
    expect(heatPct(30)).toBe(50);
    expect(heatPct(null)).toBe(0);
  });
});

describe('히트맵 타일', () => {
  it('★ 값을 못 읽은 타일은 초록이 아니라 회색이다', () => {
    expect(tileFill(null)).toBe('rgba(255,255,255,.08)');
    expect(tileFill(NaN)).toBe('rgba(255,255,255,.08)');
  });
  it('임계 이상은 상태색으로 굳힌다(농도와 섞지 않는다)', () => {
    expect(tileFill(41)).toBe('#ef4444');
    expect(tileFill(TEMP_HOT_C)).toBe('#ef4444');
    expect(tileFill(35)).toBe('#f59e0b');
    expect(tileFill(TEMP_WARN_C)).toBe('#f59e0b');
    expect(tileFill(20)).toMatch(/^rgba\(34,197,94,0\.\d+\)$/);
  });
  it('열 수는 4~24 로 묶는다', () => {
    expect(gridCols(0)).toBe(4);
    expect(gridCols(1)).toBe(4);
    expect(gridCols(100)).toBe(15);
    expect(gridCols(100000)).toBe(24);
  });
  it('타일 크기는 뷰·밀도로 갈린다', () => {
    expect(tileSize('server', false).tile).toBe(12);
    expect(tileSize('server', true).tile).toBe(9);
    expect(tileSize('cluster', false).tile).toBe(18);
    expect(tileSize('vc', false).tile).toBe(24);
  });

  it('★ 그룹 배치 — 값 내림차순 · 평균은 읽은 값만 · 못 읽은 개수를 밝힌다', () => {
    const g = layoutGroup([R(20), R(null), R(41), R(30)], (x) => x.curC, { view: 'server' });
    expect(g.n).toBe(4);
    expect(g.items.map((i) => i.v)).toEqual([41, 30, 20, null]);
    expect(g.avg).toBeCloseTo(30.3, 1);   // (41+30+20)/3 — null 을 0 으로 세지 않는다
    expect(g.unreadable).toBe(1);
    expect(g.width).toBeGreaterThan(0);
    expect(g.height).toBeGreaterThan(0);
  });

  it('빈 그룹도 크기가 0 이 아니다(SVG 가 음수 폭이면 렌더가 깨진다)', () => {
    const g = layoutGroup([], (x) => x.curC);
    expect(g.n).toBe(0);
    expect(g.avg).toBe(null);
    expect(g.width).toBeGreaterThan(0);
    expect(g.height).toBeGreaterThan(0);
    expect(g.rows).toBe(1);
  });
});

describe('스파크라인', () => {
  it('★ 점이 2개 미만이면 null — 한 점을 선으로 만들지 않는다', () => {
    expect(sparkPath([])).toBe(null);
    expect(sparkPath([{ avg: 20 }])).toBe(null);
    expect(sparkPath(null)).toBe(null);
  });
  it('★ 평탄한 계열을 톱니로 만들지 않는다(최소 폭 2℃)', () => {
    const flat = sparkPath([{ avg: 21.0 }, { avg: 21.1 }, { avg: 21.0 }], { width: 84, height: 24 });
    const ys = flat.d.match(/,([\d.]+)/g).map((m) => Number(m.slice(1)));
    // span 2℃ 기준이므로 0.1℃ 변동은 높이의 1/20 이하만 움직여야 한다
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(2);
  });
  it('숫자 배열도 받는다 · 면(area)이 닫힌다', () => {
    const sp = sparkPath([20, 25, 30]);
    expect(sp.n).toBe(3);
    expect(sp.first).toBe(20);
    expect(sp.last).toBe(30);
    expect(sp.area.endsWith('Z')).toBe(true);
  });
  it('결측 점은 건너뛴다(0℃ 로 떨어지지 않게)', () => {
    const sp = sparkPath([{ avg: 20 }, { avg: null }, { avg: 22 }]);
    expect(sp.n).toBe(2);
  });
  it('24h 변화량은 계열이 있을 때만 말한다', () => {
    expect(sparkDeltaText([{ avg: 20 }, { avg: 21 }], 21.2)).toBe('24h +1.2');
    expect(sparkDeltaText([{ avg: 25 }, { avg: 24 }], 23)).toBe('24h -2.0');
    expect(sparkDeltaText([], 21)).toBe('');
    expect(sparkDeltaText([{ avg: 20 }, { avg: 21 }], null)).toBe('');
  });
  it('★ 계열 이름은 서버가 준 메트릭만 쓴다 — 모르면 계열을 단정하지 않는다', () => {
    expect(sparkSeriesLabel('idractemp_inlet')).toContain('흡기');
    expect(sparkSeriesLabel('idractemp_max')).toContain('최고');
    expect(sparkSeriesLabel('temp_host')).toContain('ESXi');
    expect(sparkSeriesLabel('')).toBe('24시간 추이');
    expect(sparkSeriesLabel('wat')).toBe('24시간 추이');
  });
});

describe('집계', () => {
  it('★★ ok + warm + hot + unknown = 전체 (못 읽은 것을 정상에 흡수하지 않는다)', () => {
    const rows = [R(20), R(33), R(41), R(null), R(31.9), R(32), R(39.9), R(40)];
    const c = tempCounts(rows);
    expect(c.ok + c.warm + c.hot + c.unknown).toBe(c.total);
    expect(c.total).toBe(8);
    expect(c.ok).toBe(2);      // 20, 31.9 — 임계 미만만
    expect(c.warm).toBe(3);    // 33, 32, 39.9
    expect(c.hot).toBe(2);     // 41, 40
    expect(c.unknown).toBe(1);
  });
  it('이상 목록은 더운 순 · 값을 못 읽은 서버는 넣지 않는다', () => {
    const h = hotList([R(35, { name: 'a' }), R(null, { name: 'x' }), R(41, { name: 'b' }), R(20, { name: 'c' })]);
    expect(h.map((r) => r.name)).toEqual(['b', 'a']);
  });
  it('법인 비교는 전체 평균 내림차순 + 그 법인의 임계 개수', () => {
    const byDc = [
      { key: 'vc1', name: 'A', all: { avgC: 20 } },
      { key: 'vc2', name: 'B', all: { avgC: 28 } },
      { key: 'vc3', name: 'C', all: { avgC: null } },
    ];
    const rows = [
      R(41, { datacenterId: 'vc2' }), R(33, { datacenterId: 'vc2' }), R(20, { datacenterId: 'vc1' }),
      R(null, { datacenterId: 'vc1' }),
    ];
    const out = compareRows(byDc, rows);
    expect(out.map((d) => d.name)).toEqual(['B', 'A', 'C']);
    expect(out[0]).toMatchObject({ hot: 1, warm: 1 });
    expect(out[1]).toMatchObject({ hot: 0, warm: 0, unknown: 1 });
  });
  it('행 배경은 임계에서만 · 값이 없으면 칠하지 않는다', () => {
    expect(rowTint(41)).toEqual({ background: 'rgba(239,68,68,.07)' });
    expect(rowTint(33)).toEqual({ background: 'rgba(245,158,11,.05)' });
    expect(rowTint(20)).toBe(undefined);
    expect(rowTint(null)).toBe(undefined);
  });
});

describe('밀도', () => {
  it('촘촘히가 여유보다 항상 작다', () => {
    const a = densityMetrics(false);
    const b = densityMetrics(true);
    expect(b.listMaxH).toBeLessThan(a.listMaxH);
    expect(b.groupGap).toBeLessThan(a.groupGap);
    expect(b.barW).toBeLessThan(a.barW);
  });
});

describe('법인 그룹 키 — 서버 조립 규칙과 같아야 한다 (v2.556)', () => {
  it('datacenterId → vcenterId → (미분류) 순서', async () => {
    const { dcKeyOf, UNASSIGNED_DC } = await import('./board.js');
    expect(dcKeyOf({ datacenterId: 'dc1', vcenterId: 'vc1' })).toBe('dc1');
    expect(dcKeyOf({ datacenterId: '', vcenterId: 'vc1' })).toBe('vc1');
    expect(dcKeyOf({})).toBe(UNASSIGNED_DC);
    expect(UNASSIGNED_DC).toBe('(미분류)');
  });
  it('★ 미분류 행도 비교 목록에서 세어진다(조용히 빠지면 개수가 어긋난다)', async () => {
    const { compareRows } = await import('./board.js');
    const out = compareRows([{ key: '(미분류)', name: '(미분류)', all: { avgC: 40 } }], [{ curC: 41 }]);
    expect(out[0].hot).toBe(1);
  });
});

describe('빈 버킷은 온도색이 아니다 (v2.556 스크린샷 판독)', () => {
  it('★ 개수 0 인 칸에는 라벨도 막대도 없다 — 40℃↑ 0 인데 빨간 선이 보이던 결함', () => {
    // 판정은 showBucketLabel 이 갖고, 렌더는 parts.jsx 가 n===0 을 중립색 1px 로 그린다.
    expect(showBucketLabel({ t: 44, n: 0 }, 100)).toBe(false);
    expect(showBucketLabel({ t: 20, n: 0 }, 100)).toBe(false);
    // 그리고 그 칸의 툴팁은 '0대' 라고 정직하게 말한다.
    expect(bucketTitle({ t: 44, n: 0 })).toBe('44~45℃ · 0대');
  });
});

describe('추이 모달 절단 안내 — v2.621 감사 RECENT-02', () => {
  it('잘리지 않았으면 null', async () => {
    const { histCutNote } = await import('./board.js');
    expect(histCutNote(null)).toBe(null);
    expect(histCutNote({ truncated: false, coveredSince: 1, limit: 5 })).toBe(null);
    expect(histCutNote({ points: [] })).toBe(null);
  });
  it('잘렸으면 시작 시각·상한을 말한다', async () => {
    const { histCutNote } = await import('./board.js');
    const ts = new Date(2026, 8, 20, 7, 5).getTime();
    const t = histCutNote({ truncated: true, coveredSince: ts, limit: 10080 });
    expect(t).toContain('09-20 07:05 이후만');
    expect(t).toContain('10,080');
    expect(t).not.toMatch(/`|\*\*/);
  });
  it('시작 시각을 모르면 단정하지 않는다(null·빈 문자열을 1970 으로 읽지 않는다)', async () => {
    const { histCutNote } = await import('./board.js');
    for (const cs of [null, '', undefined, 0]) {
      const t = histCutNote({ truncated: true, coveredSince: cs, limit: 5000 });
      expect(t).toContain('다 담지 못했습니다');
      expect(t).not.toContain('1970');
      expect(t).not.toContain('01-01');
    }
  });
});
