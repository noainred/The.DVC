// v2.688 — 베어메탈 스토리지 화면 재구성(시안 'BM Storage v2') + 그룹별 사용량·추이.
// 사용자 요청: "그룹별로 사용량, 추이 볼 수 있게 하고, 그룹별로 볼때 소팅은 사용량 많은 순서로"(정렬 기준은 사용량(TB) — 사용자 선택).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
import {
  changeOf, ratePerDay, daysTo90, watchList, headline, yRange, yTicks, sortGroupsByUsed, sortServers,
  groupColors, groupKeyOf, seriesMap, contributions, daysText, pctText, lastOf, pathFor, dotsFor, NO_GROUP,
} from './bmStorHistoryText.js';

const TB = 1024 ** 4; const H = 3_600_000; const D = 24 * H;
const t0 = 1_790_000_000_000;
// used/avail 은 TB 단위. total = used + avail(+ 예약 0).
const pt = (day, used, avail = 100 - used, extra = {}) => ({ ts: t0 + day * D, usedBytes: used * TB, availBytes: avail * TB, totalBytes: (used + avail) * TB, partial: false, ...extra });
const ser = (kind, key, name, points) => ({ kind, key, name, points });

describe('기간 변화 · 증가율 · 90% 도달', () => {
  it('부분 합 점은 변화 계산에서 빠진다(첫·마지막 온전한 점)', () => {
    const s = ser('total', '', '전체', [pt(0, 40), pt(1, 10, 90, { partial: true }), pt(7, 47), pt(7.5, 5, 95, { partial: true })]);
    expect(changeOf(s)).toBe(7 * TB);
    expect(ratePerDay(s)).toBeCloseTo(1 * TB);
  });
  it('기록이 1개뿐이면 변화·증가율·도달 추정이 null', () => {
    const s = ser('total', '', '전체', [pt(0, 40)]);
    expect(changeOf(s)).toBeNull();
    expect(ratePerDay(s)).toBeNull();
    expect(daysTo90(s)).toBeNull();
  });
  it('90% 도달 — 선형 추정, 증가가 0 이하이면 null, 이미 넘었으면 0', () => {
    // 하루 1 TB 증가 · 마지막 47/100 → 90 까지 43 TB → 43일
    expect(daysTo90(ser('t', '', '', [pt(0, 40), pt(7, 47)]))).toBe(43);
    expect(daysTo90(ser('t', '', '', [pt(0, 47), pt(7, 47)]))).toBeNull();
    expect(daysTo90(ser('t', '', '', [pt(0, 50), pt(7, 47)]))).toBeNull();
    expect(daysTo90(ser('t', '', '', [pt(0, 90), pt(7, 92)]))).toBe(0);
    expect(daysText(0)).toBe('이미 90% 이상');
    expect(daysText(null)).toBe('—');
    expect(pctText(null)).toBe('—');
  });
});

