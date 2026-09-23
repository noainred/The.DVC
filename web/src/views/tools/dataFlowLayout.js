/**
 * dataFlowLayout.js — '데이터 흐름 지도' 의 배치(v2.587, 순수).
 *
 * 왼쪽 데이터 종류 카드 → 가운데 경로 버스(눈금 = 경로) → 오른쪽 엣지 카드 격자.
 * 선은 ① 종류 카드 → 그 종류의 눈금(경로마다 1개) ② 눈금 → 그 경로를 쓴 엣지(**기록 있는 연결만**).
 * 폭은 1440px 화면의 본문(약 1390px) 안에 들어가게 잡았다 — 넘치면 세 번째 열 엣지가 잘려 보인다(v2.587 판독).
 * 컴포넌트는 조립만 한다 — 좌표·선택 강조 판정을 여기서 테스트로 고정한다.
 */

export const W = 1344;
export const TOP = 16;
export const CAT_X = 0;
export const CAT_W = 228;
export const CAT_H = 58;
export const CAT_GAP = 8;
export const BUS_X = 470;
export const BUS_W = 16;
export const EDGE_X = 760;
export const EDGE_COLS = 3;
export const EDGE_W = 184;
export const EDGE_H = 150;
export const EDGE_GAP_X = 16;
export const EDGE_GAP_Y = 22;

const cubic = (x1, y1, x2, y2, bend = 0.5) => {
  const mx = x1 + (x2 - x1) * bend;
  return `M${x1} ${y1} C ${mx} ${y1}, ${x2 - (x2 - x1) * (1 - bend)} ${y2}, ${x2} ${y2}`;
};

/**
 * @param data  서버 응답(routes·cats·edges·links)
 * @param sel   null | {type:'cat'|'edge', id}
 */
export function layoutDataFlow(data = {}, sel = null) {
  const cats = data.cats || [];
  const routes = data.routes || [];
  const edges = data.edges || [];
  const links = data.links || [];

  const catPos = new Map();
  cats.forEach((c, i) => catPos.set(c.id, { x: CAT_X, y: TOP + i * (CAT_H + CAT_GAP), w: CAT_W, h: CAT_H }));
  const catBottom = TOP + cats.length * (CAT_H + CAT_GAP);

  const edgeRows = Math.max(1, Math.ceil(edges.length / EDGE_COLS));
  const edgePos = new Map();
  edges.forEach((e, j) => {
    const col = j % EDGE_COLS, row = Math.floor(j / EDGE_COLS);
    edgePos.set(e.id, { x: EDGE_X + col * (EDGE_W + EDGE_GAP_X), y: TOP + row * (EDGE_H + EDGE_GAP_Y), w: EDGE_W, h: EDGE_H });
  });
  const edgeBottom = TOP + edgeRows * (EDGE_H + EDGE_GAP_Y);

  const height = Math.max(catBottom, edgeBottom, TOP + routes.length * 8 + 40) + 24;
  const busTop = TOP + 10;
  const busBottom = height - 34;
  const step = routes.length > 1 ? (busBottom - busTop) / (routes.length - 1) : 0;
  const tickY = new Map(routes.map((r, i) => [r.id, busTop + i * step]));

  const routeCat = new Map(routes.map((r) => [r.id, r.cat]));
  const hot = (catId, edgeId) => {
    if (!sel) return null;
    if (sel.type === 'cat') return sel.id === catId;
    if (sel.type === 'edge') return edgeId != null && sel.id === edgeId;
    return null;
  };

  const inLines = routes.map((r) => {
    const cp = catPos.get(r.cat); const y2 = tickY.get(r.id);
    const h = sel?.type === 'edge' ? links.some((l) => l.route === r.id && l.edge === sel.id) : hot(r.cat);
    return { key: `in:${r.id}`, route: r.id, cat: r.cat, state: r.state,
      d: cubic(CAT_X + CAT_W, cp.y + CAT_H / 2, BUS_X, y2, 0.55), dim: sel ? !h : false, hot: !!h };
  });

  const outLines = [];
  for (const l of links) {
    const ep = edgePos.get(l.edge); const y1 = tickY.get(l.route);
    if (!ep || y1 == null) continue;
    const h = sel?.type === 'cat' ? routeCat.get(l.route) === sel.id : hot(null, l.edge);
    outLines.push({ key: `out:${l.edge}|${l.route}`, route: l.route, edge: l.edge, state: l.state,
      d: cubic(BUS_X + BUS_W, y1, ep.x, ep.y + 44, 0.42), dim: sel ? !h : false, hot: !!h });
  }
  // 실패 선을 맨 위에 그린다(흰 선 다발에 묻히지 않게).
  const rank = { none: 0, ok: 1, stale: 2, fail: 3 };
  outLines.sort((a, b) => (Number(a.hot) - Number(b.hot)) || (rank[a.state] - rank[b.state]));

  const ticks = routes.map((r) => ({ id: r.id, y: tickY.get(r.id), state: r.state, cat: r.cat }));
  return { width: W, height, catPos, edgePos, ticks, inLines, outLines, bus: { x: BUS_X, w: BUS_W, top: busTop - 8, bottom: busBottom + 8 } };
}
