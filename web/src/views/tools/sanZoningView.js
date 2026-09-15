/**
 * sanZoningView.js — SAN 조닝 그림의 레이아웃·라벨·문구(순수, v2.511).
 *
 * 웹 테스트가 node 환경(DOM 없음)이라 **좌표 계산과 문구는 여기서** 회귀로 고정한다
 * (accessDeniedText·loadState·vmSeriesText 와 같은 관례). 컴포넌트는 그리기만 한다.
 *
 * 정직 규약
 *  · 역할 판정이 추정이면 그렇게 적는다(`confidence`). 확정(네임서버)과 섞지 않는다.
 *  · 상한으로 잘린 노드·링크는 **개수를 밝힌다**(조용한 상한 금지).
 *  · 같은 장비가 양쪽 열에 나타날 수 있다(VPLEX FE/BE) — 오류가 아니라 사실이므로 그렇게 설명한다.
 */

/** 이름 라벨 — 별칭 > 네임서버 심볼릭 > WWN 뒤 4바이트. WWN 전체는 툴팁에.
 *  `labels`(labelMap 결과)를 주면 **충돌 해소된 라벨**을 쓴다 — 아래 labelMap 주석 참조. */
export function shortLabel(node, labels) {
  const fixed = labels?.get?.(node?.wwn);
  if (fixed) return fixed;
  if (node?.alias) return node.alias;
  if (node?.label && node.label !== node.wwn) return node.label;
  const w = String(node?.wwn || '');
  return w ? `…${w.slice(-11)}` : '';
}

/**
 * 표시 라벨 충돌 해소(v2.511 — Chromium 스크린샷을 읽다가 발견한 실제 결함).
 *
 * 뒤 4바이트만 보여 주면 **서로 다른 WWN 이 같은 라벨로 보인다**. 이 현장 출력에서 실제로
 * 그랬다: Unity SPA0 `50:06:01:60:4c:e4:0b:f8` 과 SPB0 `50:06:01:69:4c:e4:0b:f8` 은 뒤 4바이트가
 * 같아 그림·매트릭스에 `…4c:e4:0b:f8` 두 줄로 나왔다(같은 장비를 두 번 그린 것처럼 보인다 —
 * 조닝 확인이 목적인 화면에서 이건 오독을 만든다).
 *
 * 그래서 **충돌한 것만** 유일해질 때까지 앞으로 늘린다(전부 늘리면 라벨이 길어져 박스를 넘친다).
 * 별칭·심볼릭 이름이 있는 노드는 그대로 둔다(스위치가 지은 이름이 진실의 원천).
 */
export function labelMap(nodes = []) {
  const out = new Map();
  const tails = new Map();   // 뒤 4바이트 라벨로 떨어지는 노드들만 모은다
  for (const n of nodes) {
    if (n?.alias || (n?.label && n.label !== n.wwn)) continue;
    const w = String(n?.wwn || '');
    if (!w) continue;
    const k = w.slice(-11);
    if (!tails.has(k)) tails.set(k, []);
    tails.get(k).push(w);
  }
  for (const [, group] of tails) {
    if (group.length < 2) continue;
    // 3바이트씩 늘려 가며(콜론 포함 3글자 단위) 전부 유일해지는 첫 길이를 찾는다.
    let len = 11;
    while (len < 23) {
      len += 3;
      if (new Set(group.map((w) => w.slice(-len))).size === group.length) break;
    }
    for (const w of group) out.set(w, `…${w.slice(-len)}`);
  }
  return out;
}

export const SIDE_LABEL = {
  initiator: '이니시에이터',
  target: '타깃',
  middle: '가운데(가상화 계층)',
  unknown: '미분류',
};

export const CONFIDENCE_LABEL = {
  confirmed: '확정 — 스위치 네임서버',
  inferred: '추정 — zone 그래프 구조',
  guess: '추정 — WWN 단서',
  none: '판정 못 함',
};

/** 화면 상단 한 줄 — 무엇을 보고 있는지. 숫자는 서버가 준 것만 쓴다. */
export function sourceText(z) {
  if (!z) return '';
  if (!z.available) return z.reason || '조닝 데이터가 없습니다.';
  const src = z.source === 'effective' ? '활성 설정(별칭이 이미 WWN 으로 풀린 상태)'
    : z.source === 'defined' ? '정의 설정(별칭을 포탈이 풀었습니다)' : '출처 불명';
  const cfg = z.effectiveConfig ? `${z.effectiveConfig} · ` : '';
  return `${cfg}${src} · zone ${z.counts?.zones ?? z.zoneCount ?? 0}개 · 별칭 ${z.counts?.aliases ?? 0}개`;
}

