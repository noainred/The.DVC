/**
 * sanZoningView 회귀(v2.511) — 좌표·상한 표기·문구.
 *
 * 고정하는 핵심:
 *  · 상한으로 잘린 노드는 **개수를 밝힌다**(조용한 상한 금지).
 *  · 같은 열끼리는 선을 긋지 않는다(자리가 없어 겹친다).
 *  · 추정 판정은 '추정' 이라고 말한다 — 확정과 섞지 않는다.
 *  · flip 은 행·열을 바꾸되 셀 내용을 잃지 않는다.
 */
import { describe, it, expect } from 'vitest';
import {
  shortLabel, SIDE_LABEL, CONFIDENCE_LABEL, sourceText, truncationText, confidenceSummary,
  layoutGraph, layoutMatrix, cellColor, matchNode, GRAPH_DEFAULTS, labelMap,
} from './sanZoningView.js';

const n = (wwn, side, extra = {}) => ({ wwn, label: wwn, alias: '', side, confidence: 'inferred', degree: 1, port: null, online: null, hint: '', ...extra });
const graph = {
  nodes: [
    n('10:00:00:10:9b:c2:11:11', 'initiator', { alias: 'ESX10_HBA1', degree: 3 }),
    n('10:00:00:10:9b:c2:53:96', 'initiator', { alias: 'ESX14_HBA1', degree: 2 }),
    n('50:06:01:60:4c:e4:0b:f8', 'target', { alias: 'Unity_SPA0', degree: 2 }),
    n('50:00:09:79:a0:03:98:98', 'target', { alias: 'VMAX_FA03', degree: 1 }),
    n('c0:01:44:87:a7:a5:00:00', 'target', { alias: 'VPLEX_FE_A0', degree: 1 }),
  ],
  links: [
    { a: '10:00:00:10:9b:c2:11:11', b: '50:06:01:60:4c:e4:0b:f8', zone: 'Z1' },
    { a: '10:00:00:10:9b:c2:11:11', b: 'c0:01:44:87:a7:a5:00:00', zone: 'Z2' },
    { a: '10:00:00:10:9b:c2:53:96', b: '50:06:01:60:4c:e4:0b:f8', zone: 'Z3' },
    { a: '10:00:00:10:9b:c2:53:96', b: '50:00:09:79:a0:03:98:98', zone: 'Z4' },
    { a: '10:00:00:10:9b:c2:11:11', b: '10:00:00:10:9b:c2:53:96', zone: 'BAD_SAME_SIDE' },
  ],
  columns: {},
};

describe('라벨·문구', () => {
  it('별칭 > 라벨 > WWN 뒤 4바이트', () => {
    expect(shortLabel({ alias: 'ESX10', label: 'x', wwn: 'a' })).toBe('ESX10');
    expect(shortLabel({ label: 'sym-name', wwn: '10:00:00:10:9b:c2:11:11' })).toBe('sym-name');
    expect(shortLabel({ label: '10:00:00:10:9b:c2:11:11', wwn: '10:00:00:10:9b:c2:11:11' })).toBe('…9b:c2:11:11');
    expect(shortLabel(null)).toBe('');
  });
  it('sourceText — 활성/정의 출처를 구분해 말한다', () => {
    expect(sourceText({ available: true, source: 'effective', effectiveConfig: 'cfg1', counts: { zones: 9, aliases: 7 } }))
      .toBe('cfg1 · 활성 설정(별칭이 이미 WWN 으로 풀린 상태) · zone 9개 · 별칭 7개');
    expect(sourceText({ available: true, source: 'defined', counts: { zones: 2, aliases: 0 } })).toMatch(/정의 설정/);
    expect(sourceText({ available: false, reason: 'cfgshow 미수집' })).toBe('cfgshow 미수집');
    expect(sourceText(null)).toBe('');
  });
  it('truncationText — 잘림·상한을 숨기지 않는다', () => {
    expect(truncationText({ truncated: true })).toMatch(/페이저/);
    expect(truncationText({ limited: true })).toMatch(/수집 상한/);
    expect(truncationText({})).toBe('');
  });
  it('confidenceSummary — 추정이 섞이면 "틀릴 수 있습니다" 를 말한다', () => {
    const all = confidenceSummary([n('a', 'initiator', { confidence: 'confirmed' }), n('b', 'target', { confidence: 'confirmed' })]);
    expect(all.text).toMatch(/네임서버가 확정/);
    const mixed = confidenceSummary(graph.nodes);
    expect(mixed.text).toMatch(/틀릴 수 있습니다/);
    expect(mixed.inferred).toBe(5);
    expect(confidenceSummary([]).text).toBe('');
  });
  it('라벨 상수', () => {
    expect(SIDE_LABEL.middle).toMatch(/가상화/);
    expect(CONFIDENCE_LABEL.confirmed).toMatch(/네임서버/);
    expect(CONFIDENCE_LABEL.none).toBe('판정 못 함');
  });
});

