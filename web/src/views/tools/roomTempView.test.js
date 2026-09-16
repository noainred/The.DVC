/**
 * roomTempView.test.js — 전산실 온도 화면(시안 2a 적용, v2.534)의 판정 회귀.
 * 웹 테스트는 node 환경(DOM 없음)이라 렌더는 못 본다 — 판정·서식만 여기서 고정한다.
 */
import { describe, it, expect } from 'vitest';
import { SORTS, VIEWS, sortGroups, columnStats, heat, tileData, boardCounts, sparkPath, matrixStats, MATRIX_COLS } from './roomTempView.js';

const g = (name, inletMax, opts = {}) => ({
  id: name, name,
  inlet: { min: inletMax == null ? null : inletMax - 5, avg: inletMax == null ? null : inletMax - 2, max: inletMax, servers: 10 },
  exhaust: { min: 20, avg: opts.exAvg ?? 30, max: opts.exMax ?? 40, servers: 10 },
  cpu: { min: 30, avg: 50, max: opts.cpuMax ?? 60, servers: 10 },
  deltaAvg: opts.dt ?? 12,
  status: opts.status ?? null,
  noSensorCount: opts.noSensor ?? 0, staleCount: opts.stale ?? 0,
  hosts: [],
});

describe('정렬', () => {
  it('★ ΔT 정렬이 있다(시안 요구)', () => {
    expect(SORTS.map(([v]) => v)).toContain('dt-desc');
    expect(SORTS.map(([v]) => v)).toContain('dt-asc');
  });

  it('흡기는 **최고값** 기준으로 정렬한다', () => {
    const out = sortGroups([g('a', 20), g('b', 30), g('c', 25)], 'inlet-desc');
    expect(out.map((x) => x.name)).toEqual(['b', 'c', 'a']);
  });

  it('ΔT 정렬은 평균 기준', () => {
    const out = sortGroups([g('a', 20, { dt: 5 }), g('b', 20, { dt: 25 })], 'dt-desc');
    expect(out.map((x) => x.name)).toEqual(['b', 'a']);
  });

  it('★ 값이 없는 법인은 방향과 무관하게 항상 뒤로', () => {
    const rows = [g('a', 20), g('none', null), g('b', 30)];
    expect(sortGroups(rows, 'inlet-desc').map((x) => x.name)).toEqual(['b', 'a', 'none']);
    expect(sortGroups(rows, 'inlet-asc').map((x) => x.name)).toEqual(['a', 'b', 'none']);
  });

  it('법인명 정렬은 그대로 동작(v2.384 유지)', () => {
    expect(sortGroups([g('B', 1), g('A', 2)], 'name-asc').map((x) => x.name)).toEqual(['A', 'B']);
  });

  it('보기는 세 가지(범위 플롯 / 매트릭스 / 월보드)', () => {
    expect(VIEWS.map(([v]) => v)).toEqual(['range', 'matrix', 'board']);
  });
});

describe('열 내 상대 농도', () => {
  it('값이 없으면 null — 0 으로 만들지 않는다(0 은 "가장 연함" 이라는 판정이다)', () => {
    expect(heat(null, { min: 0, max: 10 })).toBe(null);
    expect(heat(5, { min: null, max: null })).toBe(null);
    expect(heat('x', { min: 0, max: 10 })).toBe(null);
  });

  it('최소=0, 최대=1, 전부 같으면 0.5(한 값만 진하게 칠하지 않는다)', () => {
    expect(heat(0, { min: 0, max: 10 })).toBe(0);
    expect(heat(10, { min: 0, max: 10 })).toBe(1);
    expect(heat(5, { min: 0, max: 10 })).toBe(0.5);
    expect(heat(7, { min: 7, max: 7 })).toBe(0.5);
  });

  it('columnStats 는 null 을 건너뛴다', () => {
    expect(columnStats([g('a', 1, { exMax: 40 }), g('b', 2, { exMax: 50 })], (x) => x.exhaust.max))
      .toEqual({ min: 40, max: 50 });
    expect(columnStats([], (x) => x.exhaust.max)).toEqual({ min: null, max: null });
  });

  it('★ 흡기 열은 상대 농도를 쓰지 않는다(상태색이 판정이다)', () => {
    const stats = matrixStats([g('a', 20), g('b', 35)]);
    expect(stats.get('inletMax')).toEqual({ min: null, max: null });
    expect(stats.get('exMax').max).toBe(40);
    expect(MATRIX_COLS.filter((c) => c.kind === 'inlet').map((c) => c.key)).toEqual(['inletMin', 'inletAvg', 'inletMax']);
  });
});

