// 148회차 — 결정 145 K1 · 144 D1 권장안 구현(Hypervisor 분석 화면).
//   K1: 지도의 빨강은 서버 판정과 같은 ‘90 초과’ — 정확히 90 인 클러스터는 과부하 · N+1(≤ 90 버팀) · 표처럼 정상(전에는 지도만 빨강).
//   D1: ‘오래됨 N곳’ 안내가 사유를 notCurrent 로 가른다 — 점검중은 ‘점검중’, 그 밖(값 늦음 · 모르는 사유)은 예전 문장.
//   응답은 서버 hostInsightOf 로 만든다(실제 모양 — 손으로 쓴 픽스처가 아니다).
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CRIT_BG } from '../insight/treemap.js';

const { hostInsightOf } = await import('../../../../server/src/vcenter/hostInsight.js');

const GB = 1024;
const MEM_TOTAL = 512 * GB;
const readable = (h) => h.connectionState !== 'DISCONNECTED' && h.connectionState !== 'NOT_RESPONDING';
const capKnown = (h) => !!h && [h.cpuCores, h.cpuTotalMhz, h.memTotalMB].every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
const host = (vc, id, cluster, o = {}) => ({
  id: `${vc}:${id}`, vcenterId: vc, name: `${vc}-${id}`, cluster, clusterRef: `domain-${cluster}`,
  connectionState: 'CONNECTED', version: '8.0.2', vendor: 'Dell Inc.', model: 'PowerEdge R760', bootTime: Date.now() - 86_400_000 * 90,
  cpuCores: 32, cpuSockets: 2, cpuThreads: 64, cpuTotalMhz: 64000, cpuUsageMhz: 1000, cpuUsagePct: 0, memTotalMB: MEM_TOTAL, memUsagePct: 40, memUsageMB: Math.round(MEM_TOTAL * 0.4), powerWatts: 400, ...o,
});
// 3대 클러스터 — 가장 바쁜 호스트 CPU = busy · 한 대 빠진 뒤 메모리 = 3 × memPct / 2(n1.js — 반올림)
const cluster3 = (vc, name, busy, memPct) => [0, 1, 2].map((i) => host(vc, `${name}-h${i}`, name, {
  cpuUsagePct: i === 0 ? busy : 0, memUsagePct: memPct, memUsageMB: Math.round(MEM_TOTAL * memPct / 100),
}));
const cfg = (name) => ({ ref: `domain-${name}`, name, ha: { enabled: true, admission: true }, drs: { enabled: true, behavior: 'fullyAutomated' }, numHosts: 3 });

// K1 — CL90: 가장 바쁜 호스트 90 · 빠진 뒤 메모리 90(정확히 경계) / CL95: 95 · 93(경계 초과)
const K1_HOSTS = [...cluster3('va', 'CL90', 90, 60), ...cluster3('va', 'CL95', 95, 62)];
const K1_VCS = [{ id: 'va', name: '법인-va', status: 'connected', location: { region: '유럽', city: 'va-city' }, clusterCfg: [cfg('CL90'), cfg('CL95')] }];
const respOf = async (p) => ({ ok: true, generatedAt: '2026-11-19T00:00:00Z', initial: false, region: null, ...(await hostInsightOf({ readable, capKnown, vms: [], ...p })) });
const K1_CLUSTER = await respOf({ vcenters: K1_VCS, hosts: K1_HOSTS, access: { cluster: true, hw: false, hygiene: false } });
const K1_NOCLUSTER = await respOf({ vcenters: K1_VCS, hosts: K1_HOSTS, access: { cluster: false, hw: false, hygiene: false } });