describe('layoutGraph', () => {
  it('열 배치 · 같은 열끼리는 선을 긋지 않는다', () => {
    const L = layoutGraph(graph, {});
    expect(L.cols.map((c) => c.key)).toEqual(['left', 'right']);
    expect(L.cols[0].title).toMatch(/이니시에이터/);
    expect(L.cols[1].title).toMatch(/타깃/);
    expect(L.cols[0].nodes).toHaveLength(2);
    expect(L.cols[1].nodes).toHaveLength(3);
    // 같은 쪽(BAD_SAME_SIDE)은 제외되어 4개만 남는다.
    expect(L.edges).toHaveLength(4);
    expect(L.edges.some((e) => e.zone === 'BAD_SAME_SIDE')).toBe(false);
    // 선은 왼쪽 박스 오른쪽 끝 → 오른쪽 박스 왼쪽 끝.
    expect(L.edges[0].x1).toBe(GRAPH_DEFAULTS.colWidth);
    expect(L.edges[0].x2).toBe(GRAPH_DEFAULTS.colWidth + GRAPH_DEFAULTS.colGap);
    expect(L.width).toBeGreaterThan(0);
  });
  it('middle 이 있으면 3열', () => {
    const g = { ...graph, nodes: [...graph.nodes, n('c0:01:44:87:a8:0e:8a:00', 'middle')] };
    expect(layoutGraph(g, {}).cols.map((c) => c.key)).toEqual(['left', 'middle', 'right']);
  });
  it('flip — 좌우가 바뀌고 제목도 따라 바뀐다', () => {
    const L = layoutGraph(graph, { flip: true });
    expect(L.cols[0].nodes).toHaveLength(3);
    expect(L.cols[0].title).toMatch(/타깃/);
    expect(L.cols[1].title).toMatch(/이니시에이터/);
    expect(L.edges).toHaveLength(4);
  });
  it('상한 초과는 잘라내고 **개수를 밝힌다**', () => {
    const many = { nodes: Array.from({ length: 10 }, (_, i) => n(`i${i}`, 'initiator')).concat([n('t', 'target')]), links: [] };
    const L = layoutGraph(many, { maxRows: 4 });
    expect(L.cols[0].nodes).toHaveLength(4);
    expect(L.omitted.left).toBe(6);
    expect(L.shown.left).toBe(4);
  });
  it('focus — 그 노드에 직접 연결된 것만 남긴다', () => {
    const L = layoutGraph(graph, { focus: '10:00:00:10:9b:c2:53:96' });
    const shown = L.cols.flatMap((c) => c.nodes).map((x) => x.wwn);
    expect(shown).toContain('10:00:00:10:9b:c2:53:96');
    expect(shown).toContain('50:00:09:79:a0:03:98:98');
    expect(shown).not.toContain('c0:01:44:87:a7:a5:00:00');
  });
  it('hover — 관련 없는 선을 dim 표시(지우지 않는다)', () => {
    const L = layoutGraph(graph, { hover: '10:00:00:10:9b:c2:11:11' });
    expect(L.edges.filter((e) => !e.dim).length).toBe(2);
    expect(L.edges.filter((e) => e.dim).length).toBe(2);
  });
  it('빈 그래프에도 던지지 않는다', () => {
    for (const bad of [null, undefined, { nodes: [], links: [] }]) {
      const L = layoutGraph(bad, {});
      expect(L.edges).toEqual([]);
      expect(L.height).toBeGreaterThan(0);
    }
  });
});

