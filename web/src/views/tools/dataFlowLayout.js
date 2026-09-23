/**
 * dataFlowLayout.js — '데이터 흐름 지도' 의 배치(v2.587, 순수).
 *
 * 왼쪽 데이터 종류 카드 → 가운데 경로 버스(눈금 = 경로) → 엣지 카드 격자(2열) → 오른쪽 MAIN(중앙 포탈) 카드.
 * 선은 ① 종류 카드 → 그 종류의 눈금(경로마다 1개) ② 눈금 → 그 경로를 쓴 엣지(**기록 있는 연결만**)
 * ③ 엣지 ↔ MAIN 두 가닥(v2.591 — **데이터가 가는 방향**. 사용자 선택).
 * 폭은 1440px 화면의 본문(약 1390px) 안에 들어가게 잡았다 — 넘치면 오른쪽 카드가 잘려 보인다(v2.587 판독).
 * 컴포넌트는 조립만 한다 — 좌표·선택 강조 판정을 여기서 테스트로 고정한다.
 *
 * v2.591 MAIN 연결:
 *  · 방향은 **데이터가 가는 쪽**이다(누가 요청했는지가 아니다). 엣지 → 메인 = push·결과 회신·메인이 가져옴(cpull),
 *    메인 → 엣지 = 설정·자료 가져감(pull)·작업 인출(job)·메인이 보냄(cpush). 엣지 카드의 '↑ 올림 / ↓ 가져감 /
 *    ⇄ 중앙 호출' 은 **요청 주체** 기준이라 축이 다르다 — 범례가 그 차이를 말한다.
 *  · 선 색 = 그 방향 연결 중 가장 나쁜 상태(실패 > 낡음 > 정상). 기록이 하나도 없으면 `none`(회색 점선) —
 *    정상으로 칠하지 않는다.
 *  · 엣지는 2열이다. 오른쪽 열은 MAIN 까지 곧은 선, 왼쪽 열은 두 열 사이 통로(NEAR·FAR)로 내려가 **그 카드 아래
 *    행 간격**을 지나 MAIN 에 닿는다 — 다른 카드를 가로지르지 않는다(테스트가 교차 0 을 고정한다).
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
export const EDGE_COLS = 2;
export const EDGE_W = 172;
export const EDGE_H = 150;
export const EDGE_GAP_X = 36;
export const EDGE_GAP_Y = 22;
/** 두 엣지 열 사이 통로 — 왼쪽 열 선이 내려가는 세로 길(아래 방향 선이 안쪽, 위 방향 선이 바깥쪽). */
export const LANE_NEAR = EDGE_X + EDGE_W + 12;
export const LANE_FAR = EDGE_X + EDGE_W + 24;
export const MAIN_X = 1168;
export const MAIN_W = W - MAIN_X;
/** MAIN 카드의 고정 내용(머리·두 방향 합계·목록 머리·범례) 높이와 엣지 목록 한 행 높이.
 *  v2.591 검토(Chromium 실측): 예전엔 최소 380px 고정이라 엣지 3~4곳에서 목록 마지막 행이 **조용히 잘렸다**
 *  (목록 칸이 overflow:hidden). 카드 높이는 max(엣지 행 높이 합, 고정 내용 + 엣지 수 × 행 높이) 다. */
export const MAIN_BASE_H = 390;
export const MAIN_ROW_H = 18;
export const MAIN_MIN_H = MAIN_BASE_H;
/** 한 엣지의 위·아래 두 가닥 사이 간격(px) — 같은 높이에 겹치지 않게 벌린다. */
const PAIR = 4;

/** 데이터가 가는 방향(v2.591 사용자 선택). 서버 KINDS 6종이 정확히 한 번씩 들어간다(테스트 고정). */
export const UP_KINDS = Object.freeze(['push', 'reply', 'cpull']);
export const DOWN_KINDS = Object.freeze(['pull', 'job', 'cpush']);

const RANK = { none: 0, ok: 1, stale: 2, fail: 3 };
const STATES = ['ok', 'stale', 'fail'];

const cubic = (x1, y1, x2, y2, bend = 0.5) => {
  const mx = x1 + (x2 - x1) * bend;
  return `M${x1} ${y1} C ${mx} ${y1}, ${x2 - (x2 - x1) * (1 - bend)} ${y2}, ${x2} ${y2}`;
};

/**
 * 엣지 한 곳의 방향별 요약 — MAIN 카드·선 색·상세 표가 같은 값을 쓴다(판정을 두 곳에 두지 않는다).
 *   { up: {state, ok, stale, fail, links, okAt, lastAt, failAt, reason}, down: {...} }
 * ⚠ 방향에 기록된 연결이 하나도 없으면 state 는 'none' 이다(0 건을 '정상' 으로 읽지 않는다).
 */
