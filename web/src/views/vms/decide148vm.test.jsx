// 148회차 — 결정 145 K1 · 144 D1 권장안 구현(VM 분석 화면 쪽).
//   K1: 공용 fillStep 에 경계 종류(critOp)를 넣었지만 **VM 지도는 그대로 ‘이상(≥)’** — 서버 VM 과부하 판정이 ≥ OVERLOAD_BIN 이라서(145 N145-2 가 문장을 ‘90% 이상인’ 으로 맞췄다).
//       정확히 90 인 법인은 VM 지도에서 빨강 · ‘지금 90% 이상인 법인은 1곳’ · 범례 ‘90% 이상(경고)’ 그대로.
//   D1: ‘오래됨 N곳’ 안내가 사유(notCurrent)를 가른다 — Hypervisor 와 같은 공용 문장(insightCore.staleScopeText).
//   응답은 서버 vmInsightOf 로 만든다(실제 모양).
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fillStep, critWord, CRIT_BG } from '../insight/treemap.js';
import { fillDefs } from './vmInsightText.js';

const { vmInsightOf } = await import('../../../../server/src/inventory/vmInsight.js');
const { signalContext, vmSignalsOf } = await import('../../../../server/src/inventory/vmSignals.js');

const vm = (vc, name, o = {}) => ({
  id: `${vc}:${name}`, vcenterId: vc, name, host: 'h1', powerState: 'POWERED_ON', template: false, guestOS: 'Ubuntu Linux (64-bit)',
  cpuCount: 2, memMB: 4096, storageGB: 100, cpuUsagePct: 15, memUsagePct: 25, toolsStatus: 'RUNNING', toolsVersionStatus: 'guestToolsCurrent',
  hwVersion: 'vmx-19', connectionState: 'connected', snapshotCount: 0, snapshotSizeGB: 0, ...o,
});
const ctx = signalContext({ snapAgeDays: 7 }, Date.now());
const respOf = async (vcenters, vms) => ({ ok: true, generatedAt: '2026-11-19T00:00:00Z', initial: false, region: null, ...(await vmInsightOf({ vcenters, vms, ctx })) });

// K1 — va: 평균 CPU 정확히 90(두 VM 다 90) · vb: 50
const K1_VMS = [vm('va', 'a1', { cpuUsagePct: 90 }), vm('va', 'a2', { cpuUsagePct: 90 }), vm('vb', 'b1', { cpuUsagePct: 50 })];
const K1 = await respOf([
  { id: 'va', name: '법인-va', status: 'connected', location: { region: '유럽', city: 'a' } },
  { id: 'vb', name: '법인-vb', status: 'connected', location: { region: '유럽', city: 'b' } },
], K1_VMS);
// D1 — va 지금 값 · vm 점검중 · vs 수집 실패 이월
const D1 = await respOf([
  { id: 'va', name: '법인-va', status: 'connected', location: { region: '유럽', city: 'a' } },
  { id: 'vm', name: '법인-vm', status: 'maintenance', location: { region: '유럽', city: 'm' } },
  { id: 'vs', name: '법인-vs', status: 'connected', stale: true, location: { region: '유럽', city: 's' } },
], [vm('va', 'a1'), vm('vm', 'm1', { cpuUsagePct: 95 }), vm('vs', 's1', { cpuUsagePct: 95 })]);
const D1_LATE = { ...D1, rows: D1.rows.filter((r) => r.id !== 'vm') };

