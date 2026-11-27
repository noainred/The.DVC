/**
 * nodeLoadViz — '연결 그래프' 보기(현 그래프 · 노드 카드)의 순수 계산(v2.951 · 설계 docs/design/isilon-node-clients-viz/README.md ① ③).
 *  · 입력은 `/client-dist` 응답 그대로(장비 호출 0 · 새 서버 작업 없음). 클라이언트 × 노드 ops 는 서버 행렬의 `nodes`(창 평균 ops/s) — 없으면 `share × total` 로.
 *  · 판정(쏠림 · 고정 · 노드 집합)은 서버 값만 쓴다 — 여기서 다시 판정하지 않는다. 그리기 좌표와 글자만 만든다.
 *  · 좌표는 수학 각도(0° = 오른쪽 · 반시계 +)로 계산하고 SVG y 는 아래가 + 라 sin 에 − 를 붙인다.
 */
import { numOrNull } from '../../../numOrNull.js';

/** 프로토콜 색 — 겹쳐 보기 4색과 같은 검증기 통과 색. 배정하지 않은 프로토콜(hdfs · ftp · s3 …)은 회색 '기타'. */
export const PROTO_COLORS = Object.freeze({ nfs: '#3987e5', smb: '#d95926', http: '#199e70' });
export const PROTO_FALLBACK = '#8b9bb4';
export const SKEW_COLOR = '#c98500';   // 쏠린 노드 호 · 카드 막대
export const SKEW_TEXT = '#fcd34d';
export const NODE_COLOR = '#5d6b85';   // 보통 노드 호
export const IDLE_COLOR = '#2b3650';   // 최근 작업 없는 노드 호
export const CARD_CHIP_MAX = 12;       // 카드 하나의 칩 상한 — 넘치면 '외 n'
export const CARDS_AUTO_NODES = 12;    // 노드가 이보다 많으면 기본 모양을 카드로
export const COMPACT_WIDTH = 560;      // 이 폭 미만이면 현 그래프를 압축(클라이언트 글자 → 툴팁)

export const protoColor = (p) => PROTO_COLORS[p] || PROTO_FALLBACK;
/** 범례 항목 — 응답에 있는 프로토콜만 · 색 없는 것은 '기타(회색)' 하나로. */
export function protoLegend(protos) {
  const out = []; let other = false;
  for (const p of protos || []) { if (PROTO_COLORS[p]) out.push({ proto: p, color: PROTO_COLORS[p] }); else other = true; }
  if (other) out.push({ proto: '기타', color: PROTO_FALLBACK });
  return out;
}

/**
 * client-dist 응답 → 그림 데이터.
 * 노드 집합은 서버 `nodes`(ops 0 노드 포함 — '최근 작업 없음'). 클라이언트는 서버 상위 목록 그대로(순서 · 상한을 바꾸지 않는다).
 * @returns {{nodes:Array<{id:number,total:number,ratio:number|null,skew:boolean}>, clients:Array<{client,name,proto,total,top,fixed,per:Object<number,number>}>, mean:number, maxClient:number, maxPair:number, protos:string[], sum:number}}
 */
export function vizDataOf(resp) {
  const nodes = (Array.isArray(resp?.nodes) ? resp.nodes : [])
    .map((n) => ({ id: numOrNull(n?.id), total: numOrNull(n?.total) ?? 0, ratio: numOrNull(n?.ratio), skew: n?.skew === true }))
    .filter((n) => n.id != null);
  const ids = new Set(nodes.map((n) => n.id));
  const clients = [];
  let maxPair = 0;
  for (const c of Array.isArray(resp?.clients) ? resp.clients : []) {
    const client = typeof c?.client === 'string' ? c.client : '';
    if (!client) continue;
    const total = numOrNull(c.total) ?? 0;
    const per = {};
    if (c.nodes && typeof c.nodes === 'object') {
      for (const [k, v] of Object.entries(c.nodes)) { const n = Number(k); const o = numOrNull(v); if (ids.has(n) && o != null && o > 0) per[n] = o; }
    } else if (c.share && typeof c.share === 'object') {
      for (const [k, v] of Object.entries(c.share)) { const n = Number(k); const p = numOrNull(v); if (ids.has(n) && p != null && p > 0) per[n] = (total * p) / 100; }
    }
    for (const v of Object.values(per)) if (v > maxPair) maxPair = v;
    const top = numOrNull(c.top);
    clients.push({ client, name: typeof c.name === 'string' ? c.name.trim() : '', proto: typeof c.proto === 'string' ? c.proto : '', total, top: top != null && ids.has(top) ? top : null, fixed: c.fixed === true, per });
  }
  const maxClient = Math.max(0, ...clients.map((c) => c.total));
  const protos = [...new Set(clients.map((c) => c.proto).filter(Boolean))].sort();
  return { nodes, clients, mean: numOrNull(resp?.mean) ?? 0, maxClient, maxPair, protos, sum: nodes.reduce((a, n) => a + n.total, 0) };
}

