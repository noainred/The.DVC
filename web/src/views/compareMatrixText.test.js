// v2.499 — 비교 매트릭스 표시·색·정렬 판정 회귀 고정(node 환경 — 순수 함수만).
import { describe, it, expect } from 'vitest';
import {
  cellText, cellSort, cellColor, metricStats, sortRows, vcenterRows, truncatedNote, cellTitle, sparsityNote,
} from './compareMatrixText.js';

const pctMetric = { key: 'cpuUsagePct', label: 'CPU 사용률', unit: '%', higher: 'bad' };
const sizeMetric = { key: 'capacityTB', label: '용량', unit: ' TB', higher: 'neutral' };
const freeMetric = { key: 'freeTB', label: '여유', unit: ' TB', higher: 'good' };

const rows = [
  { name: 'PROD', cells: { kr: { cpuUsagePct: 25, hosts: 2, vms: 3, vmsOn: 2 }, us: { cpuUsagePct: 80, hosts: 1, vms: 1, vmsOn: 1 } }, total: { cpuUsagePct: 44 } },
  { name: 'DEV', cells: { kr: { cpuUsagePct: 10, hosts: 1 } }, total: { cpuUsagePct: 10 } },
  { name: 'DMZ', cells: { pl: { cpuUsagePct: 95, hosts: 1 } }, total: { cpuUsagePct: 95 } },
];

describe('셀 표기', () => {
  it('없는 값은 —(0 으로 채우지 않는다)', () => {
    expect(cellText(null, pctMetric)).toBe('—');
    expect(cellText(undefined, pctMetric)).toBe('—');
    expect(cellText(0, pctMetric)).toBe('0%');
  });
  it('단위를 붙이고 큰 수는 천 단위 구분', () => {
    expect(cellText(25, pctMetric)).toBe('25%');
    expect(cellText(1.25, sizeMetric)).toBe('1.3 TB');
    expect(cellText(12_345, sizeMetric)).toBe('12,345 TB');
  });
  it('정렬 값은 숫자만(없으면 null → 표 규약대로 뒤로)', () => {
    expect(cellSort(12)).toBe(12);
    expect(cellSort(null)).toBe(null);
    expect(cellSort('x')).toBe(null);
  });
});

describe('색 판정', () => {
  const stats = metricStats(rows, 'cpuUsagePct');
  it('보이는 셀의 min/max 를 모수로 삼는다', () => {
    expect(stats).toEqual({ min: 10, max: 95, n: 4 });
  });
  it('퍼센트 지표는 절대 기준도 함께 본다(표 안에서 최저여도 90% 이상은 빨강)', () => {
    expect(cellColor(95, pctMetric, { min: 90, max: 99 })).toBe('red');
    expect(cellColor(78, pctMetric, { min: 78, max: 79 })).toBe('amber');
  });
  it('상대 위치로 칠한다 — 전 사이트가 한가하면 아무 것도 빨갛지 않다', () => {
    const calm = { min: 5, max: 20 };
    expect(cellColor(20, pctMetric, calm)).toBe('red');   // 그 날의 최악은 드러난다
    expect(cellColor(5, pctMetric, calm)).toBe('green');
  });
  it("higher='good' 은 방향이 뒤집힌다", () => {
    expect(cellColor(1, freeMetric, { min: 1, max: 100 })).toBe('red');
    expect(cellColor(100, freeMetric, { min: 1, max: 100 })).toBe('green');
  });
  it('규모 지표(neutral)·없는 값·모수 부족은 색 없음', () => {
    expect(cellColor(999, sizeMetric, { min: 1, max: 1000 })).toBe(null);
    expect(cellColor(null, pctMetric, { min: 1, max: 2 })).toBe(null);
    expect(cellColor(5, pctMetric, { min: 5, max: 5 })).toBe(null);
    expect(cellColor(5, pctMetric, null)).toBe(null);
  });
});

