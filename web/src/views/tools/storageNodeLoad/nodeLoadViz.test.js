import { describe, it, expect } from 'vitest';
import {
  PROTO_COLORS, PROTO_FALLBACK, SKEW_COLOR, IDLE_COLOR, NODE_COLOR, CARD_CHIP_MAX, CARDS_AUTO_NODES,
  protoColor, protoLegend, vizDataOf, clientLabel, polarPt, arcPath, splitArc, spreadLabels, chordLayout, ribbonOpacity, chipTier, cardsOf, defaultShape, fmtOps, graphSummary,
} from './nodeLoadViz.js';
import { OVERLAY_COLORS } from './nodeLoadText.js';

/** 설계 README 의 가상 데이터와 같은 모양(서버 clientNodeMatrix · nodeSkew 결과) — 노드 2 쏠림 · 노드 3 빈 노드 · 두 노드를 쓰는 클라이언트 하나. */
function resp() {
  const nodes = [
    { id: 1, total: 1220, ratio: 0.6, skew: false }, { id: 2, total: 5668, ratio: 2.9, skew: true }, { id: 3, total: 0, ratio: 0, skew: false },
    { id: 4, total: 1337, ratio: 0.7, skew: false }, { id: 5, total: 908, ratio: 0.5, skew: false }, { id: 6, total: 2449, ratio: 1.3, skew: false },
  ];
  const c = (client, name, proto, nodesMap, fixed = true) => {
    const total = Object.values(nodesMap).reduce((a, b) => a + b, 0);
    const share = {}; let top = null; let ts = 0;
    for (const [k, v] of Object.entries(nodesMap)) { share[k] = Math.round((v / total) * 1000) / 10; if (v > ts) { ts = v; top = Number(k); } }
    return { client, name, proto, total, nodes: nodesMap, share, top, topShare: Math.round((ts / total) * 1000) / 10, fixed };
  };
  return {
    ok: true, deviceId: 'isi-1', range: '7d', nodes, mean: 1930, thresholds: { fixedShare: 0.9, skewFactor: 1.5 },
    clients: [
      c('172.63.212.44', 'demo-http-41', 'http', { 2: 1431 }), c('10.20.6.2', 'vm-backup-01', 'nfs', { 6: 1537 }), c('172.76.4.18', 'demo-nfs-36', 'nfs', { 2: 1240 }),
      c('172.176.230.69', '', 'nfs', { 2: 1096 }), c('10.20.4.11', 'vm-erp-db01', 'nfs', { 1: 520 }), c('10.20.5.8', 'vm-gitlab', 'nfs', { 4: 881 }),
      c('10.20.1.13', 'esx-kr-03', 'nfs', { 5: 908 }), c('172.39.248.94', 'demo-smb-35', 'smb', { 2: 902 }),
      c('10.20.9.9', 'vm-two-nodes', 'hdfs', { 1: 300, 6: 250 }, false),   // 두 노드 사용 · 고정 아님 · 색 없는 프로토콜
    ],
  };
}