describe('layoutMatrix', () => {
  const matrix = {
    rows: [n('i1', 'initiator', { alias: 'ESX10' }), n('i2', 'initiator', { alias: 'ESX14' })],
    cols: [n('t1', 'target', { alias: 'Unity' }), n('t2', 'target', { alias: 'VMAX' })],
    cells: [{ r: 0, c: 0, n: 2, zones: ['Z1', 'Z2'] }, { r: 1, c: 1, n: 1, zones: ['Z4'] }],
  };
  it('좌표 · 크기', () => {
    const M = layoutMatrix(matrix, { cell: 20, labelW: 100, labelH: 80 });
    expect(M.width).toBe(140);
    expect(M.height).toBe(120);
    expect(M.cells[0]).toMatchObject({ x: 100, y: 80, n: 2 });
    expect(M.cells[1]).toMatchObject({ x: 120, y: 100, n: 1 });
    expect(M.rows[1].y).toBe(100);
    expect(M.cols[1].x).toBe(120);
  });
  it('flip — 행·열을 바꾸되 셀을 잃지 않는다', () => {
    const M = layoutMatrix(matrix, { flip: true });
    expect(M.rows.map((r) => r.wwn)).toEqual(['t1', 't2']);
    expect(M.cols.map((c) => c.wwn)).toEqual(['i1', 'i2']);
    expect(M.cells).toHaveLength(2);
    expect(new Set(M.cells.flatMap((c) => c.zones))).toEqual(new Set(['Z1', 'Z2', 'Z4']));
  });
  it('상한 초과는 잘라내고 개수를 밝힌다', () => {
    const big = {
      rows: Array.from({ length: 5 }, (_, i) => n(`r${i}`, 'initiator')),
      cols: Array.from({ length: 5 }, (_, i) => n(`c${i}`, 'target')),
      cells: [{ r: 4, c: 4, n: 1, zones: ['Zx'] }],
    };
    const M = layoutMatrix(big, { maxRows: 2, maxCols: 2 });
    expect(M.omitted).toEqual({ rows: 3, cols: 3 });
    expect(M.cells).toHaveLength(0, '잘린 영역의 셀은 그리지 않는다');
  });
  it('빈 입력에도 던지지 않는다', () => {
    expect(layoutMatrix(null, {}).cells).toEqual([]);
  });
});

describe('cellColor · matchNode', () => {
  it('0 은 그리지 않는다(빈 칸 = 경로 없음)', () => {
    expect(cellColor(0)).toBe('transparent');
    expect(cellColor(null)).toBe('transparent');
    expect(cellColor(1)).not.toBe('transparent');
    expect(cellColor(3)).not.toBe(cellColor(1));
  });
  it('검색은 이름·별칭·WWN·포트를 본다', () => {
    const node = n('50:06:01:60:4c:e4:0b:f8', 'target', { alias: 'Unity_SPA0', port: '3/9' });
    expect(matchNode(node, '')).toBe(true);
    expect(matchNode(node, 'unity')).toBe(true);
    expect(matchNode(node, '4c:e4')).toBe(true);
    expect(matchNode(node, '3/9')).toBe(true);
    expect(matchNode(node, 'esx')).toBe(false);
  });
});

describe('labelMap — 뒤 4바이트가 겹치면 라벨이 같아 보인다(v2.511 스크린샷에서 발견)', () => {
  // 실제 현장 값: Unity SPA0/SPB0 은 뒤 4바이트가 같다.
  const SPA = '50:06:01:60:4c:e4:0b:f8';
  const SPB = '50:06:01:69:4c:e4:0b:f8';
  it('충돌한 것만 앞으로 늘려 유일하게 만든다', () => {
    const m = labelMap([n(SPA, 'target'), n(SPB, 'target'), n('10:00:00:10:9b:c2:11:11', 'initiator')]);
    expect(m.get(SPA)).not.toBe(m.get(SPB));
    expect(m.get(SPA)).toContain('4c:e4:0b:f8');
    expect(m.has('10:00:00:10:9b:c2:11:11')).toBe(false, '충돌하지 않은 것은 손대지 않는다(라벨이 길어지지 않게)');
    // shortLabel 이 그 라벨을 실제로 쓴다.
    expect(shortLabel({ wwn: SPA, label: SPA }, m)).toBe(m.get(SPA));
    expect(shortLabel({ wwn: SPB, label: SPB }, m)).toBe(m.get(SPB));
  });
  it('별칭·심볼릭 이름이 있으면 건드리지 않는다(스위치가 지은 이름이 우선)', () => {
    const m = labelMap([
      { ...n(SPA, 'target'), alias: 'Unity_SPA0' },
      { ...n(SPB, 'target'), label: 'Unity SPB0' },
    ]);
    expect(m.size).toBe(0);
    expect(shortLabel({ wwn: SPA, alias: 'Unity_SPA0' }, m)).toBe('Unity_SPA0');
  });
  it('labels 없이 호출하던 기존 사용처는 그대로 동작한다', () => {
    expect(shortLabel({ wwn: SPA, label: SPA })).toBe('…4c:e4:0b:f8');
    expect(labelMap([]).size).toBe(0);
    expect(labelMap().size).toBe(0);
  });
});