/** 잘림·상한 경고. 없으면 빈 문자열. */
export function truncationText(z) {
  const parts = [];
  if (z?.truncated) parts.push('스위치 출력이 페이저(--More--)로 잘렸습니다 — 일부 zone 이 빠졌을 수 있습니다.');
  if (z?.limited) parts.push('zone/별칭이 수집 상한을 넘어 일부만 저장했습니다(설정 SANSW_ZONE_MAX).');
  return parts.join(' ');
}

/** 판정 근거 요약 — 확정/추정/미판정 개수. 사용자가 그림을 얼마나 믿을지 정할 근거. */
export function confidenceSummary(nodes = []) {
  const c = { confirmed: 0, inferred: 0, guess: 0, none: 0 };
  for (const n of nodes) c[n.confidence] = (c[n.confidence] || 0) + 1;
  const total = nodes.length;
  if (!total) return { total, ...c, text: '' };
  const text = c.confirmed === total
    ? '모든 엔드포인트의 역할을 스위치 네임서버가 확정했습니다.'
    : `역할 판정: 확정 ${c.confirmed} · 추정 ${c.inferred + c.guess} · 미판정 ${c.none} — 추정은 zone 연결 구조와 WWN 단서로 나눈 것이라 **틀릴 수 있습니다**. 좌우 바꾸기로 확인하세요.`;
  return { total, ...c, text };
}

/* ────────────────── 이분(3열) 그래프 레이아웃 ────────────────── */

export const GRAPH_DEFAULTS = {
  colWidth: 210,      // 라벨 박스 폭
  rowGap: 26,         // 노드 세로 간격
  padY: 18,
  maxRows: 60,        // 열당 표시 상한(넘으면 잘라내고 개수를 밝힌다)
  colGap: 150,        // 열 사이 간격
};

/**
 * 노드·링크 → SVG 좌표.
 * @param graph  서버 buildZoneGraph 결과(nodes/links/columns)
 * @param opts   { flip:boolean(좌우 반전), focus:wwn|null, maxRows, ... }
 * @returns { width, height, cols:[{key,title,x,nodes:[{...node,x,y}]}], edges:[{x1,y1,x2,y2,zone,a,b,dim}], omitted:{} }
 */
export function layoutGraph(graph, opts = {}) {
  const o = { ...GRAPH_DEFAULTS, ...opts };
  const nodes = graph?.nodes || [];
  const byWwn = new Map(nodes.map((n) => [n.wwn, n]));
  const pick = (side) => nodes.filter((n) => n.side === side);
  let leftNodes = pick('initiator');
  let rightNodes = pick('target');
  if (o.flip) { const t = leftNodes; leftNodes = rightNodes; rightNodes = t; }
  const midNodes = nodes.filter((n) => n.side === 'middle' || n.side === 'unknown');

  // 포커스가 있으면 그 노드와 직접 연결된 것만 남긴다(대형 패브릭에서 털뭉치 방지).
  let links = graph?.links || [];
  if (o.focus) {
    const keep = new Set([o.focus]);
    for (const l of links) { if (l.a === o.focus) keep.add(l.b); if (l.b === o.focus) keep.add(l.a); }
    leftNodes = leftNodes.filter((n) => keep.has(n.wwn));
    rightNodes = rightNodes.filter((n) => keep.has(n.wwn));
    links = links.filter((l) => keep.has(l.a) && keep.has(l.b));
  }

  const omitted = {};
  const cut = (arr, key) => {
    if (arr.length <= o.maxRows) return arr;
    omitted[key] = arr.length - o.maxRows;
    return arr.slice(0, o.maxRows);   // 이미 차수 내림차순 정렬(서버) — 중요한 것부터 남는다
  };
  const L = cut(leftNodes, 'left');
  const M = cut(midNodes, 'middle');
  const R = cut(rightNodes, 'right');

  const hasMid = M.length > 0;
  const colDefs = hasMid
    ? [{ key: 'left', nodes: L }, { key: 'middle', nodes: M }, { key: 'right', nodes: R }]
    : [{ key: 'left', nodes: L }, { key: 'right', nodes: R }];
  const titleOf = (key) => {
    if (key === 'middle') return '가운데 — 가상화 계층·미분류';
    const isLeft = key === 'left';
    const side = o.flip ? (isLeft ? 'target' : 'initiator') : (isLeft ? 'initiator' : 'target');
    return side === 'initiator' ? '이니시에이터(호스트·VPLEX 백엔드)' : '타깃(스토리지·VPLEX 프론트엔드)';
  };

  const cols = colDefs.map((c, i) => ({
    key: c.key,
    title: titleOf(c.key),
    x: i * (o.colWidth + o.colGap),
    nodes: c.nodes.map((n, r) => ({ ...n, x: i * (o.colWidth + o.colGap), y: o.padY + r * o.rowGap })),
  }));
  const pos = new Map();
  for (const c of cols) for (const n of c.nodes) pos.set(n.wwn, { x: c.x, y: n.y, col: c.key });

  const edges = [];
  for (const l of links) {
    const a = pos.get(l.a); const b = pos.get(l.b);
    if (!a || !b || a.col === b.col) continue;      // 같은 열끼리는 선을 긋지 않는다(자리가 없다)
    const [from, to] = a.x < b.x ? [a, b] : [b, a];
    edges.push({
      x1: from.x + o.colWidth, y1: from.y, x2: to.x, y2: to.y,
      zone: l.zone, a: l.a, b: l.b,
      dim: !!(o.hover && l.a !== o.hover && l.b !== o.hover),
    });
  }
  const rows = Math.max(...cols.map((c) => c.nodes.length), 1);
  return {
    width: cols.length * o.colWidth + (cols.length - 1) * o.colGap,
    height: o.padY * 2 + rows * o.rowGap,
    cols, edges, omitted,
    shown: { left: L.length, middle: M.length, right: R.length, links: edges.length },
    byWwn,
  };
}

