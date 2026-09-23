/**
 * commMapLayout.js — 통신 지도 라디얼 배치(순수, vitest 고정, v2.584).
 *
 * 형태(사용자 캡처): 중앙 허브 → 안쪽 링(엣지) → 바깥 링(각 엣지가 위임받은 자원). 엣지마다 바깥 링에
 * **부채꼴(sector)** 을 자원 수에 비례해 배정하고 엣지 노드를 그 부채꼴 가운데 각도에 둔다 — 그래야
 * 안쪽 노드와 그 자원이 방사형으로 맞물린다. 중앙 직접 자원은 허브 전용 부채꼴에 둔다.
 *
 * 규칙:
 *  · 좌표계는 viewBox 정사각(`size`), 중심 (size/2, size/2). 반지름은 비율(`R_EDGE`·`R_RES`)로 잡는다.
 *  · 바깥 노드가 `LABEL_MAX` 를 넘으면 라벨을 끄고(겹침) 툴팁만 남긴다 — 그 사실은 `labelsHidden` 으로 밝힌다.
 *  · 서버가 이미 종류별 상한으로 잘랐다(`omitted`). 여기서는 그 개수를 ‘+N’ 노드로 그린다(조용한 상한 금지).
 *  · 엣지가 0곳이어도 허브와 직접 자원은 그린다(화면이 비지 않게).
 */
export const R_EDGE = 0.30;   // 엣지 링 반지름(size 대비)
export const R_RES = 0.455;   // 자원 링 반지름
export const HUB_R = 0.075;   // 허브 반지름
export const LABEL_MAX = 72;  // 바깥 라벨을 그릴 최대 노드 수
export const MIN_SECTOR_W = 1; // 부채꼴 가중치 하한(자원 0개 엣지도 자리를 갖는다)

const TAU = Math.PI * 2;
const KINDS = ['vcenter', 'storage', 'sanswitch', 'pdu'];

/** 부채꼴 안에 n개를 고르게 — 양 끝에 여백을 둬 이웃 부채꼴과 붙지 않게. */
function spread(a0, a1, n) {
  if (n <= 0) return [];
  const w = a1 - a0; const pad = Math.min(w * 0.12, 0.05);
  const s = a0 + pad; const e = a1 - pad;
  if (n === 1) return [(s + e) / 2];
  const step = (e - s) / (n - 1);
  return Array.from({ length: n }, (_, i) => s + step * i);
}

function polar(cx, cy, r, a) { return { x: +(cx + r * Math.cos(a)).toFixed(2), y: +(cy + r * Math.sin(a)).toFixed(2) }; }

/** 자원 목록을 종류 순서로 평탄화 + ‘+N’ 자리표시. */
function flattenResources(res) {
  const out = []; let omitted = 0;
  for (const k of KINDS) {
    const g = res?.[k]; if (!g) continue;
    for (const it of g.items || []) out.push({ ...it, kind: k });
    omitted += Number(g.omitted) || 0;
  }
  return { list: out, omitted };
}

/**
 * @param {object} data  `/tools/comm-map` 응답
 * @param {{size?:number}} opt
 */
export function layoutCommMap(data, { size = 1000 } = {}) {
  const cx = size / 2; const cy = size / 2;
  const rEdge = size * R_EDGE; const rRes = size * R_RES; const hubR = size * HUB_R;
  const edges = Array.isArray(data?.edges) ? data.edges : [];
  const direct = flattenResources(data?.hub?.direct);

  // 부채꼴 가중치: 자원 수 + 1(라벨 자리). 직접 자원은 허브의 부채꼴(엣지가 있을 때만 별도 자리).
  const groups = edges.map((e) => ({ kind: 'edge', e, res: flattenResources(e.resources), w: 0 }));
  if (direct.list.length || direct.omitted) groups.push({ kind: 'direct', e: null, res: direct, w: 0 });
  for (const g of groups) g.w = Math.max(MIN_SECTOR_W, g.res.list.length + (g.res.omitted ? 1 : 0) + 1);
  const wsum = groups.reduce((s, g) => s + g.w, 0) || 1;

  let a = -Math.PI / 2; // 12시 방향부터 시계 방향
  const edgeNodes = []; const resNodes = []; const moreNodes = []; let directSector = null;
  for (const g of groups) {
    const a0 = a; const a1 = a + TAU * (g.w / wsum); a = a1;
    const mid = (a0 + a1) / 2;
    const slots = g.res.list.length + (g.res.omitted ? 1 : 0);
    const angles = spread(a0, a1, slots);
    const owner = g.kind === 'edge' ? g.e.id : '(central)';
    g.res.list.forEach((r, i) => {
      const ang = angles[i];
      resNodes.push({ ...polar(cx, cy, rRes, ang), angle: ang, id: `${owner}|${r.kind}|${r.id}`, owner, kind: r.kind, name: r.name, state: r.state, raw: r });
    });
    if (g.res.omitted) {
      const ang = angles[slots - 1];
      moreNodes.push({ ...polar(cx, cy, rRes, ang), angle: ang, owner, count: g.res.omitted });
    }
    if (g.kind === 'edge') edgeNodes.push({ ...polar(cx, cy, rEdge, mid), angle: mid, sector: [a0, a1], id: g.e.id, name: g.e.name, state: g.e.state, raw: g.e });
    else directSector = { angle: mid, sector: [a0, a1], count: g.res.list.length, omitted: g.res.omitted };
  }
  const outerCount = resNodes.length + moreNodes.length;
  return {
    size, cx, cy, rEdge, rRes, hubR,
    hub: { x: cx, y: cy, r: hubR },
    edges: edgeNodes, resources: resNodes, more: moreNodes, directSector,
    labelsHidden: outerCount > LABEL_MAX, outerCount,
  };
}

/** 두 점 사이의 살짝 휜 경로(입자 애니메이션의 mpath). `bend` 부호로 두 가닥을 나눈다. */
export function arcPath(x1, y1, x2, y2, bend = 0.08) {
  const mx = (x1 + x2) / 2; const my = (y1 + y2) / 2;
  const dx = x2 - x1; const dy = y2 - y1; const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len; const ny = dx / len; // 법선
  const qx = +(mx + nx * len * bend).toFixed(2); const qy = +(my + ny * len * bend).toFixed(2);
  return `M ${x1} ${y1} Q ${qx} ${qy} ${x2} ${y2}`;
}

/** 라벨 정렬 — 오른쪽 반원은 시작 정렬, 왼쪽 반원은 끝 정렬(라벨이 안쪽으로 파고들지 않게). */
export function labelAnchor(angle) {
  const c = Math.cos(angle);
  if (Math.abs(c) < 0.12) return 'middle';
  return c > 0 ? 'start' : 'end';
}