describe('월보드', () => {
  it('★ 상태가 없으면 unknown — ok 로 흡수하지 않는다', () => {
    expect(tileData(g('a', 20)).status).toBe('unknown');
    expect(tileData(g('a', 20, { status: 'ok' })).status).toBe('ok');
    expect(tileData(null).status).toBe('unknown');
  });

  it('★ 판정 불가를 정상에 섞지 않는다', () => {
    const c = boardCounts([
      g('a', 20, { status: 'ok' }), g('b', 20, { status: 'lowok' }),
      g('c', 30, { status: 'warn' }), g('d', 35, { status: 'hot' }),
      g('e', 10, { status: 'cold' }), g('f', null),
    ]);
    expect(c).toEqual({ hot: 1, warn: 1, ok: 2, cold: 1, unknown: 1 });
  });

  it('집계 제외(미수집 + 미갱신)를 합쳐 밝힌다', () => {
    expect(tileData(g('a', 20, { noSensor: 3, stale: 2 })).missing).toBe(5);
  });
});

describe('스파크라인', () => {
  const H = 3_600_000;
  const pts = (n, t0 = 1_000_000_000_000) => Array.from({ length: n }, (_, i) => ({ ts: t0 + i * H, avg: 20 + i }));

  it('점이 2개 미만이면 null — 한 점으로 선을 그리지 않는다', () => {
    expect(sparkPath([])).toBe(null);
    expect(sparkPath(pts(1))).toBe(null);
    expect(sparkPath(null)).toBe(null);
  });

  it('★ 수집이 없던 구간은 선을 잇지 않는다(끊어진 subpath)', () => {
    const t0 = 1_000_000_000_000;
    const gapped = [
      { ts: t0, avg: 20 }, { ts: t0 + H, avg: 21 },
      { ts: t0 + 8 * H, avg: 22 }, { ts: t0 + 9 * H, avg: 23 },   // 6시간 공백
    ];
    const p = sparkPath(gapped);
    expect(p.d.match(/M/g).length).toBe(2);   // 공백에서 새 subpath 가 시작된다
    expect(p.n).toBe(4);
  });

  it('연속 구간은 한 줄로 잇는다', () => {
    const p = sparkPath(pts(5));
    expect(p.d.match(/M/g).length).toBe(1);
    expect(p.lo).toBe(20);
    expect(p.hi).toBe(24);
  });

  it('avg 가 null 인 점은 버린다 — 0 으로 채우지 않는다', () => {
    const t0 = 1_000_000_000_000;
    const p = sparkPath([{ ts: t0, avg: 20 }, { ts: t0 + H, avg: null }, { ts: t0 + 2 * H, avg: 22 }]);
    expect(p.n).toBe(2);
    expect(p.lo).toBe(20);
    expect(p.hi).toBe(22);
  });

  it('값이 전부 같아도 터지지 않는다(0 으로 나누지 않는다)', () => {
    const t0 = 1_000_000_000_000;
    const p = sparkPath([{ ts: t0, avg: 20 }, { ts: t0 + H, avg: 20 }]);
    expect(p.d).toMatch(/^M/);
    expect(Number.isFinite(p.lo)).toBe(true);
  });
});
