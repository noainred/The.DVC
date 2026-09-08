/**
 * relayTopoLayout.js — 중계 토폴로지 그래픽(2D SVG / 3D 캔버스)의 순수 계산(v2.431, 사용자 요구 '입력이 완료되면 화려한 그래픽 2D/3D').
 * 외부 라이브러리 없이 좌표·투영·상태 색을 계산한다. 웹 테스트가 node 환경이라 DOM 없이 이 파일로 회귀를 고정한다.
 *
 *  buildGraph(topology, results): { nodes:[{id,kind,label,sub,dc,x,y, p3:[x,y,z], status}], links:[{id,from,to,label,kind,status}] }
 *   - 2D 좌표: 폭 W 안에 Main(상단 중앙) → 사이트 열(Edge 중단, IRS 하단, vCenter 는 옆 소형).
 *   - 3D 좌표: Main 위(0,1.6,0), Edge 는 반지름 R 원, IRS 는 바깥 원 아래층, vCenter 는 각 노드 옆.
 *  project(p3, cam): 원근 투영 → { x, y, depth }. cam = { rotY, rotX, dist, scale, cx, cy }.
 */
export const W2D = 1100;

export function statusOf(dc, results) {
  const r = results?.[dc];
  if (!r || !r.ok) return r?.ok === false ? 'bad' : 'unknown';
  if (!r.edge?.ok) return 'bad';
  const bad = (r.rows || []).filter((x) => x.status !== 'ok').length + (r.irsIssues || []).filter((i) => i.level === 'error').length;
  return bad ? 'warn' : 'ok';
}

export const COLORS = { ok: '#22c55e', warn: '#f59e0b', bad: '#ef4444', unknown: '#64748b', main: '#60a5fa', edge: '#a78bfa', irs: '#2dd4bf', vc: '#fbbf24' };

export function buildGraph(topology, results = {}) {
  const sites = topology?.sites || []; const main = topology?.main || {}; const services = (topology?.services || []).filter((s) => s.enabled !== false);
  const n = Math.max(1, sites.length);
  const colW = Math.max(150, Math.min(260, (W2D - 80) / n));
  const totalW = colW * n; const x0 = (W2D - totalW) / 2 + colW / 2;
  const nodes = []; const links = [];
  const mainId = 'main';
  nodes.push({ id: mainId, kind: 'main', label: main.name || 'Main', sub: [main.publicIp, main.privateIp].filter(Boolean).join(' / ') || '(IP 없음)', dc: '', x: W2D / 2, y: 60, p3: [0, 1.6, 0], status: 'unknown', color: COLORS.main });
  const R = 2.2;
  sites.forEach((s, i) => {
    const st = statusOf(s.dc, results);
    const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
    const x = x0 + i * colW;
    const edgeId = `edge:${s.dc}`, irsId = `irs:${s.dc}`;
    const hasIrs = !!(s.irs?.privateIp || s.irs?.publicIp);
    nodes.push({ id: edgeId, kind: 'edge', label: `${s.dc} Edge`, sub: s.edge?.publicIp || s.edge?.privateIp || '(IP 없음)', dc: s.dc, x, y: 230, p3: [Math.cos(ang) * R, 0.1, Math.sin(ang) * R], status: st, color: COLORS.edge });
    links.push({ id: `l:main-${s.dc}`, from: mainId, to: edgeId, label: `:${main.portalPort || 4000}`, kind: 'portal', status: st });
    if (s.edge?.vcenterIp) {
      const vid = `vc:edge:${s.dc}`; const svc = services.find((x) => x.target === 'edge-vcenter');
      nodes.push({ id: vid, kind: 'vc', label: 'vCenter', sub: s.edge.vcenterIp, dc: s.dc, x: x + colW * 0.36, y: 300, p3: [Math.cos(ang + 0.22) * (R + 0.5), 0.35, Math.sin(ang + 0.22) * (R + 0.5)], status: st, color: COLORS.vc, small: true });
      links.push({ id: `l:edge-vc:${s.dc}`, from: edgeId, to: vid, label: svc ? `:${svc.listenPort}→${svc.targetPort}` : '', kind: 'vcenter', status: st });
    }
    if (hasIrs) {
      nodes.push({ id: irsId, kind: 'irs', label: `${s.dc} IRS`, sub: s.irs.privateIp || s.irs.publicIp, dc: s.dc, x, y: 420, p3: [Math.cos(ang) * (R * 1.45), -1.2, Math.sin(ang) * (R * 1.45)], status: st, color: COLORS.irs });
      for (const svc of services.filter((x) => x.target === 'irs')) links.push({ id: `l:${s.dc}:${svc.key}`, from: edgeId, to: irsId, label: `${svc.key} :${svc.listenPort}→${svc.targetPort}`, kind: svc.key, status: st, service: svc.key });
      const hq = services.find((x) => x.target === 'main');
      if (hq) links.push({ id: `l:hq:${s.dc}`, from: irsId, to: mainId, label: `hq :${hq.listenPort}→${hq.targetPort}`, kind: 'hq', status: st, via: edgeId, dashed: true });
      if (s.irs?.vcenterIp) {
        const vid = `vc:irs:${s.dc}`; const svc = services.find((x) => x.target === 'irs-vcenter');
        nodes.push({ id: vid, kind: 'vc', label: 'vCenter', sub: s.irs.vcenterIp, dc: s.dc, x: x + colW * 0.36, y: 490, p3: [Math.cos(ang + 0.2) * (R * 1.45 + 0.5), -1.0, Math.sin(ang + 0.2) * (R * 1.45 + 0.5)], status: st, color: COLORS.vc, small: true });
        links.push({ id: `l:irs-vc:${s.dc}`, from: edgeId, to: vid, label: svc ? `:${svc.listenPort}→${svc.targetPort}` : '', kind: 'vcenter', status: st });
      }
    }
  });
  const height = sites.some((s) => s.irs?.vcenterIp) ? 560 : sites.some((s) => s.irs?.privateIp || s.irs?.publicIp) ? 490 : 360;
  return { nodes, links, width: W2D, height };
}