export function edgeDirections(edgeId, links = [], routesById = new Map()) {
  const blank = () => ({ state: 'none', ok: 0, stale: 0, fail: 0, links: 0, okAt: 0, lastAt: 0, failAt: 0, reason: '', reasons: [], worstOkAt: 0, worstUnverified: 0, _l: [] });
  const out = { up: blank(), down: blank() };
  for (const l of links) {
    if (l.edge !== edgeId) continue;
    const k = routesById.get(l.route)?.kind;
    const d = UP_KINDS.includes(k) ? out.up : DOWN_KINDS.includes(k) ? out.down : null;
    if (!d) continue;
    d.links += 1; d._l.push(l);
    if (STATES.includes(l.state)) d[l.state] += 1;
    if ((RANK[l.state] || 0) > RANK[d.state]) d.state = l.state;
    const ok = Number(l.okAt) || 0, last = Number(l.lastAt) || 0, fail = Number(l.failAt) || 0;
    if (ok > d.okAt) d.okAt = ok;
    if (last > d.lastAt) d.lastAt = last;
    if (l.state === 'fail' && fail >= d.failAt) { d.failAt = fail; d.reason = typeof l.reason === 'string' ? l.reason : ''; }
  }
  for (const d of [out.up, out.down]) {
    // v2.591 검토: '마지막 성공' 을 방향 전체의 최댓값으로만 두면, 낡은 연결이 있어도 다른 연결의 30초 전 성공이 보여
    // **주황 점 옆에 '30초'** 라는 모순이 된다. 그래서 가장 나쁜 상태의 연결들 중 **가장 오래된 성공**(worstOkAt)을 따로 든다.
    const worst = d._l.filter((l) => l.state === d.state);
    const oks = worst.map((l) => Number(l.okAt) || 0);
    d.worstOkAt = oks.length && oks.every((x) => x > 0) ? Math.min(...oks) : 0;
    d.worstUnverified = worst.filter((l) => l.unverified).length;
    // 실패 사유는 하나만 보여주면 '그것만 고치면 된다' 로 읽힌다 — 서로 다른 사유를 최근 순으로 전부 든다.
    const seen = new Set();
    for (const l of [...worst].filter((x) => x.state === 'fail').sort((a, b) => (Number(b.failAt) || 0) - (Number(a.failAt) || 0))) {
      const r = typeof l.reason === 'string' && l.reason ? l.reason : '사유 미상';
      if (!seen.has(r)) { seen.add(r); d.reasons.push(r); }
    }
    delete d._l;
  }
  return out;
}

/** MAIN 카드용 — 엣지별 방향 요약 + 방향별 합계(엣지 수 기준: 그 방향 선이 어떤 색인 엣지가 몇 곳인가). */
export function mainSummary(data = {}) {
  const routesById = new Map((data.routes || []).map((r) => [r.id, r]));
  const sum = () => ({ ok: 0, stale: 0, fail: 0, none: 0 });
  const upSum = sum(), downSum = sum();
  const rows = (data.edges || []).map((e) => {
    const d = edgeDirections(e.id, data.links || [], routesById);
    upSum[d.up.state] += 1; downSum[d.down.state] += 1;
    return { edge: e.id, name: e.name || e.id, registered: e.registered !== false, enabled: e.enabled !== false, up: d.up, down: d.down };
  });
  return { rows, upSum, downSum };
}

/**
 * @param data  서버 응답(routes·cats·edges·links)
 * @param sel   null | {type:'cat'|'edge'|'main', id}
 */