vi.mock('react', async (orig) => {
  const real = await orig();
  // 색 기준 상태(처음 'att')만 ‘평균 CPU’ 로 — 그 밖 상태는 그대로.
  return { ...real, useState: (init) => (init === 'att' ? real.useState('cpu') : real.useState(init)) };
});
const cur = { resp: K1 };
vi.mock('../../api.js', async (orig) => {
  const real = await orig();
  return { ...real, fetchJson: () => new Promise(() => {}), usePolling: (path) => (path === '/vms/insight' ? { data: cur.resp, error: null, loading: false } : { data: null, error: null, loading: true }),
    toolAllowed: () => false, hasRole: () => true, can: () => true };
});
vi.mock('../insight/useInsight.js', () => ({
  useFolded: () => [{}, () => {}],
  useLazyJson: () => ({ data: null, error: null, loading: false, reload: () => {} }),
}));
const { default: VmInsight } = await import('./VmInsight.jsx');
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const html = (resp) => { cur.resp = resp; return renderToStaticMarkup(React.createElement(VmInsight, { filters: {}, onScopeIds: () => {} })); };
const tilesOf = (h) => [...h.matchAll(/<button[^>]*class="ins-tl[^"]*"[^>]*style="([^"]*)"[^>]*><b>([^<]*)<\/b>/g)]
  .map((m) => ({ title: m[2], bg: (m[1].match(/background-color:\s*([^;]+)/) || [])[1]?.trim() }));

describe('148회차 K1 — VM 지도는 ‘이상(≥)’ 그대로(공용 모듈 변경이 VM 동작을 바꾸지 않는다)', () => {
  it('정의: VM 색 기준에는 경계 종류 ‘초과’ 가 없다 · 정확히 90 은 경고', () => {
    const defs = fillDefs({ overloadPct: 90 });
    expect(defs.every((d) => d.critOp !== 'gt')).toBe(true);
    const cpu = defs.find((d) => d.key === 'cpu');
    expect(critWord(cpu)).toBe('이상');
    expect(fillStep(90, cpu).over).toBe(true);
    expect(fillStep(89.9, cpu).over).toBe(false);
  });
  it('전제(서버): VM 과부하는 ≥ 90 — CPU 90 인 VM 도 과부하 · va 평균 CPU 90', () => {
    expect(vmSignalsOf(K1_VMS[0], ctx)).toContain('overload');
    const va = K1.rows.find((r) => r.id === 'va');
    expect(va.cpuAvg.value).toBe(90);
    expect(va.signals.overload).toBe(2);
  });
  it('화면: 평균 CPU 90 인 법인은 빨강 · ‘지금 90% 이상인 법인은 1곳’ · 범례 ‘90% 이상(경고)’', () => {
    const h = html(K1);
    const tiles = tilesOf(h);
    expect(tiles.find((t) => t.title === '법인-va').bg).toBe(CRIT_BG);
    expect(tiles.find((t) => t.title === '법인-vb').bg).not.toBe(CRIT_BG);
    const t = text(h);
    expect(t).toMatch(/빨강 = 90% 이상인 법인만\. 지금 90% 이상인 법인은 1곳입니다\./);
    expect(t).toMatch(/90% 이상\(경고\)/);
    expect(t).not.toMatch(/초과\(경고\)|초과인/);
  });
});

describe('148회차 D1 — VM 분석의 ‘오래됨 N곳’ 사유', () => {
  it('전제(서버): 점검중 = maintenance · 수집 실패 이월 = stale', () => {
    const by = new Map(D1.rows.map((r) => [r.id, r]));
    expect([by.get('vm').notCurrent, by.get('vs').notCurrent]).toEqual(['maintenance', 'stale']);
  });
  it('점검중과 값 늦음을 나눠 적는다 · 지도 안내는 옛 값 2곳을 세지 않는다(145 N145-2)', () => {
    const t = text(html(D1));
    expect(t).toMatch(/오래됨 2곳 — 점검중 1곳\(법인-vm\) · 값 늦음 1곳\(법인-vs\) — 지금 값이 아니라 합에 넣지 않았습니다\./);
    expect(t).toMatch(/지금 90% 이상인 법인은 0곳입니다\(경계를 넘은 오래된 값 2곳은 세지 않았습니다\)/);
  });
  it('점검중이 없으면 예전 문장 그대로', () => {
    const t = text(html(D1_LATE));
    expect(t).toMatch(/오래됨 1곳\(법인-vs\) — 값이 늦어 합에 넣지 않았습니다\./);
    expect(t).not.toMatch(/점검중 \d+곳/);
  });
});