/** 원근 투영(순수). rotY 는 수평 회전, rotX 는 기울임(라디안). */
export function project([x, y, z], { rotY = 0, rotX = 0.45, dist = 7, scale = 160, cx = 0, cy = 0 } = {}) {
  const cy1 = Math.cos(rotY), sy1 = Math.sin(rotY);
  const x1 = x * cy1 - z * sy1, z1 = x * sy1 + z * cy1;
  const cx1 = Math.cos(rotX), sx1 = Math.sin(rotX);
  const y2 = y * cx1 - z1 * sx1, z2 = y * sx1 + z1 * cx1;
  const depth = dist + z2;
  const f = scale * (dist / Math.max(0.5, depth));
  return { x: cx + x1 * f, y: cy - y2 * f, depth, f: f / scale };
}

/** 링크 위 패킷 위치(순수): t∈[0,1) 를 from→to 사이 보간. */
export const lerp = (a, b, t) => a + (b - a) * t;

/** 3D 씬 프레임 계산(순수): 노드 투영 + 깊이 정렬 + 링크 끝점. cam 은 project 옵션. */
export function frame3d(graph, cam, t = 0) {
  const pos = new Map(graph.nodes.map((n) => [n.id, project(n.p3, cam)]));
  const nodes = graph.nodes.map((n) => ({ ...n, ...pos.get(n.id) })).sort((a, b) => b.depth - a.depth);
  const links = graph.links.map((l, i) => {
    const a = pos.get(l.from), b = pos.get(l.to);
    const phase = ((t * (l.kind === 'hq' ? 0.6 : 1) + i * 0.13) % 1 + 1) % 1;
    return { ...l, x1: a.x, y1: a.y, x2: b.x, y2: b.y, depth: (a.depth + b.depth) / 2, px: lerp(a.x, b.x, phase), py: lerp(a.y, b.y, phase) };
  }).sort((a, b) => b.depth - a.depth);
  return { nodes, links };
}