/* ────────────────── 매트릭스 ────────────────── */

export const MATRIX_DEFAULTS = { cell: 18, labelW: 190, labelH: 130, maxRows: 80, maxCols: 80 };

/**
 * 매트릭스 좌표. 행=이니시에이터(또는 flip 시 타깃), 열=반대편.
 * @returns { width, height, rows, cols, cells:[{x,y,n,zones,row,col}], omitted }
 */
export function layoutMatrix(matrix, opts = {}) {
  const o = { ...MATRIX_DEFAULTS, ...opts };
  let rows = matrix?.rows || []; let cols = matrix?.cols || [];
  let cells = matrix?.cells || [];
  if (o.flip) {
    const t = rows; rows = cols; cols = t;
    cells = cells.map((c) => ({ ...c, r: c.c, c: c.r }));
  }
  const omitted = {};
  if (rows.length > o.maxRows) { omitted.rows = rows.length - o.maxRows; }
  if (cols.length > o.maxCols) { omitted.cols = cols.length - o.maxCols; }
  const rKeep = rows.slice(0, o.maxRows); const cKeep = cols.slice(0, o.maxCols);
  const rIdx = new Map(rKeep.map((n, i) => [n.wwn, i]));
  const cIdx = new Map(cKeep.map((n, i) => [n.wwn, i]));
  const out = [];
  for (const cell of cells) {
    const rn = rows[cell.r]; const cn = cols[cell.c];
    if (!rn || !cn) continue;
    const ri = rIdx.get(rn.wwn); const ci = cIdx.get(cn.wwn);
    if (ri == null || ci == null) continue;
    out.push({ x: o.labelW + ci * o.cell, y: o.labelH + ri * o.cell, n: cell.n, zones: cell.zones, row: rn, col: cn });
  }
  return {
    width: o.labelW + cKeep.length * o.cell,
    height: o.labelH + rKeep.length * o.cell,
    rows: rKeep.map((n, i) => ({ ...n, y: o.labelH + i * o.cell })),
    cols: cKeep.map((n, i) => ({ ...n, x: o.labelW + i * o.cell })),
    cells: out, omitted, cell: o.cell, labelW: o.labelW, labelH: o.labelH,
  };
}

/** 셀 색 — 연결 수에 따른 농도. 0 은 그리지 않는다(빈 칸 = 경로 없음). */
export function cellColor(n) {
  if (!(n > 0)) return 'transparent';
  if (n === 1) return 'rgba(96,165,250,.55)';
  if (n === 2) return 'rgba(74,222,128,.65)';
  return 'rgba(251,191,36,.75)';
}

/** 결함 심각도 → 배지 클래스(기존 규약과 같은 이름). */
export const SEVERITY_BADGE = { warn: 'amber', info: 'gray', error: 'red' };

/** 검색어로 노드 필터 — 이름·별칭·WWN·포트. */
export function matchNode(node, q) {
  const t = String(q || '').trim().toLowerCase();
  if (!t) return true;
  return [node.label, node.alias, node.wwn, node.port, node.hint].filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(t));
}