describe('행 정렬', () => {
  it('합계 기준 내림차순이 기본', () => {
    expect(sortRows(rows, 'cpuUsagePct').map((r) => r.name)).toEqual(['DMZ', 'PROD', 'DEV']);
  });
  it('특정 vCenter 열 기준으로도 정렬하고, 그 열에 값이 없는 행은 뒤로', () => {
    const s = sortRows(rows, 'cpuUsagePct', { by: 'kr' });
    expect(s[0].name).toBe('PROD');
    expect(s[1].name).toBe('DEV');
    expect(s[2].name).toBe('DMZ');   // kr 셀이 없다 → 뒤로
  });
  it('오름차순에서도 없는 값은 뒤로 간다', () => {
    const s = sortRows(rows, 'cpuUsagePct', { by: 'kr', dir: 'asc' });
    expect(s.map((r) => r.name)).toEqual(['DEV', 'PROD', 'DMZ']);
  });
});

describe('vCenter 축 전치', () => {
  it('지표를 행으로, vCenter 를 열로 바꾼다', () => {
    const vcs = [
      { id: 'kr', name: '한국', metrics: { cpuUsagePct: 30, hosts: 10 } },
      { id: 'us', name: '미국', metrics: { cpuUsagePct: 70 } },
    ];
    const out = vcenterRows(vcs, [pctMetric, { key: 'hosts', label: '호스트', higher: 'neutral' }]);
    expect(out.vcenters.map((v) => v.id)).toEqual(['kr', 'us']);
    expect(out.rows[0].name).toBe('CPU 사용률');
    expect(out.rows[0].cells.us.cpuUsagePct).toBe(70);
    expect(out.rows[1].cells.us).toBeUndefined();   // 값이 없으면 셀을 만들지 않는다
    expect(out.rows[1].vcenters).toBe(1);
  });
});

describe('안내 문구·툴팁', () => {
  it('절단되지 않으면 문구가 없다', () => {
    expect(truncatedNote({ truncated: false }, '클러스터')).toBe('');
    expect(truncatedNote(null, '클러스터')).toBe('');
  });
  it('절단되면 모집단과 생략 수를 밝힌다', () => {
    const t = truncatedNote({ truncated: true, rowCount: 1100, rows: [1, 2, 3], truncatedRows: 1097, maxRows: 300 }, '데이터스토어');
    expect(t).toContain('1100개 중');
    expect(t).toContain('1097개 생략');
    expect(t).toContain('상한 300');
  });
  it('툴팁은 그 셀이 무엇의 합인지 밝힌다', () => {
    const t = cellTitle({ rowName: 'PROD', vcName: '한국', metric: pctMetric, value: 25, cell: rows[0].cells.kr });
    expect(t).toContain('PROD · 한국');
    expect(t).toContain('CPU 사용률 25%');
    expect(t).toContain('호스트 2');
    const ds = cellTitle({ rowName: 'SAN', vcName: '한국', metric: sizeMetric, value: 20, cell: { count: 2, capacityTB: 20, freeTB: 4 } });
    expect(ds).toContain('데이터스토어 2개 합산');
    expect(ds).toContain('여유 4 TB');
  });
});

describe('희소도 안내 — 대각선 매트릭스라는 사실을 숨기지 않는다', () => {
  const mk = (n, shared) => Array.from({ length: n }, (_, i) => ({ name: `r${i}`, vcenters: i < shared ? 2 : 1, cells: {} }));
  it('행이 적으면 판단하지 않는다', () => {
    expect(sparsityNote(mk(2, 0), '클러스터')).toBe(null);
    expect(sparsityNote([], '클러스터')).toBe(null);
    expect(sparsityNote(null, '클러스터')).toBe(null);
  });
  it('여러 사이트에 걸친 행이 20% 이상이면 안내하지 않는다', () => {
    expect(sparsityNote(mk(10, 2), '클러스터')).toBe(null);
  });
  it('거의 모든 행이 한 vCenter 에만 있으면 그 사실과 대안을 알린다', () => {
    const t = sparsityNote(mk(25, 1), '클러스터');
    expect(t).toContain('이름이 사이트마다 달라');
    expect(t).toContain('1/25개');
    expect(t).toContain('합계');
  });
});