/** 표시 이름 — 포탈 인벤토리 이름이 있으면 그것, 없으면 주소(역방향 DNS 없음). */
export const clientLabel = (c) => (c?.name ? c.name : String(c?.client || '—'));

/* ── 현(Chord) 그래프 ────────────────────────────────────────────────────── */
const rad = (d) => (d * Math.PI) / 180;
const r1 = (v) => Math.round(v * 10) / 10;
/** 극좌표 → SVG 점(y 아래가 +). */
export function polarPt(cx, cy, r, deg) { return { x: r1(cx + r * Math.cos(rad(deg))), y: r1(cy - r * Math.sin(rad(deg))) }; }
/** 고리 조각 경로 — a0 < a1(도) · 바깥 r1 · 안쪽 r0. 180° 를 넘지 않는 조각만 쓴다. */
export function arcPath(cx, cy, r0, rOut, a0, a1) {
  const lo = Math.min(a0, a1); const hi = Math.max(a0, a1);
  const large = hi - lo > 180 ? 1 : 0;
  const o0 = polarPt(cx, cy, rOut, lo); const o1 = polarPt(cx, cy, rOut, hi);
  const i1 = polarPt(cx, cy, r0, hi); const i0 = polarPt(cx, cy, r0, lo);
  // 수학 각도가 커지는 방향은 화면에서 반시계 → sweep 0, 되돌아오는 안쪽은 sweep 1.
  return `M ${o0.x} ${o0.y} A ${rOut} ${rOut} 0 ${large} 0 ${o1.x} ${o1.y} L ${i1.x} ${i1.y} A ${r0} ${r0} 0 ${large} 1 ${i0.x} ${i0.y} Z`;
}
/**
 * 각도 배분 — 값에 비례해 span(도)을 나눈다. 0 인 항목은 minArc 를 받고 나머지가 비례. 항목 사이 gap.
 * @returns {number[]} 항목별 길이(도) — 합 + gap 합 = span
 */
export function splitArc(values, { span, gap = 1.6, minArc = 2.5 } = {}) {
  const n = values.length;
  if (!n) return [];
  const avail = Math.max(0, span - gap * (n - 1));
  const sum = values.reduce((a, v) => a + (v > 0 ? v : 0), 0);
  if (!(sum > 0)) return values.map(() => avail / n);
  const floor = Math.min(minArc, avail / n);          // 모두가 바닥값을 받는다(항목이 아주 많으면 바닥값도 줄인다)
  const rest = avail - floor * n;                       // 남은 길이는 값에 비례 — 합은 정확히 avail
  return values.map((v) => floor + (v > 0 ? (v / sum) * rest : 0));
}
/**
 * 라벨 y 벌리기 — 위 → 아래 순서의 y 들을 pitch 이상 떨어뜨린다(호가 수평에 가까운 꼭대기 · 바닥에서 글자가 겹친다 — Chromium 판독).
 * 아래로 밀고, 끝(max)을 넘으면 아래부터 위로 되민다. 공간이 모자라면 min 쪽을 우선한다.
 */