// D1 — va 지금 값 · vm 점검중(직전 캐시) · vs 수집 실패 이월(vc.stale) · vu 연결 실패(호스트가 남은 캐시)
const D1_VCS = [
  { id: 'va', name: '법인-va', status: 'connected', location: { region: '유럽', city: 'a' } },
  { id: 'vm', name: '법인-vm', status: 'maintenance', location: { region: '유럽', city: 'm' } },
  { id: 'vs', name: '법인-vs', status: 'connected', stale: true, location: { region: '유럽', city: 's' } },
  { id: 'vu', name: '법인-vu', status: 'unreachable', stale: true, location: { region: '유럽', city: 'u' } },
];
// 오래된 세 법인의 옛 값은 95%(경계 초과) — 지도 안내가 ‘지금 0칸’ · ‘경계를 넘은 오래된 값 3칸’ 으로 따로 센다(145 N145-2)
const D1_HOSTS = ['va', 'vm', 'vs', 'vu'].flatMap((vc) => [host(vc, 'h1', `C${vc}`, { cpuUsagePct: vc === 'va' ? 40 : 95 }), host(vc, 'h2', `C${vc}`, { cpuUsagePct: 40 })]);
const d1Resp = (ids) => respOf({ vcenters: D1_VCS.filter((v) => ids.includes(v.id)), hosts: D1_HOSTS.filter((h) => ids.includes(h.vcenterId)), access: { cluster: false, hw: false, hygiene: false } });
const D1_ALL = await d1Resp(['va', 'vm', 'vs', 'vu']);
const D1_LATE = await d1Resp(['va', 'vs', 'vu']);
const D1_MAINT = await d1Resp(['va', 'vm']);
// 사유를 싣지 않는 응답(옛 서버 · 모르는 값) — 단정하지 않고 예전 문장
const D1_NOREASON = { ...D1_MAINT, rows: D1_MAINT.rows.map((r) => (r.id === 'vm' ? (({ notCurrent, ...rest }) => rest)(r) : r)) };
const D1_ODDREASON = { ...D1_MAINT, rows: D1_MAINT.rows.map((r) => (r.id === 'vm' ? { ...r, notCurrent: 'something-new' } : r)) };

