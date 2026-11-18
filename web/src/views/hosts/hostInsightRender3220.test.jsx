// v3.22.0 — Hypervisor 탭 ‘분석’ 보기 렌더(서버 hostInsightOf 로 만든 실제 응답 모양) · 권한별 숨김 · 소스 규약.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { stripComments } from '../../test/_stripComments.js';

const { hostInsightOf } = await import('../../../../server/src/vcenter/hostInsight.js');

const GB = 1024;
const readable = (h) => h.connectionState !== 'DISCONNECTED' && h.connectionState !== 'NOT_RESPONDING';
const capKnown = (h) => !!h && [h.cpuCores, h.cpuTotalMhz, h.memTotalMB].every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
const host = (vc, id, cluster, o = {}) => ({
  id: `${vc}:${id}`, vcenterId: vc, name: `${vc}-${id}`, cluster, clusterRef: cluster === 'standalone' ? null : `domain-${cluster}`,
  connectionState: 'CONNECTED', version: '8.0.2', vendor: 'Dell Inc.', model: 'PowerEdge R760',
  cpuCores: 32, cpuSockets: 2, cpuThreads: 64, cpuTotalMhz: 64000, cpuUsagePct: 40, memTotalMB: 512 * GB, memUsagePct: 50, powerWatts: 400, ...o,
});
const HOSTS = [
  host('va', 'h1', 'CL1', { cpuUsagePct: 95, memUsagePct: 93 }), host('va', 'h2', 'CL1', { memUsagePct: 92 }),
  host('va', 'h3', 'CL2'), host('va', 'h4', 'CL2', { connectionState: 'DISCONNECTED', cpuUsagePct: 0, memUsagePct: 0 }),
  host('vb', 'h1', 'BCL', { cpuUsagePct: 60 }), host('vb', 'h2', 'BCL'), host('vb', 'h3', 'standalone'),
  host('vs', 'h1', 'SCL'),
];
const VCS = [
  { id: 'va', name: '법인-va', status: 'connected', location: { region: '유럽', city: 'va-city' }, clusterCfg: [
    { ref: 'domain-CL1', name: 'CL1', ha: { enabled: true, admission: true }, drs: { enabled: true, behavior: 'fullyAutomated' }, numHosts: 2 },
    { ref: 'domain-CL2', name: 'CL2', ha: { enabled: false }, drs: { enabled: true, behavior: 'manual' }, numHosts: 2 },
  ] },
  { id: 'vb', name: '법인-vb', status: 'connected', location: { region: '아시아', city: 'vb-city' } },
  { id: 'vs', name: '법인-vs', status: 'connected', location: { region: '아시아', city: 'vs-city' } },
];
const respOf = async (access, checks = null) => {
  const r = { ok: true, generatedAt: '2026-11-18T00:00:00Z', initial: false, region: null,
    ...(await hostInsightOf({ vcenters: VCS, hosts: HOSTS, vms: [], readable, capKnown, access, checks, bootDays: access.hygiene ? 30 : null })) };
  r.rows = r.rows.map((x) => (x.id === 'vs' ? { ...x, stale: true } : x));   // vs 는 값이 오래됨 — 합에 섞지 않는다
  return r;
};
const FULL = await respOf({ cluster: true, hw: true, hygiene: true }, { access: { hw: true, hygiene: true }, byId: { 'va:h1': { hw: { state: 'fault' } } } });
const BARE = await respOf({ cluster: false, hw: false, hygiene: false });

const st = { tools: true, resp: FULL };
vi.mock('../../api.js', async (orig) => {
  const real = await orig();
  return { ...real, fetchJson: () => new Promise(() => {}), usePolling: (path) => (path === '/hosts/insight' ? { data: st.resp, error: null, loading: false } : { data: null, error: null, loading: true }),
    toolAllowed: () => st.tools, hasRole: () => st.tools };
});
const { default: HostInsight } = await import('./HostInsight.jsx');