describe('데이터 정리(vizDataOf) — 서버 값만 · 판정 재계산 없음', () => {
  it('노드 집합은 서버 nodes(ops 0 포함) · 클라이언트 × 노드 ops 는 서버 nodes 맵 그대로', () => {
    const d = vizDataOf(resp());
    expect(d.nodes.map((n) => n.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(d.nodes[1].skew).toBe(true);
    expect(d.clients.find((c) => c.client === '10.20.9.9').per).toEqual({ 1: 300, 6: 250 });
    expect(d.maxClient).toBe(1537);
    expect(d.maxPair).toBe(1537);
    expect(d.protos).toEqual(['hdfs', 'http', 'nfs', 'smb']);
    expect(d.sum).toBe(11582);
  });
  it('nodes 맵이 없으면 share × total 로 — 모르는 노드 · 0 · 문자열 쓰레기는 버린다', () => {
    const d = vizDataOf({ nodes: [{ id: 1, total: 100 }, { id: 2, total: 0 }], clients: [{ client: 'a', total: 100, share: { 1: 75, 2: 25, 9: 10, 3: 'x' } }], mean: 50 });
    expect(d.clients[0].per).toEqual({ 1: 75, 2: 25 });
    expect(vizDataOf(null)).toEqual({ nodes: [], clients: [], mean: 0, maxClient: 0, maxPair: 0, protos: [], sum: 0 });
  });
  it('이름이 없으면 주소를 라벨로(역방향 DNS 없음)', () => {
    expect(clientLabel({ client: '1.2.3.4', name: '' })).toBe('1.2.3.4');
    expect(clientLabel({ client: '1.2.3.4', name: 'vm-a' })).toBe('vm-a');
  });
});

describe('색 — 겹쳐 보기와 같은 검증기 통과 색 · 모르는 프로토콜은 회색 기타', () => {
  it('nfs · smb · http 는 OVERLAY_COLORS 의 세 색', () => {
    for (const c of Object.values(PROTO_COLORS)) expect(OVERLAY_COLORS).toContain(c);
    expect(protoColor('hdfs')).toBe(PROTO_FALLBACK);
    expect(protoLegend(['nfs', 'hdfs', 'ftp'])).toEqual([{ proto: 'nfs', color: PROTO_COLORS.nfs }, { proto: '기타', color: PROTO_FALLBACK }]);
    expect(SKEW_COLOR).toBe('#c98500');   // 쏠림 = 겹쳐 보기 4번째 색(잡 표지와 같은 호박색)
  });
});

describe('각도 · 호', () => {
  it('splitArc — 합은 span 에서 간격을 뺀 값 · 0 항목도 바닥값을 받는다 · 비례', () => {
    const s = splitArc([1000, 0, 3000], { span: 140, gap: 2, minArc: 2.5 });
    expect(s.reduce((a, b) => a + b, 0)).toBeCloseTo(136, 6);
    expect(s[1]).toBeCloseTo(2.5, 6);
    expect(s[2] / s[0]).toBeGreaterThan(2.5);   // 바닥값 때문에 정확히 3 은 아니지만 큰 쪽이 크다
    expect(splitArc([0, 0], { span: 100, gap: 0 })).toEqual([50, 50]);
    expect(splitArc([], { span: 100 })).toEqual([]);
    // 항목이 아주 많으면 바닥값을 줄여 넘치지 않는다
    const many = splitArc(Array.from({ length: 100 }, (_, i) => (i % 2 ? 1 : 0)), { span: 140, gap: 0.5, minArc: 2.5 });
    expect(many.reduce((a, b) => a + b, 0)).toBeCloseTo(140 - 0.5 * 99, 6);
    expect(Math.min(...many)).toBeGreaterThan(0);
  });
  it('spreadLabels — 위 → 아래 pitch 이상 · 끝을 넘으면 위로 되밀고 · 모자라면 min 우선', () => {
    expect(spreadLabels([10, 12, 40], { pitch: 12 })).toEqual([10, 22, 40]);
    expect(spreadLabels([90, 95], { pitch: 12, max: 100 })).toEqual([88, 100]);
    expect(spreadLabels([0, 1, 2], { pitch: 12, min: 0, max: 20 })).toEqual([0, 12, 24].map((v, i) => [0, 8, 20][i]));
    expect(spreadLabels([], { pitch: 12 })).toEqual([]);
  });
  it('polarPt — 0° 는 오른쪽 · 90° 는 위(SVG y 작아짐) · arcPath 는 네 점을 지난다', () => {
    expect(polarPt(100, 100, 50, 0)).toEqual({ x: 150, y: 100 });
    expect(polarPt(100, 100, 50, 90)).toEqual({ x: 100, y: 50 });
    const p = arcPath(100, 100, 40, 50, 10, 40);
    expect(p.startsWith('M ')).toBe(true);
    expect((p.match(/ A /g) || []).length).toBe(2);
    expect(p.endsWith('Z')).toBe(true);
    expect(arcPath(100, 100, 40, 50, 40, 10)).toBe(p);   // 순서를 바꿔 줘도 같은 조각
  });
});

describe('현 그래프 좌표(chordLayout)', () => {
  const d = vizDataOf(resp());
  const L = chordLayout(d, { size: 760 });
  it('노드는 왼쪽 반원(110°~250°) id 순 · 클라이언트는 오른쪽 반원(70°~−70°) 주 노드 순 묶음 · 묶음 안 ops 내림차순', () => {
    expect(L.nodes.map((n) => n.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(L.nodes[0].a0).toBeCloseTo(110, 0);
    expect(L.nodes[5].a1).toBeCloseTo(250, 0);
    for (const n of L.nodes) expect(n.a1).toBeGreaterThan(n.a0);
    expect(L.clients[0].a1).toBeCloseTo(70, 0);
    expect(L.clients[L.clients.length - 1].a0).toBeCloseTo(-70, 0);
    // 주 노드 순서: 노드 1(vm-erp-db01 520 > vm-two-nodes 300) → 노드 2(1431 · 1240 · 1096 · 902) → 4 → 5 → 6
    expect(L.clients.map((c) => c.top)).toEqual([1, 1, 2, 2, 2, 2, 4, 5, 6]);
    expect(L.clients.slice(2, 6).map((c) => c.total)).toEqual([1431, 1240, 1096, 902]);
    // 위 → 아래로 각도가 줄어든다 · 라벨 y 는 글자 높이 이상 떨어진다
    for (let i = 1; i < L.clients.length; i++) expect(L.clients[i].mid).toBeLessThan(L.clients[i - 1].mid);
    for (let i = 1; i < L.clients.length; i++) expect(L.clients[i].label.y - L.clients[i - 1].label.y).toBeGreaterThanOrEqual(L.labelFont + 1.5 - 0.11);
    for (let i = 1; i < L.nodes.length; i++) expect(L.nodes[i].label.y - L.nodes[i - 1].label.y).toBeGreaterThanOrEqual(29.9);
  });
  it('쏠린 노드 호는 호박색 · 빈 노드는 어두운 색 + "최근 작업 없음"(연결 없음 아님) · 보통 노드 회색', () => {
    const byId = new Map(L.nodes.map((n) => [n.id, n]));
    expect(byId.get(2).color).toBe(SKEW_COLOR);
    expect(byId.get(2).label.name).toBe('노드 2 · 쏠림 2.9×');
    expect(byId.get(3).color).toBe(IDLE_COLOR);
    expect(byId.get(3).idle).toBe(true);
    expect(byId.get(3).label.sub).toBe('최근 작업 없음');
    expect(byId.get(1).color).toBe(NODE_COLOR);
    expect(byId.get(1).label.sub).toBe('1,220 ops/s');
    // 노드 2 의 호가 가장 길다(길이 = 합)
    const len = (n) => n.a1 - n.a0;
    expect(len(byId.get(2))).toBeGreaterThan(len(byId.get(6)));
    expect(len(byId.get(3))).toBeLessThan(len(byId.get(5)));
  });
  it('리본 = 클라이언트 × 노드(ops > 0) · 두 노드 클라이언트는 리본 2개 · 굵기는 가장 큰 쌍 대비 · 가는 것부터', () => {
    expect(L.ribbons.length).toBe(10);   // 8 + 2
    const two = L.ribbons.filter((r) => r.client === '10.20.9.9');
    expect(two.map((r) => r.node).sort()).toEqual([1, 6]);
    expect(two[0].color).toBe(PROTO_FALLBACK);
    const big = L.ribbons.find((r) => r.client === '10.20.6.2');
    expect(big.width).toBe(22);
    expect(Math.min(...L.ribbons.map((r) => r.width))).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < L.ribbons.length; i++) expect(L.ribbons[i].width).toBeGreaterThanOrEqual(L.ribbons[i - 1].width);
    expect(big.path).toMatch(/^M [\d.]+ [\d.]+ Q 380 380 [\d.]+ [\d.]+$/);
    expect(L.ribbons.find((r) => r.node === 2).skew).toBe(true);
    expect(L.ribbons.find((r) => r.client === '10.20.4.11').fixed).toBe(true);
    expect(two[0].fixed).toBe(false);
  });
  it('모든 점이 캔버스 안 · 라벨은 바깥 반지름 · compact 면 클라이언트 라벨 없음 · 반지름 큼', () => {
    const pts = [...L.nodes, ...L.clients].flatMap((o) => [[o.x, o.y], [o.label.x, o.label.y]]);
    for (const [x, y] of pts) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(760); expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(760); }
    expect(L.nodes[0].label.anchor).toBe('end');
    expect(L.clients[0].label.anchor).toBe('start');
    const C = chordLayout(d, { size: 360, compact: true });
    expect(C.clients.every((c) => c.label === null)).toBe(true);
    expect(C.R / 360).toBeGreaterThan(L.R / 760);
    expect(C.nodes[1].label.name).toContain('노드 2');
  });
  it('클라이언트가 많으면 라벨은 ops 상위 labelMax 개만 · 글자는 작게 · 숨긴 수를 말한다', () => {
    const many = { nodes: [{ id: 1, total: 1000 }], clients: Array.from({ length: 30 }, (_, i) => ({ client: `10.0.0.${i}`, name: `c${i}`, proto: 'nfs', total: 100 - i, top: 1, fixed: true, per: { 1: 100 - i } })), mean: 1000, maxClient: 100, maxPair: 100 };
    const M = chordLayout(many, { size: 760 });
    expect(M.clients.filter((c) => c.label).length).toBe(24);
    expect(M.hiddenLabels).toBe(6);
    expect(M.labelFont).toBe(10.5);
    expect(M.clients.find((c) => c.client === '10.0.0.0').label).not.toBeNull();   // 가장 큰 것은 라벨 있음
    expect(M.clients.find((c) => c.client === '10.0.0.29').label).toBeNull();      // 가장 작은 것은 툴팁만
    expect(chordLayout(many, { size: 760, labelMax: 5 }).hiddenLabels).toBe(25);
    const ys = M.clients.filter((c) => c.label).map((c) => c.label.y);
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(10.5 + 1.5 - 0.11);
    // 노드가 많으면 라벨은 한 줄(ops 없음) · 바닥값 호라도 라벨이 겹치지 않는다
    const lots = { nodes: Array.from({ length: 40 }, (_, i) => ({ id: i + 1, total: i === 3 ? 5000 : 10, ratio: null, skew: i === 3 })), clients: [], mean: 100, maxClient: 0, maxPair: 0, sum: 5390 };
    const N = chordLayout(lots, { size: 760 });
    expect(N.nodes.every((n) => n.label.sub === null)).toBe(true);
    for (let i = 1; i < N.nodes.length; i++) expect(N.nodes[i].label.y - N.nodes[i - 1].label.y).toBeGreaterThanOrEqual(14.9);
    expect(L.hiddenLabels).toBe(0);
    expect(L.labelFont).toBe(11.5);
  });
  it('빈 응답 · 노드만 있고 클라이언트 없음도 그려진다(리본 0)', () => {
    const E = chordLayout(vizDataOf({ nodes: [{ id: 1, total: 0 }, { id: 2, total: 0 }], clients: [] }));
    expect(E.nodes.length).toBe(2);
    expect(E.nodes.every((n) => n.idle)).toBe(true);
    expect(E.ribbons).toEqual([]);
    expect(chordLayout(vizDataOf(null)).nodes).toEqual([]);
  });
  it('리본 불투명도 — 강조 모드 · 호버(연결된 것만 진하게)', () => {
    const rb = { node: 2, client: 'a', skew: true, fixed: false };
    expect(ribbonOpacity(rb, { emphasis: 'skew' })).toBe(0.72);
    expect(ribbonOpacity({ ...rb, skew: false }, { emphasis: 'skew' })).toBe(0.38);
    expect(ribbonOpacity({ ...rb, fixed: true }, { emphasis: 'fixed' })).toBe(0.72);
    expect(ribbonOpacity(rb, { emphasis: 'none' })).toBe(0.55);
    expect(ribbonOpacity(rb, { hot: { kind: 'node', id: 2 } })).toBe(0.95);
    expect(ribbonOpacity(rb, { hot: { kind: 'node', id: 3 } })).toBe(0.08);
    expect(ribbonOpacity(rb, { hot: { kind: 'client', id: 'a' } })).toBe(0.95);
  });
});

describe('노드 카드(cardsOf)', () => {
  const d = vizDataOf(resp());
  const cards = cardsOf(d);
  it('부하 높은 순 · 빈 노드 맨 뒤 · 막대 = 최대 대비 % · 평균 눈금', () => {
    expect(cards.map((c) => c.id)).toEqual([2, 6, 4, 1, 5, 3]);
    expect(cards[0].barPct).toBe(100);
    expect(cards[0].meanPct).toBe(34);
    expect(cards[5].idle).toBe(true);
    expect(cards[5].chips).toEqual([]);
    expect(cards[5].protoSplit).toEqual([]);
  });
  it('칩 = 그 노드에 ops 낸 클라이언트(내림차순) · 두 노드 사용은 multi · 고정은 서버 fixed ∧ 주 노드 · 크기 3단계는 최대 클라이언트 대비', () => {
    const n1 = cards.find((c) => c.id === 1);
    expect(n1.chips.map((c) => c.label)).toEqual(['vm-erp-db01', 'vm-two-nodes']);
    expect(n1.chips[1].multi).toBe(true);
    expect(n1.chips[1].fixed).toBe(false);
    expect(n1.chips[0].fixed).toBe(true);
    expect(n1.multiCount).toBe(1);
    expect(n1.fixedCount).toBe(1);
    const n6 = cards.find((c) => c.id === 6);
    expect(n6.chips[0].tier).toBe('l');          // 1537 / 1537
    expect(n6.chips[0].fillPct).toBe(100);
    expect(n1.chips[0].tier).toBe('m');          // 520 / 1537 = 0.34
    expect(n1.chips[1].tier).toBe('s');          // 300 / 1537 = 0.2
    expect(chipTier(0, 100)).toBe('s');
    expect(chipTier(10, 0)).toBe('s');
    // 이름 없는 클라이언트는 주소가 라벨
    expect(cards[0].chips.find((c) => c.client === '172.176.230.69').label).toBe('172.176.230.69');
  });
  it('프로토콜 띠 = 그 노드 ops 의 프로토콜 비중(내림차순) · 색 없는 프로토콜은 기타 회색', () => {
    const n2 = cards.find((c) => c.id === 2);
    expect(n2.protoSplit.map((p) => p.proto)).toEqual(['nfs', 'http', 'smb']);
    expect(n2.protoSplit.reduce((a, p) => a + p.pct, 0)).toBeGreaterThanOrEqual(99);
    expect(n2.protoSplit[0].ops).toBe(2336);
    const n6 = cards.find((c) => c.id === 6);
    expect(n6.protoSplit.find((p) => p.proto === 'hdfs').color).toBe(PROTO_FALLBACK);
  });
  it('칩 상한 — 넘친 수는 more 로 말한다(조용한 상한 금지)', () => {
    const many = { nodes: [{ id: 1, total: 100 }], clients: Array.from({ length: 15 }, (_, i) => ({ client: `c${i}`, name: '', proto: 'nfs', total: 15 - i, top: 1, fixed: true, per: { 1: 15 - i } })), mean: 100, maxClient: 15, maxPair: 15 };
    const c = cardsOf(many)[0];
    expect(c.chips.length).toBe(CARD_CHIP_MAX);
    expect(c.more).toBe(3);
    expect(c.clientCount).toBe(15);
    expect(cardsOf(many, { chipMax: 5 })[0].more).toBe(10);
  });
  it('기본 모양 — 노드가 많으면 카드', () => {
    expect(defaultShape(6)).toBe('chord');
    expect(defaultShape(CARDS_AUTO_NODES)).toBe('chord');
    expect(defaultShape(CARDS_AUTO_NODES + 1)).toBe('cards');
  });
});

describe('글자', () => {
  it('fmtOps — 천 단위 쉼표 · 못 읽은 값은 — (단위 없음)', () => {
    expect(fmtOps(5668.4)).toBe('5,668');
    expect(fmtOps(null)).toBe('—');
    expect(fmtOps('')).toBe('—');
  });
  it('graphSummary — 쏠린 노드 · 빈 노드 · 두 노드 클라이언트 · 고정 수(서버 값만 센다)', () => {
    const s = graphSummary(vizDataOf(resp()));
    expect(s).toEqual({ skewed: [2], idle: [3], multi: 1, fixed: 8, clients: 9, nodes: 6 });
    expect(graphSummary(vizDataOf(null))).toEqual({ skewed: [], idle: [], multi: 0, fixed: 0, clients: 0, nodes: 0 });
  });
});