export function spreadLabels(ys, { pitch, min = -Infinity, max = Infinity } = {}) {
  const out = ys.slice();
  for (let i = 1; i < out.length; i++) if (out[i] < out[i - 1] + pitch) out[i] = out[i - 1] + pitch;
  for (let i = out.length - 1; i >= 0; i--) { const lim = i === out.length - 1 ? max : out[i + 1] - pitch; if (out[i] > lim) out[i] = lim; }
  for (let i = 0; i < out.length; i++) if (out[i] < min) out[i] = min;
  return out.map((v) => Math.round(v * 10) / 10);
}
/**
 * 현 그래프 좌표. 왼쪽 반원(nodeFrom~nodeTo = 110°~250° · 위 → 아래)에 노드 호(길이 = 노드 합), 오른쪽 반원(70° → −70° · 위 → 아래)에 클라이언트 호
 * (노드별 묶음 — 주 노드 순서를 따라 리본이 엇갈리지 않게 · 묶음 안은 ops 내림차순), 가운데를 지나는 2차 곡선 리본(굵기 = 그 쌍의 창 평균 ops/s).
 * compact 면 클라이언트 글자를 빼고(툴팁만) 반지름을 키운다.
 */
export const CHORD_LABEL_MAX = 24;     // 클라이언트 라벨은 ops 상위 이 수만 — 나머지는 툴팁(호가 좁아 글자가 겹친다)
export function chordLayout(data, { size = 760, compact = false, thickness = 14, gap = 1.6, minArc = 2.5, ribbonMax = 22, ribbonMin = 2, labelMax = CHORD_LABEL_MAX } = {}) {
  const cx = size / 2; const cy = size / 2;
  const labelRoom = compact ? Math.round(size * 0.13) : Math.round(size * 0.165);
  const R = Math.max(40, Math.round(size / 2 - 10 - labelRoom));
  const r0 = R - thickness;
  const nodesIn = data?.nodes || [];
  const clientsIn = data?.clients || [];
  // 노드 호 — id 오름차순(노드 표와 같은 순서) · 110° → 250°
  const nodesSorted = [...nodesIn].sort((a, b) => a.id - b.id);
  const nodeSpans = splitArc(nodesSorted.map((n) => n.total), { span: 140, gap, minArc });
  let a = 110;
  const nodes = nodesSorted.map((n, i) => {
    const a0 = a; const a1 = a + nodeSpans[i]; a = a1 + gap;
    const mid = (a0 + a1) / 2;
    const hasClient = clientsIn.some((c) => c.per[n.id] > 0);
    const idle = !(n.total > 0) && !hasClient;
    const color = n.skew ? SKEW_COLOR : idle ? IDLE_COLOR : NODE_COLOR;
    const lp = polarPt(cx, cy, R + 10, mid);
    const ip = polarPt(cx, cy, r0, mid);
    const sub = idle ? '최근 작업 없음' : `${fmtOps(n.total)} ops/s`;
    // compact(400px) 는 글자 자리가 좁아 이름만 · 노드가 많으면(20 초과) 둘째 줄을 뺀다 — 나머지는 툴팁(title)으로
    const name = !compact && n.skew && n.ratio != null ? `노드 ${n.id} · 쏠림 ${n.ratio}×` : `노드 ${n.id}`;
    const oneLine = compact || nodesSorted.length > 20;
    return { id: n.id, total: n.total, ratio: n.ratio, skew: n.skew, idle, a0: r1(a0), a1: r1(a1), mid: r1(mid), color, path: arcPath(cx, cy, r0, R, a0, a1),
      x: ip.x, y: ip.y, title: `노드 ${n.id} · ${sub}${n.skew && n.ratio != null ? ` · 쏠림 ${n.ratio}×` : ''}`, label: { x: lp.x, y: lp.y, anchor: 'end', name, sub: oneLine ? null : sub, fill: n.skew ? SKEW_TEXT : null } };
  });
  // 클라이언트 호 — 주 노드 순서(노드 순) 묶음 · 묶음 안 ops 내림차순 · 주 노드 없는 것은 맨 뒤 · 70° → −70°(위 → 아래 = 각도 감소)
  const order = new Map(nodesSorted.map((n, i) => [n.id, i]));
  const clientsSorted = [...clientsIn].sort((p, q) => {
    const op = p.top != null ? order.get(p.top) ?? 1e9 : 1e9; const oq = q.top != null ? order.get(q.top) ?? 1e9 : 1e9;
    return op - oq || q.total - p.total || p.client.localeCompare(q.client);
  });
  const clientSpans = splitArc(clientsSorted.map((c) => c.total), { span: 140, gap, minArc });
  // 라벨은 ops 상위 labelMax 개만(글자 높이 ≈ 바닥 호 길이 13px — 전부 적으면 겹친다) · 글자 크기는 수가 많을수록 작게
  const labelKeys = new Set([...clientsIn].sort((p, q) => q.total - p.total || p.client.localeCompare(q.client)).slice(0, Math.max(0, labelMax)).map((c) => c.client));
  const labelFont = clientsIn.length > 14 ? 10.5 : 11.5;
  let b = 70;
  const clients = clientsSorted.map((c, i) => {
    const a1 = b; const a0 = b - clientSpans[i]; b = a0 - gap;   // 각도가 줄어드는 방향(위 → 아래)
    const mid = (a0 + a1) / 2;
    const lp = polarPt(cx, cy, R + 10, mid);
    const ip = polarPt(cx, cy, r0, mid);
    return { key: c.client, client: c.client, name: c.name, proto: c.proto, total: c.total, top: c.top, fixed: c.fixed, per: c.per,
      a0: r1(a0), a1: r1(a1), mid: r1(mid), color: protoColor(c.proto), path: arcPath(cx, cy, r0, R, a0, a1), x: ip.x, y: ip.y,
      label: compact || !labelKeys.has(c.client) ? null : { x: lp.x, y: lp.y, anchor: 'start', name: clientLabel(c), sub: fmtOps(c.total) } };
  });
  const hiddenLabels = compact ? 0 : clients.filter((c) => c.label === null).length;
  // 라벨 벌리기 — 노드(위 → 아래 = 배열 순) · 클라이언트(위 → 아래 = 배열 순, 라벨 있는 것만)
  const nodePitch = nodes.some((n) => n.label.sub) ? 30 : (compact ? 13 : 15);
  spreadLabels(nodes.map((n) => n.label.y), { pitch: nodePitch, min: 10, max: size - 10 }).forEach((y, i) => { nodes[i].label.y = y; });
  const labeled = clients.filter((c) => c.label);
  spreadLabels(labeled.map((c) => c.label.y), { pitch: labelFont + 1.5, min: 8, max: size - 8 }).forEach((y, i) => { labeled[i].label.y = y; });
  // 리본 — 클라이언트 × 노드(ops > 0) · 가운데 제어점 · 굵기는 가장 큰 쌍 대비
  const maxPair = data?.maxPair > 0 ? data.maxPair : 1;
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const ribbons = [];
  for (const c of clients) {
    for (const [k, ops] of Object.entries(c.per)) {
      const n = nodeById.get(Number(k));
      if (!n || !(ops > 0)) continue;
      ribbons.push({ key: `${c.client}|${n.id}`, node: n.id, client: c.client, proto: c.proto, ops, fixed: c.fixed && c.top === n.id, skew: n.skew,
        width: r1(Math.max(ribbonMin, (ops / maxPair) * ribbonMax)), color: c.color, path: `M ${n.x} ${n.y} Q ${cx} ${cy} ${c.x} ${c.y}` });
    }
  }
  ribbons.sort((p, q) => p.width - q.width);   // 가는 것 먼저 그려 굵은 것이 위에
  return { size, cx, cy, R, r0, compact, nodes, clients, ribbons, maxPair: data?.maxPair ?? 0, sum: data?.sum ?? 0, labelFont, hiddenLabels, labelMax };
}
/** 리본 불투명도 — 강조 모드(skew · fixed · none)와 호버(노드/클라이언트)로. 판정은 서버 값(skew · fixed). */
export function ribbonOpacity(rb, { emphasis = 'skew', hot = null } = {}) {
  if (hot) {
    const on = hot.kind === 'node' ? rb.node === hot.id : rb.client === hot.id;
    return on ? 0.95 : 0.08;
  }
  if (emphasis === 'skew') return rb.skew ? 0.72 : 0.38;
  if (emphasis === 'fixed') return rb.fixed ? 0.72 : 0.3;
  return 0.55;
}