const render = (p) => renderToStaticMarkup(React.createElement(HostInsight, { filters: {}, onScopeIds: () => {}, onOpenCorp: () => {}, ...p }));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('분석 보기 렌더', () => {
  it('시안 순서 — 요약 6장 · 확인할 것 · 가상화 호스트 현황 · 지역별 분포 · 묶음 · 지금 볼 호스트', () => {
    st.tools = true; st.resp = FULL;
    const t = text(render({}));
    const order = ['전체 호스트', '연결', '확인 대상', '물리 코어', '메모리', '전력', '확인할 것', '가상화 호스트 현황', '지역별 분포', '성능', '구성 점검', '용량', '분포', '지금 볼 호스트'];
    let at = -1;
    for (const w of order) { const i = t.indexOf(w, at + 1); expect(i, w).toBeGreaterThan(at); at = i; }
    expect(t).toMatch(/오래됨 1곳\(법인-vs\)/);
    expect(t).toMatch(/전체 호스트 7 /);               // 8대 중 오래된 법인의 1대 제외
    expect(t).toMatch(/설정 · 520px ▾/);               // 처음 크기 = 크게 520 · 설정 상자는 닫힘
    expect(t).not.toMatch(/지도 크기 설정/);
    expect(t).toMatch(/하드웨어 장애 · 경고/);
    expect(t).toMatch(/예기치 않은 재부팅\(30일\)/);
    expect(t).toMatch(/HA 꺼진 클러스터/);
    expect(t).not.toMatch(/`/);                         // 화면 문구 백틱 금지
  });
  it('처음 색 = 한 대 빠진 뒤 메모리(눌림) · 못 버팀 범례', () => {
    const html = render({});
    expect(html).toMatch(/aria-pressed="true"[^>]*>한 대 빠진 뒤 메모리</);
    expect(text(html)).toMatch(/한 대가 빠지면 버티지 못하는 클러스터/);
  });
  it('고른 법인만 합 — vb 하나 · 지도 칸은 법인으로 눌림', () => {
    const html = render({ scopeIds: ['vb'] });
    const t = text(html);
    expect(t).toMatch(/전체 호스트 3 /);
    expect(t).toMatch(/법인 1곳을 골랐습니다/);
    expect((html.match(/class="ins-tl [^"]*"/g) || []).length).toBe(5);   // 칸 = 클러스터 4(오래된 법인의 1 포함) + 독립 1
    expect((html.match(/aria-pressed="true"[^>]*title="(BCL|독립 호스트)/g) || []).length).toBe(2);
  });
  it('권한이 없으면 — 하드웨어 · 재부팅 · 클러스터 칸과 도구 묶음이 없다(0 이 아니라 숨김)', () => {
    st.tools = false; st.resp = BARE;
    const t = text(render({}));
    expect(t).not.toMatch(/하드웨어 장애/);
    expect(t).not.toMatch(/재부팅/);
    expect(t).not.toMatch(/HA 꺼진/);
    expect(t).not.toMatch(/클러스터 안전성/);
    expect(t).not.toMatch(/한 대 빠진 뒤 메모리/);
    expect(t).not.toMatch(/구성 점검/);
    expect(t).not.toMatch(/CPU 경합/);
    expect(t).toMatch(/분포/);
    st.tools = true; st.resp = FULL;
  });
});

describe('소스 규약', () => {
  const src = (p) => stripComments(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
  it('공용 부품을 그대로 쓴다 — 지도 · 지도 크기 · 타일 · 묶음 접기 · 합 계산 · 도구 패널 부품', () => {
    const s = src('./HostInsight.jsx');
    for (const w of ["from '../insight/Treemap.jsx'", "from '../insight/MapSize.jsx'", "from '../insight/InsightParts.jsx'", "from '../insight/insightCore.js'", "from '../insight/useInsight.js'"]) expect(s).toContain(w);
    const p = src('./insight-tools/HostToolPanels.jsx');
    for (const w of ["from '../../vms/insight-tools/ToolParts.jsx'", "from '../../vms/insight-tools/useToolSummary.js'", "from '../../vms/insight-tools/toolSumText.js'"]) expect(p).toContain(w);
    expect(s).not.toMatch(/localStorage/);   // 기억은 insightPrefs(try/catch) 한 곳
    expect(s).not.toMatch(/<table/);         // 표는 STable
  });
  it('/hosts/insight 는 30초 폴링 · 리전만 싣는다 · 도구 요약은 폴링하지 않는다', () => {
    const s = src('./HostInsight.jsx');
    expect(s).toMatch(/usePolling\('\/hosts\/insight', region \? \{ region \} : \{\}, 30_000\)/);
    expect(src('./insight-tools/HostToolPanels.jsx')).not.toMatch(/usePolling/);
  });
  it('Hosts.jsx — 보기는 주소로(#/hosts/<보기>) · 상세 주소 판정은 hostIdOfHash · 옛 보기 기억을 읽지 않는다', () => {
    const s = src('../Hosts.jsx');
    expect(s).toMatch(/hostIdOfHash/);
    expect(s).toMatch(/HOST_VIEWS\.map/);
    expect(s).not.toMatch(/readHostsView|writeHostsView/);
    expect(s).toMatch(/view === 'insight'/);
  });
});
