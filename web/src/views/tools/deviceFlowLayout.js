/**
 * deviceFlowLayout.js — '3단 지도(장비 → 엣지 → 메인)' 의 배치(v2.588, 순수).
 *
 * 한 줄 = 엣지 하나: [장비 묶음 칩들] ── [엣지 카드] ── [메인]. 맨 위 줄은 메인 직접 수집 장비(엣지 칸은 비운다).
 * 메인은 모든 줄을 세로로 덮는 긴 카드라, 엣지 → 메인 선은 거의 수평이다(28곳이어도 선이 서로 엉키지 않는다).
 * 폭은 1440px 본문 안(v2.587 판독 — 더 넓으면 오른쪽이 잘린다). 좁은 화면은 그래프 상자만 가로 스크롤.
 */
import { worstTone } from './deviceFlowText.js';

export const W = 1344;
export const HEAD_H = 26;
export const TOP = HEAD_H + 6;
export const CHIP_X = 0;
export const CHIP_W = 84;
export const CHIP_GAP = 6;
export const CHIP_H = 46;
export const CHIPS_MAX_X = CHIP_X + 5 * CHIP_W + 4 * CHIP_GAP; // 종류 5개가 다 있어도 들어간다
export const EDGE_X = 540;
export const EDGE_W = 260;
export const ROW_H = 58;
export const ROW_GAP = 10;
export const MAIN_X = 1064;
export const MAIN_W = 280;
export const MAIN_MIN_H = 240;

const curve = (x1, y1, x2, y2) => {
  const mx = (x1 + x2) / 2;
  return `M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
};

/**
 * @param data  서버 응답(main·edges)
 * @param sel   null | {type:'edge', id} | {type:'main'} | {type:'group', where, edgeId, kind}
 */
export function layoutDeviceFlow(data = {}, sel = null) {
  const edges = data.edges || [];
  const mainGroups = data.main?.groups || [];
  const selRow = sel?.type === 'edge' ? `edge:${sel.id}` : sel?.type === 'main' ? 'main' : sel?.type === 'group' ? (sel.where === 'main' ? 'main' : sel.where === 'edge' ? `edge:${sel.edgeId}` : null) : null;

  const rows = [];
  const rowOf = (key, kind, groups, edge) => {
    const i = rows.length;
    const y = TOP + i * (ROW_H + ROW_GAP);
    const cy = y + ROW_H / 2;
    const chips = groups.map((g, j) => ({ kind: g.kind, group: g, x: CHIP_X + j * (CHIP_W + CHIP_GAP), y: cy - CHIP_H / 2, w: CHIP_W, h: CHIP_H }));
    const chipsEnd = chips.length ? chips[chips.length - 1].x + CHIP_W : CHIP_X;
    const tone = worstTone(groups);
    const dim = selRow ? selRow !== key : false;
    const row = { key, kind, y, h: ROW_H, cy, chips, dim, edgeId: edge?.id ?? null };
    if (kind === 'direct') {
      // 메인 직접 — 엣지 칸을 지나 메인으로 곧장(점선 아님: 실제 수집 경로다)
      row.inLine = chips.length ? { d: `M${chipsEnd} ${cy} L${MAIN_X} ${cy}`, tone } : null;
      row.outLine = null;
    } else {
      row.inLine = chips.length ? { d: curve(chipsEnd, cy, EDGE_X, cy), tone } : null;
      row.outLine = { d: `M${EDGE_X + EDGE_W} ${cy} L${MAIN_X} ${cy}`, state: edge.line || 'none', dashed: (edge.line || 'none') === 'none' };
      row.edge = { x: EDGE_X, y, w: EDGE_W, h: ROW_H };
    }
    rows.push(row);
  };
  rowOf('main', 'direct', mainGroups, null);
  for (const e of edges) rowOf(`edge:${e.id}`, 'edge', e.groups || [], e);

  const last = rows[rows.length - 1];
  const bottom = last.y + last.h;
  const mainH = Math.max(MAIN_MIN_H, bottom - TOP);
  const height = TOP + mainH + 16;
  return { width: W, height, rows, main: { x: MAIN_X, y: TOP, w: MAIN_W, h: mainH }, cols: { chips: CHIP_X, edge: EDGE_X, main: MAIN_X } };
}
