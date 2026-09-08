/**
 * relayTopoLayout 회귀 테스트(v2.431) — 2D/3D 토폴로지 그래픽의 순수 계산.
 * 웹 테스트는 node 환경(DOM 없음)이라 SVG/캔버스 렌더는 확인할 수 없다 — 노드/링크 구성·상태 색·투영 수식을 여기서 고정한다.
 */
import { describe, it, expect } from 'vitest';
import { buildGraph, statusOf, project, frame3d, W2D } from './relayTopoLayout.js';

const topo = {
  main: { name: 'OC2', privateIp: '192.168.20.143', publicIp: '10.94.40.217', portalPort: 4000 },
  services: [
    { key: 'portal', listenPort: 4068, target: 'irs', targetPort: 4000, enabled: true },
    { key: 'ssh', listenPort: 4067, target: 'irs', targetPort: 22, enabled: true },
    { key: 'vcsa', listenPort: 4066, target: 'irs-vcenter', targetPort: 443, enabled: true },
    { key: 'edge-vcsa', listenPort: 4065, target: 'edge-vcenter', targetPort: 443, enabled: true },
    { key: 'hq', listenPort: 4001, target: 'main', targetPort: 4000, enabled: true },
    { key: 'off', listenPort: 4099, target: 'irs', targetPort: 9, enabled: false },
  ],
  sites: [
    { dc: 'AZ', edge: { privateIp: '192.168.30.221', publicIp: '10.112.158.217', vcenterIp: '192.168.30.10' }, irs: { privateIp: '192.168.31.11', vcenterIp: '192.168.31.10' } },
    { dc: 'NA', edge: { privateIp: '192.168.50.221', publicIp: '10.114.158.217', vcenterIp: '' }, irs: { privateIp: '', publicIp: '', vcenterIp: '' } },
  ],
};

describe('statusOf', () => {
  it('결과 없음=unknown, 실패=bad, 오류 행=warn, 전부 정상=ok', () => {
    expect(statusOf('AZ', {})).toBe('unknown');
    expect(statusOf('AZ', { AZ: { ok: false } })).toBe('bad');
    expect(statusOf('AZ', { AZ: { ok: true, edge: { ok: false } } })).toBe('bad');
    expect(statusOf('AZ', { AZ: { ok: true, edge: { ok: true }, rows: [{ status: 'ok' }, { status: 'missing' }] } })).toBe('warn');
    expect(statusOf('AZ', { AZ: { ok: true, edge: { ok: true }, rows: [{ status: 'ok' }], irsIssues: [{ level: 'warn' }] } })).toBe('ok');
  });
});

describe('buildGraph', () => {
  it('Main + 사이트별 Edge/IRS/vCenter 노드, 서비스별 링크(비활성 제외), IRS 없는 사이트는 Edge 만', () => {
    const g = buildGraph(topo, { AZ: { ok: true, edge: { ok: true }, rows: [] } });
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toEqual(['main', 'edge:AZ', 'vc:edge:AZ', 'irs:AZ', 'vc:irs:AZ', 'edge:NA']);
    expect(g.nodes.find((n) => n.id === 'edge:AZ').status).toBe('ok');
    expect(g.nodes.find((n) => n.id === 'edge:NA').status).toBe('unknown');
    const az = g.links.filter((l) => l.id.includes('AZ'));
    expect(az.map((l) => l.kind)).toEqual(['portal', 'vcenter', 'portal', 'ssh', 'hq', 'vcenter']);
    expect(g.links.filter((l) => l.from === 'edge:NA' || l.to === 'edge:NA')).toHaveLength(1);
    expect(g.links.find((l) => l.kind === 'hq').dashed).toBe(true);
    expect(g.links.some((l) => l.kind === 'off')).toBe(false);
    expect(g.width).toBe(W2D); expect(g.height).toBe(560);
    // 2D: 사이트 열은 겹치지 않고 폭 안에 있다
    const xs = g.nodes.filter((n) => n.kind === 'edge').map((n) => n.x);
    expect(new Set(xs).size).toBe(2); expect(Math.min(...xs)).toBeGreaterThan(0); expect(Math.max(...xs)).toBeLessThan(W2D);
    // 3D: Edge 는 반지름이 같고 IRS 는 더 바깥·아래층
    const e = g.nodes.find((n) => n.id === 'edge:AZ').p3, i = g.nodes.find((n) => n.id === 'irs:AZ').p3;
    expect(Math.hypot(i[0], i[2])).toBeGreaterThan(Math.hypot(e[0], e[2])); expect(i[1]).toBeLessThan(e[1]);
  });
  it('빈 토폴로지도 Main 노드 하나로 안전', () => {
    const g = buildGraph({}, {});
    expect(g.nodes).toHaveLength(1); expect(g.links).toHaveLength(0); expect(g.height).toBe(360);
  });
});

describe('project / frame3d', () => {
  it('원점은 화면 중심, 회전 대칭, 멀수록 작게', () => {
    const o = project([0, 0, 0], { cx: 100, cy: 50 });
    expect(o.x).toBeCloseTo(100); expect(o.y).toBeCloseTo(50);
    const a = project([1, 0, 0], { rotY: 0, rotX: 0 }), b = project([-1, 0, 0], { rotY: 0, rotX: 0 });
    expect(a.x).toBeCloseTo(-b.x); expect(a.y).toBeCloseTo(b.y);
    const near = project([0, 0, -2], { rotX: 0 }), far = project([0, 0, 2], { rotX: 0 });
    expect(near.f).toBeGreaterThan(far.f);
    const up = project([0, 1, 0], { rotX: 0 }); expect(up.y).toBeLessThan(0);
  });
  it('frame3d: 깊이 내림차순 정렬(뒤에서 앞으로 그리기), 패킷은 링크 위', () => {
    const g = buildGraph(topo, {});
    const f = frame3d(g, { rotY: 0.3 }, 0.25);
    for (let i = 1; i < f.nodes.length; i++) expect(f.nodes[i - 1].depth).toBeGreaterThanOrEqual(f.nodes[i].depth);
    const l = f.links[0];
    const t = (l.px - l.x1) / ((l.x2 - l.x1) || 1);
    expect(t).toBeGreaterThanOrEqual(0); expect(t).toBeLessThanOrEqual(1);
  });
});