/* ── 노드 카드 ────────────────────────────────────────────────────────────── */
/** 칩 크기 3단계 — 가장 큰 클라이언트 대비(절대값 기준은 장비마다 규모가 달라 쓰지 않는다). */
export function chipTier(ops, maxClient) {
  if (!(maxClient > 0) || !(ops > 0)) return 's';
  const r = ops / maxClient;
  return r >= 0.6 ? 'l' : r >= 0.25 ? 'm' : 's';
}
/**
 * 카드 — 노드 하나당 하나. 순서는 부하 높은 순(합 내림차순 · 같으면 id) · 빈 노드는 맨 뒤.
 * 칩은 그 노드에 ops 를 낸 클라이언트(내림차순 · 상한 chipMax — 넘친 수는 more) · 프로토콜 띠는 그 노드 ops 의 프로토콜 비중.
 */
export function cardsOf(data, { chipMax = CARD_CHIP_MAX } = {}) {
  const nodes = data?.nodes || []; const clients = data?.clients || [];
  const max = Math.max(0, ...nodes.map((n) => n.total));
  const mean = data?.mean ?? 0;
  const cards = nodes.map((n) => {
    const rows = clients.filter((c) => c.per[n.id] > 0).map((c) => ({ client: c.client, name: c.name, label: clientLabel(c), proto: c.proto, ops: c.per[n.id], color: protoColor(c.proto),
      tier: chipTier(c.per[n.id], data?.maxClient ?? 0), fillPct: data?.maxClient > 0 ? Math.round((c.per[n.id] / data.maxClient) * 100) : 0,
      multi: Object.keys(c.per).length > 1, fixed: c.fixed && c.top === n.id })).sort((p, q) => q.ops - p.ops || p.client.localeCompare(q.client));
    const protoMap = {};
    for (const r of rows) protoMap[r.proto || '기타'] = (protoMap[r.proto || '기타'] || 0) + r.ops;
    const protoSum = Object.values(protoMap).reduce((s, v) => s + v, 0);
    const protoSplit = Object.entries(protoMap).map(([proto, ops]) => ({ proto, ops, pct: protoSum > 0 ? Math.round((ops / protoSum) * 100) : 0, color: proto === '기타' ? PROTO_FALLBACK : protoColor(proto) })).sort((p, q) => q.ops - p.ops);
    const idle = !(n.total > 0) && rows.length === 0;
    return { id: n.id, total: n.total, ratio: n.ratio, skew: n.skew, idle, barPct: max > 0 ? Math.round((n.total / max) * 100) : 0, meanPct: max > 0 && mean > 0 ? Math.min(100, Math.round((mean / max) * 100)) : null,
      protoSplit, chips: rows.slice(0, Math.max(1, chipMax)), more: Math.max(0, rows.length - chipMax), clientCount: rows.length, fixedCount: rows.filter((r) => r.fixed).length, multiCount: rows.filter((r) => r.multi).length };
  });
  return cards.sort((p, q) => (q.idle ? 0 : 1) - (p.idle ? 0 : 1) || q.total - p.total || p.id - q.id);
}
/** 기본 모양 — 노드가 많으면 카드(현 그래프는 호가 좁아진다). */
export const defaultShape = (nodeCount) => (nodeCount > CARDS_AUTO_NODES ? 'cards' : 'chord');

/** ops/s 숫자(단위 없이) — 못 읽은 값은 '—'. */
export function fmtOps(v) {
  const n = numOrNull(v);
  if (n == null) return '—';
  return Math.round(n).toLocaleString('en-US');
}
/** 그래프 머리 요약 — 쏠린 노드 · 빈 노드 · 두 노드 이상을 쓰는 클라이언트 수. 문장은 사실만(판정은 서버 값). */
export function graphSummary(data) {
  const nodes = data?.nodes || []; const clients = data?.clients || [];
  const skewed = nodes.filter((n) => n.skew);
  const idle = nodes.filter((n) => !(n.total > 0) && !clients.some((c) => c.per[n.id] > 0));
  const multi = clients.filter((c) => Object.keys(c.per).length > 1).length;
  const fixed = clients.filter((c) => c.fixed).length;
  return { skewed: skewed.map((n) => n.id), idle: idle.map((n) => n.id), multi, fixed, clients: clients.length, nodes: nodes.length };
}