const cur = { resp: K1_CLUSTER };
vi.mock('../../api.js', async (orig) => {
  const real = await orig();
  return { ...real, fetchJson: () => new Promise(() => {}), usePolling: (path) => (path === '/hosts/insight' ? { data: cur.resp, error: null, loading: false } : { data: null, error: null, loading: true }),
    toolAllowed: () => false, hasRole: () => true };
});
const { default: HostInsight } = await import('./HostInsight.jsx');
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const html = (resp) => { cur.resp = resp; return renderToStaticMarkup(React.createElement(HostInsight, { filters: {}, onScopeIds: () => {} })); };
/** 지도 칸 — { title, bg } (Treemap tileBtn: <button class="ins-tl …" style="…background-color:#…"><b>이름</b>…) */
const tilesOf = (h) => [...h.matchAll(/<button[^>]*class="ins-tl[^"]*"[^>]*style="([^"]*)"[^>]*><b>([^<]*)<\/b>/g)]
  .map((m) => ({ title: m[2], bg: (m[1].match(/background-color:\s*([^;]+)/) || [])[1]?.trim() }));

describe('148회차 K1 — Hypervisor 지도의 빨강 = 서버 판정과 같은 ‘90 초과’', () => {
  it('전제(서버): CL90 은 가장 바쁜 호스트 90 · 빠진 뒤 메모리 90 · 버팀(n1Ok) — 과부하 호스트는 95 인 한 대뿐', () => {
    const c90 = K1_CLUSTER.clusters.find((c) => c.label === 'CL90');
    const c95 = K1_CLUSTER.clusters.find((c) => c.label === 'CL95');
    expect(c90.busiestCpu).toBe(90);
    expect(c90.n1Mem).toBe(90);
    expect(c90.n1Ok).toBe(true);
    expect(c95.n1Mem).toBeGreaterThan(90);
    expect(c95.n1Ok).toBe(false);
    expect(K1_CLUSTER.rows[0].overloaded).toBe(1);
    expect(K1_CLUSTER.thresholds.overloadPct).toBe(90);
    expect(K1_CLUSTER.thresholds.n1LimitPct).toBe(90);
  });
  it('처음 색(한 대 빠진 뒤 메모리): 정확히 90 인 칸은 빨강이 아니고 못 버티는 칸만 빨강 · 안내 ‘90% 초과인 칸만 — 1칸’ · 범례 ‘90% 초과(경고)’', () => {
    const h = html(K1_CLUSTER);
    const tiles = tilesOf(h);
    expect(tiles.map((t) => t.title).sort()).toEqual(['CL90', 'CL95']);
    expect(tiles.find((t) => t.title === 'CL90').bg).not.toBe(CRIT_BG);
    expect(tiles.find((t) => t.title === 'CL95').bg).toBe(CRIT_BG);
    const t = text(h);
    expect(t).toMatch(/빨강 = 90% 초과인 칸만 — 지금 ‘한 대 빠진 뒤 메모리’ 기준으로 1칸입니다\(2칸 중\)/);
    expect(t).toMatch(/90% 초과\(경고\)/);
    expect(t).not.toMatch(/90% 이상\(경고\)|90% 이상인 칸/);
    // 빨강 칸 수 = 서버가 못 버팀으로 판정한 클러스터 수(같은 화면이 같은 말)
    expect(tiles.filter((x) => x.bg === CRIT_BG).length).toBe(K1_CLUSTER.clusters.filter((c) => c.n1Ok === false).length);
  });
  it('가장 바쁜 호스트 CPU(클러스터 구성 권한 없음 — 첫 기준): 90 은 빨강 아님 · 95 만 — 과부하 호스트 1 과 같다', () => {
    const h = html(K1_NOCLUSTER);
    const tiles = tilesOf(h);
    expect(tiles.find((t) => t.title === 'CL90').bg).not.toBe(CRIT_BG);
    expect(tiles.find((t) => t.title === 'CL95').bg).toBe(CRIT_BG);
    expect(text(h)).toMatch(/빨강 = 90% 초과인 칸만 — 지금 ‘가장 바쁜 호스트 CPU’ 기준으로 1칸입니다\(2칸 중\)/);
  });
});

describe('148회차 D1 — ‘오래됨 N곳’ 이 사유(notCurrent)를 가른다 · 숫자 정책은 그대로', () => {
  it('전제(서버): 점검중 = maintenance · 수집 실패 이월 = stale · 연결 실패(캐시) = unreachable — 셋 다 stale:true', () => {
    const by = new Map(D1_ALL.rows.map((r) => [r.id, r]));
    expect([by.get('vm').notCurrent, by.get('vs').notCurrent, by.get('vu').notCurrent]).toEqual(['maintenance', 'stale', 'unreachable']);
    expect(['vm', 'vs', 'vu'].every((id) => by.get(id).stale === true && by.get(id).unknown === false)).toBe(true);
    expect(by.get('va').stale).not.toBe(true);
  });
  it('섞여 있으면 점검중 · 값 늦음을 나눠 적고 셋 다 합에서 뺀다(전체 호스트 2)', () => {
    const t = text(html(D1_ALL));
    expect(t).toMatch(/오래됨 3곳 — 점검중 1곳\(법인-vm\) · 값 늦음 2곳\(법인-vs · 법인-vu\) — 지금 값이 아니라 합에 넣지 않았습니다\./);
    expect(t).toMatch(/전체 호스트 2 /);
  });
  it('점검중만 있으면 ‘점검중’ 으로', () => {
    expect(text(html(D1_MAINT))).toMatch(/오래됨 1곳 — 점검중 1곳\(법인-vm\) — 지금 값이 아니라 합에 넣지 않았습니다\./);
  });
  it('점검중이 없으면 예전 문장 그대로(값이 늦어)', () => {
    const t = text(html(D1_LATE));
    expect(t).toMatch(/오래됨 2곳\(법인-vs · 법인-vu\) — 값이 늦어 합에 넣지 않았습니다\./);
    expect(t).not.toMatch(/점검중 \d+곳/);
  });
  it('사유가 없거나 모르는 값이면 단정하지 않는다 — 예전 문장', () => {
    for (const resp of [D1_NOREASON, D1_ODDREASON]) {
      const t = text(html(resp));
      expect(t).toMatch(/오래됨 1곳\(법인-vm\) — 값이 늦어 합에 넣지 않았습니다\./);
      expect(t).not.toMatch(/점검중 \d+곳/);
    }
  });
  it('지도 안내(145 N145-2)와 같은 법인 집합 — 오래된 3곳의 칸은 ‘지금 … N칸’ 에 세지 않는다', () => {
    const t = text(html(D1_ALL));
    expect(t).toMatch(/지금 ‘가장 바쁜 호스트 CPU’ 기준으로 0칸입니다\(4칸 중\) — 경계를 넘은 오래된 값 3칸은 세지 않았습니다/);
  });
});