describe('그룹 — 사용량 많은 순 정렬 · 색 · 주의 목록', () => {
  const groups = [
    { name: 'AZ-master', usedBytes: 10 * TB, availBytes: 90 * TB, usedPct: 10 },
    { name: 'MI-worker', usedBytes: 300 * TB, availBytes: 30 * TB, usedPct: 90.9 },
    { name: 'AZ-worker', usedBytes: 120 * TB, availBytes: 30 * TB, usedPct: 80 },
    { name: NO_GROUP, usedBytes: 0, availBytes: 0, usedPct: null },
    { name: 'MI-master', usedBytes: 50 * TB, availBytes: 50 * TB, usedPct: 50 },
  ];
  it('사용량(바이트) 많은 순 — 사용률 순이 아니다 · 못 읽은 그룹은 뒤로 · 원본 불변', () => {
    const before = groups.map((g) => g.name);
    expect(sortGroupsByUsed(groups).map((g) => g.name)).toEqual(['MI-worker', 'AZ-worker', 'MI-master', 'AZ-master', NO_GROUP]);
    expect(groups.map((g) => g.name)).toEqual(before);
    // 사용률은 낮아도 사용량이 크면 앞(사용자 선택)
    const g2 = [{ name: 'a', usedBytes: 5 * TB, availBytes: 0, usedPct: 100 }, { name: 'b', usedBytes: 50 * TB, availBytes: 450 * TB, usedPct: 10 }];
    expect(sortGroupsByUsed(g2).map((g) => g.name)).toEqual(['b', 'a']);
  });
  it('그룹 색은 이름순 자리로 정해 사용량 순위가 바뀌어도 같다', () => {
    const a = groupColors(['b', 'a', 'c']); const b = groupColors(['c', 'b', 'a']);
    expect(a.get('a')).toBe(b.get('a'));
    expect(a.get('c')).toBe(b.get('c'));
    expect(groupKeyOf(NO_GROUP)).toBe('');
  });
  it('주의 목록: 75% 이상 또는 30일 내 90% · 사용률 null 그룹 제외 · 위험도 순', () => {
    const gs = seriesMap([
      ser('group', 'MI-master', 'MI-master', [pt(0, 40, 60), pt(7, 50, 50)]),   // 하루 ~1.43TB · 90까지 40TB → 28일
      ser('group', '', NO_GROUP, [pt(0, 0, 0), pt(7, 0, 0)]),
    ], 'group');
    const w = watchList(groups, gs);
    expect(w.map((x) => x.name)).toEqual(['MI-worker', 'MI-master', 'AZ-worker']);   // 같은 주의 단계 안에서는 도달이 가까운 것 먼저
    expect(w[0].level).toBe('crit');
    expect(w[1].days).toBe(28);
    expect(w[2].level).toBe('warn');
    expect(w.some((x) => x.name === NO_GROUP)).toBe(false);
  });
});

describe('서버가 여러 그룹에 속하면 그룹 합이 전체보다 클 수 있다(그룹은 관점별 묶음)', () => {
  it('기여 목록의 비율 합이 100% 를 넘을 수 있고, 감소·기록 부족은 비율 null', () => {
    const total = ser('total', '', '전체', [pt(0, 40), pt(7, 50)]);
    const gA = ser('group', 'A', 'A', [pt(0, 30), pt(7, 38)]);
    const gB = ser('group', 'B', 'B', [pt(0, 25), pt(7, 33)]);   // 같은 서버가 A·B 둘 다
    const gC = ser('group', 'C', 'C', [pt(0, 5)]);
    const c = contributions([gC, gA, gB], changeOf(total));
    expect(c.map((x) => x.key)).toEqual(['A', 'B', 'C']);
    expect(c[0].share + c[1].share).toBeGreaterThan(100);
    expect(c[2].share).toBeNull();
  });
});

describe('머리 문장', () => {
  it('전체 합계 — 기록 1개면 —', () => {
    const one = headline('total', { periodLabel: '7일', series: [ser('total', '', '전체', [pt(0, 40)])] });
    expect(one.main).toContain('**—**');
    const two = headline('total', { periodLabel: '7일', series: [ser('total', '', '전체', [pt(0, 40), pt(7, 47)])] });
    expect(two.main).toContain('**+7.0 TB**');
    expect(two.main).toContain('늘어');
    expect(two.sub).toContain('약 43일');
    expect(two.sub).toContain('선형 추정');
  });
  it('그룹·서버·강조 문장', () => {
    const list = [ser('group', 'A', 'A', [pt(0, 70, 30), pt(7, 80, 20)]), ser('group', 'B', 'B', [pt(0, 10), pt(7, 30)])];
    const g = headline('group', { periodLabel: '7일', series: list });
    expect(g.main).toContain('**A 80.0%**');
    expect(g.sub).toContain('B(+20.0 TB)');
    const s = headline('server', { periodLabel: '7일', series: list, scopeLabel: 'X' });
    expect(s.main).toContain('X 그룹 2대');
    const f = headline('group', { periodLabel: '7일', series: list }, 'B');
    expect(f.main).toContain('B 사용률은 지금 **30.0%**');
    for (const t of [g.main, g.sub, s.main, s.sub, f.main, f.sub]) expect(t).not.toContain('`');
  });
});