export function layoutDataFlow(data = {}, selIn = null) {
  const cats = data.cats || [];
  const routes = data.routes || [];
  const edges = data.edges || [];
  const links = data.links || [];
  // v2.591 검토: 고른 엣지·종류가 다음 조회에서 사라지면 상단은 '선택 없음' 인데 선은 전부 흐린 채 남았다 — 선택을 버린다.
  const sel = !selIn ? null
    : selIn.type === 'edge' && !edges.some((e) => e.id === selIn.id) ? null
    : selIn.type === 'cat' && !cats.some((c) => c.id === selIn.id) ? null
    : selIn;

  const catPos = new Map();
  cats.forEach((c, i) => catPos.set(c.id, { x: CAT_X, y: TOP + i * (CAT_H + CAT_GAP), w: CAT_W, h: CAT_H }));
  const catBottom = TOP + cats.length * (CAT_H + CAT_GAP);

  const edgeRows = Math.max(1, Math.ceil(edges.length / EDGE_COLS));
  const edgePos = new Map();
  edges.forEach((e, j) => {
    const col = j % EDGE_COLS, row = Math.floor(j / EDGE_COLS);
    edgePos.set(e.id, { x: EDGE_X + col * (EDGE_W + EDGE_GAP_X), y: TOP + row * (EDGE_H + EDGE_GAP_Y), w: EDGE_W, h: EDGE_H, col, row });
  });
  // 마지막 행 아래의 간격도 남긴다 — 왼쪽 열 선이 그 행 간격을 지나 MAIN 에 닿는다.
  const edgeBottom = TOP + edgeRows * (EDGE_H + EDGE_GAP_Y);
  // MAIN 카드는 마지막 행 **아래 간격까지** 내려온다 — 마지막 행 왼쪽 열 선이 그 간격으로 MAIN 에 닿는다
  // (v2.591 자체 테스트가 잡았다: 간격을 빼면 그 두 가닥이 카드 아래 허공에 꽂혔다).
  const mainH = Math.max(MAIN_BASE_H + edges.length * MAIN_ROW_H, edgeRows * (EDGE_H + EDGE_GAP_Y));
  const main = { x: MAIN_X, y: TOP, w: MAIN_W, h: mainH };

  const height = Math.max(catBottom, edgeBottom, TOP + mainH + 16, TOP + routes.length * 8 + 40) + 24;
  const busTop = TOP + 10;
  const busBottom = height - 34;
  const step = routes.length > 1 ? (busBottom - busTop) / (routes.length - 1) : 0;
  const tickY = new Map(routes.map((r, i) => [r.id, busTop + i * step]));

  const routeCat = new Map(routes.map((r) => [r.id, r.cat]));
  const hot = (catId, edgeId) => {
    if (!sel) return null;
    if (sel.type === 'cat') return sel.id === catId;
    if (sel.type === 'edge') return edgeId != null && sel.id === edgeId;
    return null; // 'main' 선택은 경로 선을 전부 흐리게 한다
  };

  const inLines = routes.map((r) => {
    const cp = catPos.get(r.cat); const y2 = tickY.get(r.id);
    const h = sel?.type === 'edge' ? links.some((l) => l.route === r.id && l.edge === sel.id) : hot(r.cat);
    const y1 = cp ? cp.y + CAT_H / 2 : y2;
    return { key: `in:${r.id}`, route: r.id, cat: r.cat, state: r.state,
      d: cubic(CAT_X + CAT_W, y1, BUS_X, y2, 0.55), dim: sel ? !h : false, hot: !!h };
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
  outLines.sort((a, b) => (Number(a.hot) - Number(b.hot)) || (RANK[a.state] - RANK[b.state]));

  // ── 엣지 ↔ MAIN(v2.591) ──
  const summary = mainSummary(data);
  const mainLines = [];
  for (const row of summary.rows) {
    const p = edgePos.get(row.edge);
    if (!p) continue;
    const right = p.x + p.w, mid = p.y + p.h / 2;
    let upD, downD, upY, downY;
    if (p.col === EDGE_COLS - 1) {
      // 오른쪽 열 — MAIN 까지 곧은 선.
      upY = mid - PAIR; downY = mid + PAIR;
      upD = `M${right} ${upY} H ${MAIN_X}`;
      downD = `M${MAIN_X} ${downY} H ${right}`;
    } else {
      // 왼쪽 열 — 통로로 나가 그 카드 아래 행 간격을 지나 MAIN 으로. 위 가닥은 바깥 통로(FAR)·간격의 윗줄,
      // 아래 가닥은 안쪽 통로(NEAR)·간격의 아랫줄 — 두 가닥이 서로 교차하지 않는다.
      const gap = p.y + p.h + EDGE_GAP_Y / 2;
      upY = gap - PAIR; downY = gap + PAIR;
      upD = `M${right} ${mid - PAIR} H ${LANE_FAR} V ${upY} H ${MAIN_X}`;
      downD = `M${MAIN_X} ${downY} H ${LANE_NEAR} V ${mid + PAIR} H ${right}`;
    }
    const h = sel?.type === 'main' || (sel?.type === 'edge' && sel.id === row.edge);
    const dim = sel ? !h : false;
    mainLines.push({ key: `up:${row.edge}`, edge: row.edge, dir: 'up', state: row.up.state, d: upD, mainY: upY, hot: !!h, dim });
    mainLines.push({ key: `down:${row.edge}`, edge: row.edge, dir: 'down', state: row.down.state, d: downD, mainY: downY, hot: !!h, dim });
  }
  mainLines.sort((a, b) => (Number(a.hot) - Number(b.hot)) || (RANK[a.state] - RANK[b.state]));

  const ticks = routes.map((r) => ({ id: r.id, y: tickY.get(r.id), state: r.state, cat: r.cat }));
  return {
    width: W, height, catPos, edgePos, ticks, inLines, outLines, mainLines, main, summary, sel,
    bus: { x: BUS_X, w: BUS_W, top: busTop - 8, bottom: busBottom + 8 },
  };
}