describe('세로축 범위 · 선', () => {
  const list = [ser('total', '', '전체', [pt(0, 400, 600), pt(7, 412, 588)])];
  it('전체 합계 확대 — 5 TB 단위 · 0 아래로 가지 않음 · 데이터가 범위 안', () => {
    const r = yRange('total', 'tb', 'zoom', list);
    expect(r.min % (5 * TB)).toBe(0);
    expect(r.max % (5 * TB)).toBe(0);
    expect(r.min).toBeLessThan(400 * TB);
    expect(r.max).toBeGreaterThan(412 * TB);
    expect(r.min).toBeGreaterThan(0);
    expect(yRange('total', 'tb', 'zoom', [ser('total', '', '', [pt(0, 1, 1)])]).min).toBe(0);
  });
  it('0~총 용량 · % · TB', () => {
    expect(yRange('total', 'tb', 'capacity', list)).toEqual({ min: 0, max: 1000 * TB * 1.05, kind: 'bytes' });
    expect(yRange('group', 'pct', 'zoom', list)).toEqual({ min: 0, max: 100, kind: 'pct' });
    expect(yRange('server', 'tb', 'zoom', list).max).toBeCloseTo(412 * TB * 1.1);
    expect(yTicks({ min: 0, max: 100, kind: 'pct' }).map((t) => t.label)).toEqual(['0%', '25%', '50%', '75%', '100%']);
  });
  it('yMin 을 주면 그 값이 바닥 · % 선은 함수 pick', () => {
    const p = pathFor(list[0].points, { t0, t1: t0 + 7 * D, h: 100, yMin: 400 * TB, yMax: 412 * TB });
    expect(p.d).toContain(',100.0');   // 400 = 바닥
    expect(p.d).toContain(',0.0');     // 412 = 천장
    const pct = (q) => (q.usedBytes / (q.usedBytes + q.availBytes)) * 100;
    const d = dotsFor(list[0].points, { t0, t1: t0 + 7 * D, h: 100, yMin: 0, yMax: 100, pick: pct });
    expect(d[0].y).toBeCloseTo(60);
  });
});

describe('서버 목록 정렬', () => {
  const rows = [
    { name: 'b', ok: true, usedPct: 50, availBytes: 10 }, { name: 'a', ok: true, usedPct: 95, availBytes: 50 },
    { name: 'c', ok: false, usedPct: null, availBytes: null }, { name: 'd', ok: true, usedPct: null, availBytes: 0 },
  ];
  it('사용률·여유·이름 — 값 없는 행은 항상 뒤', () => {
    expect(sortServers(rows, 'pct').map((r) => r.name)).toEqual(['a', 'b', 'c', 'd']);
    expect(sortServers(rows, 'avail').map((r) => r.name)).toEqual(['d', 'b', 'a', 'c']);
    expect(sortServers(rows, 'name').map((r) => r.name)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('lastOf 는 부분 합을 건너뛴다', () => {
    expect(lastOf(ser('s', 'x', 'x', [pt(0, 10), pt(1, 1, 99, { partial: true })])).usedBytes).toBe(10 * TB);
    expect(lastOf(ser('s', 'x', 'x', []))).toBeNull();
  });
});

describe('화면 소스 계약', () => {
  const read = (f) => fs.readFileSync(path.join(HERE, f), 'utf8');
  it('그룹 카드·추이 목록은 sortGroupsByUsed(사용량 순)를 쓰고, 추이는 폴링하지 않는다', () => {
    const tool = read('BmStorageTool.jsx'); const panel = read('BmStorHistoryPanel.jsx');
    expect(tool).toContain('sortGroupsByUsed(');
    expect(panel).toContain('sortGroupsByUsed(');
    expect(panel).not.toMatch(/setInterval\(/);
    expect(tool).toContain('canCsv()');
  });
});
